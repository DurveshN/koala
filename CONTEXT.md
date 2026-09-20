# Koala Project Context

Koala is a local-only sovereign agentic AI workbench for confidential
industrial work. It is based on an independent import of OpenCode Desktop
`v1.18.31` at upstream commit
`014614d35b397775e5d397a490fc72368c894ec2`.

## Product Decisions

- Keep OpenCode Desktop's layout and interaction model initially.
- Ship only a local Desktop product; CLI, TUI, web, and installers are outside
  the current implementation target.
- Connect only to user-configured OpenAI-compatible local or private-network
  endpoints.
- Support multiple model profiles with user-declared capabilities and optional
  probes for `Don't know` values.
- Require context-window and maximum-output values from the user.
- Route coding, document, vision, and other tasks by required capabilities and
  configured model roles, with a user override.
- Remove cloud providers, sharing, remote tools, telemetry, public updates, and
  other nonessential external communication paths.
- Use `@anthropic-ai/sandbox-runtime` behind a Koala-owned interface with an
  empty sandbox network allowlist and no unsandboxed fallback.
- Confine each document job behind one short-lived trusted sandbox proxy with
  one SRT singleton, bounded inner NDJSON, an attested read-only runtime, and a
  private sole-writable job root; production has no direct worker fallback, and
  native enforcement remains unverified pending the release matrix in
  `docs/superpowers/specs/2026-09-20-document-runtime-confinement-design.md`.
- Add local document, OCR, vision, Office generation, calculation, knowledge,
  artifact, audit, and network-activity capabilities.
- Brand the product Koala with a professional geometric and friendly mascot
  identity, eucalyptus green and charcoal palette, and system Light/Dark theme.
- Keep Koala's top-level license separate while retaining required third-party
  notices. The Koala license text has not yet been selected.

## Repository State

- Independent branch: `dev`
- Untouched baseline commit: `41880aa`
- Approved plan: `docs/plans/koala-implementation-plan.md`
- Upstream provenance: `UPSTREAM.md`
- Third-party notices: `THIRD_PARTY_NOTICES.md`
- Infrastructure: `infra.md`
- Implementation learnings: `learning.md`
- Delegated work reports: `.subagent/`
- Koala domain package: `packages/koala`
- Packaging is deferred.

## Development Orchestration

Use subagents for bounded research and implementation tasks. Store concise,
non-sensitive reports in `.subagent/`. The orchestrating agent reviews all
delegated changes, resolves integration concerns, runs verification, updates
project context and learnings, and creates commits.

## Current Milestone

The independent baseline and implementation plan are committed. The first
local-only Desktop slice is implemented:

- Desktop binary updates are disabled in every channel.
- The sidecar receives `OPENCODE_DISABLE_AUTOUPDATE=1` and
  `OPENCODE_DISABLE_SHARE=1`.
- Effective sidecar configuration forces `share: "disabled"` when the sharing
  switch is active, so existing App sharing controls are hidden.
- Inherited OTLP endpoint, header, and resource metadata are removed before the
  sidecar starts.
- Desktop Sentry initialization and Sentry source-map upload integration are
  removed.
- Desktop release-note requests to `opencode.ai` are skipped.
- Desktop notification icons use a bundled local asset.
- The App custom-element declaration uses a portable TypeScript import so the
  Windows checkout typechecks.

Verification completed on 2026-09-17:

- Desktop targeted tests: 12 passed.
- `packages/desktop`: `bun typecheck` passed.
- `packages/app`: `bun typecheck` passed.
- `packages/desktop`: `bun run build` passed.
- Sharing configuration tests: 3 passed.
- `packages/opencode`: `bun typecheck` passed.

The existing custom OpenAI-compatible flow is now Koala's local/private model
form. It collects required limits, tri-state capabilities, roles, enabled state,
and routing priority, then saves canonical profiles through the generated CRUD
client. Raw API keys remain on the existing auth route. The next milestone is
endpoint policy, `/v1/models` discovery, and active capability probes for fields
set to `unknown`. The pure endpoint policy now validates local/private literals,
DNS answer sets, endpoint scope, metadata denials, and redirect statuses. The
sidecar now also has a direct HTTP/HTTPS transport that pins authorized DNS at
socket creation, preserves Host/SNI, avoids environment proxies, and rejects
redirects. A read-only authenticated discovery API now lists model IDs through
this transport with transient-key support, bounded responses, and redacted
errors. The Desktop form now exposes this discovery action and merges model IDs
without discarding manual edits. Canonical profile-backed AI SDK inference now
uses the same pinned transport, with profile base URL and fetch policy taking
precedence over config/plugin overrides. Capability probing is now implemented
end to end: a read-only authenticated API runs a text control followed by
requested OpenAI-compatible streaming, tool, structured-output, image, and
reasoning probes in a fixed sequential order. The Desktop applies only verified
yes/no results to fields that remain unknown and ignores stale responses. Full
deletion of dormant sharing APIs and persistence follows in dependency order.

The isolated sandbox worker and host adapter are implemented around
`@anthropic-ai/sandbox-runtime@0.0.76`. Each availability check or execution
uses one short-lived forked process and schema-validated Node IPC. Execution is
fail-closed, uses strict filesystem and network policy, bounds combined output,
handles cancellation and timeouts, terminates the command process tree, and
performs SRT command cleanup and reset. The Node build emits a standalone
`sandbox-runtime/sandbox-worker.mjs` with the required vendor runtime assets and
license. Desktop packages that directory outside `app.asar`, passes its path to
the sidecar, and selects sandbox-only agent execution. The model-facing registry
exposes `sandbox_execute` instead of `bash`, while the shell implementation also
rejects direct calls in sandbox mode. Artifact-store promotion remains pending.

Verification completed on 2026-09-19:

- OpenCode sandbox, runtime-flag, registry, and tool parameter tests: 82 passed.
- Direct host-shell denial test: 1 passed.
- Koala sandbox protocol and policy tests: 31 passed.
- Desktop sandbox path, environment, and packaging tests: 12 passed.
- `packages/opencode`: `bun typecheck` passed.
- `packages/koala`: `bun typecheck` passed.
- `packages/desktop`: `bun typecheck` passed.
- `packages/opencode`: `bun run script/build-node.ts` passed.
- `packages/desktop`: `bun run build` passed.
- The emitted worker passed Node syntax and real IPC availability checks.
- Native sandbox command execution was not exercised because this Windows host
  reports `initialization-failed` until the required sandbox setup is provisioned.
