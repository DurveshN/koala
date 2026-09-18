import { describe, expect } from "bun:test"
import http from "node:http"
import { networkInterfaces } from "node:os"
import type { IncomingMessage, ServerResponse } from "node:http"
import { EndpointPolicy } from "@koala-ai/core/network/endpoint-policy"
import { ModelProfile } from "@koala-ai/core/model/profile"
import { Effect, Layer, Schema } from "effect"
import { ModelEndpointClient } from "../../src/koala/model-endpoint-client"
import { NetworkResolver } from "../../src/koala/network-resolver"
import { it } from "../lib/effect"

const providerID = Schema.decodeUnknownSync(ModelProfile.ProviderID)("local-test")
const decodeBaseURL = Schema.decodeUnknownSync(ModelProfile.BaseURL)

function clientLayer(lookup: (hostname: string) => PromiseLike<ReadonlyArray<EndpointPolicy.ResolvedAddress>>) {
  return ModelEndpointClient.layer.pipe(Layer.provide(NetworkResolver.layerWith({ lookup })))
}

const bind = (client: ModelEndpointClient.Interface, baseURL: string) =>
  client.bind({ providerID, baseURL: decodeBaseURL(baseURL) })

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

const readBody = (request: IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    const chunks: Uint8Array[] = []
    request.on("data", (chunk: Uint8Array) => chunks.push(chunk))
    request.once("end", () => resolve(Buffer.concat(chunks).toString()))
    request.once("error", reject)
  })

