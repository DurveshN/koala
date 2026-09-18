import { ModelProfile } from "@koala-ai/core/model/profile"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { collectBoundedResponseBody } from "@opencode-ai/core/tool/http-body"
import { Context, Effect, Layer, Redacted, Schema } from "effect"
import { HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { Auth } from "../auth"
import { ModelEndpointClient } from "./model-endpoint-client"

const maximumBodyBytes = 1024 * 1024
const maximumEntries = 10_000
const maximumIDLength = 512
const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/

export const ApiKey = Schema.Redacted(Schema.String.check(Schema.isNonEmpty()), {
  label: "API key",
  disallowJsonEncode: true,
})

export interface Input extends Schema.Schema.Type<typeof Input> {}
export const Input = Schema.Struct({
  providerID: ModelProfile.ProviderID,
  baseURL: ModelProfile.BaseURL,
  apiKey: Schema.optional(ApiKey),
}).annotate({ identifier: "ModelDiscoveryInput" })

export interface Model extends Schema.Schema.Type<typeof Model> {}
export const Model = Schema.Struct({ id: Schema.String }).annotate({ identifier: "DiscoveredModel" })

export interface Result extends Schema.Schema.Type<typeof Result> {}
export const Result = Schema.Struct({
  models: Schema.Array(Model),
  duplicateCount: NonNegativeInt,
}).annotate({ identifier: "ModelDiscoveryResult" })

const Envelope = Schema.Struct({
  data: Schema.Array(Schema.Struct({ id: Schema.String })),
})

export class InvalidInputError extends Schema.TaggedErrorClass<InvalidInputError>()("ModelDiscoveryInvalidInputError", {
  reason: Schema.Literals(["invalid-endpoint", "models-endpoint", "unsupported-auth"]),
}) {
  override get message() {
    return "Invalid model discovery input"
  }
}

export class EndpointError extends Schema.TaggedErrorClass<EndpointError>()("ModelDiscoveryEndpointError", {
  status: Schema.optional(Schema.Int),
}) {
  override get message() {
    return "Model discovery endpoint request failed"
  }
}

export class TimeoutError extends Schema.TaggedErrorClass<TimeoutError>()("ModelDiscoveryTimeoutError", {}) {
  override get message() {
    return "Model discovery request timed out"
  }
}

export class MalformedResponseError extends Schema.TaggedErrorClass<MalformedResponseError>()(
  "ModelDiscoveryMalformedResponseError",
  { reason: Schema.Literals(["invalid-json", "invalid-envelope", "invalid-model-id"]) },
) {
  override get message() {
    return "Model discovery returned a malformed response"
  }
}

export class TooLargeError extends Schema.TaggedErrorClass<TooLargeError>()("ModelDiscoveryTooLargeError", {
  limit: Schema.Literals(["body", "entries"]),
}) {
  override get message() {
    return "Model discovery response exceeded its limit"
  }
}

export class InternalError extends Schema.TaggedErrorClass<InternalError>()("ModelDiscoveryInternalError", {}) {
  override get message() {
    return "Model discovery could not read authentication"
  }
}

export type Error =
  | InvalidInputError
  | EndpointError
  | TimeoutError
  | MalformedResponseError
  | TooLargeError
  | InternalError

export interface Interface {
  readonly discover: (input: Input) => Effect.Effect<Result, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/KoalaModelDiscovery") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const endpointClient = yield* ModelEndpointClient.Service
    const auth = yield* Auth.Service
    const decodeJson = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)
    const decodeEnvelope = Schema.decodeUnknownEffect(Envelope)

    const run = Effect.fn("ModelDiscovery.run")(function* (input: Input) {
      const client = yield* endpointClient
        .bind({ providerID: input.providerID, baseURL: input.baseURL })
        .pipe(Effect.mapError(() => new InvalidInputError({ reason: "invalid-endpoint" })))
      const url = new URL(client.baseURL)
      const root = url.pathname.replace(/\/+$/, "")
      if (root.endsWith("/models")) return yield* new InvalidInputError({ reason: "models-endpoint" })
      url.pathname = `${root}/models`

      const key = input.apiKey
        ? Redacted.value(input.apiKey)
        : yield* auth.get(input.providerID).pipe(
            Effect.mapError(() => new InternalError()),
            Effect.flatMap((stored) => {
              if (!stored) return Effect.succeed(undefined)
              if (stored.type !== "api") return new InvalidInputError({ reason: "unsupported-auth" })
              return Effect.succeed(stored.key)
            }),
          )
      const response = yield* Effect.tryPromise({
        try: (signal) =>
          client.fetch(url, {
            signal,
            ...(key !== undefined && { headers: { authorization: `Bearer ${key}` } }),
          }),
        catch: () => new EndpointError(),
      })
      if (!response.ok) return yield* new EndpointError({ status: response.status })

      const body = yield* collectBoundedResponseBody(
        HttpClientResponse.fromWeb(HttpClientRequest.get(url), response),
        maximumBodyBytes,
        () => new TooLargeError({ limit: "body" }),
      ).pipe(Effect.mapError((error) => (error instanceof TooLargeError ? error : new EndpointError())))
      const text = yield* Effect.try({
        try: () => new TextDecoder("utf-8", { fatal: true }).decode(body),
        catch: () => new MalformedResponseError({ reason: "invalid-json" }),
      })
      const json = yield* decodeJson(text).pipe(
        Effect.mapError(() => new MalformedResponseError({ reason: "invalid-json" })),
      )
      const envelope = yield* decodeEnvelope(json).pipe(
        Effect.mapError(() => new MalformedResponseError({ reason: "invalid-envelope" })),
      )
      if (envelope.data.length > maximumEntries) return yield* new TooLargeError({ limit: "entries" })

      const models: Model[] = []
      const seen = new Set<string>()
      let duplicateCount = 0
      for (const entry of envelope.data) {
        const id = entry.id.trim()
        if (!id || id.length > maximumIDLength || controlCharacters.test(entry.id)) {
          return yield* new MalformedResponseError({ reason: "invalid-model-id" })
        }
        if (seen.has(id)) {
          duplicateCount++
          continue
        }
        seen.add(id)
        models.push({ id })
      }
      return { models, duplicateCount }
    })

    const discover = Effect.fn("ModelDiscovery.discover")(function* (input: Input) {
      return yield* run(input).pipe(
        Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.fail(new TimeoutError()) }),
      )
    })

    return Service.of({ discover })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [ModelEndpointClient.node, Auth.node],
})

export * as ModelDiscovery from "./model-discovery"