- Linux filesystem violation reporting remains best effort with runtime version
  `0.0.76`; strict filesystem and network enforcement does not depend on that
  reporting monitor.

Phase 8 artifact-store design is recorded in
`docs/superpowers/specs/2026-09-19-artifact-store-design.md`. The approved first
slice uses the existing application database for metadata, content-addressed
files under `<Global data>/koala/artifacts`, and explicit sandbox output paths.
The first artifact-store slice is implemented. Browser-safe Koala contracts
define artifact identity, digest, output paths, validation, provenance, lineage,
limits, and typed store errors. Core persists blob, artifact, and lineage
metadata through generated migrations `20260919125324_koala_artifact_store`,
`20260919125730_koala_artifact_sandbox_run_index`, and
`20260919133950_koala_artifact_constraints`. The process-global OpenCode store
creates private run staging, validates explicit outputs, streams SHA-256 hashing
and copying, publishes immutable blobs without replacement, deduplicates equal
content, and commits metadata and lineage transactionally. `sandbox_execute`
promotes declared outputs only after a clean run, returns compact references,
redacts private store paths, and always abandons staging. Artifact HTTP delivery,
UI cards, garbage collection, deep document validation, and a separate
`koala.db` remain later slices.

Verification completed on 2026-09-19:

- Koala artifact and sandbox contracts: 72 passed.
- Core artifact database and migration suites: 20 passed.
- OpenCode artifact store, sandbox runtime, worker, registry, and tool suites:
  62 passed.
- Koala, Core, and OpenCode typechecks passed.
- Core migration check passed.
- Desktop production build passed with the artifact store and generated
  migrations in the sidecar bundle.

The full Industrial Tools program design is recorded in
`docs/superpowers/specs/2026-09-19-industrial-tools-design.md`. It covers every
planned tool plus `docx_read`, `pptx_read`, `pdf_read`, and immutable update tools
for DOCX, PPTX, spreadsheets, and PDF. Installers will bundle pinned Tesseract
with English/OSD data and a permissively licensed PDF.js/canvas renderer; users
will not install separate OCR/PDF software. PDF OCR runs on every page, and a
verified vision model receives one page image per call when available.

Phase 9A is implemented. Browser-safe Koala contracts define the closed 22-tool
inventory, permission classes, artifact/path sources, citations, checked result
envelopes, curated errors, bounded projections, audit records, and shared
`sandbox_execute` input/results. Core migration
`20260919162426_koala_industrial_audit` adds normalized artifact source
provenance and the independent `koala_tool_audit` table; generated follow-up
migrations strengthen audit identity, terminal consistency, permission mapping,
and separate producer/projection truncation. The migration explicitly preserves
pre-existing artifact lineage while rebuilding the artifact table.

OpenCode now has process-global Industrial Audit and Industrial Execution
services plus a scoped ownership-aware Artifact Input service. Audits begin
before permission or engine side effects, persist only canonical digests and
safe summaries, and complete through one guarded transition. Path inputs pass
external-directory/read authorization before stable snapshot promotion.
`sandbox_execute` uses the shared typed/audited boundary and atomic batch artifact
metadata publication.

The Phase 9A industrial foundation review is remediated. Industrial Execution
records caller cancellation or its own deadline at the first abort event, keeps
bounded cleanup grace, and authenticates every returned artifact reference
against same-Session ArtifactStore metadata and output provenance. Sandbox
execution delegates timeout authority to the worker boundary and gates artifact
publication through an explicit commit boundary. Cancellation before that
boundary rolls publication back; cancellation during the commit is held pending
until the transaction either rolls back or commits, and committed publication
wins thereafter. The tool constructs and records its final typed result inside
that uninterruptible region, allowing Industrial Execution to recover the exact
result when the operation fiber receives a deferred interruption after commit.
Projection redaction covers arbitrary URI schemes and punctuation-delimited
POSIX, drive, root-relative Windows, UNC, device, and mixed-separator host paths.

Audit tool-call IDs now follow the upstream opaque-string contract while
remaining length-bounded and control-safe. Durable audit constraints enforce
curated error codes, truncation consistency, and valid unique artifact IDs;
legacy combined truncation is conservatively migrated as producer truncation.
Artifact source-project paths now have database constraints equivalent to the
runtime path contract. Artifact promotion uses process-local serialization plus
the existing heartbeat-backed cross-process lock, and removes only blobs created
by a failed metadata batch that remain unreferenced while the lock is held. A
startup and explicitly callable reconciliation pass removes residual orphan files
and unreferenced blob rows. It also removes safely aged blob temporary files and
abandoned run-staging entries while retaining active and recent staging;
reconciliation failures are typed and startup or rollback failures are logged
for a later retry.

Phase 9B foundation is implemented but not release-complete. Koala owns exact
six-target document runtime, manifest, detached-attestation, limits, and IPC contracts. The new
`@koala-ai/document-runtime` package performs local PDF.js 300-DPI rendering,
bounded Tesseract TSV execution, manifest verification, one-page-at-a-time IPC,
cancellation, deadlines, and cleanup. OpenCode provides a process-global
render-and-OCR coordinator, but worker execution now requires an injected native
OS confinement launcher and fails closed without one. Desktop release staging
and packaged startup consume a detached attestation outside the runtime tree.
Release verification requires explicit `RUST_TARGET`, validates a strict
component/source/path/dependency/license/executable profile, and runs offline
probe/render/OCR checks when the artifact target matches the build host. PE,
ELF, and Mach-O headers bind Tesseract and native canvas to the attested target.
Cross-target staging requires externally attested target-native smoke evidence
bound to that target and manifest digest. The production layout gate includes
the PDF.js CMap/ICC/font/WASM trees, canvas support modules, and exact native
package files used by the coordinator. Native and launcher reaping is bounded;
missing exit confirmation is reported as cleanup/runtime failure.

