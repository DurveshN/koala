# Model Capability Probe API Implementation

## Contract

The authenticated V1 model-profile API exposes
`POST /global/model-profile/probe` as operation `modelProfile.probe`. Its request
and success contracts are `ModelCapabilityProbe.Input` and
`ModelCapabilityProbe.Result`. The endpoint declares only
`InvalidRequestError` (400) and `UnknownError` (500). Operational probe outcomes
remain successful HTTP 200 result entries.

The handler acquires `ModelCapabilityProbe.Service` once while constructing the
model-profile handler group and calls `probe` without mutating configuration or
the model-profile store and without disposing instances. The server application
graph includes `ModelCapabilityProbe.node`.

## Error Mapping

- `ModelCapabilityProbe.InvalidInputError` maps to `InvalidRequestError` with
  the service reason in the safe `kind` field.
- `ModelCapabilityProbe.InternalError` maps to an opaque `UnknownError` message
  that does not expose authentication details.
- Expected endpoint, transport, timeout, rate-limit, and probe-evidence outcomes
  remain encoded in the 200 result contract by the service.

## SDK Generation

The legacy SDK was regenerated with
`bun ./packages/sdk/js/script/build.ts`. The generated changes are limited to
`packages/sdk/js/src/v2/gen/sdk.gen.ts` and
`packages/sdk/js/src/v2/gen/types.gen.ts`. The generated client exposes
`modelProfile.probe`, its payload/result types, and only the declared 400 and
500 operation errors. `packages/client` generation was not run.

## Tests And Results

The model-profile API tests cover exact successful JSON serialization and
result order, transient API-key decoding as `Redacted`, invalid and duplicate
capability payloads, service-level 400/500 mapping, response-field redaction,
and absence of store mutation or instance disposal. Root global and
control-plane API fixtures provide probe-service mocks. The HttpApi exerciser
contains a protected, global, non-mutating probe scenario.

- Focused probe service, model-profile API, global API, and control-plane API:
  34 passed, 0 failed.
- Filtered HttpApi coverage mode: 1 passed, 0 failed, 0 missing.
- Filtered HttpApi auth mode: 1 passed, 0 failed, 0 missing.
- Filtered HttpApi effect mode: 1 passed, 0 failed, 0 missing.
- `packages/opencode`: `bun typecheck` passed.
- `packages/sdk/js`: generation and `bun typecheck` passed.
- `packages/koala`: 139 tests passed and `bun typecheck` passed.

## Risks

- A probe performs active requests against the supplied endpoint and can consume
  endpoint resources even though it does not mutate local profile state.
- Capability results describe one bounded observation and may vary with model,
  deployment, load, or endpoint policy.
- API consumers must treat the transient `apiKey` as write-only request data;
  response schemas strip undeclared fields.

No capability-service logic changed for API schema compatibility.
