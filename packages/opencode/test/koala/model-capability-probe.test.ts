import http from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import { inflateSync } from "node:zlib"
import { describe, expect } from "bun:test"
import { EndpointPolicy } from "@koala-ai/core/network/endpoint-policy"
import { ModelProfile } from "@koala-ai/core/model/profile"
import { Effect, Fiber, Layer, Option, Redacted, Schema } from "effect"
import { TestClock } from "effect/testing"
import { Auth } from "../../src/auth"
import { ModelCapabilityProbe } from "../../src/koala/model-capability-probe"
import { ModelEndpointClient } from "../../src/koala/model-endpoint-client"
import { NetworkResolver } from "../../src/koala/network-resolver"
import { it } from "../lib/effect"

const providerID = Schema.decodeUnknownSync(ModelProfile.ProviderID)("local-test")
const modelID = Schema.decodeUnknownSync(ModelProfile.ModelID)("probe-model")
const decodeInput = Schema.decodeUnknownSync(ModelCapabilityProbe.Input)
const allCapabilities = [
  "reasoning",
  "imageInput",
  "structuredOutput",
  "toolCalling",
  "streaming",
  "textInput",
] as const

interface WireRequest {
  readonly model: string
  readonly stream: boolean
  readonly temperature?: unknown
  readonly messages: ReadonlyArray<{
    readonly content:
      | string
      | ReadonlyArray<{
          readonly type: string
          readonly text?: string
          readonly image_url?: { readonly url: string }
        }>
  }>
  readonly tools?: ReadonlyArray<{
    readonly function: {
      readonly name: string
      readonly parameters: { readonly properties: { readonly nonce: { readonly enum: readonly [string] } } }
    }
  }>
  readonly tool_choice?: { readonly function: { readonly name: string } }
  readonly response_format?: {
    readonly type: string
    readonly json_schema: {
      readonly name: string
      readonly strict: boolean
      readonly schema: { readonly properties: { readonly nonce: { readonly enum: readonly [string] } } }
    }
  }
  readonly reasoning_effort?: string
}

function input(
  capabilities: ReadonlyArray<ModelProfile.Capability>,
  baseURL = "http://127.0.0.1:49152/v1",
  apiKey?: string,
) {
  return decodeInput({
    providerID,
    baseURL,
    modelID: "probe-model",
    capabilities,
    ...(apiKey !== undefined && { apiKey: Redacted.make(apiKey, { label: "API key" }) }),
  })
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

function fakeLayer(
  fetch: ModelEndpointClient.Fetch,
  info?: Auth.Info,
  onGet?: () => void,
): Layer.Layer<ModelCapabilityProbe.Service> {
  return ModelCapabilityProbe.layer.pipe(
    Layer.provide(
      Layer.mock(ModelEndpointClient.Service, {
        bind: (options) => Effect.succeed({ ...options, fetch }),
      }),
    ),
    Layer.provide(authLayer(info, onGet)),
  )
}

function liveLayer(
  info: Auth.Info | undefined,
  lookup: (hostname: string) => PromiseLike<ReadonlyArray<EndpointPolicy.ResolvedAddress>>,
  onGet?: () => void,
) {
  return ModelCapabilityProbe.layer.pipe(
    Layer.provide(ModelEndpointClient.layer.pipe(Layer.provide(NetworkResolver.layerWith({ lookup })))),
    Layer.provide(authLayer(info, onGet)),
  )
}

function probe(value: ModelCapabilityProbe.Input, layer: Layer.Layer<ModelCapabilityProbe.Service>) {
  return ModelCapabilityProbe.Service.use((service) => service.probe(value)).pipe(Effect.provide(layer))
}

function withServer<A, E, R>(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  use: (port: number) => Effect.Effect<A, E, R>,
) {
  return Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () =>
        new Promise<http.Server>((resolve, reject) => {
          const server = http.createServer(handler)
          server.once("error", reject)
          server.listen(0, "127.0.0.1", () => resolve(server))
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

function readBody(request: IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    const chunks: Uint8Array[] = []
    request.on("data", (chunk: Uint8Array) => chunks.push(chunk))
    request.once("end", () => resolve(Buffer.concat(chunks).toString()))
    request.once("error", reject)
  })
}

function json(content: string, extra?: object) {
  return Response.json({ choices: [{ message: { content, ...extra } }] })
}

function textNonce(request: WireRequest) {
  const content = request.messages[0]?.content
  if (typeof content !== "string") throw new Error("Expected text prompt")
  const match = content.match(/[0-9a-f]{32}/i)
  if (!match) throw new Error("Expected nonce in text prompt")
  return match[0]
}

function requestCapability(request: WireRequest): ModelProfile.Capability {
  if (request.stream) return "streaming"
  if (request.tools) return "toolCalling"
  if (request.response_format) return "structuredOutput"
  if (Array.isArray(request.messages[0]?.content)) return "imageInput"
  if (request.reasoning_effort) return "reasoning"
  return "textInput"
}

function positiveResponse(request: WireRequest) {
  const capability = requestCapability(request)
  if (capability === "streaming") {
    const value = textNonce(request)
    return new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { content: value.slice(0, 16) } }] })}\n\n` +
        `data: ${JSON.stringify({ choices: [{ delta: { content: value.slice(16) } }] })}\n\n` +
        `data: ${JSON.stringify({ choices: [], usage: {} })}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream; charset=utf-8" } },
    )
  }
  if (capability === "toolCalling") {
    const value = request.tools?.[0]?.function.parameters.properties.nonce.enum[0]
    return Response.json({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                type: "function",
                function: { name: "koala_capability_probe", arguments: JSON.stringify({ nonce: value }) },
              },
            ],
          },
        },
      ],
    })
  }
  if (capability === "structuredOutput") {
    return json(JSON.stringify({ nonce: request.response_format?.json_schema.schema.properties.nonce.enum[0] }))
  }
  if (capability === "imageInput") return json(readImageNonce(request).nonce)
  if (capability === "reasoning") return json(`${textNonce(request)}:1517`, { reasoning_content: "37 * 41 = 1517" })
  return json(textNonce(request))
}

