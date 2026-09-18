import { randomBytes } from "node:crypto"
import { deflateSync } from "node:zlib"
import { ModelProfile } from "@koala-ai/core/model/profile"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { collectBoundedResponseBody } from "@opencode-ai/core/tool/http-body"
import { Clock, Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { Auth } from "../auth"
import { ModelEndpointClient } from "./model-endpoint-client"

const maximumRequestBytes = 128 * 1024
const maximumResponseBytes = 256 * 1024
const maximumAssistantBytes = 16 * 1024
const maximumToolArgumentBytes = 8 * 1024
const maximumSSEEventBytes = 64 * 1024
const maximumSSEEvents = 1024
const requestTimeoutMilliseconds = 30_000
const suiteTimeoutMilliseconds = 120_000
const maximumModelIDLength = 512
const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/
const optionalExecutionOrder = [
  "streaming",
  "toolCalling",
  "structuredOutput",
  "imageInput",
  "reasoning",
] as const satisfies ReadonlyArray<Exclude<ModelProfile.Capability, "textInput">>
const executionOrder = [
  "textInput",
  ...optionalExecutionOrder,
] as const satisfies ReadonlyArray<ModelProfile.Capability>

export const ApiKey = Schema.Redacted(Schema.String.check(Schema.isNonEmpty()), {
  label: "API key",
  disallowJsonEncode: true,
})

export const RequestedCapabilities = Schema.Array(ModelProfile.Capability).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(6),
  Schema.makeFilter((capabilities) =>
    new Set(capabilities).size === capabilities.length ? undefined : "Requested capabilities must be unique",
  ),
)

export interface Input extends Schema.Schema.Type<typeof Input> {}
export const Input = Schema.Struct({
  providerID: ModelProfile.ProviderID,
  baseURL: ModelProfile.BaseURL,
  modelID: ModelProfile.ModelID.check(
    Schema.isMaxLength(maximumModelIDLength),
    Schema.makeFilter((value) =>
      controlCharacters.test(value) ? "Model ID cannot contain control characters" : undefined,
    ),
  ),
  capabilities: RequestedCapabilities,
  apiKey: Schema.optional(ApiKey),
}).annotate({ identifier: "ModelCapabilityProbeInput" })

export const Classification = ModelProfile.Detectable
export type Classification = typeof Classification.Type

export const Kind = Schema.Literals(["verified", "endpoint-rejection", "ambiguous-model-behavior", "operational"])
export type Kind = typeof Kind.Type

export const EvidenceCode = Schema.Literals([
  "exact_text_nonce",
  "exact_stream_nonce",
  "exact_tool_arguments",
  "exact_structured_object",
  "exact_image_nonce",
  "correct_answer_with_reasoning",
  "endpoint_rejection",
  "baseline_unverified",
  "response_mismatch",
  "stream_terminal_missing",
  "authentication_rejected",
  "endpoint_not_found",
  "upstream_timeout",
  "rate_limited",
  "upstream_failure",
  "http_error",
  "policy_denied",
  "redirect_denied",
  "transport_error",
  "request_timeout",
  "suite_timeout",
  "request_limit",
  "response_limit",
  "assistant_text_limit",
  "tool_arguments_limit",
  "sse_event_limit",
  "sse_event_count_limit",
  "response_parse_error",
])
export type EvidenceCode = typeof EvidenceCode.Type

export interface ProbeResult extends Schema.Schema.Type<typeof ProbeResult> {}
export const ProbeResult = Schema.Struct({
  capability: ModelProfile.Capability,
  classification: Classification,
  kind: Kind,
  evidenceCode: EvidenceCode,
  httpStatus: Schema.optional(Schema.Int),
}).annotate({ identifier: "ModelCapabilityProbeResult" })

export interface Result extends Schema.Schema.Type<typeof Result> {}
export const Result = Schema.Struct({
  probeVersion: Schema.Literal(1),
  modelID: ModelProfile.ModelID,
  results: Schema.Array(ProbeResult),
}).annotate({ identifier: "ModelCapabilityProbeResultSet" })

export class InvalidInputError extends Schema.TaggedErrorClass<InvalidInputError>()(
  "ModelCapabilityProbeInvalidInputError",
  {
    reason: Schema.Literals(["invalid-input", "invalid-endpoint", "chat-completions-endpoint", "unsupported-auth"]),
  },
) {
  override get message() {
    return "Invalid model capability probe input"
  }
}

