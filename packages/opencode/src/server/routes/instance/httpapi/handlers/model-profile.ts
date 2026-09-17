import { ModelProfile } from "@koala-ai/core/model/profile"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { EffectBridge } from "@/effect/bridge"
import { ModelProfileStore } from "@/koala/model-profile-store"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"
import { RootHttpApi } from "../api"
import { ConflictError, InvalidRequestError, ProviderNotFoundError, UnknownError } from "../errors"

export const modelProfileHandlers = HttpApiBuilder.group(RootHttpApi, "modelProfile", (handlers) =>
  Effect.gen(function* () {
    const store = yield* ModelProfileStore.Service
    const bridge = yield* EffectBridge.make()
    const dispose = () => bridge.fork(disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true }))

    const list = Effect.fn("ModelProfileHttpApi.list")(function* () {
      return yield* store.list().pipe(Effect.mapError(repositoryError))
    })

    const create = Effect.fn("ModelProfileHttpApi.create")(function* (ctx: { payload: ModelProfile.Provider }) {
      const profile = yield* store
        .create(ctx.payload)
        .pipe(
          Effect.mapError((error) =>
            error instanceof ModelProfileStore.AlreadyExistsError
              ? new ConflictError({ message: error.message, resource: String(error.providerID) })
              : repositoryError(),
          ),
        )
      dispose()
      return profile
    })

    const update = Effect.fn("ModelProfileHttpApi.update")(function* (ctx: {
      params: { providerID: ModelProfile.ProviderID }
      payload: ModelProfile.Provider
    }) {
      const profile = yield* store.update(ctx.params.providerID, ctx.payload).pipe(
        Effect.mapError((error) => {
          if (error instanceof ModelProfileStore.IdentityMismatchError) {
            return new InvalidRequestError({ message: error.message, field: "id" })
          }
          if (error instanceof ModelProfileStore.NotFoundError) {
            return new ProviderNotFoundError({ providerID: String(error.providerID), message: error.message })
          }
          return repositoryError()
        }),
      )
      dispose()
      return profile
    })

    const remove = Effect.fn("ModelProfileHttpApi.delete")(function* (ctx: {
      params: { providerID: ModelProfile.ProviderID }
    }) {
      yield* store
        .remove(ctx.params.providerID)
        .pipe(
          Effect.mapError((error) =>
            error instanceof ModelProfileStore.NotFoundError
              ? new ProviderNotFoundError({ providerID: String(error.providerID), message: error.message })
              : repositoryError(),
          ),
        )
      dispose()
      return true
    })

    return handlers.handle("list", list).handle("create", create).handle("update", update).handle("remove", remove)
  }),
)

function repositoryError() {
  return new UnknownError({ message: "Failed to access the model profile repository" })
}