describe("ModelEndpointClient", () => {
  it.live("preserves method, safe headers, JSON body, query, and original Host", () => {
    const calls: string[] = []
    return withServer(
      (request, response) => {
        void readBody(request).then((body) => {
          response.setHeader("content-type", "application/json")
          response.end(
            JSON.stringify({ method: request.method, host: request.headers.host, body, token: request.headers.token }),
          )
        })
      },
      (port) =>
        Effect.gen(function* () {
          const factory = yield* ModelEndpointClient.Service
          const client = yield* bind(factory, `http://model.internal:${port}/v1`)
          const response = yield* Effect.promise(() =>
            client.fetch(`http://model.internal:${port}/v1/chat?mode=stream`, {
              method: "POST",
              headers: { "content-type": "application/json", token: "safe-header" },
              body: JSON.stringify({ message: "hello" }),
            }),
          )

          expect(response.status).toBe(200)
          expect(yield* Effect.promise(() => response.json())).toEqual({
            method: "POST",
            host: `model.internal:${port}`,
            body: '{"message":"hello"}',
            token: "safe-header",
          })
          expect(calls).toEqual(["model.internal"])
        }).pipe(
          Effect.provide(
            clientLayer((hostname) => {
              calls.push(hostname)
              return Promise.resolve([{ address: "127.0.0.1", family: 4 }])
            }),
          ),
        ),
    )
  })

  it.live("authorizes literal endpoints without DNS", () =>
    withServer(
      (_request, response) => response.end("literal-ok"),
      (port) =>
        Effect.gen(function* () {
          const factory = yield* ModelEndpointClient.Service
          const client = yield* bind(factory, `http://127.0.0.1:${port}/v1`)
          const response = yield* Effect.promise(() => client.fetch(`http://127.0.0.1:${port}/v1/models`))
          expect(yield* Effect.promise(() => response.text())).toBe("literal-ok")
        }).pipe(Effect.provide(clientLayer(() => Promise.reject(new Error("DNS must not run"))))),
    ),
  )

  it.live("checks DNS for every connection", () => {
    const calls: string[] = []
    return withServer(
      (_request, response) => response.end("ok"),
      (port) =>
        Effect.gen(function* () {
          const factory = yield* ModelEndpointClient.Service
          const client = yield* bind(factory, `http://model.internal:${port}/v1`)
          yield* Effect.promise(() =>
            client.fetch(`http://model.internal:${port}/v1/first`).then((response) => response.text()),
          )
          yield* Effect.promise(() =>
            client.fetch(`http://model.internal:${port}/v1/second`).then((response) => response.text()),
          )
          expect(calls).toEqual(["model.internal", "model.internal"])
        }).pipe(
          Effect.provide(
            clientLayer((hostname) => {
              calls.push(hostname)
              return Promise.resolve([{ address: "127.0.0.1", family: 4 }])
            }),
          ),
        ),
    )
  })

  it.live("allows a private interface address when one is available", () => {
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
      (_request, response) => response.end("private-ok"),
      (port) =>
        Effect.gen(function* () {
          const factory = yield* ModelEndpointClient.Service
          const client = yield* bind(factory, `http://model.internal:${port}/v1`)
          const response = yield* Effect.promise(() => client.fetch(`http://model.internal:${port}/v1/models`))
          expect(yield* Effect.promise(() => response.text())).toBe("private-ok")
        }).pipe(
          Effect.provide(
            clientLayer(() =>
              Promise.resolve([{ address: address.address, family: address.family === "IPv4" ? 4 : 6 }]),
            ),
          ),
        ),
      address.address,
    )
  })

  it.live("denies mixed, public, and metadata DNS answers before connecting", () => {
    let requests = 0
    const resolutions: Readonly<Record<string, ReadonlyArray<EndpointPolicy.ResolvedAddress>>> = {
      "mixed.internal": [
        { address: "127.0.0.1", family: 4 },
        { address: "8.8.8.8", family: 4 },
      ],
      "public.internal": [{ address: "8.8.8.8", family: 4 }],
      "metadata.internal": [{ address: "169.254.169.254", family: 4 }],
    }
    return withServer(
      (_request, response) => {
        requests++
        response.end("unexpected")
      },
      (port) =>
        Effect.gen(function* () {
          const factory = yield* ModelEndpointClient.Service
          yield* Effect.forEach(
            [
              ["mixed.internal", "mixed-resolution"],
              ["public.internal", "public-address"],
              ["metadata.internal", "metadata-address"],
            ] as const,
            ([hostname, rule]) =>
              Effect.gen(function* () {
                const client = yield* bind(factory, `http://${hostname}:${port}/v1`)
                yield* Effect.promise(async () => {
                  const error = await client.fetch(`http://${hostname}:${port}/v1/models`).catch((cause) => cause)
                  expect(error).toBeInstanceOf(ModelEndpointClient.PolicyError)
                  expect(error.rule).toBe(rule)
                })
              }),
          )
          expect(requests).toBe(0)
        }).pipe(Effect.provide(clientLayer((hostname) => Promise.resolve(resolutions[hostname] ?? [])))),
    )
  })

  it.live("rejects redirects without following or exposing Location", () => {
    let targetCalls = 0
    return withServer(
      (request, response) => {
        if (request.url === "/v1/target") {
          targetCalls++
          response.end("followed")
          return
        }
        response.writeHead(302, { location: "/v1/target?token=location-secret-canary" })
        response.end()
      },
      (port) =>
        Effect.gen(function* () {
          const factory = yield* ModelEndpointClient.Service
          const client = yield* bind(factory, `http://model.internal:${port}/v1`)
          yield* Effect.promise(async () => {
            const error = await client.fetch(`http://model.internal:${port}/v1/redirect`).catch((cause) => cause)
            expect(error).toBeInstanceOf(ModelEndpointClient.RedirectError)
            expect(error.status).toBe(302)
            expect(error.message).not.toContain("location-secret-canary")
            expect(targetCalls).toBe(0)
          })
        }).pipe(Effect.provide(clientLayer(() => Promise.resolve([{ address: "127.0.0.1", family: 4 }])))),
    )
  })

  it.live("denies out-of-scope requests, unsafe headers, and transport overrides", () =>
    Effect.gen(function* () {
      const factory = yield* ModelEndpointClient.Service
      const client = yield* bind(factory, "http://model.internal:49152/v1")
      yield* Effect.promise(async () => {
        const proxyInit: RequestInit = {}
        Object.defineProperty(proxyInit, "proxy", { value: "http://escape.internal" })
        const cases = [
          client.fetch("http://model.internal:49152/outside?token=query-secret-canary"),
          client.fetch("http://other.internal:49152/v1/models"),
          client.fetch("http://user:credential-secret-canary@model.internal:49152/v1/models"),
          client.fetch("http://model.internal:49152/v1/models", { headers: { Host: "escape.internal" } }),
          client.fetch("http://model.internal:49152/v1/models", {
            headers: { "Proxy-Authorization": "proxy-secret-canary" },
          }),
          client.fetch("http://model.internal:49152/v1/models", proxyInit),
        ]
        const errors = await Promise.all(cases.map((request) => request.catch((cause) => cause)))
        expect(errors.every((error) => error instanceof ModelEndpointClient.PolicyError)).toBe(true)
        expect(errors.map((error) => error.rule)).toEqual([
          "request-path-mismatch",
          "request-origin-mismatch",
          "credentials-not-allowed",
          "unsafe-header",
          "unsafe-header",
          "transport-override",
        ])
        expect(errors.map((error) => error.message).join(" ")).not.toContain("secret-canary")
        expect(errors.map((error) => error.message).join(" ")).not.toContain("escape.internal")
      })
    }).pipe(Effect.provide(clientLayer(() => Promise.resolve([{ address: "127.0.0.1", family: 4 }])))),
  )

  it.live("propagates abort as a standard AbortError", () => {
    let abort = () => {}
    return withServer(
      (_request, _response) => abort(),
      (port) =>
        Effect.gen(function* () {
          const factory = yield* ModelEndpointClient.Service
          const client = yield* bind(factory, `http://model.internal:${port}/v1`)
          yield* Effect.promise(async () => {
            const controller = new AbortController()
            abort = () => controller.abort("abort-secret-canary")
            const pending = client.fetch(`http://model.internal:${port}/v1/hang`, { signal: controller.signal })
            const error = await pending.catch((cause) => cause)
            expect(error).toBeInstanceOf(DOMException)
            expect(error.name).toBe("AbortError")
            expect(error.message).not.toContain("abort-secret-canary")
          })
        }).pipe(Effect.provide(clientLayer(() => Promise.resolve([{ address: "127.0.0.1", family: 4 }])))),
    )
  })

  it.live("streams response chunks without buffering the body", () => {
    let release = () => {}
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    return withServer(
      (_request, response) => {
        response.setHeader("content-type", "text/event-stream")
        response.write("first")
        void released.then(() => response.end("second"))
      },
      (port) =>
        Effect.gen(function* () {
          const factory = yield* ModelEndpointClient.Service
          const client = yield* bind(factory, `http://model.internal:${port}/v1`)
          const response = yield* Effect.promise(() => client.fetch(`http://model.internal:${port}/v1/stream`))
          if (!response.body) return yield* Effect.die("Expected a response body")
          const reader = response.body.getReader()
          const first = yield* Effect.promise(() => reader.read())
          expect(new TextDecoder().decode(first.value)).toBe("first")
          release()
          const second = yield* Effect.promise(() => reader.read())
          expect(new TextDecoder().decode(second.value)).toBe("second")
          expect((yield* Effect.promise(() => reader.read())).done).toBe(true)
        }).pipe(Effect.provide(clientLayer(() => Promise.resolve([{ address: "127.0.0.1", family: 4 }])))),
    )
  })

  it.live("redacts raw resolver and transport failures", () =>
    Effect.gen(function* () {
      const factory = yield* ModelEndpointClient.Service
      const client = yield* bind(factory, "http://failure-secret.internal:49152/v1")
      yield* Effect.promise(async () => {
        const error = await client.fetch("http://failure-secret.internal:49152/v1/models").catch((cause) => cause)
        expect(error).toBeInstanceOf(ModelEndpointClient.TransportError)
        expect(error.message).not.toContain("resolver-secret-canary")
        expect(error.origin).toBe("http://failure-secret.internal:49152")
      })
    }).pipe(Effect.provide(clientLayer(() => Promise.reject(new Error("resolver-secret-canary"))))),
  )
})