export class InternalError extends Schema.TaggedErrorClass<InternalError>()("ModelCapabilityProbeInternalError", {}) {
  override get message() {
    return "Model capability probe could not read authentication"
  }
}

export type Error = InvalidInputError | InternalError

export interface Interface {
  readonly probe: (input: Input) => Effect.Effect<Result, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/KoalaModelCapabilityProbe") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const endpointClient = yield* ModelEndpointClient.Service
    const auth = yield* Auth.Service

    const probe = Effect.fn("ModelCapabilityProbe.probe")(function* (input: Input) {
      if (!validInput(input)) return yield* new InvalidInputError({ reason: "invalid-input" })

      const client = yield* endpointClient
        .bind({ providerID: input.providerID, baseURL: input.baseURL })
        .pipe(Effect.mapError(() => new InvalidInputError({ reason: "invalid-endpoint" })))
      const url = new URL(client.baseURL)
      const root = url.pathname.replace(/\/+$/, "")
      if (root.toLowerCase().endsWith("/chat/completions")) {
        return yield* new InvalidInputError({ reason: "chat-completions-endpoint" })
      }
      url.pathname = `${root}/chat/completions`

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

      const requested = new Set(input.capabilities)
      const startedAt = yield* Clock.currentTimeMillis
      const textNonce = nonce()
      const baseline = yield* executeProbe({
        capability: "textInput",
        client,
        url,
        key,
        body: textRequest(input.modelID, textNonce),
        parse: (response) => parseExactText(response, textNonce, "exact_text_nonce"),
        startedAt,
      })
      if (baseline.classification !== "yes") {
        return {
          probeVersion: 1 as const,
          modelID: input.modelID,
          results: executionOrder.flatMap((capability) => {
            if (!requested.has(capability)) return []
            if (capability === "textInput") return [baseline]
            return [operational(capability, "baseline_unverified")]
          }),
        }
      }

      const results: ProbeResult[] = requested.has("textInput") ? [baseline] : []
      for (const capability of optionalExecutionOrder) {
        if (!requested.has(capability)) continue
        const value = nonce()
        const body = requestFor(capability, input.modelID, value)
        results.push(
          yield* executeProbe({
            capability,
            client,
            url,
            key,
            body,
            parse: (response) => parseFor(capability, response, value),
            startedAt,
          }),
        )
      }

      return { probeVersion: 1 as const, modelID: input.modelID, results }
    })

    return Service.of({ probe })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [ModelEndpointClient.node, Auth.node],
})

interface ExecuteOptions {
  readonly capability: ModelProfile.Capability
  readonly client: ModelEndpointClient.BoundClient
  readonly url: URL
  readonly key: string | undefined
  readonly body: object
  readonly parse: (response: Response) => Effect.Effect<ProbeResult>
  readonly startedAt: number
}

function executeProbe(options: ExecuteOptions) {
  return Effect.gen(function* () {
    const body = JSON.stringify(options.body)
    if (Buffer.byteLength(body) > maximumRequestBytes) return operational(options.capability, "request_limit")
    const now = yield* Clock.currentTimeMillis
    const remaining = suiteTimeoutMilliseconds - (now - options.startedAt)
    if (remaining <= 0) return operational(options.capability, "suite_timeout")
    const timeout = Math.min(requestTimeoutMilliseconds, remaining)
    const timeoutEvidence = remaining < requestTimeoutMilliseconds ? "suite_timeout" : "request_timeout"

    return yield* Effect.gen(function* () {
      const response = yield* Effect.tryPromise({
        try: (signal) =>
          options.client.fetch(options.url, {
            method: "POST",
            signal,
            headers: {
              accept: options.capability === "streaming" ? "text/event-stream" : "application/json",
              "content-type": "application/json",
              ...(options.key !== undefined && { authorization: `Bearer ${options.key}` }),
            },
            body,
          }),
        catch: classifyTransportError,
      })
      if (!response.ok) {
        yield* Effect.promise(() => response.body?.cancel() ?? Promise.resolve()).pipe(Effect.ignore)
        return classifyStatus(options.capability, response.status)
      }
      return yield* options.parse(response)
    }).pipe(
      Effect.catch((failure: TransportFailure) =>
        Effect.succeed(operational(options.capability, failure.evidenceCode, failure.httpStatus)),
      ),
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () => Effect.succeed(operational(options.capability, timeoutEvidence)),
      }),
    )
  })
}

