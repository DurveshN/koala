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

- Koala uses `@anthropic-ai/sandbox-runtime@0.0.76` behind versioned Koala IPC
  contracts. The upstream sandbox manager has process-global mutable state, so
  each availability check or execution uses a short-lived worker process.
- Model requests stay in the Koala sidecar. Generated code receives no endpoint
  credential and runs with an empty network allowlist.
- The strict sandbox must fail closed when the platform implementation is not
  available. It must not retry a blocked command directly on the host.
- Windows requires the upstream sandbox user and WFP setup. This development
  machine reports `initialization-failed`; the emitted worker returns that fixed
  status without attempting host execution.
- The worker must use `wrapWithSandboxArgv()` and `shell: false`. The string
  wrapper is unsupported on Windows and would expose command bytes to a host
  shell.
- Desktop passes `KOALA_AGENT_EXECUTION=sandbox`, omits model-facing `bash`, and
  separately rejects direct shell execution. Internal host subprocesses remain
  available for trusted application operations.
- Electron packages the worker, native helpers, Java agent, and Apache license
  under `process.resourcesPath/sandbox-runtime`, outside `app.asar`.
- Sandbox Runtime adds several compatibility write paths internally. Koala puts
  its shared temporary/debug paths in `denyWrite` so only the per-run temporary
  workspace remains writable; required device endpoints remain available.
- Linux seccomp degradation is reported upstream as a warning. Koala treats a
  missing/non-executable helper or any seccomp warning as unavailable.
- Filesystem violation reporting on Linux is best effort in version `0.0.76`
  because its monitor readiness is not exposed, while OS policy enforcement is
  independent of that reporting path.
- Sandbox diagnostics must treat runtime unavailability as an observed product
  state rather than an execution exception. Checking availability first also
  makes it possible to prove that no execution was attempted.
- A sandbox self-test cannot trust its own report for write or network denial.
  Host-created nonce canaries, absent-target checks, and a host-owned loopback
  listener provide independent observations without returning sensitive values.
- Cancellation readiness must be explicit. A fixed sandbox script writes a
  nonce-bound readiness file, bounded polling observes it, and only then does a
  local abort request test the runtime cancellation path.
- Diagnostic cleanup needs both an explicit verified pass before result
  construction and an idempotent finalizer for interruption. This permits a
  stable `cleanup-failed` outcome when the normal cleanup attempt does not
  remove all resources.
- Promise-backed setup must not mutate shared cleanup state before ownership is
  acquired. `Effect.acquireRelease` makes acquisition and finalizer registration
  atomic with respect to interruption; later setup can proceed only after the
  owned resource has a registered release.
- External probe paths should be grouped beneath one atomically created owned
  directory. Recording prospective individual paths before creation risks
  deleting a path the diagnostic never owned.
- Dynamic Windows paths should not be interpolated into `cmd.exe` syntax.
  `sandbox_test` uses a fixed encoded PowerShell launcher for the executable and
  script and transports script arguments as base64 JSON through one allowlisted
  environment key. It also supplies fixed `ELECTRON_RUN_AS_NODE=1` because the
  packaged Desktop utility process uses the Electron executable for Node child
  scripts.
- Native sandbox CI is not meaningful until its host setup is explicit. Windows
  needs the elevated sandbox-account/WFP installation; Ubuntu needs
  `bubblewrap`, `socat`, `ripgrep`, and an AppArmor user-namespace allowance.
  The current workflow provisions none of these, so the gated test must not be
  described as OS-enforcement coverage.
- Diagnostic result schemas and renderers should enumerate fixed probe names.
  Iterating arbitrary decoded object properties could expose unknown fields even
  when the TypeScript type appears closed.

## Artifacts

- Artifact metadata uses the existing application database so Session and tool
  ownership remain in one transaction domain. A separate `koala.db` would need
  an independent migration lifecycle and is deferred.
- Logical `art_<uuid>` identity is distinct from lowercase SHA-256 blob identity.
  Multiple artifacts can share immutable content while preserving separate
  provenance and lineage.
- Sandbox artifacts are opt-in outputs beneath a reserved `artifacts/`
  directory. Recursive promotion is not used because temporary files are not
  necessarily deliverables.
- Promotion is serialized and derives run byte/count totals from committed
  metadata rather than trusting callers. Limits are 10 outputs, 100 MiB per
  artifact, and 250 MiB per run.
- Candidate validation rejects traversal, cross-platform reserved paths,
  directories, symbolic links, junctions, hard links, and files that change
  while one opened handle is hashed and copied.
- Blob publication uses a destination-local temporary file and no-overwrite hard
  link. Filesystem publication precedes the metadata transaction, making an
  orphan blob possible but not a committed row pointing to a missing blob.
