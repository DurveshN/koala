import { randomUUID } from "crypto"
import path from "path"
import { ModelProfile } from "@koala-ai/core/model/profile"
import { ModelProfileDocument } from "@koala-ai/core/model/profile-document"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { Context, Effect, Layer, Schema } from "effect"

export class ReadError extends Schema.TaggedErrorClass<ReadError>()("ModelProfileStoreReadError", {}) {
  override get message() {
    return "Failed to read the model profile document"
  }
}

export class WriteError extends Schema.TaggedErrorClass<WriteError>()("ModelProfileStoreWriteError", {}) {
  override get message() {
    return "Failed to write the model profile document"
  }
}

export class AlreadyExistsError extends Schema.TaggedErrorClass<AlreadyExistsError>()(
  "ModelProfileStoreAlreadyExistsError",
  { providerID: ModelProfile.ProviderID },
) {
  override get message() {
    return `Model profile already exists: ${this.providerID}`
  }
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("ModelProfileStoreNotFoundError", {
  providerID: ModelProfile.ProviderID,
}) {
  override get message() {
    return `Model profile not found: ${this.providerID}`
  }
}

export class IdentityMismatchError extends Schema.TaggedErrorClass<IdentityMismatchError>()(
  "ModelProfileStoreIdentityMismatchError",
  {
    providerID: ModelProfile.ProviderID,
    payloadProviderID: ModelProfile.ProviderID,
  },
) {
  override get message() {
    return `Model profile identity mismatch: expected ${this.providerID}, received ${this.payloadProviderID}`
  }
}

export interface Interface {
  readonly list: () => Effect.Effect<ReadonlyArray<ModelProfile.Provider>, ReadError>
  readonly create: (
    profile: ModelProfile.Provider,
  ) => Effect.Effect<ModelProfile.Provider, ReadError | WriteError | AlreadyExistsError>
  readonly update: (
    providerID: ModelProfile.ProviderID,
    profile: ModelProfile.Provider,
  ) => Effect.Effect<ModelProfile.Provider, ReadError | WriteError | NotFoundError | IdentityMismatchError>
  readonly remove: (providerID: ModelProfile.ProviderID) => Effect.Effect<void, ReadError | WriteError | NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/KoalaModelProfileStore") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const global = yield* Global.Service
    const fs = yield* FSUtil.Service
    const flock = yield* EffectFlock.Service
    const directory = path.join(global.data, "koala")
    const filepath = path.join(directory, "model-profiles.json")
    const lockKey = `koala-model-profiles:${filepath}`
    const decodeText = Schema.decodeUnknownEffect(Schema.fromJsonString(ModelProfileDocument.Document))
    const decodeDocument = Schema.decodeUnknownEffect(ModelProfileDocument.Document)
    const encodeDocument = Schema.encodeEffect(ModelProfileDocument.Document)

    const read = Effect.fn("ModelProfileStore.read")(function* () {
      const content = yield* fs.readFileString(filepath).pipe(
        Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)),
        Effect.mapError(() => new ReadError()),
      )
      if (content === undefined) return ModelProfileDocument.empty
      return yield* decodeText(content).pipe(Effect.mapError(() => new ReadError()))
    })

    const write = Effect.fn("ModelProfileStore.write")(function* (profiles: ReadonlyArray<ModelProfile.Provider>) {
      const document = yield* decodeDocument({
        version: 1,
        profiles: profiles.toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      }).pipe(Effect.mapError(() => new WriteError()))
      const encoded = yield* encodeDocument(document).pipe(Effect.mapError(() => new WriteError()))
      const tempfile = path.join(directory, `.model-profiles.${process.pid}.${randomUUID()}.tmp`)

      yield* Effect.gen(function* () {
        yield* fs.writeFileString(tempfile, JSON.stringify(encoded, null, 2) + "\n", { flag: "wx", mode: 0o600 })
        if (process.platform !== "win32") yield* fs.chmod(tempfile, 0o600)
        yield* fs.rename(tempfile, filepath)
      }).pipe(
        Effect.mapError(() => new WriteError()),
        Effect.ensuring(fs.remove(tempfile, { force: true }).pipe(Effect.ignore)),
      )

      return document
    })

    const mutate = <A, E>(
      change: (
        profiles: ReadonlyArray<ModelProfile.Provider>,
      ) => Effect.Effect<{ readonly profiles: ReadonlyArray<ModelProfile.Provider>; readonly result: A }, E>,
    ) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* flock.acquire(lockKey, directory).pipe(Effect.mapError(() => new WriteError()))
          const next = yield* change((yield* read()).profiles)
          const document = yield* write(next.profiles)
          return { document, result: next.result }
        }),
      )

    const list = Effect.fn("ModelProfileStore.list")(function* () {
      return (yield* read()).profiles
    })

    const create = Effect.fn("ModelProfileStore.create")(function* (profile: ModelProfile.Provider) {
      const result = yield* mutate((profiles) =>
        Effect.gen(function* () {
          if (profiles.some((item) => item.id === profile.id)) {
            return yield* Effect.fail(new AlreadyExistsError({ providerID: profile.id }))
          }
          return { profiles: [...profiles, profile], result: profile.id }
        }),
      )
      return result.document.profiles.find((item) => item.id === result.result)!
    })

    const update = Effect.fn("ModelProfileStore.update")(function* (
      providerID: ModelProfile.ProviderID,
      profile: ModelProfile.Provider,
    ) {
      const result = yield* mutate((profiles) =>
        Effect.gen(function* () {
          if (providerID !== profile.id) {
            return yield* Effect.fail(new IdentityMismatchError({ providerID, payloadProviderID: profile.id }))
          }
          if (!profiles.some((item) => item.id === providerID)) {
            return yield* Effect.fail(new NotFoundError({ providerID }))
          }
          return {
            profiles: profiles.map((item) => (item.id === providerID ? profile : item)),
            result: providerID,
          }
        }),
      )
      return result.document.profiles.find((item) => item.id === result.result)!
    })

    const remove = Effect.fn("ModelProfileStore.remove")(function* (providerID: ModelProfile.ProviderID) {
      yield* mutate((profiles) =>
        Effect.gen(function* () {
          if (!profiles.some((item) => item.id === providerID)) {
            return yield* Effect.fail(new NotFoundError({ providerID }))
          }
          return { profiles: profiles.filter((item) => item.id !== providerID), result: undefined }
        }),
      )
    })

    return Service.of({ list, create, update, remove })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Global.node, FSUtil.node, EffectFlock.node],
})

export * as ModelProfileStore from "./model-profile-store"