The development runtime contains PDF.js, one target-specific native canvas
package, worker code, manifests, and licenses, but intentionally remains
`releaseReady: false`. It does not yet contain pinned Tesseract 5.5.3,
Leptonica 1.87.0, English/OSD trained data, or their complete native notice and
signature inventory. Koala's own license is unresolved and the runtime no longer
attributes the OpenCode root license to Koala. OCR/document tools remain
unregistered until those six native target artifacts pass packaged offline tests
and the native-confinement launcher is implemented.

The first Phase 9D tool, `calculate`, is implemented and model-visible. It uses
a Koala-owned bounded tokenizer, Pratt parser, and shared generator-based
decimal evaluator; no dynamic evaluation, shell, or sandbox is involved. The
same evaluator supports synchronous contract tests and cooperative Effect
execution so cancellation and the Industrial Execution deadline remain active
during large calculations. It supports decimal arithmetic, right-associative
powers, percentages, bounded functions, dimensional units, and conversions.
Registry lookups require own properties, source-unit suffix powers apply to the
unit rather than the coefficient (`2 m^2` is distinct from `(2 m)^2`), and all
errors carry bounded source spans and curated audit-safe summaries.

The Phase 9D `sandbox_test` diagnostic is also implemented and model-visible
only when sandbox agent execution is enabled. Its Koala contract accepts exactly
an empty object and returns every required probe through a closed stable reason
vocabulary in the shared Industrial Result envelope. The OpenCode adapter asks
for only the fixed `sandbox_test` permission token, checks native runtime
availability before creating staging, and never uses host execution as a
fallback.

An available runtime receives two fixed host-authored runs. The first verifies
private staging reads/writes while testing denial of project reads/writes,
separate external-temporary reads/writes, and loopback TCP. Nonces, paths,
scripts, configuration, native output, and violation details remain outside the
result, projection, and audit; host-side checks independently inspect write
effects and listener connections. The second run publishes a readiness file,
after which the host aborts it with a local signal and accepts only
`cancelled=true` with `timedOut=false`. Cleanup is idempotent, finalizer-backed,
verified before the result is built, and promotes no artifacts. An unavailable
runtime returns ordinary diagnostic data with all execution probes marked
`not-run` and makes no execute call.

The `sandbox_test` review remediation makes preparation interruption-safe.
Staging, the project probe directory, the external temporary directory, the
loopback listener, and each host-created file are acquired with scoped releases,
so cancellation cannot leave an untracked completed acquisition. The project
probe now atomically creates one UUID-named owned directory, places both
canaries beneath it, and removes only that directory. Deterministic tests
interrupt at the staging, project, external, and listener acquisition boundaries
and wait for the suspended setup continuation before checking that resources
were not recreated.

Diagnostic command construction no longer interpolates Windows paths into a
`cmd.exe` command. A fixed PowerShell encoded launcher decodes only the
executable and script path, while script arguments travel as base64 JSON in the
allowlisted `KOALA_SANDBOX_TEST_ARGUMENTS` environment field and are decoded by
the fixed script. The request also sets the fixed `ELECTRON_RUN_AS_NODE=1` flag
so a packaged Desktop utility process invokes its Electron executable as Node.
The Windows test exercises real `cmd.exe` parsing with percent
syntax, spaces, ampersand, caret, parentheses, a quote-bearing argument, and a
trailing backslash.

Combined verification completed on 2026-09-20:

- Koala complete suite: 429 passed.
- Core industrial audit, artifact, and migration suites: 25 passed.
- Document runtime engine/worker suite: 66 passed and 2 capability-gated
  symlink tests skipped.
- OpenCode document runtime, industrial execution, audit, artifact input/store,
  sandbox, calculator, and registry suites: 121 passed.
- Desktop document-runtime, sidecar-environment, and packaging suites: 25 passed.
- Koala, Core, document-runtime, OpenCode, and Desktop typechecks passed.
- Core migration consistency check passed.

Sandbox diagnostic verification completed on 2026-09-20:

- Koala complete suite: 438 passed.
- OpenCode focused sandbox, tool-registry, artifact, audit, and Industrial
  Execution suites: 113 passed and 1 capability-gated native test skipped.
- OpenCode, Koala, and Desktop typechecks passed.
- OpenCode Node build, single-target Windows x64 build/smoke test, and Desktop
  production build passed.
- Desktop sandbox-runtime, sidecar-environment, and document-runtime tests: 11
  passed.
- Native sandbox availability returned `initialization-failed` on this Windows
  host, so no native policy execution result was claimed.
- A broader OpenCode tool sweep reached 471 passed and 1 skipped but had 8
  Windows path-normalization failures involving `C:\Users\...` and the
  checkout's `E:\users\...` mapping. The failing source and test files were not
  changed by this implementation.

Sandbox diagnostic review verification completed on 2026-09-20:

- Koala complete suite: 438 passed.
- OpenCode focused sandbox, registry, artifact, audit, calculator, and Industrial
  Execution suites: 113 passed and 1 capability-gated native test skipped.
- Koala, OpenCode, and Desktop typechecks passed.
- OpenCode single-target Windows x64 build/smoke test and Desktop production
  build passed.
- Native OS enforcement remains unverified. This repository has no sandbox host
  provisioning script: Windows requires an elevated one-time
  `windows-install` that creates the `srt-sandbox` account and machine-wide WFP
  filters; Ubuntu requires `bubblewrap`, `socat`, `ripgrep`, and an AppArmor
  policy or privileged sysctl allowing capability-bearing unprivileged user
  namespaces. The existing CI jobs install neither configuration.

Phase 9B runtime-review remediation details:

- Document runtime build and suite: 66 passed, 2 capability-gated symlink tests
  skipped because this Windows host does not permit file symlink creation.
- Koala document-runtime contracts: 79 passed.
- OpenCode document-runtime coordinator: 14 passed.
- Desktop staging, resolution, sidecar environment, and packaging: 25 passed.
- Document runtime, Koala, OpenCode, and Desktop typechecks passed.
- The release remains blocked on authentic six-target native artifacts, complete
  native notices/signatures, a selected Koala license, and a real native-
  confinement launcher.