- The initial MIME validator recognizes PNG, JPEG, GIF, WebP, PDF, ZIP, strict
  UTF-8 text, and generic binary. Deep Office/PDF/archive validation remains a
  later phase.
- Sandbox output and violation text redact the private artifact storage root;
  returned artifact references contain no bytes or absolute storage paths.

## Industrial Tools

- Industrial tools share one browser-safe contract version and exhaustive
  permission mapping. Tools remain absent from the registry until their engine
  and hostile-input tests pass.
- Durable audit starts before permission or engine side effects and stores only
  canonical input digests, safe counts/types, terminal state, engine identity,
  and artifact references. Producer and model-projection truncation are separate
  durable facts.
- Cancellation and deadline outcomes must be recorded when the abort event
  occurs; cleanup grace cannot remain a window in which delayed operation
  success wins outside an active publication commit.
- Artifact publication needs an explicit commit handshake with execution.
  Cancellation before commit remains terminal, cancellation during commit is
  resolved by the transaction outcome, and a committed publication remains a
  success even if caller cancellation arrives immediately afterward.
- The final typed result must be handed off before leaving the uninterruptible
  commit region. Otherwise a deferred Effect interruption can commit artifact
  rows but interrupt the operation before Industrial Execution can return or
  audit their IDs.
- A worker-owned timeout and an outer timeout must not race without preserving
  the first abort source. Sandbox execution uses the worker timeout as its single
  timeout authority, while the shared boundary still owns caller cancellation.
- Returned artifact references are untrusted protocol data until their complete
  reference fields, Session ownership, and applicable output provenance match
  ArtifactStore metadata.
- Blob rollback cleanup must run under the same process-local and cross-process
  promotion locks as deduplication, and may unlink only a blob created by the
  failed batch after confirming no committed artifact references it.
- Rollback cleanup errors cannot be discarded. ArtifactStore exposes typed
  reconciliation, runs it at startup under the promotion locks, and logs failed
  rollback/startup cleanup so residual orphans receive a later retry.
- Reconciliation may remove valid digest blobs immediately after proving they
  are unreferenced under the promotion lock. Temporary blob files and abandoned
  run staging require an age threshold; current-process active runs and recent
  entries remain untouched.
- Audit call IDs are upstream opaque strings, not slug identifiers. They remain
  bounded and reject control characters at both schema and database boundaries.
- Permission waiting must race caller cancellation; engine deadlines begin only
  after permission approval.
- Project paths become stable artifacts only after external-directory/read
  authorization. Same-Session artifact ownership is checked before materializing
  a private processing snapshot.
- Multi-output sandbox publication validates/copies every candidate before one
  metadata transaction. Filesystem publication may leave reclaimable orphan
  blobs, but failed batches leave no partial artifact metadata.
- A deterministic calculator should share one generator-based evaluator between
  synchronous tests and cooperative Effect execution. Yielding at bounded
  operations keeps cancellation and deadlines observable without duplicating
  arithmetic semantics.
- Unit suffix precedence must distinguish `2 m^2` from `(2 m)^2`: the first
  applies the exponent only to the unit dimension and scale, while the second
  raises the complete quantity. Function and unit registries also need own-
  property checks so prototype names cannot enter dispatch.

## Document Runtime

- Production document workers derive worker, PDF.js, canvas, Tesseract, and
  tessdata paths from one verified root. Release staging and packaged startup
  obtain the manifest digest from a detached attestation outside that root;
  they do not derive trust from the manifest being checked.
- PDF.js plus `@napi-rs/canvas` provides a permissively licensed local 300-DPI
  renderer. Pages are allocated and released sequentially; fixed pixel, byte,
  page, temporary-storage, and deadline limits apply before publication.
- Office parsing uses `mammoth` (docx), `xlsx` (xlsx), and `jszip` + `fast-xml-parser`
  (pptx), bundled as JS inside the worker, with the same input/output/temporary
  bounds as other document runtime operations.
- Tesseract output is TSV streamed through a bounded file. The selected command
  uses English recognition with OSD-enabled page segmentation, one thread, a
  reduced environment, shell-free execution, and process-tree cancellation.
- Native canvas must load only after manifest verification, with system-font and
  native-loader overrides disabled.
- Release preparation and verification require explicit `RUST_TARGET` and
  reject attestations or PE/ELF/Mach-O native headers for another target.
  Development builds alone may infer the build-host target.
- A runtime is not production-ready merely because JavaScript/PDF rendering
  works. `releaseReady` also requires pinned Tesseract/Leptonica binaries,
  English/OSD models, architecture/dependency checks, signatures, and complete
  native licenses/notices for every target. The unresolved Koala license is not
  represented by the OpenCode root license in document-runtime artifacts.