describe("ModelCapabilityProbe", () => {
  it.live("validates model IDs and a unique nonempty capability list", () =>
    Effect.sync(() => {
      const decode = Schema.decodeUnknownOption(ModelCapabilityProbe.Input)
      const base = { providerID, baseURL: "http://127.0.0.1:49152/v1", modelID: "model" }
      expect(Option.isNone(decode({ ...base, capabilities: [] }))).toBe(true)
      expect(Option.isNone(decode({ ...base, capabilities: ["streaming", "streaming"] }))).toBe(true)
      expect(Option.isNone(decode({ ...base, capabilities: allCapabilities, modelID: `${"x".repeat(512)}y` }))).toBe(
        true,
      )
      expect(Option.isNone(decode({ ...base, capabilities: ["textInput"], modelID: "bad\nmodel" }))).toBe(true)
      const trimmed = decode({ ...base, capabilities: allCapabilities, modelID: "  trimmed-model  " })
      expect(Option.isSome(trimmed)).toBe(true)
      if (Option.isSome(trimmed)) {
        expect(trimmed.value.modelID).toBe(Schema.decodeUnknownSync(ModelProfile.ModelID)("trimmed-model"))
      }
      expect(Option.isSome(decode({ ...base, capabilities: allCapabilities, modelID: ` ${"x".repeat(512)} ` }))).toBe(
        true,
      )
      expect(Option.isSome(decode({ ...base, capabilities: allCapabilities, modelID: "x".repeat(512) }))).toBe(true)
    }),
  )

  it.live("runs exact positive probes sequentially in fixed order through the pinned local transport", () => {
    const bodies: WireRequest[] = []
    const nonces: string[] = []
    let active = 0
    let maximumActive = 0
    let authReads = 0
    return withServer(
      (request, response) => {
        active++
        maximumActive = Math.max(maximumActive, active)
        expect(request.url).toBe("/v1/chat/completions")
        expect(request.method).toBe("POST")
        expect(request.headers.authorization).toBe("Bearer transient-secret-canary")
        void readBody(request).then((body) => {
          expect(Buffer.byteLength(body)).toBeLessThanOrEqual(128 * 1024)
          const parsed = JSON.parse(body) as WireRequest
          expect(Object.hasOwn(parsed, "temperature")).toBe(false)
          bodies.push(parsed)
          const capability = requestCapability(parsed)
          const value = capability === "imageInput" ? readImageNonce(parsed).nonce : textNonceFor(parsed)
          nonces.push(value.toLowerCase())
          const result = positiveResponse(parsed)
          result.headers.forEach((header, name) => response.setHeader(name, header))
          void result.text().then((payload) => {
            response.statusCode = result.status
            response.end(payload)
            active--
          })
        })
      },
      (port) =>
        Effect.gen(function* () {
          const result = yield* probe(
            input(allCapabilities, `http://model.internal:${port}/v1///`, "transient-secret-canary"),
            liveLayer(
              new Auth.WellKnown({ type: "wellknown", key: "stored-secret", token: "stored-token" }),
              () => Promise.resolve([{ address: "127.0.0.1", family: 4 }]),
              () => authReads++,
            ),
          )
          expect(result.probeVersion).toBe(1)
          expect(result.modelID).toBe(modelID)
          expect(result.results.map((entry) => entry.capability)).toEqual([
            "textInput",
            "streaming",
            "toolCalling",
            "structuredOutput",
            "imageInput",
            "reasoning",
          ])
          expect(result.results.every((entry) => entry.classification === "yes" && entry.kind === "verified")).toBe(
            true,
          )
          expect(bodies.map(requestCapability)).toEqual(result.results.map((entry) => entry.capability))
          expect(maximumActive).toBe(1)
          expect(authReads).toBe(0)
          expect(new Set(nonces).size).toBe(6)

          const tool = bodies.find((body) => requestCapability(body) === "toolCalling")
          expect(tool?.tool_choice?.function.name).toBe("koala_capability_probe")
          expect(tool?.tools?.[0]?.function.parameters.properties.nonce.enum).toHaveLength(1)
          const structured = bodies.find((body) => requestCapability(body) === "structuredOutput")
          expect(structured?.response_format?.type).toBe("json_schema")
          expect(structured?.response_format?.json_schema.strict).toBe(true)
          expect(structured?.response_format?.json_schema.schema.properties.nonce.enum).toHaveLength(1)
          const structuredPrompt = structured?.messages[0]?.content
          expect(typeof structuredPrompt === "string" && structuredPrompt.includes(nonces[3] ?? "missing")).toBe(false)
          const image = bodies.find((body) => requestCapability(body) === "imageInput")
          const decoded = image ? readImageNonce(image) : undefined
          expect(decoded?.chunks).toEqual(["IHDR", "IDAT", "IEND"])
          expect(decoded?.colorType).toBe(2)
          expect(decoded?.png.byteLength).toBeLessThan(64 * 1024)
          expect(decoded && decoded.png.includes(Buffer.from(decoded.nonce))).toBe(false)
          const imagePrompt = image?.messages[0]?.content
          expect(Array.isArray(imagePrompt) && imagePrompt[0]?.text?.includes(decoded?.nonce ?? "missing")).toBe(false)
        }),
    )
  })

  it.live("uses the canonical trimmed model ID in requests and results", () => {
    const models: string[] = []
    return Effect.gen(function* () {
      const result = yield* probe(
        decodeInput({
          providerID,
          baseURL: "http://127.0.0.1:49152/v1",
          modelID: "  probe-model  ",
          capabilities: ["textInput"],
        }),
        fakeLayer((_url, init) => {
          const request = JSON.parse(String(init?.body)) as WireRequest
          models.push(request.model)
          return Promise.resolve(positiveResponse(request))
        }),
      )
      expect(models).toEqual(["probe-model"])
      expect(result.modelID).toBe(modelID)
    })
  })

  it.live("accepts whitespace-wrapped exact assistant and stream outputs without stripping Markdown fences", () =>
    Effect.gen(function* () {
      const result = yield* probe(
        input(allCapabilities),
        fakeLayer((_url, init) => {
          const request = JSON.parse(String(init?.body)) as WireRequest
          const capability = requestCapability(request)
          if (capability === "streaming") {
            return Promise.resolve(
              new Response(
                `data: ${JSON.stringify({ choices: [{ delta: { content: ` \n${textNonce(request)}` } }] })}\n\n` +
                  `data: ${JSON.stringify({ choices: [{ delta: { content: "\t" } }] })}\n\ndata: [DONE]\n\n`,
                { headers: { "content-type": "text/event-stream" } },
              ),
            )
          }
          if (capability === "toolCalling") return Promise.resolve(positiveResponse(request))
          if (capability === "structuredOutput") {
            const value = request.response_format?.json_schema.schema.properties.nonce.enum[0]
            return Promise.resolve(json(` \n${JSON.stringify({ nonce: value })}\t`))
          }
          if (capability === "imageInput") return Promise.resolve(json(`\n${readImageNonce(request).nonce} `))
          if (capability === "reasoning") {
            return Promise.resolve(json(` ${textNonce(request)}:1517\n`, { reasoning: "calculation" }))
          }
          return Promise.resolve(json(` \n${textNonce(request)}\t`))
        }),
      )
      expect(result.results.every((entry) => entry.classification === "yes")).toBe(true)

      const fenced = yield* probe(
        input(["structuredOutput"]),
        fakeLayer((_url, init) => {
          const request = JSON.parse(String(init?.body)) as WireRequest
          if (!request.response_format) return Promise.resolve(positiveResponse(request))
          const value = request.response_format.json_schema.schema.properties.nonce.enum[0]
          return Promise.resolve(json(`\`\`\`json\n${JSON.stringify({ nonce: value })}\n\`\`\``))
        }),
      )
      expect(fenced.results[0]?.classification).toBe("unknown")
      expect(fenced.results[0]?.kind).toBe("ambiguous-model-behavior")
    }),
  )

  it.live("resolves stored API auth once and otherwise probes anonymously", () => {
    const headers: Array<string | null> = []
    let authReads = 0
    const fetch: ModelEndpointClient.Fetch = (_url, init) => {
      headers.push(new Headers(init?.headers).get("authorization"))
      const request = JSON.parse(String(init?.body)) as WireRequest
      return Promise.resolve(positiveResponse(request))
    }
    return Effect.gen(function* () {
      yield* probe(
        input(["streaming"]),
        fakeLayer(fetch, new Auth.Api({ type: "api", key: "stored-secret-canary" }), () => authReads++),
      )
      yield* probe(
        input(["textInput"]),
        fakeLayer(fetch, undefined, () => authReads++),
      )
      expect(authReads).toBe(2)
      expect(headers).toEqual(["Bearer stored-secret-canary", "Bearer stored-secret-canary", null])
    })
  })

  it.live("rejects unsupported auth, auth read failures, and chat completion roots without leaking data", () => {
    let requests = 0
    const fetch = () => {
      requests++
      return Promise.resolve(json("unexpected"))
    }
    const failedAuth = ModelCapabilityProbe.layer.pipe(
      Layer.provide(
        Layer.mock(ModelEndpointClient.Service, {
          bind: (options) => Effect.succeed({ ...options, fetch }),
        }),
      ),
      Layer.provide(
        Layer.mock(Auth.Service, {
          get: () => Effect.fail(new Auth.AuthError({ message: "auth-secret-canary", cause: "cause-secret-canary" })),
        }),
      ),
    )
    return Effect.gen(function* () {
      const unsupported = yield* probe(
        input(["textInput"]),
        fakeLayer(
          fetch,
          new Auth.Oauth({ type: "oauth", refresh: "refresh-secret", access: "access-secret", expires: 0 }),
        ),
      ).pipe(Effect.flip)
      const authFailure = yield* probe(input(["textInput"]), failedAuth).pipe(Effect.flip)
      const endpoint = yield* probe(
        input(["textInput"], "http://127.0.0.1:49152/v1/chat/completions///"),
        fakeLayer(fetch),
      ).pipe(Effect.flip)
      expect(unsupported).toBeInstanceOf(ModelCapabilityProbe.InvalidInputError)
      expect(authFailure).toBeInstanceOf(ModelCapabilityProbe.InternalError)
      expect(endpoint).toBeInstanceOf(ModelCapabilityProbe.InvalidInputError)
      expect(`${unsupported.message} ${authFailure.message} ${endpoint.message}`).not.toContain("secret")
      expect(requests).toBe(0)
    })
  })

  it.live("stops after an unverified baseline and omits an unrequested text control", () => {
    let calls = 0
    return Effect.gen(function* () {
      const result = yield* probe(
        input(["reasoning", "streaming"]),
        fakeLayer((_url, init) => {
          calls++
          const request = JSON.parse(String(init?.body)) as WireRequest
          return Promise.resolve(json(`${textNonce(request)}-wrong`))
        }),
      )
      expect(calls).toBe(1)
      expect(result.results).toEqual([
        {
          capability: "streaming",
          classification: "unknown",
          kind: "operational",
          evidenceCode: "baseline_unverified",
        },
        {
          capability: "reasoning",
          classification: "unknown",
          kind: "operational",
          evidenceCode: "baseline_unverified",
        },
      ])
    })
  })

  it.live("classifies accepted but inexact behavior as ambiguous", () =>
    Effect.gen(function* () {
      const result = yield* probe(
        input(["textInput", "structuredOutput"]),
        fakeLayer((_url, init) => {
          const request = JSON.parse(String(init?.body)) as WireRequest
          if (request.response_format) return Promise.resolve(json('{"nonce":"wrong"}'))
          return Promise.resolve(positiveResponse(request))
        }),
      )
      expect(result.results[1]).toEqual({
        capability: "structuredOutput",
        classification: "unknown",
        kind: "ambiguous-model-behavior",
        evidenceCode: "response_mismatch",
        httpStatus: 200,
      })

      const stream = yield* probe(
        input(["streaming"]),
        fakeLayer((_url, init) => {
          const request = JSON.parse(String(init?.body)) as WireRequest
          if (!request.stream) return Promise.resolve(positiveResponse(request))
          return Promise.resolve(
            new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: textNonce(request) } }] })}\n\n`, {
              headers: { "content-type": "text/event-stream" },
            }),
          )
        }),
      )
      expect(stream.results[0]?.evidenceCode).toBe("stream_terminal_missing")
    }),
  )

  it.live("accepts positive reasoning token counts as reasoning evidence", () =>
    Effect.gen(function* () {
      const result = yield* probe(
        input(["reasoning"]),
        fakeLayer((_url, init) => {
          const request = JSON.parse(String(init?.body)) as WireRequest
          if (!request.reasoning_effort) return Promise.resolve(positiveResponse(request))
          return Promise.resolve(
            Response.json({
              choices: [{ message: { content: `${textNonce(request)}:1517` } }],
              usage: { completion_tokens_details: { reasoning_tokens: 1 } },
            }),
          )
        }),
      )
      expect(result.results[0]?.classification).toBe("yes")
      expect(result.results[0]?.evidenceCode).toBe("correct_answer_with_reasoning")
    }),
  )

  it.live("generates a fresh metadata-free RGB PNG for each image probe", () => {
    const images: Buffer[] = []
    const fetch: ModelEndpointClient.Fetch = (_url, init) => {
      const request = JSON.parse(String(init?.body)) as WireRequest
      if (requestCapability(request) === "imageInput") images.push(readImageNonce(request).png)
      return Promise.resolve(positiveResponse(request))
    }
    return Effect.gen(function* () {
      yield* probe(input(["imageInput"]), fakeLayer(fetch))
      yield* probe(input(["imageInput"]), fakeLayer(fetch))
      expect(images).toHaveLength(2)
      expect(images[0]).not.toEqual(images[1])
    })
  })

  it.live("maps endpoint rejection and operational HTTP statuses without reading error bodies", () =>
    Effect.gen(function* () {
      const cases = [
        [400, "no", "endpoint-rejection", "endpoint_rejection"],
        [405, "no", "endpoint-rejection", "endpoint_rejection"],
        [413, "no", "endpoint-rejection", "endpoint_rejection"],
        [415, "no", "endpoint-rejection", "endpoint_rejection"],
        [422, "no", "endpoint-rejection", "endpoint_rejection"],
        [401, "unknown", "operational", "authentication_rejected"],
        [403, "unknown", "operational", "authentication_rejected"],
        [404, "unknown", "operational", "endpoint_not_found"],
        [408, "unknown", "operational", "upstream_timeout"],
        [429, "unknown", "operational", "rate_limited"],
        [503, "unknown", "operational", "upstream_failure"],
      ] as const
      for (const [status, classification, kind, evidenceCode] of cases) {
        let call = 0
        const result = yield* probe(
          input(["streaming"]),
          fakeLayer((_url, init) => {
            call++
            if (call === 1) return Promise.resolve(positiveResponse(JSON.parse(String(init?.body)) as WireRequest))
            return Promise.resolve(new Response("upstream-secret-canary", { status }))
          }),
        )
        expect(result.results[0]).toEqual({
          capability: "streaming",
          classification,
          kind,
          evidenceCode,
          httpStatus: status,
        })
        expect(JSON.stringify(result)).not.toContain("secret-canary")
      }

      const baseline = yield* probe(
        input(["textInput", "streaming"]),
        fakeLayer(() => Promise.resolve(new Response("ignored", { status: 409 }))),
      )
      expect(baseline.results[0]?.classification).toBe("no")
      expect(baseline.results[1]?.evidenceCode).toBe("baseline_unverified")
    }),
  )

  it.live("maps malformed responses and all response limits to operational evidence", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<
        readonly [ModelProfile.Capability, (request: WireRequest) => Response, ModelCapabilityProbe.EvidenceCode]
      > = [
        ["textInput", () => new Response("not-json-secret-canary"), "response_parse_error"],
        ["textInput", () => new Response("x".repeat(256 * 1024 + 1)), "response_limit"],
        ["textInput", () => json("x".repeat(16 * 1024 + 1)), "assistant_text_limit"],
        [
          "toolCalling",
          (request) =>
            Response.json({
              choices: [
                {
                  message: {
                    tool_calls: [
                      {
                        function: {
                          name: "koala_capability_probe",
                          arguments: JSON.stringify({
                            nonce: request.tools?.[0]?.function.parameters.properties.nonce.enum[0],
                            pad: "x".repeat(8192),
                          }),
                        },
                      },
                    ],
                  },
                },
              ],
            }),
          "tool_arguments_limit",
        ],
        [
          "streaming",
          () =>
            new Response(`data: ${"x".repeat(64 * 1024)}\n\ndata: [DONE]\n\n`, {
              headers: { "content-type": "text/event-stream" },
            }),
          "sse_event_limit",
        ],
        [
          "streaming",
          () =>
            new Response(`${Array.from({ length: 1025 }, () => ": ping\n\n").join("")}data: [DONE]\n\n`, {
              headers: { "content-type": "text/event-stream" },
            }),
          "sse_event_count_limit",
        ],
      ]

      for (const [capability, response, evidenceCode] of cases) {
        let call = 0
        const result = yield* probe(
          input([capability]),
          fakeLayer((_url, init) => {
            call++
            const request = JSON.parse(String(init?.body)) as WireRequest
            if (capability !== "textInput" && call === 1) return Promise.resolve(positiveResponse(request))
            return Promise.resolve(response(request))
          }),
        )
        expect(result.results[0]?.classification).toBe("unknown")
        expect(result.results[0]?.kind).toBe("operational")
        expect(result.results[0]?.evidenceCode).toBe(evidenceCode)
        expect(JSON.stringify(result)).not.toContain("secret-canary")
      }
    }),
  )

  it.effect("times out one request at 30 seconds and aborts its transport", () => {
    let started = () => {}
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    let aborted = false
    const layer = fakeLayer((_url, init) => {
      started()
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            aborted = true
            reject(new DOMException("timeout-secret-canary", "AbortError"))
          },
          { once: true },
        )
      })
    })
    return Effect.gen(function* () {
      const fiber = yield* probe(input(["textInput"]), layer).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Effect.promise(() => ready)
      yield* TestClock.adjust("30 seconds")
      const result = yield* Fiber.join(fiber)
      expect(result.results[0]?.evidenceCode).toBe("request_timeout")
      expect(aborted).toBe(true)
    })
  })

  it.effect("stops starting requests when the 120-second suite budget is exhausted", () => {
    let calls = 0
    let aborted = 0
    let optionalStarted = () => {}
    const ready = new Promise<void>((resolve) => {
      optionalStarted = resolve
    })
    const layer = fakeLayer((_url, init) => {
      calls++
      const request = JSON.parse(String(init?.body)) as WireRequest
      if (calls === 1) return Promise.resolve(positiveResponse(request))
      optionalStarted()
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            aborted++
            reject(new DOMException("suite-secret-canary", "AbortError"))
          },
          { once: true },
        )
      })
    })
    return Effect.gen(function* () {
      const fiber = yield* probe(input(allCapabilities.filter((capability) => capability !== "textInput")), layer).pipe(
        Effect.forkChild({ startImmediately: true }),
      )
      yield* Effect.promise(() => ready)
      yield* TestClock.adjust("120 seconds")
      const result = yield* Fiber.join(fiber)
      expect(calls).toBe(5)
      expect(aborted).toBe(4)
      expect(result.results.map((entry) => entry.evidenceCode)).toEqual([
        "request_timeout",
        "request_timeout",
        "request_timeout",
        "request_timeout",
        "suite_timeout",
      ])
    })
  })

  it.live("propagates caller cancellation to the active request", () => {
    let started = () => {}
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    let aborted = false
    const layer = fakeLayer((_url, init) => {
      started()
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            aborted = true
            reject(new DOMException("cancel-secret-canary", "AbortError"))
          },
          { once: true },
        )
      })
    })
    return Effect.gen(function* () {
      const fiber = yield* probe(input(["textInput"]), layer).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Effect.promise(() => ready)
      yield* Fiber.interrupt(fiber)
      expect(aborted).toBe(true)
    })
  })

  it.live("classifies redirect, public DNS, and transport failures without exposing endpoint details", () =>
    withServer(
      (_request, response) => {
        response.writeHead(302, { location: "/v1/target?token=redirect-secret-canary" })
        response.end()
      },
      (port) =>
        Effect.gen(function* () {
          const redirect = yield* probe(
            input(["textInput"], `http://redirect-secret.internal:${port}/v1`),
            liveLayer(undefined, () => Promise.resolve([{ address: "127.0.0.1", family: 4 }])),
          )
          const publicAddress = yield* probe(
            input(["textInput"], "http://public-secret.internal:49152/v1"),
            liveLayer(undefined, () => Promise.resolve([{ address: "8.8.8.8", family: 4 }])),
          )
          const transport = yield* probe(
            input(["textInput"], "http://transport-secret.internal:49152/v1"),
            liveLayer(undefined, () => Promise.reject(new Error("resolver-secret-canary"))),
          )
          expect(redirect.results[0]?.evidenceCode).toBe("redirect_denied")
          expect(redirect.results[0]?.httpStatus).toBe(302)
          expect(publicAddress.results[0]?.evidenceCode).toBe("policy_denied")
          expect(transport.results[0]?.evidenceCode).toBe("transport_error")
          expect(JSON.stringify([redirect, publicAddress, transport])).not.toContain("secret")
        }),
    ),
  )
})

