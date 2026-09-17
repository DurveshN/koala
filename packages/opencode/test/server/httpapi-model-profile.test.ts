import { NodeHttpServer } from "@effect/platform-node"
import { afterEach, describe, expect } from "bun:test"
import { rm } from "fs/promises"
import os from "os"
import path from "path"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { Context, Effect, Layer, Option } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Installation } from "../../src/installation"
import { ModelProfileStore } from "../../src/koala/model-profile-store"
import { InstanceStore } from "../../src/project/instance-store"
import { ServerAuth } from "../../src/server/auth"
import { RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { ModelProfilePaths } from "../../src/server/routes/instance/httpapi/groups/model-profile"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "../../src/server/routes/instance/httpapi/handlers/control-plane"
import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { modelProfileHandlers } from "../../src/server/routes/instance/httpapi/handlers/model-profile"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { pollWithTimeout, testEffect } from "../lib/effect"

const data = path.join(os.tmpdir(), `opencode-model-profile-http-${process.pid}`)
let disposals = 0

const instanceStoreLayer = Layer.mock(InstanceStore.Service, {
  disposeAll: () => Effect.sync(() => disposals++).pipe(Effect.asVoid),
})

const routes = HttpRouter.serve(
  HttpApiBuilder.layer(RootHttpApi).pipe(
    Layer.provide([controlHandlers, controlPlaneHandlers, globalHandlers, modelProfileHandlers]),
    Layer.provide([authorizationLayer, schemaErrorLayer]),
    // Raw HttpApi routes expose an opaque handler context at the request boundary.
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    HttpRouter.provideRequest(Layer.succeedContext(Context.empty() as Context.Context<unknown>)),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provide(Layer.mock(Auth.Service)({})),
  Layer.provide(Layer.mock(Config.Service)({})),
  Layer.provide(Layer.mock(MoveSession.Service)({})),
  Layer.provide(
    Layer.mock(Installation.Service)({
      method: () => Effect.succeed("npm"),
      latest: () => Effect.succeed("9.9.9"),
      upgrade: () => Effect.void,
    }),
  ),
  Layer.provide(instanceStoreLayer),
  Layer.provide(ServerAuth.Config.configLayer({ password: Option.none(), username: "opencode" })),
)

const storeLayer = AppNodeBuilder.build(ModelProfileStore.node, [
  [Global.node, Global.layerWith({ data, state: data })],
])
const failureStoreLayer = Layer.mock(ModelProfileStore.Service, {
  list: () => Effect.fail(new ModelProfileStore.ReadError()),
  create: () => Effect.fail(new ModelProfileStore.WriteError()),
  update: () => Effect.fail(new ModelProfileStore.WriteError()),
  remove: () => Effect.fail(new ModelProfileStore.WriteError()),
})
const it = testEffect(routes.pipe(Layer.provide(storeLayer)))
const itFailure = testEffect(routes.pipe(Layer.provide(failureStoreLayer)))

const model = (id = "local-model") => ({
  id,
  displayName: "Local Model",
  capabilities: {
    textInput: "yes",
    imageInput: "no",
    toolCalling: "yes",
    streaming: "yes",
    structuredOutput: "yes",
    reasoning: "unknown",
  },
  contextWindow: 32_768,
  maxOutput: 4_096,
  roles: ["general"],
  enabled: true,
  priority: 10,
})

const provider = (id = "local", displayName = "Local Provider") => ({
  id,
  displayName,
  baseURL: "http://127.0.0.1:11434/v1",
  secretReference: `keychain:${id}`,
  models: [model()],
})

const profilePath = (providerID: string) => ModelProfilePaths.provider.replace(":providerID", providerID)

const request = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, body?: unknown) =>
  HttpClientRequest.make(method)(url).pipe(
    body === undefined ? (value) => value : HttpClientRequest.bodyJsonUnsafe(body),
    HttpClient.execute,
  )

const waitForDisposals = (count: number) =>
  pollWithTimeout(
    Effect.sync(() => (disposals === count ? count : undefined)),
    `expected ${count} instance disposal calls, received ${disposals}`,
  )

afterEach(async () => {
  disposals = 0
  await rm(data, { recursive: true, force: true })
})

describe("model profile HttpApi", () => {
  it.live("supports the CRUD lifecycle and disposes only after mutations", () =>
    Effect.gen(function* () {
      const initial = yield* request("GET", ModelProfilePaths.root)
      expect(initial.status).toBe(200)
      expect(yield* initial.json).toEqual([])
      expect(disposals).toBe(0)

      const created = yield* request("POST", ModelProfilePaths.root, provider())
      expect(created.status).toBe(200)
      expect(yield* created.json).toEqual(provider())
      yield* waitForDisposals(1)

      const listed = yield* request("GET", ModelProfilePaths.root)
      expect(yield* listed.json).toEqual([provider()])
      expect(disposals).toBe(1)

      const updated = yield* request("PUT", profilePath("local"), provider("local", "Updated Provider"))
      expect(updated.status).toBe(200)
      expect(yield* updated.json).toEqual(provider("local", "Updated Provider"))
      yield* waitForDisposals(2)

      const removed = yield* request("DELETE", profilePath("local"))
      expect(removed.status).toBe(200)
      expect(yield* removed.json).toBe(true)
      yield* waitForDisposals(3)

      const empty = yield* request("GET", ModelProfilePaths.root)
      expect(yield* empty.json).toEqual([])
      expect(disposals).toBe(3)
    }),
  )

  it.live("rejects invalid URLs, empty models, duplicate model IDs, and invalid provider paths", () =>
    Effect.gen(function* () {
      const invalid = [
        { ...provider(), baseURL: "not-a-url", apiKey: "raw-provider-credential" },
        { ...provider(), models: [] },
        { ...provider(), models: [model(), model()] },
      ]

      for (const body of invalid) {
        const response = yield* request("POST", ModelProfilePaths.root, body)
        expect(response.status).toBe(400)
        expect(yield* response.text).not.toContain("raw-provider-credential")
      }
      expect((yield* request("PUT", profilePath("INVALID"), provider())).status).toBe(400)
      expect(disposals).toBe(0)
    }),
  )

  it.live("returns conflict for a duplicate provider", () =>
    Effect.gen(function* () {
      expect((yield* request("POST", ModelProfilePaths.root, provider())).status).toBe(200)
      yield* waitForDisposals(1)

      const duplicate = yield* request("POST", ModelProfilePaths.root, {
        ...provider("local", "Duplicate"),
        apiKey: "raw-provider-credential",
      })
      expect(duplicate.status).toBe(409)
      const body = yield* duplicate.text
      expect(body).toContain('"_tag":"ConflictError"')
      expect(body).not.toContain("raw-provider-credential")
      expect(disposals).toBe(1)
    }),
  )

  it.live("returns not found for missing updates and deletes", () =>
    Effect.gen(function* () {
      const update = yield* request("PUT", profilePath("missing"), {
        ...provider("missing"),
        apiKey: "raw-provider-credential",
      })
      expect(update.status).toBe(404)
      const updateBody = yield* update.text
      const remove = yield* request("DELETE", profilePath("missing"))
      expect(remove.status).toBe(404)
      expect(updateBody).toContain('"_tag":"ProviderNotFoundError"')
      expect(yield* remove.text).toContain('"_tag":"ProviderNotFoundError"')
      expect(updateBody).not.toContain("raw-provider-credential")
      expect(disposals).toBe(0)
    }),
  )

  it.live("rejects path and payload identity mismatch", () =>
    Effect.gen(function* () {
      const response = yield* request("PUT", profilePath("local"), {
        ...provider("remote"),
        apiKey: "raw-provider-credential",
      })
      expect(response.status).toBe(400)
      const body = yield* response.text
      expect(body).toContain('"_tag":"InvalidRequestError"')
      expect(body).not.toContain("raw-provider-credential")
      expect(disposals).toBe(0)
    }),
  )

  it.live("strips credential-like excess fields from responses", () =>
    Effect.gen(function* () {
      const response = yield* request("POST", ModelProfilePaths.root, {
        ...provider(),
        apiKey: "raw-provider-credential",
        models: [{ ...model(), token: "raw-model-credential" }],
      })
      const body = yield* response.text

      expect(response.status).toBe(200)
      expect(body).not.toContain("raw-provider-credential")
      expect(body).not.toContain("raw-model-credential")
      expect(body).not.toContain("apiKey")
      expect(body).not.toContain("token")
      yield* waitForDisposals(1)
    }),
  )

  itFailure.live("maps repository read and write failures to opaque server errors", () =>
    Effect.gen(function* () {
      const read = yield* request("GET", ModelProfilePaths.root)
      const readBody = yield* read.text
      const create = yield* request("POST", ModelProfilePaths.root, {
        ...provider(),
        apiKey: "raw-provider-credential",
      })
      const createBody = yield* create.text
      const update = yield* request("PUT", profilePath("local"), {
        ...provider(),
        apiKey: "raw-provider-credential",
      })
      const updateBody = yield* update.text
      const remove = yield* request("DELETE", profilePath("local"))
      const removeBody = yield* remove.text

      expect(read.status).toBe(500)
      expect(create.status).toBe(500)
      expect(update.status).toBe(500)
      expect(remove.status).toBe(500)
      expect(
        [readBody, createBody, updateBody, removeBody].every((body) => body.includes('"_tag":"UnknownError"')),
      ).toBe(true)
      expect(readBody).not.toContain("raw-provider-credential")
      expect(createBody).not.toContain("raw-provider-credential")
      expect(updateBody).not.toContain("raw-provider-credential")
      expect(removeBody).not.toContain("raw-provider-credential")
      expect([readBody, createBody, updateBody, removeBody].join("\n")).not.toContain("ModelProfileStore")
      expect(disposals).toBe(0)
    }),
  )
})
