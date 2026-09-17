# Provider Config Adapter Research

## Objective

Define a secret-free projection from canonical Koala model profiles to the
OpenCode V1 OpenAI-compatible provider configuration.

## Mapping

- Provider display name and base URL map directly.
- Model display name and context/output limits map directly.
- Only capability value `yes` maps to true or an included modality.
- `no` and `unknown` map conservatively to false or omission from modalities.
- Input modalities use stable text-then-image ordering.
- Output modality is text for this language-model adapter.
- Disabled models are omitted.
- Secret references, streaming, structured-output status, roles, enabled state,
  priority, headers, and arbitrary options do not enter the V1 projection.

## Boundary Decision

The adapter owns a narrow output type and has no runtime dependency on
`@opencode-ai/core`. Canonical Koala profiles remain the source of truth.

## Risks

- All-disabled providers project to an empty model record and must be omitted by
  integration code.
- Embedding and reranking endpoints need separate runtime adapters later.
- Endpoint policy and reachability are outside this projection.