function textNonceFor(request: WireRequest) {
  if (request.tools) return request.tools[0]?.function.parameters.properties.nonce.enum[0] ?? ""
  if (request.response_format) return request.response_format.json_schema.schema.properties.nonce.enum[0]
  return textNonce(request)
}

const font: Readonly<Record<string, ReadonlyArray<string>>> = {
  "0": ["11111", "10001", "10011", "10101", "11001", "10001", "11111"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["11110", "00001", "00001", "11110", "10000", "10000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["10010", "10010", "10010", "11111", "00010", "00010", "00010"],
  "5": ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
  "6": ["01111", "10000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00001", "11110"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
}

function readImageNonce(request: WireRequest) {
  const content = request.messages[0]?.content
  if (!Array.isArray(content)) throw new Error("Expected image prompt")
  const url = content.find((part) => part.type === "image_url")?.image_url?.url
  if (!url?.startsWith("data:image/png;base64,")) throw new Error("Expected PNG data URL")
  const png = Buffer.from(url.slice("data:image/png;base64,".length), "base64")
  expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  const chunks: string[] = []
  const compressed: Buffer[] = []
  let offset = 8
  let width = 0
  let height = 0
  let colorType = -1
  while (offset < png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.subarray(offset + 4, offset + 8).toString("ascii")
    const data = png.subarray(offset + 8, offset + 8 + length)
    expect(png.readUInt32BE(offset + 8 + length)).toBe(crc32(Buffer.concat([Buffer.from(type), data])))
    chunks.push(type)
    if (type === "IHDR") {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      expect(data[8]).toBe(8)
      colorType = data[9] ?? -1
    }
    if (type === "IDAT") compressed.push(data)
    offset += 12 + length
  }
  const pixels = inflateSync(Buffer.concat(compressed))
  const characters = Array.from({ length: 32 }, (_, index) => {
    const pattern = Array.from({ length: 7 }, (_, y) =>
      Array.from({ length: 5 }, (_, x) => {
        const pixel = (4 + y * 2) * (width * 3 + 1) + 1 + (4 + index * 12 + x * 2) * 3
        return pixels[pixel] === 0 ? "1" : "0"
      }).join(""),
    )
    return Object.entries(font).find((entry) => entry[1].join("") === pattern.join(""))?.[0] ?? "?"
  }).join("")
  expect(characters).not.toContain("?")
  expect(height).toBe(22)
  return { nonce: characters, png, chunks, colorType }
}

function crc32(data: Uint8Array) {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}
