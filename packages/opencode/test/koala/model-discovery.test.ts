import http from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import { networkInterfaces } from "node:os"
import { describe, expect } from "bun:test"
import { EndpointPolicy } from "@koala-ai/core/network/endpoint-policy"
import { ModelProfile } from "@koala-ai/core/model/profile"
import { Effect, Layer, Redacted, Schema } from "effect"
import { Auth } from "../../src/auth"
import { ModelDiscovery } from "../../src/koala/model-discovery"
import { ModelEndpointClient } from "../../src/koala/model-endpoint-client"
import { NetworkResolver } from "../../src/koala/network-resolver"
import { it } from "../lib/effect"

const providerID = Schema.decodeUnknownSync(ModelProfile.ProviderID)("local-test")
const decodeBaseURL = Schema.decodeUnknownSync(ModelProfile.BaseURL)

function input(baseURL: string, apiKey?: string): ModelDiscovery.Input {
  return {
    providerID,
    baseURL: decodeBaseURL(baseURL),
    ...(apiKey !== undefined && { apiKey: Redacted.make(apiKey, { label: "API key" }) }),
  }
}

function authLayer(info?: Auth.Info, onGet?: () => void) {
  return Layer.mock(Auth.Service, {
    get: () =>
      Effect.sync(() => {
        onGet?.()
        return info
      }),
  })
}

function liveLayer(
  info: Auth.Info | undefined,
  lookup: (hostname: string) => PromiseLike<ReadonlyArray<EndpointPolicy.ResolvedAddress>>,
  onGet?: () => void,
) {
  return ModelDiscovery.layer.pipe(
    Layer.provide(ModelEndpointClient.layer.pipe(Layer.provide(NetworkResolver.layerWith({ lookup })))),
    Layer.provide(authLayer(info, onGet)),
  )
}

function responseLayer(response: () => Response, info?: Auth.Info) {
  return ModelDiscovery.layer.pipe(
    Layer.provide(
      Layer.mock(ModelEndpointClient.Service, {
        bind: (options) =>
          Effect.succeed({
            ...options,
            fetch: (_input, init) => {
              if (init?.signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"))
              return Promise.resolve(response())
            },
          }),
      }),
    ),
    Layer.provide(authLayer(info)),
  )
}

function discover(baseURL: string, layer: Layer.Layer<ModelDiscovery.Service>, apiKey?: string) {
  return ModelDiscovery.Service.use((service) => service.discover(input(baseURL, apiKey))).pipe(Effect.provide(layer))
}

function withServer<A, E, R>(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  use: (port: number) => Effect.Effect<A, E, R>,
  hostname = "127.0.0.1",
) {
  return Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () =>
        new Promise<http.Server>((resolve, reject) => {
          const server = http.createServer(handler)
          server.once("error", reject)
          server.listen(0, hostname, () => resolve(server))
        }),
      catch: (cause) => cause,
    }),
    (server) => {
      const address = server.address()
      if (!address || typeof address === "string") return Effect.die("Expected a TCP server address")
      return use(address.port)
    },
    (server) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            server.closeAllConnections()
            server.close(() => resolve())
          }),
      ),
  )
}

