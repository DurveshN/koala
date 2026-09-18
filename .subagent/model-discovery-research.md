# Model Discovery Research

## Objective

Define a read-only OpenAI-compatible model-list operation that can run before a
complete profile is saved.

## Decision

Expose `POST /global/model-profile/discover` with provider ID, base URL, and an
optional transient API key. A transient key is used only for this request;
otherwise the sidecar uses an existing API-key credential for that provider ID
or performs anonymous discovery.

The sidecar appends `/models` to the configured API root, uses the DNS-pinned
endpoint transport, rejects redirects, applies one five-second deadline, limits
the response to 1 MiB and 10,000 entries, and returns only model IDs plus a
duplicate count.

## Security

- The transient key is represented as a redacted schema value.
- Discovery does not mutate auth, profiles, config, or active instances.
- Public errors omit credentials, response bodies, redirect locations, query
  strings, and raw transport messages.
- Model IDs are trimmed, bounded, control-character checked, and deduplicated
  case-sensitively in first-seen order.

## UI Sequence

Discovery occurs before final form submission. Returned IDs merge into existing
rows without deleting user-edited rows. Discovery does not infer capabilities,
token limits, or roles from the standard model-list response.
