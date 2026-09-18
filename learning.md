# Koala Learnings

This file records verified implementation lessons that should influence later
work. It is not a substitute for the implementation plan or audit logs.

## Baseline

- OpenCode `v1.18.31` resolves to commit
  `014614d35b397775e5d397a490fc72368c894ec2`.
- The release commit's parent is
  `a97622c801f4ca571530ddc51076af659a9c32cd`; the parent must not be used as the
  imported source identity.
- Koala's untouched baseline is commit `41880aa` on the independent `dev`
  branch.
- The Desktop application is not a standalone renderer. It starts an
  authenticated loopback sidecar built from `packages/opencode/src/node.ts`.

## Build Graph

- Desktop depends on `packages/app`, `packages/ui`, `packages/session-ui`, the
  embedded OpenCode server, and several current V2 packages used by the hybrid
  server.
- CLI- or TUI-named server routes are not automatically removable. Some are
  part of the Desktop sidecar API even though Koala does not ship a CLI or TUI.
- Electron build dependencies may be declared as dev dependencies because Vite
  bundles them. Dependency category alone is not a safe deletion signal.
- The app currently uses compatibility and current API clients together.
  Protocol cleanup must be a separate migration, not incidental deletion.

## Windows Development

- `packages/app/src/custom-elements.d.ts` contained a plain relative-path
  literal that `tsgo` could not parse on this checkout. Replacing it with a
  TypeScript declaration import made App and Desktop typechecks pass.
- Interrupted Bun installs can leave linked packages incomplete. In this
  session `@pierre/trees` was present as a link but lacked its package manifest
  and root declarations.
- `bun install --force --frozen-lockfile --ignore-scripts` restored the pinned
  dependency graph without changing `bun.lock`.
- Repository tests must run from package directories, not the repository root.

## Sovereignty

- Disabling visible cloud controls is insufficient. The Desktop previously had
  independent public paths for binary updates, release notes, Sentry source-map
  upload, optional Sentry runtime reporting, OTLP export, remote notification
  icons, sharing, web tools, providers, plugins, and MCP.
- OTLP activation can come from inherited process environment variables. The
  Desktop must sanitize the sidecar environment before the server module loads.
- The sidecar and effective configuration now both honor
  `OPENCODE_DISABLE_SHARE`. The runtime blocks remote synchronization and the App
  receives `share: "disabled"`, which hides its existing sharing controls.
- The environment override is applied after legacy `autoshare` normalization,
  so persisted user configuration cannot re-enable sharing in the Koala
  Desktop process.
- Application request logs are not complete operating-system network proof.
  Production deployment also needs host firewall policy or an independent
  packet monitor for sovereignty evidence.

## Models

- The existing custom-provider form already writes an
  `@ai-sdk/openai-compatible` provider and can serve as the first Koala
  connection path.
- Current custom-provider success means configuration was saved, not that the
  endpoint or model was reached.
- Custom models currently default tool calling to true, context and output
  limits to zero, and image/reasoning support to false. Koala must collect or
  probe these values before using the profile for routing.
- `GET /v1/models` provides model IDs but does not provide a portable capability
  contract across OpenAI-compatible servers.
- Koala model profiles store only secret references, never raw credentials.
- Provider profiles require at least one model and unique model IDs.
- Models use `yes`, `no`, or `unknown` for detectable capabilities. `unknown`
  can be stored before probing but cannot satisfy a hard routing requirement.
- User overrides narrow model selection but do not bypass disabled-state or
  capability checks.
- Routing order is deterministic: numeric priority, provider ID, then model ID.
- OpenCode V1 config cannot retain all Koala routing metadata. Canonical profiles
  are stored separately and projected into V1 provider configuration at runtime.
- Profile persistence uses a versioned, schema-decoded JSON document with a
  cross-process lock and same-directory atomic replacement.
- A malformed or unknown-version profile document blocks config loading instead
  of silently reverting to an empty profile set.
- Profile mutations dispose active instances after persistence so subsequent
  provider state reloads from the canonical document.
- The local/private model form persists canonical profiles through the generated
  model-profile client and keeps raw API keys on the existing auth route.
- An empty API-key field preserves an existing profile secret reference during
  update; it does not clear credentials implicitly.
- New Koala UI copy lives in a dedicated English fallback dictionary merged
  before locale overlays. This avoids fabricated translations while retaining
  typed `language.t(...)` calls.