function requestFor(capability: Exclude<ModelProfile.Capability, "textInput">, modelID: string, value: string) {
  if (capability === "streaming") return streamRequest(modelID, value)
  if (capability === "toolCalling") return toolRequest(modelID, value)
  if (capability === "structuredOutput") return structuredOutputRequest(modelID, value)
  if (capability === "imageInput") return imageRequest(modelID, value.toUpperCase())
  return reasoningRequest(modelID, value)
}

function parseFor(capability: Exclude<ModelProfile.Capability, "textInput">, response: Response, value: string) {
  if (capability === "streaming") return parseStream(response, value)
  if (capability === "toolCalling") return parseToolCall(response, value)
  if (capability === "structuredOutput") return parseStructuredOutput(response, value)
  if (capability === "imageInput")
    return parseExactText(response, value.toUpperCase(), "exact_image_nonce", "imageInput")
  return parseReasoning(response, value)
}

function textRequest(model: string, value: string) {
  return {
    model,
    messages: [{ role: "user", content: `Return exactly this token and nothing else: ${value}` }],
    max_tokens: 64,
    stream: false,
  }
}

function streamRequest(model: string, value: string) {
  return { ...textRequest(model, value), stream: true }
}

function toolRequest(model: string, value: string) {
  const name = "koala_capability_probe"
  return {
    model,
    messages: [{ role: "user", content: "Call the provided function exactly once with the required argument." }],
    tools: [
      {
        type: "function",
        function: {
          name,
          description: "Return the required probe argument.",
          parameters: {
            type: "object",
            properties: { nonce: { type: "string", enum: [value] } },
            required: ["nonce"],
            additionalProperties: false,
          },
        },
      },
    ],
    tool_choice: { type: "function", function: { name } },
    max_tokens: 128,
    stream: false,
  }
}

function structuredOutputRequest(model: string, value: string) {
  return {
    model,
    messages: [{ role: "user", content: "Return one JSON object that satisfies the supplied response schema." }],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "koala_capability_probe",
        strict: true,
        schema: {
          type: "object",
          properties: { nonce: { type: "string", enum: [value] } },
          required: ["nonce"],
          additionalProperties: false,
        },
      },
    },
    max_tokens: 64,
    stream: false,
  }
}

function imageRequest(model: string, value: string) {
  return {
    model,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Read the 32-character hexadecimal code shown in the image. Return only that code.",
          },
          { type: "image_url", image_url: { url: `data:image/png;base64,${makeNoncePng(value).toString("base64")}` } },
        ],
      },
    ],
    max_tokens: 64,
    stream: false,
  }
}

function reasoningRequest(model: string, value: string) {
  return {
    model,
    messages: [
      {
        role: "user",
        content: `Calculate 37 * 41. Think through the calculation, then return exactly ${value}:1517 as the final answer.`,
      },
    ],
    reasoning_effort: "medium",
    max_tokens: 256,
    stream: false,
  }
}

function parseExactText(
  response: Response,
  expected: string,
  evidenceCode: EvidenceCode,
  capability: ModelProfile.Capability = "textInput",
) {
  return Effect.gen(function* () {
    const envelope = yield* responseEnvelope(response, capability)
    const content = Reflect.get(envelope.message, "content")
    if (typeof content !== "string") {
      return unknown(envelope.capability, "ambiguous-model-behavior", "response_mismatch", response.status)
    }
    if (Buffer.byteLength(content) > maximumAssistantBytes) {
      return operational(envelope.capability, "assistant_text_limit", response.status)
    }
    if (content.trim() !== expected) {
      return unknown(envelope.capability, "ambiguous-model-behavior", "response_mismatch", response.status)
    }
    return yes(envelope.capability, evidenceCode, response.status)
  }).pipe(
    Effect.catch((failure: ParseFailure) =>
      Effect.succeed(operational(failure.capability, failure.code, response.status)),
    ),
  )
}

