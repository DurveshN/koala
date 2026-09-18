import { NodeHttpServer } from "@effect/platform-node"
import { afterEach, describe, expect } from "bun:test"
import { rm } from "fs/promises"
import os from "os"
import path from "path"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { Context, Effect, Layer, Option, Redacted } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Installation } from "../../src/installation"
import { ModelCapabilityProbe } from "../../src/koala/model-capability-probe"
import { ModelDiscovery } from "../../src/koala/model-discovery"
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
const discoveryInputs: ModelDiscovery.Input[] = []
const probeInputs: ModelCapabilityProbe.Input[] = []

const instanceStoreLayer = Layer.mock(InstanceStore.Service, {
  disposeAll: () => Effect.sync(() => disposals++).pipe(Effect.asVoid),
})

const discoveryLayer = Layer.mock(ModelDiscovery.Service, {
  discover: (input) =>
    Effect.sync(() => {
      discoveryInputs.push(input)
      return { models: [{ id: "first" }, { id: "second" }], duplicateCount: 1 }
    }),
})

const discoveryErrorLayer = Layer.mock(ModelDiscovery.Service, {
  discover: (input) => {
    const errors: Record<string, ModelDiscovery.Error> = {
      invalid: new ModelDiscovery.InvalidInputError({ reason: "models-endpoint" }),
      endpoint: new ModelDiscovery.EndpointError({ status: 503 }),
      timeout: new ModelDiscovery.TimeoutError(),
      malformed: new ModelDiscovery.MalformedResponseError({ reason: "invalid-json" }),
      large: new ModelDiscovery.TooLargeError({ limit: "body" }),
      internal: new ModelDiscovery.InternalError(),
    }
    return Effect.fail(errors[input.providerID] ?? new ModelDiscovery.InternalError())
  },
})

const capabilityProbeLayer = Layer.mock(ModelCapabilityProbe.Service, {
  probe: (input) =>
    Effect.sync(() => {
      probeInputs.push(input)
      return {
        probeVersion: 1 as const,
        modelID: input.modelID,
        results: [
          {
            capability: "textInput" as const,
            classification: "yes" as const,
            kind: "verified" as const,
            evidenceCode: "exact_text_nonce" as const,
            outputSecret: "probe-output-secret-canary",
          },
          {
            capability: "streaming" as const,
            classification: "unknown" as const,
            kind: "operational" as const,
            evidenceCode: "rate_limited" as const,
            httpStatus: 429,
          },
          {
            capability: "toolCalling" as const,
            classification: "no" as const,
            kind: "endpoint-rejection" as const,
            evidenceCode: "endpoint_rejection" as const,
            httpStatus: 422,
          },
        ],
        apiKey: "probe-output-secret-canary",
      }
    }),
})

const capabilityProbeErrorLayer = Layer.mock(ModelCapabilityProbe.Service, {
  probe: (input) =>
    input.providerID === "invalid-service"
      ? Effect.fail(new ModelCapabilityProbe.InvalidInputError({ reason: "invalid-endpoint" }))
      : Effect.fail(new ModelCapabilityProbe.InternalError()),
})

const routesWith = (
  modelDiscoveryLayer: Layer.Layer<ModelDiscovery.Service>,
  modelCapabilityProbeLayer: Layer.Layer<ModelCapabilityProbe.Service> = capabilityProbeLayer,
) =>
  HttpRouter.serve(
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
    Layer.provide(modelDiscoveryLayer),
    Layer.provide(modelCapabilityProbeLayer),
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
const routes = routesWith(discoveryLayer)

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
const itDiscoveryError = testEffect(routesWith(discoveryErrorLayer).pipe(Layer.provide(storeLayer)))
const itCapabilityProbeError = testEffect(
  routesWith(discoveryLayer, capabilityProbeErrorLayer).pipe(Layer.provide(storeLayer)),
)

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
  discoveryInputs.length = 0
  probeInputs.length = 0
  await rm(data, { recursive: true, force: true })
})

