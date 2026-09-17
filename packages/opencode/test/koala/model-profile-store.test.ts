import { describe, expect } from "bun:test"
import { mkdir, stat } from "fs/promises"
import path from "path"
import { ModelProfile } from "@koala-ai/core/model/profile"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { Effect, Schema } from "effect"
import { ModelProfileStore } from "../../src/koala/model-profile-store"
import { tmpdir } from "../fixture/fixture"
import { it } from "../lib/effect"

const decodeProvider = Schema.decodeUnknownSync(ModelProfile.Provider)
const decodeProviderID = Schema.decodeUnknownSync(ModelProfile.ProviderID)

const provider = (id: string, displayName = `${id} Provider`) =>
  decodeProvider({
    id,
    displayName,
    baseURL: `http://127.0.0.1/${id}`,
    secretReference: `keychain:${id}`,
    models: [
      {
        id: `${id}-model`,
        displayName: `${id} Model`,
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
        roles: ["general", "coding"],
        enabled: true,
        priority: 10,
      },
    ],
  })

const documentPath = (data: string) => path.join(data, "koala", "model-profiles.json")

const writeDocument = (data: string, content: string) =>
  Effect.promise(async () => {
    await mkdir(path.dirname(documentPath(data)), { recursive: true })
    await Bun.write(documentPath(data), content)
  })

const withStore = <A, E>(body: (data: string) => Effect.Effect<A, E, ModelProfileStore.Service>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) =>
      body(tmp.path).pipe(
        Effect.provide(
          AppNodeBuilder.build(ModelProfileStore.node, [
            [Global.node, Global.layerWith({ data: tmp.path, state: tmp.path })],
          ]),
        ),
      ),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