function parseToolCall(response: Response, expected: string) {
  return Effect.gen(function* () {
    const envelope = yield* responseEnvelope(response, "toolCalling")
    const calls = Reflect.get(envelope.message, "tool_calls")
    const content = Reflect.get(envelope.message, "content")
    if (typeof content === "string" && Buffer.byteLength(content) > maximumAssistantBytes) {
      return operational("toolCalling", "assistant_text_limit", response.status)
    }
    if (
      Array.isArray(calls) &&
      calls.some((call) => {
        const argumentsText = get(get(call, "function"), "arguments")
        return typeof argumentsText === "string" && Buffer.byteLength(argumentsText) > maximumToolArgumentBytes
      })
    ) {
      return operational("toolCalling", "tool_arguments_limit", response.status)
    }
    if (!Array.isArray(calls) || calls.length !== 1) {
      return unknown("toolCalling", "ambiguous-model-behavior", "response_mismatch", response.status)
    }
    const fn = get(calls[0], "function")
    const argumentsText = get(fn, "arguments")
    if (get(fn, "name") !== "koala_capability_probe" || typeof argumentsText !== "string") {
      return unknown("toolCalling", "ambiguous-model-behavior", "response_mismatch", response.status)
    }
    const parsed = decodeJsonOption(argumentsText)
    if (Option.isNone(parsed) || !exactNonceObject(parsed.value, expected)) {
      return unknown("toolCalling", "ambiguous-model-behavior", "response_mismatch", response.status)
    }
    return yes("toolCalling", "exact_tool_arguments", response.status)
  }).pipe(
    Effect.catch((failure: ParseFailure) =>
      Effect.succeed(operational(failure.capability, failure.code, response.status)),
    ),
  )
}

function parseStructuredOutput(response: Response, expected: string) {
  return Effect.gen(function* () {
    const envelope = yield* responseEnvelope(response, "structuredOutput")
    const content = Reflect.get(envelope.message, "content")
    if (typeof content !== "string") {
      return unknown("structuredOutput", "ambiguous-model-behavior", "response_mismatch", response.status)
    }
    if (Buffer.byteLength(content) > maximumAssistantBytes) {
      return operational("structuredOutput", "assistant_text_limit", response.status)
    }
    const parsed = decodeJsonOption(content.trim())
    if (Option.isNone(parsed) || !exactNonceObject(parsed.value, expected)) {
      return unknown("structuredOutput", "ambiguous-model-behavior", "response_mismatch", response.status)
    }
    return yes("structuredOutput", "exact_structured_object", response.status)
  }).pipe(
    Effect.catch((failure: ParseFailure) =>
      Effect.succeed(operational(failure.capability, failure.code, response.status)),
    ),
  )
}

function parseReasoning(response: Response, value: string) {
  return Effect.gen(function* () {
    const envelope = yield* responseEnvelope(response, "reasoning")
    const content = Reflect.get(envelope.message, "content")
    if (typeof content !== "string") {
      return unknown("reasoning", "ambiguous-model-behavior", "response_mismatch", response.status)
    }
    if (Buffer.byteLength(content) > maximumAssistantBytes) {
      return operational("reasoning", "assistant_text_limit", response.status)
    }
    if (content.trim() !== `${value}:1517` || !hasReasoningEvidence(envelope.json, envelope.message)) {
      return unknown("reasoning", "ambiguous-model-behavior", "response_mismatch", response.status)
    }
    return yes("reasoning", "correct_answer_with_reasoning", response.status)
  }).pipe(
    Effect.catch((failure: ParseFailure) =>
      Effect.succeed(operational(failure.capability, failure.code, response.status)),
    ),
  )
}

