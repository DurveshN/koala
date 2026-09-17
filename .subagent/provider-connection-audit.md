# Local Provider Connection Audit

- Task ID: `ses_f5043a54bffewR6PZfAcNr7Cuy`
- Type: read-only exploration
- Baseline: OpenCode `v1.18.31`

## Scope

Trace the existing custom OpenAI-compatible provider form through config and
credential persistence, provider loading, model selection, and request
execution.

## Key Findings

- The existing custom-provider form already writes an
  `@ai-sdk/openai-compatible` provider with base URL, optional API key, model
  IDs, display names, and headers.
- The form writes credentials through `PUT /auth/:providerID` and provider
  config through `PATCH /global/config`.
- Saving a provider does not contact the endpoint or verify the model ID.
- The form does not collect context limits, modality, tool support, streaming,
  structured output, reasoning, or preferred roles.
- Custom model defaults are unsafe for routing: tool calls default true,
  context and output limits default zero, and vision/reasoning default false.
- The form accepts arbitrary HTTP or HTTPS destinations and does not apply a
  local/private endpoint policy.

## Recommended Integration

Reuse the current config and provider loader initially, but reframe the UI as a
local/private model connection. Add URL policy, `/v1/models` discovery,
capability fields and probes, required limits, truthful connection testing, and
secure secret handling in separate reviewed changes.
