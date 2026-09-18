# Model Capability Probe Implementation

## Contract

`ModelCapabilityProbe` is a read-only Effect service and `LayerNode` in
`packages/opencode/src/koala/model-capability-probe.ts`. It depends only on
`ModelEndpointClient` and `Auth`. It accepts a provider ID, API base URL, model
ID, one to six unique requested capabilities, and an optional redacted
transient API key. Model IDs use the canonical `ModelProfile.ModelID` decoder
before the probe applies its 512-character and control-character checks.

The service validates the model ID and endpoint root, binds the policy-aware
endpoint client once, and resolves authentication once with this precedence:
transient API key, stored `Auth.Api`, then anonymous. Unsupported stored auth is
invalid input, while auth-store failure is an internal error.

The result contains `probeVersion: 1`, the model ID, and ordered requested
capability results. Results expose only capability, yes/no/unknown
classification, evidence kind, stable evidence code, and an optional HTTP
status. Probe prompts, nonces, response content, endpoint URLs, and credentials
are not returned.

## Probes

The suite always sends a text control first. When it is not verified, no
dependent requests are sent and requested dependent capabilities receive
`baseline_unverified`. The text control appears in results only when requested.
Remaining requested probes run sequentially in this order:

1. Streaming requires valid SSE, an exact nonce assembled from deltas, and a
   terminal `[DONE]` event.
2. Tool calling forces one named function, constrains its nonce with a
   single-value JSON Schema `enum`, and requires exact JSON arguments.
3. Structured output places the nonce only in a strict `json_schema`
   single-value `enum` and requires the direct exact JSON object.
4. Image input embeds a generated RGB PNG containing a visual uppercase
   32-hex nonce. The nonce is absent from prompt text and PNG metadata.
5. Reasoning requires the exact nonce-bound arithmetic answer plus a recognized
   reasoning field or positive reasoning-token count.

Every request uses an independent cryptographic 128-bit nonce. The internal PNG
encoder uses a built-in 5x7 hexadecimal font, zlib-compressed RGB scanlines,
PNG `IHDR`/`IDAT`/`IEND` chunks, and computed CRC-32 values. It performs no
external image request. Probe payloads omit `temperature`. Textual final
evidence is whitespace-trimmed before exact comparison or direct structured
JSON parsing; Markdown fences are not removed.

## Classification And Bounds

- Exact capability evidence: `yes` / `verified`.
- Optional-feature status 400, 405, 413, 415, or 422 after a verified baseline:
  `no` / `endpoint-rejection`.
- Valid accepted responses without exact evidence: `unknown` /
  `ambiguous-model-behavior`.
- Authentication, endpoint-not-found, upstream timeout, rate limiting, server
  failure, redirect, policy, transport, local timeout, malformed protocol, and
  size-limit outcomes: `unknown` / `operational`.
- A text-control 4xx rejection can classify text as unsupported; requested
  dependents remain unknown because their baseline was not verified.

There are no retries. Limits are 30 seconds per request, 120 seconds per suite,
128 KiB per request body, 256 KiB per response, 16 KiB assistant text, 8 KiB
tool arguments, 64 KiB per SSE event, and 1,024 SSE events.

## Tests And Results

`packages/opencode/test/koala/model-capability-probe.test.ts` uses local HTTP,
the real pinned endpoint client with a fake resolver, and fake bound clients.
It covers request shape, auth precedence and read count, fixed order and maximum
concurrency of one, baseline stopping, each positive parser, canonical model-ID
trimming, payload field and schema shape, whitespace-wrapped exact evidence,
Markdown-fence rejection, ambiguous behavior, the HTTP status matrix,
body/text/tool/SSE bounds, request and suite timeouts, caller cancellation,
output redaction, DNS and redirect policy, and PNG structure, CRC, color type,
metadata absence, visual nonce decoding, and nonce freshness. It makes no live
external model call.

- Focused tests: 16 passed, 0 failed.
- `packages/opencode` Koala tests: 56 passed, 0 failed.
- `packages/opencode`: `bun typecheck` passed.
- `packages/koala`: `bun test` passed, 139 tests.
- `packages/koala`: `bun typecheck` passed.

## Limitations

- A probe identifies behavior observed in one bounded request; it is not a
  durable statement about all prompts, loads, model versions, or server modes.
- OpenAI-compatible servers vary in optional-field and reasoning metadata
  conventions. Unrecognized but successful behavior remains unknown rather
  than being treated as support.
- A rejection can reflect endpoint policy or deployment configuration rather
  than an intrinsic model limitation.
- AI behavior is not guaranteed and may vary.