function parseStream(response: Response, expected: string) {
  return Effect.gen(function* () {
    const contentType = response.headers.get("content-type")?.toLowerCase()
    if (!contentType?.startsWith("text/event-stream")) {
      return operational("streaming", "response_parse_error", response.status)
    }
    const body = yield* boundedBody(response, "streaming")
    const text = yield* decodeUtf8(body, "streaming")
    const blocks = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n\n").filter(Boolean)
    if (blocks.length > maximumSSEEvents) return operational("streaming", "sse_event_count_limit", response.status)

    const content: string[] = []
    let terminal = false
    for (const block of blocks) {
      if (Buffer.byteLength(block) > maximumSSEEventBytes) {
        return operational("streaming", "sse_event_limit", response.status)
      }
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n")
      if (!data) continue
      if (terminal) return operational("streaming", "response_parse_error", response.status)
      if (data === "[DONE]") {
        terminal = true
        continue
      }
      const event = yield* decodeJson(data).pipe(
        Effect.mapError(() => new ParseFailure("streaming", "response_parse_error")),
      )
      const choices = get(event, "choices")
      if (!Array.isArray(choices)) return operational("streaming", "response_parse_error", response.status)
      if (choices.length === 0) continue
      const delta = get(choices[0], "delta")
      const part = get(delta, "content")
      if (part === undefined || part === null) continue
      if (typeof part !== "string") return operational("streaming", "response_parse_error", response.status)
      content.push(part)
      if (Buffer.byteLength(content.join("")) > maximumAssistantBytes) {
        return operational("streaming", "assistant_text_limit", response.status)
      }
    }
    if (!terminal) return unknown("streaming", "ambiguous-model-behavior", "stream_terminal_missing", response.status)
    if (content.join("").trim() !== expected) {
      return unknown("streaming", "ambiguous-model-behavior", "response_mismatch", response.status)
    }
    return yes("streaming", "exact_stream_nonce", response.status)
  }).pipe(
    Effect.catch((failure: ParseFailure) =>
      Effect.succeed(operational(failure.capability, failure.code, response.status)),
    ),
  )
}

function responseEnvelope(response: Response, capability: ModelProfile.Capability = "textInput") {
  return Effect.gen(function* () {
    const body = yield* boundedBody(response, capability)
    const json = yield* decodeJson(yield* decodeUtf8(body, capability)).pipe(
      Effect.mapError(() => new ParseFailure(capability, "response_parse_error")),
    )
    const choices = get(json, "choices")
    if (!Array.isArray(choices) || choices.length === 0) {
      return yield* Effect.fail(new ParseFailure(capability, "response_parse_error"))
    }
    const message = get(choices[0], "message")
    if (!isObject(message)) return yield* Effect.fail(new ParseFailure(capability, "response_parse_error"))
    return { capability, json, message }
  })
}

function boundedBody(response: Response, capability: ModelProfile.Capability) {
  return collectBoundedResponseBody(
    HttpClientResponse.fromWeb(HttpClientRequest.post("http://probe.invalid"), response),
    maximumResponseBytes,
    () => new ParseFailure(capability, "response_limit"),
  ).pipe(
    Effect.mapError((failure) =>
      failure instanceof ParseFailure
        ? failure
        : new ParseFailure(
            capability,
            failure instanceof ModelEndpointClient.TransportError ? "transport_error" : "response_parse_error",
          ),
    ),
  )
}

function decodeUtf8(body: Uint8Array, capability: ModelProfile.Capability) {
  return Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(body),
    catch: () => new ParseFailure(capability, "response_parse_error"),
  })
}

const decodeJson = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)
const decodeJsonOption = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)

class ParseFailure extends Error {
  constructor(
    readonly capability: ModelProfile.Capability,
    readonly code: EvidenceCode,
  ) {
    super("Model capability probe response could not be parsed")
  }
}

interface TransportFailure {
  readonly evidenceCode: EvidenceCode
  readonly httpStatus?: number
}

function classifyTransportError(cause: unknown): TransportFailure {
  if (cause instanceof ModelEndpointClient.PolicyError) return { evidenceCode: "policy_denied" }
  if (cause instanceof ModelEndpointClient.RedirectError) {
    return { evidenceCode: "redirect_denied", httpStatus: cause.status }
  }
  return { evidenceCode: "transport_error" }
}

function classifyStatus(capability: ModelProfile.Capability, status: number): ProbeResult {
  if (status === 401 || status === 403) return operational(capability, "authentication_rejected", status)
  if (status === 404) return operational(capability, "endpoint_not_found", status)
  if (status === 408) return operational(capability, "upstream_timeout", status)
  if (status === 429) return operational(capability, "rate_limited", status)
  if (status >= 500 && status <= 599) return operational(capability, "upstream_failure", status)
  if (status >= 300 && status <= 399) return operational(capability, "redirect_denied", status)
  if ([400, 405, 413, 415, 422].includes(status) || (capability === "textInput" && status >= 400 && status < 500)) {
    return {
      capability,
      classification: "no",
      kind: "endpoint-rejection",
      evidenceCode: "endpoint_rejection",
      httpStatus: status,
    }
  }
  return operational(capability, "http_error", status)
}