Document-runtime confinement Phase 1 is implemented. Koala now exposes strict
version-1 parent/proxy schemas, separate initial and continuation worker
requests, exact outer IPC and inner NDJSON transport ceilings, and a pure outer
lifecycle machine that delegates document page ordering to the existing runtime
protocol. Excess nested fields, job and target substitution, invalid lifecycle
sequences, and requested-limit violations are covered without changing the
Node, OpenCode, or document-runtime implementations.

Document confinement Phase 1 verification completed on 2026-09-20:

- Koala document-runtime suite: 177 passed with 222 assertions across 6 files.
- `packages/koala`: `bun typecheck` passed.
- `packages/document-runtime`: `bun typecheck` passed.
- `packages/opencode`: `bun typecheck` passed.

Document-runtime confinement Phase 2 is implemented. Koala now owns a browser-
safe NDJSON codec with fatal UTF-8 decoding and exact line, unterminated-buffer,
frame, aggregate-byte, and pending-write ceilings. Document Runtime adds bounded
Node stream adapters with serialized backpressure-aware writes and permanent
failure behavior. Its minimal bootstrap validates the fixed handoff, clears the
inherited environment, reconstructs only the approved deterministic values, and
then dynamically imports the worker. The confined bootstrap path uses strict
stdin/stdout NDJSON; the current direct coordinator retains an isolated Node IPC
compatibility entrypoint that Phase 5 must delete during its atomic proxy
cutover. Generated-file cleanup failures produce terminal curated failures.
Transport failure clears queued input, blocks later delivery, settles every
pending write, destroys both streams, retains error handlers through asynchronous
shutdown, and detaches all transport listeners when each stream closes. Builds
delete the selected target first and emit separately hashed
`worker/bootstrap.js` and `worker/worker.js` under a hashed root ESM
`package.json`; all three are required by production profiles and Desktop
fixtures. The bootstrap integration test runs from a copied runtime outside the
repository package scope and checks complete stdout framing, bounded empty
stderr, and clean process exit.

Document confinement Phase 2 verification completed on 2026-09-20:

- Koala document-runtime suite: 188 passed with 386 assertions across 7 files.
- Document Runtime suite: 81 passed with 190 assertions; 2 existing symlink
  capability tests skipped on this Windows host.
- OpenCode document coordinator suite: 14 passed with 49 assertions.
- Desktop document-runtime fixture, resolution, staging, and packaging suites:
  22 passed with 54 assertions across 3 files.
- Koala, Document Runtime, downstream OpenCode, and Desktop typechecks passed.
- Both emitted worker JavaScript files passed `node --check`.

Document-runtime confinement Phase 3 is implemented as a document-only OpenCode
policy and process boundary. It validates canonical pairwise-disjoint runtime,
job, and SRT asset roots; resolves the exact runtime and target-specific SRT
files; checks host/target identity; uses fixed loader roots; creates an empty
strict network policy; grants runtime/job reads and job-only ordinary writes;
and explicitly deny-writes the runtime, SRT assets, ambient writable roots, and
SRT persistent compatibility paths. The broker and bootstrap handoff
environments are closed allowlists, and the fixed bootstrap descriptor handles
shell metacharacters without admitting caller commands. Linux resolves and
identity-checks fixed-location `bwrap`, `socat`, `rg`, and shell executables once,
then passes their canonical absolute paths through SRT's supported fields.
macOS similarly checks the fixed `env`, `sandbox-exec`, and shell paths. The
broker uses a fixed system-only `PATH`; inherited search paths are not retained.
Effective SRT config, read, write, network, default-write expansion, and weaker-
mode state is inspected before use. The document-specific tree reaper has fixed
deadlines, handles synchronous and asynchronous tree-killer failures, and
reports success only after an observed child exit. Failed or timed-out Windows
tree-killer helpers are signaled and observed within reserved cleanup time;
missing helper-exit confirmation is a distinct typed unhealthy result.

Windows policy preparation rejects UNC/device/ADS paths and the entire visible-
volume inventory when any entry is non-fixed, nonlocal, unknown, or uses an
unsupported filesystem. It also rejects paths with reported reparse points and
requires complete native volume, reparse, and explicit loader-file/root evidence
with matching filesystem identities. Windows receives no recursive executable-
directory or `SystemRoot` read grant. The evidence and exact volume-deny set are
checked again at the effective-policy boundary. No exact target-specific Windows
loader inventory is currently attested, so the closed loader registry returns
`windows-loader-evidence-required` and Windows remains disabled. Independently,
stock SRT `0.0.76` cannot provide conclusive ACL reset outcomes and returns
`windows-acl-reset-evidence-required` when that check is reached; no weaker
policy is selected.

Document confinement Phase 3 verification completed on 2026-09-20:

- OpenCode document and generic sandbox regression suites: 99 passed with 271
  assertions across 6 files.
- The document policy/process slice: 48 passed with 139 assertions across 2
  files.
- `packages/opencode`: `bun typecheck` passed.
- `packages/opencode`: `bun run script/build-node.ts` passed.
- `packages/opencode`: single-target Windows x64 build and version smoke test
  passed.
- Native confinement was not claimed: this Windows host still lacks provisioned
  SRT account/WFP evidence, and stock SRT `0.0.76` does not expose conclusive ACL
  reset evidence.

## Upstream OpenCode Session Runtime

OpenCode sessions preserve durable conversational history while assembling the runtime context an agent needs to act correctly in its current environment.

## Language

**System Context**:
The structured collection of contextual facts presented to the model as initial instructions and chronological updates.
_Avoid_: System prompt

**Session History**:
The projected chronological conversation selected for a provider turn after applying the active compaction and **Context Epoch** cutoffs.
_Avoid_: Session Context

**Context Source**:
One independently observed typed value within the **System Context**, represented by a stable key, JSON codec, infallible loader, pure baseline/update renderers, and an optional removal renderer for dynamic sources.
_Avoid_: Prompt fragment

**System Context Registry**:
The Location-scoped registry of ordered, scoped producers that contribute to the current **System Context**.

**Mid-Conversation System Message**:
A durable chronological instruction that tells the model the newly effective state of a changed **Context Source**.
_Avoid_: System update, system notification, raw text diff