describe("ModelProfileStore", () => {
  it.live("returns an empty list for a missing file without writing one", () =>
    withStore((data) =>
      Effect.gen(function* () {
        const store = yield* ModelProfileStore.Service

        expect(yield* store.list()).toEqual([])
        expect(yield* Effect.promise(() => Bun.file(documentPath(data)).exists())).toBe(false)
      }),
    ),
  )

  it.live("creates and lists a profile", () =>
    withStore(() =>
      Effect.gen(function* () {
        const store = yield* ModelProfileStore.Service
        const input = provider("local")

        expect(yield* store.create(input)).toEqual(input)
        expect(yield* store.list()).toEqual([input])
      }),
    ),
  )

  it.live("persists profiles in provider ID order", () =>
    withStore((data) =>
      Effect.gen(function* () {
        const store = yield* ModelProfileStore.Service
        yield* store.create(provider("zeta"))
        yield* store.create(provider("alpha"))
        yield* store.create(provider("middle"))

        expect((yield* store.list()).map((item) => String(item.id))).toEqual(["alpha", "middle", "zeta"])
        expect(
          JSON.parse(yield* Effect.promise(() => Bun.file(documentPath(data)).text())).profiles.map(
            (item: { id: string }) => item.id,
          ),
        ).toEqual(["alpha", "middle", "zeta"])
      }),
    ),
  )

  it.live("rejects a duplicate provider ID", () =>
    withStore(() =>
      Effect.gen(function* () {
        const store = yield* ModelProfileStore.Service
        yield* store.create(provider("local"))

        const error = yield* store.create(provider("local", "Replacement")).pipe(Effect.flip)
        expect(error).toBeInstanceOf(ModelProfileStore.AlreadyExistsError)
        expect((yield* store.list())[0]?.displayName).toBe("local Provider")
      }),
    ),
  )

  it.live("replaces exactly one profile on update", () =>
    withStore(() =>
      Effect.gen(function* () {
        const store = yield* ModelProfileStore.Service
        const local = provider("local")
        const remote = provider("remote")
        const updated = provider("local", "Updated Local")
        yield* store.create(local)
        yield* store.create(remote)

        expect(yield* store.update(local.id, updated)).toEqual(updated)
        expect(yield* store.list()).toEqual([updated, remote])
      }),
    ),
  )

  it.live("rejects an update whose path and payload IDs differ", () =>
    withStore(() =>
      Effect.gen(function* () {
        const store = yield* ModelProfileStore.Service
        const local = provider("local")
        yield* store.create(local)

        const error = yield* store.update(local.id, provider("remote")).pipe(Effect.flip)
        expect(error).toBeInstanceOf(ModelProfileStore.IdentityMismatchError)
        expect(yield* store.list()).toEqual([local])
      }),
    ),
  )

  it.live("rejects update and remove for a missing provider ID", () =>
    withStore(() =>
      Effect.gen(function* () {
        const store = yield* ModelProfileStore.Service
        const missing = decodeProviderID("missing")

        expect(yield* store.update(missing, provider("missing")).pipe(Effect.flip)).toBeInstanceOf(
          ModelProfileStore.NotFoundError,
        )
        expect(yield* store.remove(missing).pipe(Effect.flip)).toBeInstanceOf(ModelProfileStore.NotFoundError)
      }),
    ),
  )

  it.live("deletes one profile while preserving the others", () =>
    withStore(() =>
      Effect.gen(function* () {
        const store = yield* ModelProfileStore.Service
        const alpha = provider("alpha")
        const beta = provider("beta")
        yield* store.create(alpha)
        yield* store.create(beta)

        yield* store.remove(alpha.id)
        expect(yield* store.list()).toEqual([beta])
      }),
    ),
  )

  it.live("reports malformed JSON and leaves it unchanged during mutation", () =>
    withStore((data) =>
      Effect.gen(function* () {
        const store = yield* ModelProfileStore.Service
        const content = "{ malformed"
        yield* writeDocument(data, content)

        expect(yield* store.create(provider("local")).pipe(Effect.flip)).toBeInstanceOf(ModelProfileStore.ReadError)
        expect(yield* Effect.promise(() => Bun.file(documentPath(data)).text())).toBe(content)
      }),
    ),
  )

  it.live("reports an unsupported version and leaves it unchanged during mutation", () =>
    withStore((data) =>
      Effect.gen(function* () {
        const store = yield* ModelProfileStore.Service
        const content = JSON.stringify({ version: 2, profiles: [] })
        yield* writeDocument(data, content)

        expect(yield* store.create(provider("local")).pipe(Effect.flip)).toBeInstanceOf(ModelProfileStore.ReadError)
        expect(yield* Effect.promise(() => Bun.file(documentPath(data)).text())).toBe(content)
      }),
    ),
  )

  it.live("rejects an invalid nested profile", () =>
    withStore((data) =>
      Effect.gen(function* () {
        const store = yield* ModelProfileStore.Service
        const input = provider("local")
        const content = JSON.stringify({
          version: 1,
          profiles: [
            {
              ...input,
              models: [{ ...input.models[0], contextWindow: 1_024, maxOutput: 2_048 }],
            },
          ],
        })
        yield* writeDocument(data, content)

        expect(yield* store.list().pipe(Effect.flip)).toBeInstanceOf(ModelProfileStore.ReadError)
        expect(yield* Effect.promise(() => Bun.file(documentPath(data)).text())).toBe(content)
      }),
    ),
  )

  it.live("serializes concurrent creates without dropping profiles", () =>
    withStore(() =>
      Effect.gen(function* () {
        const store = yield* ModelProfileStore.Service
        const inputs = Array.from({ length: 12 }, (_, index) =>
          provider(`provider-${index.toString().padStart(2, "0")}`),
        )

        yield* Effect.all(inputs.map(store.create), { concurrency: "unbounded" })
        expect(yield* store.list()).toEqual(inputs)
      }),
    ),
  )

  it.live("canonicalizes profiles and strips credential-like excess fields", () =>
    withStore((data) =>
      Effect.gen(function* () {
        const store = yield* ModelProfileStore.Service
        const input = provider("local")
        const unsafe = {
          ...input,
          apiKey: "provider-key-canary",
          headers: { authorization: "provider-header-canary" },
          models: [
            {
              ...input.models[0],
              token: "model-token-canary",
              capabilities: { ...input.models[0]?.capabilities, apiKey: "capability-key-canary" },
            },
          ],
        }

        expect(yield* store.create(unsafe as ModelProfile.Provider)).toEqual(input)
        const content = yield* Effect.promise(() => Bun.file(documentPath(data)).text())
        expect(JSON.parse(content)).toEqual({ version: 1, profiles: [input] })
        expect(content).not.toContain("canary")
        expect(content).not.toContain("apiKey")
        expect(content).not.toContain("headers")
        expect(content).not.toContain("token")
      }),
    ),
  )

  it.live("writes the profile document with owner-only mode on POSIX", () =>
    withStore((data) =>
      Effect.gen(function* () {
        if (process.platform === "win32") return
        const store = yield* ModelProfileStore.Service
        yield* store.create(provider("local"))

        expect((yield* Effect.promise(() => stat(documentPath(data)))).mode & 0o777).toBe(0o600)
      }),
    ),
  )
})