function yes(capability: ModelProfile.Capability, evidenceCode: EvidenceCode, httpStatus: number): ProbeResult {
  return { capability, classification: "yes", kind: "verified", evidenceCode, httpStatus }
}

function unknown(
  capability: ModelProfile.Capability,
  kind: Extract<Kind, "ambiguous-model-behavior">,
  evidenceCode: EvidenceCode,
  httpStatus?: number,
): ProbeResult {
  return { capability, classification: "unknown", kind, evidenceCode, ...(httpStatus !== undefined && { httpStatus }) }
}

function operational(
  capability: ModelProfile.Capability,
  evidenceCode: EvidenceCode,
  httpStatus?: number,
): ProbeResult {
  return {
    capability,
    classification: "unknown",
    kind: "operational",
    evidenceCode,
    ...(httpStatus !== undefined && { httpStatus }),
  }
}

function validInput(input: Input) {
  return (
    input.modelID.trim().length > 0 &&
    input.modelID.length <= maximumModelIDLength &&
    !controlCharacters.test(input.modelID) &&
    input.capabilities.length >= 1 &&
    input.capabilities.length <= 6 &&
    new Set(input.capabilities).size === input.capabilities.length &&
    input.capabilities.every((capability) => executionOrder.includes(capability)) &&
    (!input.apiKey || Redacted.value(input.apiKey).length > 0)
  )
}

function nonce() {
  return randomBytes(16).toString("hex")
}

function get(value: unknown, key: string): unknown {
  return isObject(value) ? Reflect.get(value, key) : undefined
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function exactNonceObject(value: unknown, expected: string) {
  return isObject(value) && Object.keys(value).length === 1 && Reflect.get(value, "nonce") === expected
}

function hasReasoningEvidence(json: unknown, message: object) {
  const direct = [
    Reflect.get(message, "reasoning_content"),
    Reflect.get(message, "reasoning"),
    Reflect.get(message, "reasoning_details"),
  ]
  if (
    direct.some((value) => (typeof value === "string" ? value.length > 0 : Array.isArray(value) && value.length > 0))
  ) {
    return true
  }
  const usage = get(json, "usage")
  const completionDetails = get(usage, "completion_tokens_details")
  const outputDetails = get(usage, "output_tokens_details")
  return [
    get(completionDetails, "reasoning_tokens"),
    get(outputDetails, "reasoning_tokens"),
    get(usage, "reasoning_tokens"),
  ].some((value) => typeof value === "number" && Number.isFinite(value) && value > 0)
}

const glyphs: Readonly<Record<string, ReadonlyArray<string>>> = {
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

function makeNoncePng(value: string) {
  const scale = 2
  const padding = 4
  const spacing = 2
  const width = padding * 2 + value.length * (5 * scale + spacing) - spacing
  const height = padding * 2 + 7 * scale
  const pixels = Buffer.alloc((width * 3 + 1) * height, 255)
  for (let y = 0; y < height; y++) pixels[y * (width * 3 + 1)] = 0
  for (const [index, character] of [...value].entries()) {
    const glyph = glyphs[character]
    if (!glyph) continue
    glyph.forEach((row, glyphY) => {
      Array.from(row).forEach((pixel, glyphX) => {
        if (pixel !== "1") return
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            const x = padding + index * (5 * scale + spacing) + glyphX * scale + dx
            const y = padding + glyphY * scale + dy
            const offset = y * (width * 3 + 1) + 1 + x * 3
            pixels.fill(0, offset, offset + 3)
          }
        }
      })
    })
  }

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  return Buffer.concat([signature, pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(pixels)), pngChunk("IEND")])
}

function pngChunk(type: "IHDR" | "IDAT" | "IEND", data = Buffer.alloc(0)) {
  const name = Buffer.from(type, "ascii")
  const chunk = Buffer.alloc(12 + data.length)
  chunk.writeUInt32BE(data.length, 0)
  name.copy(chunk, 4)
  data.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length)
  return chunk
}

function crc32(data: Uint8Array) {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

export * as ModelCapabilityProbe from "./model-capability-probe"