**Context Epoch**:
The span during which one initially rendered **System Context** remains the immutable provider-cache baseline, ending at completed compaction, Session movement, or an incompatible context transition that requires a fresh baseline.

**Baseline System Context**:
The full **System Context** rendered at the start of a **Context Epoch**.
_Avoid_: Live system prompt

**Context Snapshot**:
The overwriteable model-hidden JSON state used to compare each **Context Source** with the value last admitted to a provider turn.

**Unavailable Context**:
An expected temporary inability to observe a **Context Source** value; the runtime retains its prior effective state and emits no update, or omits it until first successfully loaded.

**Safe Provider-Turn Boundary**:
The point immediately before a provider call, after durable input promotion and any required tool settlement, where context changes may be admitted chronologically.

**Admitted Prompt**:
A durable user input accepted into the Session inbox but not yet included in **Session History**.

**Prompt Promotion**:
The durable transition that removes an **Admitted Prompt** from pending input and appends its user message to **Session History**.

**Provider Turn**:
One request to a model provider and the response projected from that request.

**Session Drain**:
One process-local execution span that promotes eligible input and runs required **Provider Turns** until no immediate continuation remains. A Session Drain has no durable identity or transcript boundary.

**Model Tool Output**:
The bounded projection of a Core-executed tool result persisted in Session history and replayed to the model. A tool may shape this projection semantically, but the Tool Registry enforces the final size limit.

**Managed Tool Output File**:
A temporary file created under OpenCode's shared tool-output directory to retain complete output that was too large for Session history.

**Model Request Options**:
Provider-semantic model settings selected from the Catalog and active Session variant before the LLM protocol adapter encodes them for a provider request.
_Avoid_: Request body, wire options

**Generation Controls**:
Provider-neutral sampling and output controls, partitioned from provider semantics and compatibility wire fields when model metadata enters the Catalog.

**Native Continuation Metadata**:
Opaque protocol-shaped data attached to assistant content and required to continue that content natively with a compatible model, such as a reasoning signature or provider-hosted item identifier.

**PTY Environment**:
The host-supplied environment overlay applied by the server when creating a PTY, observed for the request Location and resolved PTY working directory.

**OpenCode Client**:
The generated Promise and Effect APIs derived from the public `HttpApi`; **Embedded OpenCode** shares the Effect API through an in-memory `HttpClient` against the same router and handlers.
_Avoid_: Remote client

**SDK Contract IR**:
The runtime-neutral compiled representation of the authoritative `HttpApi`, preserving encoded and decoded type projections plus transport metadata so independent SDK emitters can choose their public value model and runtime interpreter.

**Embedded OpenCode**:
A scoped in-process host that structurally extends the **OpenCode Client**, supplies an in-memory HTTP transport, and exposes additional same-process capabilities directly.
_Avoid_: Local implementation

**Page**:
A bounded ordered result containing `items` and opaque `previous` and `next` cursor links for navigating the same query in either direction.
_Avoid_: Response envelope

## Relationships

