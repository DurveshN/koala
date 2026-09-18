import { ModelProfile } from "@koala-ai/core/model/profile"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { EffectBridge } from "@/effect/bridge"
import { ModelCapabilityProbe } from "@/koala/model-capability-probe"
import { ModelDiscovery } from "@/koala/model-discovery"
import { ModelProfileStore } from "@/koala/model-profile-store"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"
import { RootHttpApi } from "../api"
import {
  ConflictError,
  InvalidRequestError,
  ProviderNotFoundError,
  TimeoutError,
  UnknownError,
  UpstreamError,
} from "../errors"

export const modelProfileHandlers = HttpApiBuilder.group(RootHttpApi, "modelProfile", (handlers) =>
  Effect.gen(function* () {
    const store = yield* ModelProfileStore.Service
    const discovery = yield* ModelDiscovery.Service
    const capabilityProbe = yield* ModelCapabilityProbe.Service
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

    const discover = Effect.fn("ModelProfileHttpApi.discover")(function* (ctx: { payload: ModelDiscovery.Input }) {
      return yield* discovery.discover(ctx.payload).pipe(Effect.mapError(discoveryError))
    })

    const probe = Effect.fn("ModelProfileHttpApi.probe")(function* (ctx: { payload: ModelCapabilityProbe.Input }) {
      return yield* capabilityProbe.probe(ctx.payload).pipe(Effect.mapError(capabilityProbeError))
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

    return handlers
      .handle("list", list)
      .handle("create", create)
      .handle("discover", discover)
      .handle("probe", probe)
      .handle("update", update)
      .handle("remove", remove)
  }),
)

function repositoryError() {
  return new UnknownError({ message: "Failed to access the model profile repository" })
}

function discoveryError(error: ModelDiscovery.Error) {
  if (error instanceof ModelDiscovery.InvalidInputError) {
    return new InvalidRequestError({ message: error.message })
  }
  if (error instanceof ModelDiscovery.TimeoutError) {
    return new TimeoutError({ message: error.message, operation: "model discovery" })
  }
  if (
    error instanceof ModelDiscovery.EndpointError ||
    error instanceof ModelDiscovery.MalformedResponseError ||
    error instanceof ModelDiscovery.TooLargeError
  ) {
    return new UpstreamError({
      message: error.message,
      service: "model discovery",
      ...(error instanceof ModelDiscovery.EndpointError && error.status !== undefined && { status: error.status }),
    })
  }
  return new UnknownError({ message: error.message })
}

function capabilityProbeError(error: ModelCapabilityProbe.Error) {
  if (error instanceof ModelCapabilityProbe.InvalidInputError) {
    return new InvalidRequestError({ message: error.message, kind: error.reason })
  }
  return new UnknownError({ message: "Failed to probe model capabilities" })
}