- Saving a profile is not a connectivity test. UI copy states that configuration
  was saved rather than claiming the endpoint connected successfully.
- Endpoint syntax is now checked by a shared Koala policy. Literal endpoints are
  limited to loopback, RFC1918, IPv6 loopback, and IPv6 ULA ranges.
- Hostnames remain pending until sidecar DNS authorization. Every returned
  address must be permitted; mixed public/private answers fail closed.
- URL validation rejects credentials, query strings, fragments, wildcard hosts,
  metadata hosts, alternate IPv4 notation, and redirect escape paths.
- The sidecar model transport performs DNS authorization inside Node's socket
  lookup callback, so the checked address is the address used for the connection.
- The transport preserves the original hostname for Host, TLS SNI, and
  certificate identity checks while avoiding environment proxies.
- Redirects are rejected instead of followed, and each connection performs a
  fresh DNS authorization because pooling is disabled initially.
- Model discovery uses the pinned endpoint transport and a five-second total
  deadline. It accepts a transient redacted key without saving it.
- Discovery returns only validated model IDs and a duplicate count; the standard
  model-list response does not provide dependable capabilities or token limits.
- Discovery response bodies are limited to 1 MiB and 10,000 entries.
- The Desktop discovery action validates only provider ID and endpoint, then
  merges returned IDs without deleting or resetting edited/manual model rows.
- Discovery API keys are transient; only final profile submission writes a key
  through the auth service.
- Actual AI SDK inference for canonical Koala profiles now uses the same pinned
  endpoint transport as discovery. Profile config and plugin fetch overrides
  cannot replace that transport.
- Profile-backed providers remain on the AI SDK path because the current native
  runtime gate accepts only OpenAI, Anthropic, and OpenCode provider IDs.
- The Desktop sidecar disables EC2/GCP metadata discovery and removes inherited
  metadata endpoint overrides as defense in depth.
- Unknown capability probes run sequentially behind a verified text baseline.
  Exact nonce/shape evidence becomes yes, controlled optional-feature rejection
  becomes no, and ambiguous or operational outcomes remain unknown.
- The image probe generates a local RGB PNG with a random visual nonce and no
  text metadata or external fetch.
- Probe results are applied only when provider, endpoint, key, row, and model ID
  still match the request snapshot; manual capability choices remain
  authoritative.

## Sandbox

- Koala will use `@anthropic-ai/sandbox-runtime` behind a Koala-owned interface.
- The upstream sandbox manager has process-global mutable state. Initial runs
  should use one short-lived worker per execution rather than sharing policies
  concurrently in the sidecar process.
- Model requests stay in the Koala sidecar. Generated code receives no endpoint
  credential and runs with an empty network allowlist.
- The strict sandbox must fail closed when the platform implementation is not
  available. It must not retry a blocked command directly on the host.

## Verification Record

On 2026-09-17, after the first sovereignty slice:

- Desktop targeted tests: 12 passed.
- `packages/desktop`: `bun typecheck` passed.
- `packages/app`: `bun typecheck` passed.
- `packages/desktop`: `bun run build` passed.
- Sharing configuration tests: 3 passed.
- `packages/opencode`: `bun typecheck` passed.
- `packages/koala`: 21 model profile and routing tests passed.
- `packages/koala`: `bun typecheck` passed.
- Profile store and runtime projection tests: 18 passed.
- Model-profile HTTP tests: 7 passed.
- Existing global/control-plane HTTP tests: 5 passed.
- Legacy SDK typecheck passed after generation.
- Local/private provider form and Koala i18n tests: 28 passed.
- Existing App i18n parity tests: 5 passed.
- App and Desktop typechecks passed after form integration.
- Desktop production build passed after form integration.
- Koala endpoint policy suite: 139 tests passed.
- Sidecar resolver and pinned transport tests: 13 passed.
- `packages/opencode`: `bun typecheck` passed with the transport services.
- Model discovery and HTTP integration tests are included in the focused
  OpenCode suite; legacy SDK and Desktop production builds pass.
- Discovery form and fallback-copy tests: 28 passed; locale parity tests: 5
  passed.
- Profile inference transport and native-gate tests: 21 passed.
- Sidecar environment hardening tests: 2 passed.
- Capability-probe service and model-profile API tests: 34 passed.
- Capability-probe form and fallback-copy tests: 68 passed.