- A **System Context** is an opaque carrier composed from zero or more **Context Sources**.
- **Session History** contains projected conversational messages and admitted **Mid-Conversation System Messages**; the active **Baseline System Context** remains separate provider-request state.
- The **System Context Registry** uses stable-keyed scoped contributions to assemble the current **System Context**; contributor removal naturally removes its sources at the next **Safe Provider-Turn Boundary**.
- A changed **Context Source** may produce one **Mid-Conversation System Message** containing its newly effective state.
- A **Mid-Conversation System Message** persists the exact combined rendered text sent to the model.
- The current **Context Snapshot** advances atomically with the corresponding durable **Mid-Conversation System Message**.
- A **Context Snapshot** stores one codec-encoded JSON value and, for removable dynamic sources, a pre-rendered removal message per stable **Context Source** key.
- Changes from multiple **Context Sources** admitted at one safe boundary combine into one **Mid-Conversation System Message**.
- Context changes are sampled and admitted lazily at a **Safe Provider-Turn Boundary**, never pushed asynchronously when their source changes.
- At a **Safe Provider-Turn Boundary**, newly promoted user input or settled tool results precede any combined **Mid-Conversation System Message**.
- An **Admitted Prompt** is replayable pending input, not yet model-visible **Session History**.
- **Prompt Promotion** atomically consumes the pending inbox entry and appends its model-visible user message.
- Steering prompts promote at the next **Safe Provider-Turn Boundary** while the current **Session Drain** still requires continuation. Promoting any newly admitted user input resets the selected agent's provider-turn allowance; multiple prompts promoted at one boundary reset it once.
- A queued prompt does not promote while the current **Session Drain** requires continuation. The runner promotes one queued prompt when the Session would otherwise become idle, then reevaluates continuation before promoting another.
- A **Session Drain** is process-local coordination rather than a durable domain entity. Durable recovery must reason from prompts, projected history, provider attempts, and tool state rather than inventing an enclosing execution identity.
- The first provider turn renders the latest complete **Baseline System Context** and initializes its **Context Snapshot** without emitting a redundant **Mid-Conversation System Message**; unavailable initial context blocks the turn instead of persisting an incomplete baseline.
- Initial **System Context** preparation precedes the first durable input promotion so an unavailable baseline leaves that input pending and retryable; ordinary reconciliation remains after promotion.
- Compaction starts a new **Context Epoch** with a freshly rendered **Baseline System Context** and **Context Snapshot**; prior **Mid-Conversation System Messages** remain durable audit history but leave projected model history.
- A newly registered core or plugin-defined **Context Source** absent from the current snapshot emits its baseline rendering once at the next **Safe Provider-Turn Boundary**.
- **Context Source** keys are stable and namespaced; duplicate keys fail composition. `SystemContext.combine(...)` preserves caller order; the **System Context Registry** evaluates producers concurrently and combines them in stable contribution-key order so rendered context remains deterministic.
- Each **Context Source** loader returns one coherent typed value. `SystemContext.make(...)` hides that value type so differently typed sources compose uniformly. Its codec compares and stores that value; its pure renderers produce model-visible baseline, update, and removal text only when needed.
- `SystemContext.initialize(...)` observes a composed **System Context** once and produces a fresh **Baseline System Context** with its **Context Snapshot**.
- `SystemContext.reconcile(...)` observes a composed **System Context** once and returns exactly one next action: unchanged, updated, replacement ready, or replacement blocked.
- `SystemContext.replace(...)` renders a fresh generation after completed compaction or another baseline-replacing transition; it reports replacement blocked while previously admitted context is unavailable.
- **Unavailable Context** uses stale-while-revalidate semantics and is distinct from a successfully loaded absence, which may emit removal text.
- Ordinary **Context Source** loaders return values directly; loaders that intentionally use stale-while-revalidate may explicitly return **Unavailable Context**.
- Nested project instruction discovery after successful reads remains a follow-up; when implemented, discovered instructions must be admitted durably at the next **Safe Provider-Turn Boundary**.
- Location-scoped services naturally re-resolve effective context when a moved session next runs in its destination location.
- Moving a Session clears its active **Context Epoch**, so the destination must initialize a complete baseline before another prompt can promote.
- Instruction discovery, source identity, persistence, and file loading belong to the instruction service; the **System Context** abstraction only composes effectful producers and renders loaded values.
- The first instruction-service slice observes global and upward project `AGENTS.md` files as one ordered aggregate **Context Source** at each **Safe Provider-Turn Boundary**.
- Built-in and instruction context producers register through the **System Context Registry** with stable contribution keys. Plugin-defined context registration and hot-reload lifecycle remain a follow-up built on the same scoped registry seam.
- Selected-agent available-skill guidance is a **Context Source** composed with Location-wide registry sources immediately before Context Epoch admission. It lists only names and descriptions permitted for that agent; skill bodies and locations are exposed only through the permission-checked `skill` tool.
- The selected agent and model are sampled when a provider turn starts. Changes admitted after that boundary apply to the next provider turn and do not restart the current turn.
- Selected-agent available-skill guidance remains a **Context Source**. An agent switch that changes that guidance produces a **Mid-Conversation System Message** while preserving the current baseline.
- Local tool authorization and pending permission requests retain the effective agent of the provider turn that issued the call; a later agent switch cannot change that call's policy.
- Context source changes never wake idle sessions; the next naturally scheduled **Safe Provider-Turn Boundary** loads and compares current values lazily.
- Once admitted, a **Mid-Conversation System Message** remains durable even if the following provider attempt fails and is replayed unchanged on retry.
- **Mid-Conversation System Messages** remain durable Session-message history; normal user-facing transcript surfaces may hide them.
- The date **Context Source** initially preserves host-local calendar-date behavior; a configured user timezone may replace that default later.
- A **Context Epoch** begins with one immutable **Baseline System Context**.
- A **Baseline System Context** is stored durably and reused verbatim across process restarts within its **Context Epoch**.
- A **Baseline System Context** durably preserves the exact joined text used for the active provider-cache prefix.
- Completed compaction starts a new **Context Epoch** on the next provider attempt, folding the current complete **System Context** into a fresh baseline and removing earlier **Mid-Conversation System Messages** from active model history.
- A model/provider switch preserves the current **Context Epoch** and chronological conversation history; the new selection applies to the next provider turn.
- **Native Continuation Metadata** remains in durable history. Provider-turn projection includes it only for a successful exact originating provider/model match; failed turns and incompatible models omit opaque metadata, while non-empty visible reasoning lowers to ordinary assistant text after a model switch. This conservative relation may widen only when recorded provider tests establish compatibility.
- **Model Request Options** remain provider-semantic through Catalog resolution. The Session runner maps them into the LLM package's provider-option namespace; the selected protocol adapter alone owns provider wire encoding.
- **Generation Controls**, protocol-semantic **Model Request Options**, and compatibility request body fields are separate Catalog domains. A shared ingestion adapter partitions legacy and models.dev AI-SDK-shaped options before routing.
- The **PTY Environment** is a server concern rather than a Core PTY concern. PTY creation merges caller values, then the host overlay, then Core-forced terminal invariants such as `TERM` and `OPENCODE_TERMINAL`.
- Networked and **Embedded OpenCode** use the same **OpenCode Client** and preserve the full HTTP encoding, routing, middleware, and decoding boundary; only the `HttpClient` transport differs.
- The Effect-native network constructor obtains `HttpClient.HttpClient` from its environment so callers own transport selection, recording, tracing, retries, and tests. Convenience runtimes may provide a fetch transport separately.
- Creating **Embedded OpenCode** is scoped. Closing its owning Scope releases the in-process server resources, database resources, registrations, and fibers.
- **Embedded OpenCode** exposes shared client capabilities and embedded-only capabilities on one object; consumers do not navigate through a nested `.client` property.
- The beta **OpenCode Client** currently uses plural consumer-facing capability groups such as `sessions`; whether the stable Session namespace should instead be singular `session` must be settled before stabilization. Internal server identifiers do not implicitly define public client names.
- Server's concrete `HttpApi` is authoritative for shared **OpenCode Client** capabilities. Codegen compiles its Session group directly; the Effect runtime uses an equivalent Protocol-only projection so generated artifacts remain independent of Core and Server.
- SDK generation reflects the public `HttpApi` once into an **SDK Contract IR**. Promise and Effect emitters share endpoint structure and transport metadata without being required to expose identical public values: an emitter may select encoded wire types, decoded domain types, compile-time brands, runtime validation, and its own execution abstraction independently.
- The first Effect emitter is the rich projection: it exposes decoded Effect-native values, preserves brands and schema transformations, performs runtime schema decoding, and delegates transport interpretation to `HttpApiClient`. Lighter wire-shaped Effect output remains possible through another emitter policy rather than constraining the shared IR.
- The rich Effect emitter regenerates private executable schemas when the **SDK Contract IR** proves that their transport semantics can be reproduced exactly. Contracts with authoritative custom transformations use the import-based Effect emitter against a Protocol-only client projection whose generated transport output is tested against Server's concrete API; the Promise emitter still derives zero-Effect structural wire types from the same IR.
- `@opencode-ai/protocol` owns Session endpoint construction and middleware placement. Server supplies concrete middleware keys to produce the authoritative build-time API; the client projection supplies transport-only keys without importing Core or Server at runtime.
- The first Promise emitter targets the same clean domain-oriented method organization rather than Hey API source compatibility. It returns unwrapped values directly, rejects declared and infrastructure failures, and begins with minimal client-level transport configuration; result wrappers, interceptors, and legacy generated signatures are outside the initial surface.
- The first Promise emitter parses response syntax and trusts its generated structural types; it does not perform runtime structural validation. Malformed payload syntax fails, while a syntactically valid shape mismatch is not detected at the SDK boundary. Standalone validator generation remains an optional future emitter policy.
- Declared Promise-client failures retain their tagged structural wire values and have generated type guards. Consumers do not depend on generated `Error` subclass identity, preserving discrimination across package copies and realms while remaining structurally aligned with Effect domain errors.
- Promise-client infrastructure failures use one generated `ClientError` class with a structured reason such as transport failure, unexpected status, unsupported content type, or malformed response. Promise methods reject with either a tagged declared domain failure or `ClientError`, matching the Effect client's conceptual domain/infrastructure error division.
- Promise methods accept a separate optional per-call transport-options argument containing `AbortSignal` and header overrides. Cancellation and transport metadata do not enter the domain input object; broader interceptor and response-mode APIs remain deferred.
- Promise streaming methods return a lazy `AsyncIterable` directly rather than a Promise-wrapped stream object. Iteration opens the connection, `AbortSignal` cancels it, and ending iteration closes the underlying request; the Effect emitter analogously returns `Stream` directly.
- Promise SSE connection establishment, declared HTTP failures, and infrastructure failures occur during `AsyncIterable` iteration, beginning with its first `next()` call, rather than during synchronous method construction.
- Neither generated streaming runtime automatically reconnects after disconnection. Promise `AsyncIterable` and Effect `Stream` fail explicitly; live consumers refresh and resubscribe, while durable sequence-based resume remains explicit composition above the generated client.
- Promise client construction is synchronous and network-free. It requires `baseUrl`, defaults to `globalThis.fetch`, accepts client-level headers, and merges them with per-call header overrides.
- Effect client construction accepts an explicit `baseUrl` and obtains `HttpClient.HttpClient` from the Effect environment. It does not install fetch or duplicate per-call transport policy; callers transform/provide the client for headers, tracing, retries, recording, and tests, while fiber interruption owns cancellation.
- Promise and Effect emitters each own their generated public type modules. The **SDK Contract IR**, not a physically shared generated type package, is the common source; this permits zero-Effect wire types and rich decoded Effect types to evolve independently.
- Promise and Effect network clients ship from `@opencode-ai/client` behind isolated root and `/effect` exports. The root has no runtime path to Effect; `/effect` imports only Effect, Schema, and Protocol.
- The Effect-native scoped host belongs to `@opencode-ai/sdk-next`, which will assume the existing `@opencode-ai/sdk` name after legacy consumers migrate. Client remains network-only and SDK depends one-way on Client.
- SDK executes Server's assembled `HttpRouter` in memory. It opens no listener and performs no network I/O, while preserving Server routing, middleware, codecs, handlers, and errors.
- The Effect Client and SDK re-export their decoded datatype facade from Schema so callers do not depend on internal package locations or Core's versioned names.
- A capability intended for both networked and **Embedded OpenCode** belongs in the authoritative public `HttpApi`; embedded-only same-process capabilities extend **Embedded OpenCode** separately.
- `sessions.events({ sessionID, after })` is a public durable Session event stream. It verifies the Session, replays durable events after the optional aggregate sequence, continues with newly committed durable events, excludes live-only fragments, and is transported as SSE in both networked and embedded modes.
- `events.subscribe()` is a distinct public instance-wide live stream for Session and non-Session activity. It has no replay guarantee and includes connection, heartbeat, and instance-disposal lifecycle events; consumers recover from disconnection by refreshing authoritative state.
- A Session ID is not an optional filter on `events.subscribe()`: instance-wide live events and durable Session events have different schemas, replay guarantees, cursors, lifecycle events, and failure behavior.
- The initial common OpenCode Client does not expose server-global event aggregation. `events.subscribe()` is bounded to the connected OpenCode instance or workspace; any future cross-instance administrative stream requires a separately designed API.
- `events.subscribe()` does not automatically reconnect after transport loss. The live-only stream fails with `ClientError`; consumers refresh authoritative state before explicitly opening a new subscription because events missed during disconnection cannot be replayed.
- `sessions.events({ sessionID, after })` returns the generated HTTP client's cold durable event stream and does not build reconnection policy into the endpoint or client constructor. Transport loss fails the stream with `ClientError`. Callers may compose an explicit resuming stream above it by retaining the last observed durable sequence and opening a new subscription with `after`; any reusable resume helper remains a separate API design question.
- The stable `sessions.list(...)` design returns a **Page** in both networked and **Embedded OpenCode**; embedded execution does not define a separate unbounded array-returning list operation. The beta client currently preserves the existing HTTP `{ data, cursor }` envelope until emitter-level Page projection is implemented.
- Session list cursors are opaque branded values carrying continuation query and ordering state. Consumers pass them back unchanged and do not inspect storage anchors or encoded filter fields.
- A Session list continuation accepts only its opaque cursor. Scope, filters, ordering, and page size are fixed by the initial query and carried by that cursor.
- `sessions.messages(...)` returns a **Page** and uses the same cursor discipline as `sessions.list(...)`: the initial request supplies `sessionID`, ordering, and page size; continuation supplies `sessionID` plus only an opaque branded message cursor carrying ordering, page size, direction, and message anchor. Using a cursor with another Session is invalid.
- `sessions.message({ sessionID, messageID })` is a required resource lookup. An unknown Session fails with `SessionNotFoundError`; a known Session with an absent or differently owned message fails with `MessageNotFoundError` without disclosing cross-Session ownership. Absence is not represented as `undefined` across the public HTTP boundary.
- `sessions.interrupt({ sessionID })` first verifies that the durable Session exists, failing with `SessionNotFoundError` otherwise. For a known Session, interruption is idempotent: idle, already-settled, or locally unowned execution is a no-op.
- `sessions.active()` snapshots the current process's foreground Session drain registry as a record of Session IDs to `{ type: "running" }`. Missing IDs are inactive; background subagents and tasks do not make their parent Session active, and process restart clears the registry.
- `sessions.context({ sessionID })` preserves the existing message-only operation. It returns projected conversational messages selected as Session context; it does not include or represent the complete provider request context, whose baseline system context and other contributions remain separate.
- **Open question**: Should a future, separately named operation expose the complete provider request context, including baseline system context, selected source contributions, and context-epoch metadata?
- `sessions.prompt(...)` exposes `resume?: boolean`. Omitting it preserves durable admission followed by an advisory execution wake; `resume: false` requests durable admit-only behavior.
- The public operation remains `sessions.prompt(...)`; `SessionInput.admit` is the internal primitive, while the public `Admission` result and `resume` option express its durable admission semantics.
- `sessions.create(...)` accepts an optional `location`. Omission resolves through the connected OpenCode instance's default or current location; an explicit value selects a known location. Networked and embedded transports use the same handler semantics.
- `sessions.switchAgent({ sessionID, agent })` is part of the common client alongside `sessions.switchModel(...)`. It affects subsequent Session activity and fails with `SessionNotFoundError` for an unknown Session.
- The **Embedded OpenCode** Layer delegates to the same scoped creation path; it does not define a second implementation.
- A **PTY Environment** adapter observes plugins in the request Location while passing the resolved PTY working directory to the hook; standalone servers use an empty adapter.
- A **Mid-Conversation System Message** lowers to the provider's native chronological instruction role when supported and to a wrapped chronological fallback otherwise.
- When the effective aggregate instruction set changes, its **Mid-Conversation System Message** includes the complete current ordered set and supersedes the prior aggregate value; when no ambient instructions remain, the message states that previously loaded instructions no longer apply.
- Ambient project instruction discovery honors `OPENCODE_DISABLE_PROJECT_CONFIG`; global instructions remain eligible.
- Oversized textual **Model Tool Output** retains a bounded preview in Session history while its complete text moves to managed tool-output storage. Arbitrary structured-result size is a separate concern.
- One tool settlement receives one aggregate textual limit, using the configured maximum lines or UTF-8 bytes, whichever is reached first. The limit is provider-independent; token pressure belongs to context assembly and compaction.
- Generic truncation preserves the beginning and end of textual output. Tools may apply a more meaningful strategy before the Tool Registry enforces the final limit.
- A truncated **Model Tool Output** identifies its complete text both in the bounded model-visible preview and as a typed managed output path. Managed output paths do not modify the tool's validated structured result.
- A **Managed Tool Output File** is temporary and may expire after its retention period. The bounded **Model Tool Output**, not the file, is the durable replayable record.
- Failure to retain a **Managed Tool Output File** does not change a successful tool operation into a failed one. The Session records an explicitly lossy bounded output without a path, while operators receive diagnostics for the storage failure.
- Once a tool operation succeeds, bounding its **Model Tool Output** and publishing its one durable settlement form an interruption-safe completion region. Raw oversized success is never published before a later correction.
- When a structured-only result would exceed the **Model Tool Output** limit, its validated structured value remains unchanged for Session consumers while model replay uses a bounded textual JSON preview and optional managed output path.
- Existing tool-managed output paths survive generic bounding. A fallback file retains exactly the complete projected text received by the Tool Registry and never claims to reconstruct output already discarded by tool-specific shaping.
- **Managed Tool Output Files** use globally unique names in one shared flat directory. Their absolute paths are readable and searchable by ordinary tools; other absolute paths remain outside Location-scoped filesystem authority.
- Provider-executed tool results remain provider-native transcript facts outside generic Tool Registry bounding. Their context control requires provider-aware pruning or compaction because some providers require exact structured round-trip payloads.