describe("ModelDiscovery", () => {
  it.live("uses a transient key first and normalizes models in first-seen order", () => {
    let authReads = 0
    return withServer(
      (request, response) => {
        expect(request.url).toBe("/v1/models")
        expect(request.headers.authorization).toBe("Bearer transient-secret-canary")
        response.setHeader("content-type", "application/json")
        response.end(
          JSON.stringify({
            ignored: true,
            data: [{ id: " beta ", ignored: "field" }, { id: "alpha" }, { id: "beta" }, { id: "ALPHA" }],
          }),
        )
      },
      (port) =>
        Effect.gen(function* () {
          const result = yield* discover(
            `http://model.internal:${port}/v1///`,
            liveLayer(
              new Auth.Oauth({ type: "oauth", refresh: "stored-refresh", access: "stored-access", expires: 0 }),
              () => Promise.resolve([{ address: "127.0.0.1", family: 4 }]),
              () => authReads++,
            ),
            "transient-secret-canary",
          )
          expect(result).toEqual({ models: [{ id: "beta" }, { id: "alpha" }, { id: "ALPHA" }], duplicateCount: 1 })
          expect(authReads).toBe(0)
        }),
    )
  })

  it.live("uses stored API auth and otherwise requests anonymously", () => {
    const headers: Array<string | undefined> = []
    return withServer(
      (request, response) => {
        headers.push(request.headers.authorization)
        response.setHeader("content-type", "application/json")
        response.end('{"data":[{"id":"model"}]}')
      },
      (port) =>
        Effect.gen(function* () {
          const lookup = () => Promise.resolve([{ address: "127.0.0.1", family: 4 }] as const)
          yield* discover(
            `http://model.internal:${port}/v1`,
            liveLayer(new Auth.Api({ type: "api", key: "stored-secret-canary" }), lookup),
          )
          yield* discover(`http://model.internal:${port}/v1`, liveLayer(undefined, lookup))
          expect(headers).toEqual(["Bearer stored-secret-canary", undefined])
        }),
    )
  })

  it.live("rejects unsupported stored auth and roots already ending in models", () =>
    Effect.gen(function* () {
      const unsupported = yield* discover(
        "http://127.0.0.1:49152/v1",
        responseLayer(
          () => Response.json({ data: [] }),
          new Auth.WellKnown({ type: "wellknown", key: "stored-key", token: "stored-token-canary" }),
        ),
      ).pipe(Effect.flip)
      const modelsRoot = yield* discover(
        "http://127.0.0.1:49152/v1/models///",
        responseLayer(() => Response.json({ data: [] })),
      ).pipe(Effect.flip)

      expect(unsupported).toBeInstanceOf(ModelDiscovery.InvalidInputError)
      expect(modelsRoot).toBeInstanceOf(ModelDiscovery.InvalidInputError)
      expect(`${unsupported.message} ${modelsRoot.message}`).not.toContain("canary")
    }),
  )

  it.live("maps authentication read failures without exposing their cause", () => {
    const layer = ModelDiscovery.layer.pipe(
      Layer.provide(
        Layer.mock(ModelEndpointClient.Service, {
          bind: (options) => Effect.succeed({ ...options, fetch: () => Promise.resolve(Response.json({ data: [] })) }),
        }),
      ),
      Layer.provide(
        Layer.mock(Auth.Service, {
          get: () =>
            Effect.fail(new Auth.AuthError({ message: "auth-secret-canary", cause: "auth-cause-secret-canary" })),
        }),
      ),
    )

    return Effect.gen(function* () {
      const error = yield* discover("http://127.0.0.1:49152/v1", layer).pipe(Effect.flip)
      expect(error).toBeInstanceOf(ModelDiscovery.InternalError)
      expect(error.message).not.toContain("secret-canary")
    })
  })

  it.live("rejects invalid JSON, envelopes, and model IDs without exposing response data", () =>
    Effect.gen(function* () {
      const cases = [
        ["not-json-secret-canary", "invalid-json"],
        [JSON.stringify({ models: [] }), "invalid-envelope"],
        [JSON.stringify({ data: [{ id: "   " }] }), "invalid-model-id"],
        [JSON.stringify({ data: [{ id: "model\nsecret-canary" }] }), "invalid-model-id"],
        [JSON.stringify({ data: [{ id: "x".repeat(513) }] }), "invalid-model-id"],
      ] as const

      const errors = yield* Effect.forEach(cases, ([body]) =>
        discover(
          "http://127.0.0.1:49152/v1",
          responseLayer(() => new Response(body, { headers: { "content-type": "application/json" } })),
        ).pipe(Effect.flip),
      )
      expect(
        errors.map((error) =>
          error instanceof ModelDiscovery.MalformedResponseError ? error.reason : "unexpected-error",
        ),
      ).toEqual(cases.map((entry) => entry[1]))
      expect(errors.map((error) => error.message).join(" ")).not.toContain("secret-canary")
    }),
  )

  it.live("bounds response bytes and entry count", () =>
    Effect.gen(function* () {
      const body = yield* discover(
        "http://127.0.0.1:49152/v1",
        responseLayer(() => new Response("x".repeat(1024 * 1024 + 1))),
      ).pipe(Effect.flip)
      const entries = yield* discover(
        "http://127.0.0.1:49152/v1",
        responseLayer(() =>
          Response.json({ data: Array.from({ length: 10_001 }, (_, index) => ({ id: `m${index}` })) }),
        ),
      ).pipe(Effect.flip)

      expect(body).toEqual(new ModelDiscovery.TooLargeError({ limit: "body" }))
      expect(entries).toEqual(new ModelDiscovery.TooLargeError({ limit: "entries" }))
    }),
  )

  it.live(
    "applies one five-second timeout and aborts the request",
    () => {
      let aborted = false
      const layer = ModelDiscovery.layer.pipe(
        Layer.provide(
          Layer.mock(ModelEndpointClient.Service, {
            bind: (options) =>
              Effect.succeed({
                ...options,
                fetch: (_input, init) =>
                  new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener(
                      "abort",
                      () => {
                        aborted = true
                        reject(new DOMException("timeout-secret-canary", "AbortError"))
                      },
                      { once: true },
                    )
                  }),
              }),
          }),
        ),
        Layer.provide(authLayer()),
      )

      return Effect.gen(function* () {
        const error = yield* discover("http://127.0.0.1:49152/v1", layer).pipe(Effect.flip)
        expect(error).toBeInstanceOf(ModelDiscovery.TimeoutError)
        expect(error.message).not.toContain("secret-canary")
        expect(aborted).toBe(true)
      })
    },
    10_000,
  )

  it.live("denies redirects and public DNS answers without exposing endpoint details", () => {
    let redirectRequests = 0
    return withServer(
      (_request, response) => {
        redirectRequests++
        response.writeHead(302, { location: "/v1/target?token=redirect-secret-canary" })
        response.end()
      },
      (port) =>
        Effect.gen(function* () {
          const redirect = yield* discover(
            `http://redirect-secret.internal:${port}/v1`,
            liveLayer(undefined, () => Promise.resolve([{ address: "127.0.0.1", family: 4 }])),
          ).pipe(Effect.flip)
          const publicAddress = yield* discover(
            "http://public-secret.internal:49152/v1",
            liveLayer(undefined, () => Promise.resolve([{ address: "8.8.8.8", family: 4 }])),
          ).pipe(Effect.flip)
          const transport = yield* discover(
            "http://transport-secret.internal:49152/v1",
            liveLayer(undefined, () => Promise.reject(new Error("transport-exception-secret-canary"))),
          ).pipe(Effect.flip)

          expect(redirect).toBeInstanceOf(ModelDiscovery.EndpointError)
          expect(publicAddress).toBeInstanceOf(ModelDiscovery.EndpointError)
          expect(transport).toBeInstanceOf(ModelDiscovery.EndpointError)
          expect(`${redirect.message} ${publicAddress.message} ${transport.message}`).not.toContain("secret")
          expect(redirectRequests).toBe(1)
        }),
    )
  })

  it.live("allows discovery through an available private interface", () => {
    const address = Object.values(networkInterfaces())
      .flatMap((entries) => entries ?? [])
      .find((entry) => {
        const result = EndpointPolicy.classifyAddress({
          address: entry.address,
          family: entry.family === "IPv4" ? 4 : 6,
        })
        return result.ok && result.value.classification === "private"
      })
    if (!address) return Effect.void

    return withServer(
      (_request, response) => {
        response.setHeader("content-type", "application/json")
        response.end('{"data":[{"id":"private-model"}]}')
      },
      (port) =>
        Effect.gen(function* () {
          const result = yield* discover(
            `http://model.internal:${port}/v1`,
            liveLayer(undefined, () =>
              Promise.resolve([{ address: address.address, family: address.family === "IPv4" ? 4 : 6 }]),
            ),
          )
          expect(result.models).toEqual([{ id: "private-model" }])
        }),
      address.address,
    )
  })
})
