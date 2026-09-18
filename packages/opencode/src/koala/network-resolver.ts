import { lookup } from "node:dns/promises"
import { isIP } from "node:net"
import { EndpointPolicy } from "@koala-ai/core/network/endpoint-policy"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Context, Effect, Layer, Schema } from "effect"
import type { Duration } from "effect"

const defaultTimeout = "5 seconds"
const defaultMaxAddresses = 32

export const ResolutionRule = Schema.Literals(["lookup-failed", "lookup-timeout", "invalid-result", "answer-limit"])
export type ResolutionRule = typeof ResolutionRule.Type

const messages: Record<ResolutionRule, string> = {
  "lookup-failed": "Model endpoint DNS resolution failed",
  "lookup-timeout": "Model endpoint DNS resolution timed out",
  "invalid-result": "Model endpoint DNS resolution returned an invalid address",
  "answer-limit": "Model endpoint DNS resolution returned too many addresses",
}

export class ResolutionError extends Schema.TaggedErrorClass<ResolutionError>()("KoalaNetworkResolutionError", {
  rule: ResolutionRule,
}) {
  override get message() {
    return messages[this.rule]
  }
}

export interface Interface {
  readonly resolve: (hostname: string) => Effect.Effect<ReadonlyArray<EndpointPolicy.ResolvedAddress>, ResolutionError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/KoalaNetworkResolver") {}

export interface LayerOptions {
  readonly lookup?: (hostname: string) => PromiseLike<unknown>
  readonly timeout?: Duration.Input
  readonly maxAddresses?: number
}

export const layerWith = (options: LayerOptions = {}) =>
  Layer.succeed(
    Service,
    Service.of({
      resolve: Effect.fn("NetworkResolver.resolve")((hostname: string) =>
        Effect.tryPromise({
          try: () => (options.lookup ? options.lookup(hostname) : lookup(hostname, { all: true, order: "verbatim" })),
          catch: () => new ResolutionError({ rule: "lookup-failed" }),
        }).pipe(
          Effect.flatMap((addresses) => {
            if (!Array.isArray(addresses)) return new ResolutionError({ rule: "invalid-result" })
            if (addresses.length > (options.maxAddresses ?? defaultMaxAddresses)) {
              return new ResolutionError({ rule: "answer-limit" })
            }
            if (!addresses.every(isResolvedAddress)) {
              return new ResolutionError({ rule: "invalid-result" })
            }
            return Effect.succeed(addresses.map((item) => ({ address: item.address, family: item.family })))
          }),
          Effect.timeoutOrElse({
            duration: options.timeout ?? defaultTimeout,
            orElse: () => new ResolutionError({ rule: "lookup-timeout" }),
          }),
        ),
      ),
    }),
  )

export const layer = layerWith()

export const node = LayerNode.make({ service: Service, layer, deps: [] })

function isResolvedAddress(input: unknown): input is EndpointPolicy.ResolvedAddress {
  return (
    typeof input === "object" &&
    input !== null &&
    "address" in input &&
    "family" in input &&
    typeof input.address === "string" &&
    typeof input.family === "number" &&
    isIP(input.address) === input.family
  )
}

export * as NetworkResolver from "./network-resolver"