describe("model profile HttpApi", () => {
  it.live("probes capabilities in service order with a transient redacted key and no mutations", () =>
    Effect.gen(function* () {
      const response = yield* request("POST", ModelProfilePaths.probe, {
        providerID: "local",
        baseURL: "http://127.0.0.1:11434/v1",
        modelID: "local-model",
        capabilities: ["toolCalling", "textInput", "streaming"],
        apiKey: "transient-probe-secret-canary",
      })
      const body = yield* response.text

      expect(response.status).toBe(200)
      expect(body).toBe(
        '{"probeVersion":1,"modelID":"local-model","results":[{"capability":"textInput","classification":"yes","kind":"verified","evidenceCode":"exact_text_nonce"},{"capability":"streaming","classification":"unknown","kind":"operational","evidenceCode":"rate_limited","httpStatus":429},{"capability":"toolCalling","classification":"no","kind":"endpoint-rejection","evidenceCode":"endpoint_rejection","httpStatus":422}]}',
      )
      expect(probeInputs).toHaveLength(1)
      const probeInput = probeInputs[0]
      if (!probeInput?.apiKey) throw new Error("expected probe input with transient API key")
      expect(probeInput.capabilities).toEqual(["toolCalling", "textInput", "streaming"])
      expect(Redacted.value(probeInput.apiKey)).toBe("transient-probe-secret-canary")
      expect(body).not.toContain("transient-probe-secret-canary")
      expect(body).not.toContain("probe-output-secret-canary")
      expect((yield* request("GET", ModelProfilePaths.root)).status).toBe(200)
      expect(yield* (yield* request("GET", ModelProfilePaths.root)).json).toEqual([])
      expect(disposals).toBe(0)
    }),
  )

  it.live("rejects invalid and duplicate capability payloads without invoking the service", () =>
    Effect.gen(function* () {
      const inputs = [
        ["textInput", "unsupported"],
        ["textInput", "textInput"],
      ]

      for (const capabilities of inputs) {
        const response = yield* request("POST", ModelProfilePaths.probe, {
          providerID: "local",
          baseURL: "http://127.0.0.1:11434/v1",
          modelID: "local-model",
          capabilities,
          apiKey: "invalid-probe-secret-canary",
        })
        const body = yield* response.text
        expect(response.status).toBe(400)
        expect(body).not.toContain("invalid-probe-secret-canary")
      }
      expect(probeInputs).toHaveLength(0)
      expect(disposals).toBe(0)
    }),
  )

  itCapabilityProbeError.live("maps probe service errors to the declared opaque statuses", () =>
    Effect.gen(function* () {
      const responses = yield* Effect.forEach(["invalid-service", "internal-service"], (providerID) =>
        request("POST", ModelProfilePaths.probe, {
          providerID,
          baseURL: "http://127.0.0.1:11434/v1",
          modelID: "local-model",
          capabilities: ["textInput"],
          apiKey: "service-probe-secret-canary",
        }),
      )
      const bodies = yield* Effect.forEach(responses, (response) => response.text)

      expect(responses.map((response) => response.status)).toEqual([400, 500])
      expect(bodies[0]).toContain('"_tag":"InvalidRequestError"')
      expect(bodies[0]).toContain('"kind":"invalid-endpoint"')
      expect(bodies[1]).toContain('"_tag":"UnknownError"')
      expect(bodies[1]).toContain("Failed to probe model capabilities")
      expect(bodies.join("\n")).not.toContain("service-probe-secret-canary")
      expect(bodies[1]).not.toContain("authentication")
      expect(disposals).toBe(0)
    }),
  )

  it.live("discovers models with a redacted transient key without mutations or disposal", () =>
    Effect.gen(function* () {
      const response = yield* request("POST", ModelProfilePaths.discover, {
        providerID: "local",
        baseURL: "http://127.0.0.1:11434/v1",
        apiKey: "transient-secret-canary",
      })

      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({ models: [{ id: "first" }, { id: "second" }], duplicateCount: 1 })
      expect(discoveryInputs).toHaveLength(1)
      expect(Redacted.value(discoveryInputs[0]!.apiKey!)).toBe("transient-secret-canary")
      expect((yield* request("GET", ModelProfilePaths.root)).status).toBe(200)
      expect(disposals).toBe(0)
    }),
  )

  it.live("redacts discovery credentials and endpoint queries from schema errors", () =>
    Effect.gen(function* () {
      const response = yield* request("POST", ModelProfilePaths.discover, {
        providerID: "local",
        baseURL: "http://127.0.0.1:11434/v1?token=query-secret-canary",
        apiKey: "transient-secret-canary",
      })
      const body = yield* response.text

      expect(response.status).toBe(400)
      expect(body).not.toContain("query-secret-canary")
      expect(body).not.toContain("transient-secret-canary")
      expect(discoveryInputs).toHaveLength(0)
      expect(disposals).toBe(0)
    }),
  )

  itDiscoveryError.live("maps discovery errors to only the declared statuses", () =>
    Effect.gen(function* () {
      const cases = [
        ["invalid", 400, "InvalidRequestError"],
        ["endpoint", 502, "UpstreamError"],
        ["timeout", 504, "TimeoutError"],
        ["malformed", 502, "UpstreamError"],
        ["large", 502, "UpstreamError"],
        ["internal", 500, "UnknownError"],
      ] as const

      for (const [providerID, status, tag] of cases) {
        const response = yield* request("POST", ModelProfilePaths.discover, {
          providerID,
          baseURL: "http://127.0.0.1:11434/v1",
          apiKey: "status-secret-canary",
        })
        const body = yield* response.text
        expect(response.status).toBe(status)
        expect(body).toContain(`"_tag":"${tag}"`)
        expect(body).not.toContain("status-secret-canary")
      }
      expect(disposals).toBe(0)
    }),
  )

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