- Runtime parsing requires a trusted native-confinement launcher dependency.
  Environment variables cannot opt into unsandboxed parsing, so document work
  remains unavailable until that launcher is implemented and wired.
- Cross-target release staging needs externally attested target-native smoke
  evidence bound to the manifest digest. A cross-target result is not itself a
  successful probe.
- Final native-process and confinement-launcher reaping must be time-bounded.
  Missing exit confirmation is an explicit cleanup/runtime failure rather than
  an unbounded wait.
- Native security tests need two explicit modes: an ordinary-development skip
  and a release-required mode in which missing capability is a failure. An
  environment Boolean can select the mode, but it is not evidence of a pass.
- Hostile policy probes can replace only the bootstrap in a copied test runtime
  with a newly hashed manifest. Real PDF rendering and bundled Tesseract OCR must
  still run separately against the authentic attested runtime before a native
  report is written.
- Report digests are meaningful only across an issuer/verifier boundary. The
  repository may deterministically construct an issuance subject and verify an
  independently returned signed envelope; it must not manufacture production
  evidence when signing infrastructure is absent.
- A digest list is not an attestation. Evidence needs a canonical signed subject,
  a pinned packaged public key identified from its DER bytes, strict typed report
  decoding, and byte-for-byte verification of both the detached runtime
  attestation and inventoried package resources.
- Release smoke must begin with the distributable artifact. Direct access to an
  unpacked build tree can test runtime behavior but cannot establish installer,
  mount, extraction, package-signature, or final resource-layout properties.
- Release staging should never recursively remove a caller-selected destination.
  Create one absent direct child under an explicit canonical parent, record its
  filesystem identity, and remove it on failure only while that identity still
  matches.
- IPC closure is not durable teardown evidence. A nonce-addressed receipt in a
  trusted sibling root can carry bounded cleanup/reset facts across parent IPC
  loss, but only when its exact canonical bytes, self-digest, file identity, and
  pending-root identity are revalidated after process exit.
- Killing a trusted proxy externally is not evidence that its detached inner
  process tree exited. The supervisor must retain the inner process-group ID,
  sweep it after proxy death, and report containment separately from cleanup or
  reset, which the killed proxy cannot attest.
- Cross-compilation cannot satisfy a native confinement gate. In particular, a
  Windows x64 host building ARM64 artifacts remains a target mismatch until an
  ARM64 runner executes the policy, descendant, cleanup, and packaged smoke
  probes.

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
- Sandbox protocol and policy tests: 31 passed.
- Sandbox worker, adapter, runtime-flag, registry, and parameter tests: 82
  passed; the direct host-shell denial test also passed.
- Desktop sandbox path, environment, and packaging tests: 12 passed.
- OpenCode, Koala, and Desktop typechecks passed after sandbox integration.
- The OpenCode Node build and Desktop production build passed with the
  standalone sandbox worker artifact.
- The `sandbox_test` change passed 438 Koala tests, 113 focused OpenCode tests
  with 1 native capability-gated skip, and 11 targeted Desktop tests. Koala,
  OpenCode, and Desktop typechecks, the OpenCode Node build, the single-target
  Windows x64 build/smoke test, and the Desktop production build passed.
- This Windows host still reports sandbox availability as
  `initialization-failed`; native diagnostics therefore remain capability-gated.
- A broader OpenCode tool sweep had 8 Windows path-normalization failures with
  differing `C:\Users\...` and `E:\users\...` views of temporary directories.
  The failing source and test files were not changed in the `sandbox_test`
  implementation.

## Office Readers

- Pure-JS Office readers for `.docx`, `.pptx`, and `.xlsx` can be bundled into the
  existing document worker without adding native dependencies, but they still
  require the same fail-closed confinement boundary as PDF/OCR operations.
- The inner protocol's output transfer is format-agnostic: the proxy creates a
  pending-root file for every completed `output-start`/`output-chunk`/
  `output-end` sequence and must rewrite the following worker event's path to
  that pending-relative file. Forgetting to rewrite `office-ready` would expose a
  sandbox-writable path to the trusted parent.
- It is safer to place office parser output under the job root, stream it
  through the proxy, and let the parent read only from the verified pending
  sibling. Deleting the job-root copy after streaming keeps per-job storage
  bounded.
- Parser-specific warnings (e.g. Mammoth conversion messages) are not size
  signals; enforce limits with file-size checks and bounded output encoding.

## Koala Phase 10

- When using `ModelEndpointClient` to call a local model endpoint, the transport
  only pins the URL/fetch; the caller must add the `Authorization: Bearer <key>`
  header by retrieving the provider's API key from the existing `Auth` service.
- When building result metadata objects for Effect `Schema.optionalKey` fields,
  omit `undefined` optional fields entirely before schema decoding to avoid
  decode failures.