## Client contract architecture

Semantic values that mean the same thing internally and publicly live in the lightweight Schema leaf. Core consumes Schema for domain behavior; Protocol composes Schema values into paths, payloads, envelopes, errors, cursors, and streams; Server imports both, hosts Protocol's exact groups, and owns protocol/domain adaptation. The root Promise client remains zero-Effect, `/effect` depends on Effect plus Schema and Protocol, and `@opencode-ai/sdk-next` composes the scoped in-process host above Client, Core, and Server.

Shared public records are plain objects declared with `Schema.Struct`. A same-name inferred interface gives object records readable TypeScript signatures without constructors, prototypes, or nominal identity; unions retain explicit type aliases.

Before stabilizing the client API:

- Keep additional public schemas in Schema and additional network groups in Protocol; neither package may transitively load databases, Drizzle, Session execution, providers, watchers, native modules, or WASM.
- Keep concrete Location middleware keys in Server while Protocol owns their placement. Client projections may supply transport-only keys, but must prove generated equivalence with Server's concrete API.
- Project the existing list response envelope to the stable client **Page** shape and enforce separate initial-query and cursor-continuation inputs without changing the hosted V2 wire contract.
- Settle the stable consumer namespace (`session` versus the current beta `sessions`) and use an explicit codegen annotation if the consumer name should differ from the server group identifier.
- Preserve V2 route paths, operation IDs, codecs, errors, middleware behavior, and OpenAPI output while making this change.
- Preserve browser-safe `@opencode-ai/client` and `@opencode-ai/client/effect` bundles through import-boundary tests.
- Define embedded-host placement before supporting multiple hosts over one database. Hosts that share durable Session storage must also share process-local Session execution coordination, or each host must receive isolated storage explicitly.
- Keep an embedded request scope alive until any streamed response body finishes. The initial non-streaming Session surface does not exercise this lifetime boundary; Session and instance event streams must do so before joining the embedded client.

## Example dialogue

> **Dev:** "The date changed while the session was active. Should the **Mid-Conversation System Message** say what the old date was?"
> **Domain expert:** "No. Emit the newly effective date so the agent can act on the current **System Context**."

## Flagged ambiguities

- Legacy `experimental.chat.system.transform` can mutate the assembled baseline system prompt arbitrarily, but V2 plugins do not yet expose an equivalent hook. Decide separately whether to port it, replace dynamic uses with plugin-defined **Context Sources**, or narrow its semantics.
