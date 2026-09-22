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
- Add local document, OCR, vision, Office generation and reading, calculation,
  knowledge, artifact, audit, and network-activity capabilities.
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

Document-runtime confinement Phase 4 is implemented as an inactive standalone
one-job proxy entrypoint. It independently repeats manifest, target, canonical
root, runtime asset, SRT asset, dependency, and effective-policy checks before
spawning the fixed Phase 3 bootstrap descriptor with `shell: false` and bounded
standard streams. The proxy strictly decodes and re-encodes both protocols,
enforces document order, accepts one launch and one cancellation, withholds the
terminal worker event until observed leader exit, a separately verified full-
tree or Job Object sweep, and bounded SRT cleanup/reset, applies curated
teardown-failure precedence, emits one `closed`, and releases its listeners,
timers, queues, and transport. Cancellation is latched across every startup
stage and aborts an active SRT wrap; non-clean spontaneous leader exits and any
post-terminal malformed, overflowing, unterminated, or errored transport replace
provisional success. A PID-less asynchronous spawn error is treated as confirmed
process absence and still runs SRT cleanup/reset. It is not connected to the
production document coordinator; that atomic cutover remains Phase 5. The
existing generic sandbox policy and runtime were not changed.

The final Phase 4 containment review separates leader exit from tree emptiness.
POSIX teardown sends `SIGTERM`, polls process-group liveness with signal zero,
treats `EPERM` as still alive, escalates to `SIGKILL`, and accepts containment
only after `ESRCH` and observed leader exit within one shared deadline. Windows
teardown runs the fixed tree killer, observes leader exit, and then requires an
explicit bounded tree-empty or owned-Job-Object evidence callback. The stock
production dependency supplies no such Windows evidence and therefore returns
`windows-tree-evidence-required`; the proxy withholds SRT cleanup/reset and any
provisional terminal event when containment is not confirmed.

Document confinement Phase 4 verification completed on 2026-09-20:

- The injected proxy lifecycle suite and real bounded-NDJSON fixture process:
  54 passed with 224 assertions.
- OpenCode document and generic sandbox regression suites: 160 passed with 507
  assertions across 7 files.
- Koala document protocol, limit, and transport suite: 188 passed with 386
  assertions across 7 files.
- Document Runtime suite: 82 passed with 192 assertions; 2 existing symlink
  capability tests skipped on this Windows host.
- Koala, Document Runtime, and OpenCode typechecks passed.
- Document Runtime and OpenCode Node builds passed.
- Native SRT confinement was not exercised or claimed; production document
  execution remains inactive pending the Phase 5 coordinator cutover and later
  native release gates.

Document-runtime confinement Phase 5 is implemented. Each coordinator job now
uses a private temporary parent, random child directory, precreated job-local
`tmp`, parent-owned sibling pending directory, canonical paths, and bigint
filesystem identities. The confined worker streams every PNG and TSV through
strict `output-start`, canonical-base64 `output-chunk`, and `output-end` NDJSON
frames before its matching normal event. Ten-KiB raw chunks and requested
per-output, cumulative payload, and live-temporary limits are accounted
separately from the 512-frame/1-MiB control budget. The proxy never opens the
worker path: it writes and hashes decoded bytes serially into an exclusive
random pending file, verifies its identity, exact size, and SHA-256, then
rewrites the normal event to its own pending-relative path and verified digest.
The parent opens only that pending file with no link following and repeats the
identity, size, stability, and digest checks. OCR reads and render callbacks
consume only these stable files; worker-writable paths and transfer payloads do
not cross parent IPC.

After confirmed process-tree exit, cleanup rechecks the parent, child, and
pending identities, refuses link/reparse or replacement traversal, and
atomically renames each owned directory to a random tombstone beneath the
non-writable parent. A short-lived fixed helper performs recursive deletion
under a hard deadline. The parent requires observed clean helper exit,
tombstone absence, an empty identity-matched parent, and verified parent
absence. Timeout, helper error, or missing exit evidence leaves process-known
tombstone names for later reconciliation and marks the runtime unhealthy.
Incremental creation ownership uses the same verified bounded cleanup path;
uncertain creation cleanup also propagates to the unhealthy latch.

The OpenCode coordinator now requires one complete runtime-path, manifest-
digest, proxy-path, and proxy-assets configuration and launches only the
canonical proxy beneath that assets root. It wraps launch, continuation, and
cancellation in the strict outer protocol, reserves lifecycle transitions
synchronously before serialized bounded IPC sends, independently advances outer
and inner ordering, retains the process-global two-job semaphore, and accepts
success only after the terminal event, `closed`, IPC disconnect, clean proxy
exit, bounded stdout/stderr end-and-close drainage, output promotion, and
verified tombstone and parent deletion. Late send callbacks cannot replace a
newer cancellation or terminal state. Missing closure, unconfirmed termination
or deletion, diagnostic overflow/error/incomplete drainage, and proxy-reported
command-cleanup, reset, or termination failures set the unhealthy latch in the
owning `DocumentRuntime.layer(config)` service instance; a cleanly
closed parser failure does not. Independent layers have independent health,
while the single layer retained by `makeGlobalNode` keeps production health
process-global. Later jobs through a poisoned layer fail closed.

The proxy independently validates that `jobRoot` and `pendingRoot` are canonical
non-link direct siblings beneath the same private parent. Only `jobRoot` enters
the sandbox allowlists, command working directory, and bootstrap handoff;
`pendingRoot` is explicitly denied to the sandbox and remains proxy/parent-owned.
Output transfer IDs are job-unique, only one transfer may be active, chunk
sequences and exact final-short geometry are enforced, and duplicate,
interleaved, missing, trailing, malformed, oversized, or digest-mismatched
payloads enter curated teardown without exposing base64, paths, or bytes.
Recorded private-parent, job-root, and pending-root bigint identities cross the
JSON outer protocol as strict canonical decimal strings and return to bigint
before policy and filesystem comparisons. Proxy and parent pending-file
operations revalidate both parent and pending canonical paths, non-link status,
and identities around create, open, finalize, read, and release boundaries;
root-evidence mismatch has a distinct proxy failure and marks the process
unhealthy. The worker fills each logical 10-KiB output chunk across repeated
short reads before encoding it. Parent shutdown uses one absolute ten-second
deadline shared by cancel delivery, cooperative closure, tree reaping,
diagnostic drainage, tombstoning, and helper deletion, with time reserved for
the deletion phase rather than adding independent maxima.

Proxy pending-file creation is a transactional acquisition: the exclusive
zero-byte handle, path, and bigint identity are retained immediately after open;
post-open root and pathname identity checks complete before the receiver accepts
or writes a payload chunk. Failure closes the handle and removes the entry only
when the original root and file identity can still be proven. Handle close is
attempted exactly once and its result is retained through output-end and cleanup;
an unconfirmed close is a root/cleanup failure and marks the runtime unhealthy.
POSIX private
parents become owner read/execute-only after both children are created and are
restored to owner-only writable mode solely by trusted cleanup after confirmed
tree exit. Windows remains unavailable without the existing ACL-reset and Job
Object evidence gates.

The direct document-worker launcher, parent-built inner environment, legacy IPC
adapter and self-start, production document-runtime `process.send` calls, direct
IPC compatibility test, and seven direct-worker fixtures are removed. Runtime
tests use one real outer-protocol proxy fixture, and structural tests reject a
direct worker launch or source proxy fallback. Phase 6 still needs to build,
stage, and resolve the production proxy and SRT assets, so default production
configuration remains unavailable until those values are supplied.

Document confinement streaming-handoff remediation verification completed on
2026-09-21:

- OpenCode document, proxy, sandbox, and `sandbox_execute` regressions: 202
  passed with 647 assertions.
- Document Runtime suite: 82 passed with 199 assertions; 2 existing symlink
  capability tests skipped on this Windows host.
- Koala document-runtime suite: 202 passed with 426 assertions.
- Desktop document-runtime, sandbox-runtime, sidecar-environment, staging, and
  packaging suites: 27 passed with 59 assertions.
- Koala, Document Runtime, OpenCode, and Desktop typechecks passed.
- Document Runtime, OpenCode Node, and Desktop builds passed; both emitted
  worker files passed `node --check`.
- Native SRT confinement was not exercised or claimed. This Windows host still
  lacks the Phase 7 native loader, Job Object, ACL reset, and WFP evidence, and
  stock SRT `0.0.76` remains unable to provide the required ACL-reset evidence.

Document-runtime confinement Phase 6 is implemented. The OpenCode Node build
cleans its sandbox-runtime output before emitting the generic sandbox worker and
the standalone minified document proxy. It writes one strict target manifest
covering hashes, sizes, modes, the SRT license and Java agent, and only the
selected target's Linux seccomp or Windows SRT helper. Build tests inspect the
exact output inventory, reject document parser/native-module and source fallback
imports, run the proxy through Node syntax checking, and exercise malformed IPC
rejection through a real Node child process.

Desktop now resolves the sandbox worker, document proxy, and SRT assets as one
verified target-specific tree. Resolution checks the closed manifest and exact
file inventory, hashes, modes where supported, non-link paths, PE/ELF helper
architecture, fixed development build location, and packaged resource
containment. The document resolver re-verifies that tree, requires a complete
runtime/proxy/assets tuple, and requires the packaged runtime, proxy, SRT assets,
and detached attestation beneath the canonical Electron resources root. A new
versioned confinement-evidence schema binds the target, runtime and proxy
digests, sandbox manifest, SRT and policy versions, native report, packaged
smoke report, signing report, exact signed-file inventory, and dependency report
by SHA-256 rather than Boolean claims. Beta/prod staging and package
configuration reject absent or mismatched evidence before packaging, and
packaged execution remains unavailable under the same gate. Development again
resolves its built host-target runtime and built proxy/assets; native SRT policy
and platform evidence remain authoritative. Missing, stale, linked,
wrong-target, wrong-architecture, partial, or changed resources remain
unavailable.

The PE helper parser requires the complete COFF header, a declared PE32+
optional header of at least `0x70` bytes, a declared range contained in the
file before reading its magic, PE32+ magic `0x20b`, the expected x64/arm64
machine, and the executable-image characteristic. Tests cover both target
architectures, undersized nonzero headers, the exact minimum boundary, truncated
headers, PE32 substitution, missing executable characteristics, and malformed
files.

The Desktop sidecar case-insensitively strips every inherited document-runtime
key and `KOALA_SANDBOX_WORKER_PATH`, then adds values only from complete verified
resolver results. Development and release staging remove owned
staged runtime, attestation, and temporary paths before rebuilding or copying,
and reject overlapping source/destination roots. Electron Builder verifies the
sandbox-runtime manifest before loading package configuration and places the
generic worker, document proxy, target SRT assets/license, document bootstrap,
document worker/runtime, runtime manifest, and detached attestation in explicit
`extraResources` outside `app.asar`.

The repository now patches pinned SRT `0.0.76` so configured Java-agent,
seccomp, and Windows helper paths are mandatory regular files and are
identity/digest checked again before wrapping. Missing or changed assets fail
closed, and the emitted proxy is scanned to exclude npm-global, system-prefix,
Homebrew, and home-directory lookup strings. The build test creates an isolated
output, seeds stale proxy/bootstrap files, invokes the real build once, and
checks stale removal and the exact resulting inventory without relying on the
workspace `dist` tree.

Document confinement Phase 6 verification completed on 2026-09-21:

- OpenCode Node build passed and emitted the Windows x64 proxy plus one Windows
  x64 SRT helper tree.
- OpenCode document, sandbox, patched-dependency, and build suite: 233 passed
  with 766 assertions.
- The emitted document proxy passed `node --check` and the real Node IPC
  malformed-launch rejection test.
- Desktop resolver, sidecar-environment, staging, and package-configuration
  suites: 39 passed with 116 assertions.
- Document Runtime build and suite: 82 passed with 199 assertions; 2 existing
  symlink-capability tests skipped on this Windows host.
- Koala document-runtime contract suite: 204 passed with 428 assertions.
- OpenCode, Koala, Desktop, and Document Runtime typechecks passed.
- Desktop production build passed, including fresh OpenCode and development
  document-runtime builds.
- Native SRT confinement was not exercised or claimed. Phase 7 target-native
  policy, teardown, packaging, and installed-app evidence remains required.

Document-runtime confinement Phase 7 code-owned gates are implemented without
enabling a target. Confinement evidence is now a detached version-3 subject in a
version-1 Ed25519 envelope. The canonical signed bytes bind target,
runtime-manifest and detached-attestation digests, proxy and sandbox-manifest
digests, SRT/policy versions, release version, source commit, build identity,
the five report digests, and the SHA-256 key ID derived from the issuer's SPKI
DER public key. The public key, release identity, strict reports, inventory, and
envelope are packaged together. Staging and packaged startup both derive the key
ID, verify the signature, decode every report with excess-property rejection,
and compare every binding and inventoried file. Repository code has no private
key or self-issuance path.

The capability-gated OpenCode native suite uses the exact built one-job proxy
whose bytes match the sandbox manifest and a real SRT policy with a manifest-
bound hostile bootstrap in a copied test runtime. It
checks allowed runtime/job operations; denied project, home, credential,
sibling, pending, application-resource, runtime-write, and system-temp access;
DNS/TCP/UDP/loopback/bind/socket denial; runtime replacement and link attacks;
output substitution; crash and inner disconnect; held-open descendants; parent
interruption; proxy nonreuse; and verified private-root deletion. Accepted runs
require a terminal result, `closed`, IPC disconnect, clean proxy exit, and no
cleanup/reset/termination failure. The `closed` event carries fixed tree,
manager, cleanup-count/completion, and reset-count/completion fields; accepted
runs require one completed cleanup and reset, while pre-initialization closures
must report zero calls. A separate pass uses the authentic release
runtime for PDF rendering, bundled Tesseract OCR, release, cancellation, and
cleanup. Both paths replace `PATH` with a Tesseract trap while SRT uses only its
audited absolute helpers. Ordinary development skips this one native test.
`KOALA_REQUIRE_DOCUMENT_CONFINEMENT=1` enters it and treats every missing input
or capability as failure.

The outer launch now carries a random 256-bit receipt nonce. After confirmed
tree containment and the teardown attempt, the proxy writes one exclusive,
bounded, canonical receipt beneath the identity-verified pending root. The
receipt contains only job identity, nonce, terminal category, containment, and
cleanup/reset counts and completion flags. Its SHA-256 covers canonical payload
bytes. Normal closure binds the same values and digest in `closed`; after parent
IPC loss, the coordinator waits for proxy exit, sweeps the recorded inner
process group, and accepts cleanup reconciliation only from the stable receipt.
An externally killed proxy produces no receipt and therefore cannot claim
cleanup/reset completion; native tests record descendant containment separately.

Desktop now has an installer-only smoke script with a hostile system-Tesseract
`PATH` trap and deterministic typed report output. It mounts a DMG, silently
installs an NSIS executable into owned temporary storage, or extracts an
AppImage, then discovers exactly one installed resource root. It has no checkout
or unpacked-build fallback. Candidate smoke supplies the report before issuance;
final smoke verifies that the installed report bytes, detached attestation,
public key, signature, release identity, and exact inventory match the envelope.

The publish matrix runs these gates only for an actual release. It builds a
non-publishable candidate whose packaged resolver remains unavailable, runs the
native and installed candidate gates, obtains external Ed25519 evidence, copies
the complete verified resource set into a fresh owned staging child, and then
builds and installs the final package. Non-release packages use the development
channel and omit release evidence. Windows ARM64 is bound to an ARM64 self-
hosted runner label rather than an x64 cross-build runner.

Candidate staging accepts only canonical, disjoint runtime, sandbox, base-
attestation, public-key, and destination paths. Its destination must be absent
and be a direct child of the explicit staging parent. Final staging similarly
creates one absent owned child, records its filesystem identity, rejects reuse
without a valid ownership marker, and removes a failed copy only while the
created identity still matches.

No Phase 7 native pass or production evidence exists in this checkout. This
Windows x64 host still lacks approved loader evidence, Job Object tree evidence,
ACL-reset reconciliation, and provisioned WFP/sandbox-account state; stock SRT
`0.0.76` remains insufficient for the Windows gate. Authentic six-target
runtimes, complete native notices/dependency closure, target signing reporters,
an Ed25519 issuer/public-key pair, a Linux package-signature verifier, and
provisioned native runners remain external inputs.

Phase 7 review-remediation verification completed on 2026-09-21:

- Koala complete suite: 568 passed; typecheck passed.
- Document Runtime complete suite: 82 passed and 2 existing symlink-capability
  tests skipped; build, typecheck, and both generated-worker syntax checks
  passed.
- OpenCode document, sandbox, and `sandbox_execute` suites: 216 passed and the
  single Phase 7 native test skipped in ordinary-development mode; typecheck and
  Node proxy build/syntax check passed.
- The document coordinator suite also passed three randomized seeds with every
  test file rerun three times; each seed completed 48 runs without failure.
- Desktop evidence, smoke, staging, resolver, sidecar-environment, and packaging
  suites: 47 passed and 1 platform-capability test skipped; typecheck and
  production build passed.
- Required native mode was invoked on this Windows x64 host and failed, rather
  than skipped, because the packaged candidate resource root was not
  provisioned. A separate ARM64 target check failed with explicit host
  `x86_64-pc-windows-msvc` versus target `aarch64-pc-windows-msvc` mismatch.
- No native report, smoke report, issuance request, or production attestation
  was generated during local verification.
- `.github/workflows/publish.yml` parsed successfully with the locally installed
  Python YAML parser.

Milestone 1 of Koala Phase 10 is implemented. The document-runtime protocol gained a `read-pdf` initial request and a streaming `pdf-info` terminal event. The worker now runs a pure-JS PDF text/metadata reader using the bundled `pdfjs-dist`, extracting page count, document metadata, page boxes/rotation, and text blocks while enforcing requested input-byte and page limits. The OpenCode `DocumentRuntime` service exposes a typed `readPdf(input)` method that stages the file, drives the proxy, collects the streamed JSON output, verifies size/digest, and parses the result.

Files added:

- `packages/document-runtime/src/read/pdf.ts`
- `packages/document-runtime/src/read/index.ts`
- `packages/document-runtime/test/read.test.ts`

Files modified:

- `packages/koala/src/document-runtime/protocol.ts` — `ReadPdfRequest`, `PdfInfoEvent`, `"read-pdf"` operation, `"pdf-text"` output frame, order/output state-machine wiring, new failure code.
- `packages/document-runtime/src/index.ts` — export read module.
- `packages/document-runtime/src/worker.ts` — `read-pdf` dispatch and `executeReadPdf`.
- `packages/opencode/src/document/runtime.ts` — `ReadPdfInput`, `ReadPdfResult`, `readPdf`, `pdfWorker`.

Verification completed on 2026-09-22:

- `packages/koala`: `bun typecheck` passed.
- `packages/document-runtime`: `bun typecheck` passed; full suite 88 passed, 2 skipped, 0 failed.
- `packages/opencode`: `bun typecheck` passed; focused `test/document` suite 179 passed, 1 skipped, 0 failed.
- The broader `packages/opencode` full test run timed out and showed pre-existing unrelated failures in `project/vcs.test.ts` (carriage-return diff parsing) and `provider/cf-ai-gateway-e2e.test.ts` (unsupported provider).

Milestone 2 of Koala Phase 11 is implemented. The document-runtime side of DOCX generation and validation is wired end to end. `docx@9.7.1` is added to `packages/document-runtime`, locked in `source-lock.json`, bundled into the worker, and captured in the manifest component/dependency/license inventory. Koala owns `DocumentGenerate.DocxCreate` input/result schemas. The runtime protocol adds `create-docx` initial requests, `docx-ready` terminal events, an `awaiting-docx`/`awaiting-completed` order phase, a `docx-output` output frame, and the `docx-generation-failed` failure code. The worker generates a DOCX from a JSON content description using the `docx` library, validates the OPC package with `jszip` and `mammoth` (structural checks, macro/external-link rejection, compression ratio), streams `generate/output.docx`, then emits `docx-ready` and `completed`. OpenCode `DocumentRuntime.createDocx` writes the content JSON, drives the proxy, collects the binary output, and returns the absolute path and bytes. One-shot result events (`office-ready`, `docx-ready`, `pdf-info`) now advance the order to `awaiting-completed` so the subsequent `completed` event is accepted.

Files added:

- `packages/koala/src/document/generate.ts`
- `packages/document-runtime/src/generate/docx.ts`
- `packages/document-runtime/src/validation/ooxml.ts`
- `packages/document-runtime/test/generate-docx.test.ts`
- `packages/opencode/test/document/runtime-create-docx.test.ts`

Files modified:

- `packages/document-runtime/package.json` — `docx@9.7.1` dependency.
- `packages/document-runtime/source-lock.json` — docx integrity.
- `packages/document-runtime/script/build.ts` — `docx` in `officePackages`; fallback `packageRoot` for packages that do not export `package.json`.
- `THIRD_PARTY_NOTICES.md` — MIT notice for docx.
- `packages/koala/src/index.ts` — export `DocumentGenerate`.
- `packages/koala/src/document-runtime/protocol.ts` — `CreateDocxRequest`, `DocxReadyEvent`, `Operation`, `FailureCode`, order/output state-machine wiring, `OutputSourcePath`, `DocxOutputStart`.
- `packages/document-runtime/src/index.ts` — export generate/validation helpers.
- `packages/document-runtime/src/worker.ts` — `create-docx` dispatch, `executeCreateDocx`.
- `packages/opencode/src/document/runtime.ts` — `CreateDocxInput`, `CreateDocxResult`, `createDocx`, `docxWorker`, request timeout branch.

Verification completed on 2026-09-22:

- `packages/koala`: `bun typecheck` passed; full suite 598 passed.
- `packages/document-runtime`: `bun typecheck` passed; full suite 90 passed, 2 skipped, 0 failed; build emitted the Windows x64 artifact with docx component, dependency, and license file.
- `packages/opencode`: `bun typecheck` passed; focused `test/document` suite 182 passed, 1 skipped, 0 failed.
- `bun.lock` reflects `docx@9.7.1` with integrity `sha512-ilXFf9Moz47ABjFpDiA5s1w9lpb4EFSp7+5iiJSbfyYDM+bpZdAgLlSr7fW4aXhVe/E+F6QCv0EvRVFEd5CsWg==`.

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

## Office Reader Tools (2026-09-21)

The first slice of Koala Office reader tools is implemented:

- Worker protocol adds the `read-office` operation for `.docx`, `.pptx`, and `.xlsx`.
- Office bounds are defined in `packages/koala/src/document-runtime/limits.ts`.
- Parsers live under `packages/document-runtime/src/office/` using `mammoth`,
  `xlsx`, `jszip`, and `fast-xml-parser`, bundled into the worker.
- The OpenCode document coordinator exposes `DocumentRuntime.readOffice` and the
  `docx_read`, `pptx_read`, and `spreadsheet_read` tools in `ToolRegistry`.
- Output is emitted as `office-text` JSON through the existing proxy NDJSON
  transfer and surfaced to the model as Markdown-like structured text.
- `THIRD_PARTY_NOTICES.md`, `infra.md`, and `learning.md` are updated with the
  new Office dependencies and operation.

Verification:

- `packages/document-runtime`: `bun test` passed (86 tests, 2 symlink-capability
  skips on this Windows host); `bun typecheck` and `bun run build` succeeded
  and the staged manifest includes the office component and dependency inventory
  with pinned license files.
- `packages/koala`: `bun test` passed (576 tests); `bun typecheck` passed.
- `packages/opencode`: `bun test test/document` passed (179 tests, 1 native
  capability skip); `bun test test/document/proxy.test.ts` and
  `test/document/runtime.test.ts` passed (73 tests); `bun typecheck` and
  `bun run script/build-node.ts` passed.
- `packages/desktop`: `bun typecheck` and `bun run build` passed.
- The proxy output receiver now rewrites `office-ready` events to the verified
  pending-root path and digest, matching the existing `page-ready`/`ocr-result`
  handoff and preventing the parent from opening a sandbox-writable path.

## Milestone 1 — Koala Phase 10 browser-safe document schemas

Implemented the browser-safe document schema foundation for Phase 10:

- Added `packages/koala/src/document/engine.ts` with decoded `IndustrialTool.Engine`
  identities for `PdfReadEngine`, `OcrEngine`, `OfficeReadEngine`, and
  `VisionEngine`.
- Added `packages/koala/src/document/normalized.ts` with Effect schemas for
  normalized document content: `OcrWord`, `OcrLine`, `PageTextBlock`,
  `PageTextBlock`, `ImageRegion`, `VisualObservation`, `Page`, `Section`,
  `DocumentMetadata`, and `NormalizedDocument`. Coordinates are normalized 0-1;
  absolute dimensions live in `Page.dimensions`.
- Added `packages/koala/src/document/tool.ts` with `PdfRead`, `OcrExtract`,
  `VisionAnalyze`, and `DocumentExtract` input/result pairs. Result schemas use
  `IndustrialResult.make` to produce the checked success/error/cancelled/timeout
  union envelopes.
- Added `packages/koala/src/document/normalized.test.ts` and
  `packages/koala/src/document/tool.test.ts` covering round-trips, invalid
  locators, out-of-range coordinates, inconsistent result states, mismatched tool
  names, and bounded collections.
- Re-exported each module with its namespace (`DocumentEngine`,
  `DocumentNormalized`, `DocumentTool`) and added them to
  `packages/koala/src/index.ts`.
- Added `"./document/*"` to `packages/koala/package.json` exports.

Verification:

- `packages/koala`: `bun test` passed (598 tests).
- `packages/koala`: `bun typecheck` shows two pre-existing errors in
  `src/document-runtime/protocol.ts` unrelated to these changes; the new document
  modules typecheck cleanly.

## Flagged ambiguities

- Legacy `experimental.chat.system.transform` can mutate the assembled baseline system prompt arbitrarily, but V2 plugins do not yet expose an equivalent hook. Decide separately whether to port it, replace dynamic uses with plugin-defined **Context Sources**, or narrow its semantics.

## Session Update — 2026-09-22

Refactored Koala Phase 10 Office readers and registered the new document tools:

- `packages/opencode/src/tool/office.ts` now defines `docx_read`, `pptx_read`, and
  `spreadsheet_read` through `IndustrialExecution.execute`, resolving sources via
  `ArtifactInput.Service`, invoking `DocumentRuntime.readOffice`, and returning
  typed industrial results with the existing friendly markdown preserved as the
  result summary.
- Added `packages/opencode/src/tool/document-common.ts` with shared schema
  helpers (`SourceInput`, `OfficeReadData`, result-schema factory), provenance and
  artifact-reference builders, runtime-error mapping, and normalized-document/OCR
  mapping helpers.
- Added Phase 10 tool adapters in `packages/opencode/src/tool/pdf-read.ts`,
  `ocr-extract.ts`, `vision-analyze.ts`, and `document-extract.ts`. Each wraps
  `IndustrialExecution.execute` with the matching `DocumentTool.*` schema and
  `DocumentRuntime` operation.
- Updated `packages/opencode/src/tool/registry.ts` to import the adapters and
  gate all document tools on `DocumentRuntime.availability()` or
  `process.env.KOALA_ENABLE_DOCUMENT_TOOLS === "1"`. Added `ArtifactInput.node` to
  the registry's dependencies. Document tools remain visible under
  `agentExecution === "sandbox"`.
- Added tests:
  - `packages/opencode/test/tool/office.test.ts` verifies Office reader execution
    and runtime-error mapping with mocked services.
  - `packages/opencode/test/tool/tool-registry-document.test.ts` verifies document
    tools are hidden when the runtime is unavailable and the env flag is unset,
    appear when the env flag is set, and remain visible under sandbox execution.

Verification:

- `packages/opencode`: `bun typecheck` passed.
- `packages/opencode`: targeted tests for Office readers and document-tool
  registry passed (6 tests).

## Session Update — 2026-09-22

Completed the Koala Phase 10 document/vision tool adapters and focused tests:

- Implemented/rewrote adapters to satisfy `IndustrialExecution.execute` contract:
  - `packages/opencode/src/tool/pdf-read.ts` — `pdf_read` using `DocumentRuntime.readPdf`.
  - `packages/opencode/src/tool/ocr-extract.ts` — `ocr_extract` using direct
    `DocumentRuntime.ocr` for explicit pages/images and `renderAndOcr` for PDF ranges.
  - `packages/opencode/src/tool/vision-analyze.ts` — `vision_analyze` using model
    routing, `ModelEndpointClient`, and parsed JSON observations.
  - `packages/opencode/src/tool/document-extract.ts` — `document_extract`
    normalizing PDF, image, office, and text sources through `DocumentRuntime`.
- Fixed `packages/opencode/src/tool/document-common.ts` to omit `undefined`
  optional metadata fields so decoded results satisfy
  `DocumentNormalized.DocumentMetadata` and avoid `optionalKey` decode failures.
- Updated `packages/opencode/src/tool/registry.ts` to add `ModelProfileStore` and
  `ModelEndpointClient` dependencies for `vision_analyze`.
- Added focused adapter tests:
  - `packages/opencode/test/tool/pdf-read.test.ts`
  - `packages/opencode/test/tool/ocr-extract.test.ts`
  - `packages/opencode/test/tool/document-extract.test.ts`
  - `packages/opencode/test/tool/vision-analyze.test.ts`
- Reworked `packages/opencode/test/tool/document-tool-fixture.ts` to provide the
  `ArtifactStore.Service` mock through `LayerNode.compile` replacement of
  `ArtifactStoreLive.node`, satisfying Industrial Execution's same-session
  artifact authentication in tests.

Verification:

- `packages/opencode`: `bun run typecheck` passed.
- `packages/opencode`: targeted document-tool tests passed (8 tests: 5 adapter + 3 registry).

## Koala Phase 10 Milestone 1 completion

- PDF `read-pdf`, OCR, vision analysis, and `document_extract` tool adapters are
  implemented in `packages/opencode/src/tool/`. The Office readers were
  refactored through `IndustrialExecution.execute` and `ArtifactInput.Service`.
- `vision_analyze` now retrieves `Auth` credentials and sends
  `Authorization: Bearer <key>` when the stored credential is `type: "api"`.
- Document tools are gated in `ToolRegistry` on `DocumentRuntime.availability()`
  or the `KOALA_ENABLE_DOCUMENT_TOOLS=1` environment override.
- Structured JSON artifacts and citations are produced; large results are
  promoted as JSON artifacts via `ArtifactStore.promoteBatch`.

Verification completed on 2026-09-22:

- `packages/koala`: `bun typecheck` passed; 598 tests passed.
- `packages/document-runtime`: `bun typecheck` passed; 88 passed, 2 skipped.
- `packages/opencode`: `bun typecheck` passed; `bun test test/document` 179
  passed, 1 skipped; targeted document-tool tests 11 passed.
- `packages/desktop`: `bun typecheck` passed; production build passed.
- `packages/core`: `bun typecheck` passed.
- The broader `packages/core` full test suite timed out on unrelated external
  network activity in `test/skill-discovery.test.ts`.

## Koala Phase 11 Milestone 2 completion

- Updated `packages/koala/src/document/generate.ts` so `DocxCreate.Result` returns
  an `artifact: Artifact.Reference` instead of a host `path`.
- Added `DocumentEngine.DocxCreateEngine` (`docx-writer` v1) in
  `packages/koala/src/document/engine.ts`.
- Implemented the `docx_create` tool adapter in
  `packages/opencode/src/tool/docx-create.ts`. It drives
  `IndustrialExecution.execute`, writes generated DOCX bytes to a staged artifact,
  runs OOXML validation via `validateOoxmlDocx`, and promotes the output through
  `ArtifactStore.promoteBatch`.
- Registered `DocxCreateTool` in `packages/opencode/src/tool/registry.ts`;
  `docx_create` is gated with the other document tools and appears under the
  `KOALA_ENABLE_DOCUMENT_TOOLS=1` override.
- Added `packages/opencode/test/tool/docx-create.test.ts` and updated
  `packages/opencode/test/tool/tool-registry-document.test.ts`.
- Fixed a type-narrowing issue in the pre-existing
  `packages/opencode/test/document/runtime-create-docx.test.ts` so the document
  test file typechecks.

Verification completed on 2026-09-22:

- `packages/koala`: `bun run typecheck` passed.
- `packages/opencode`: `bun run typecheck` passed.
- `packages/opencode`: `bun test test/tool/docx-create.test.ts
  test/tool/tool-registry-document.test.ts --timeout 30000` passed (5 tests).
- `packages/opencode`: `bun test test/document --timeout 30000` passed (182
  passed, 1 skipped).

## Koala Phase 11 artifact validation

- Added `packages/koala/src/document/validation.ts` with `ArtifactValidate` input and
  result schemas, plus a `DocumentEngine.ValidationEngine` identity in
  `packages/koala/src/document/engine.ts`.
- Added `packages/opencode/src/tool/artifact-validate.ts` implementing
  `artifact_validate`. It resolves an artifact/path input, reads the snapshot
  bytes, and runs the existing OOXML validator (`validateOoxmlDocx` from
  `@koala-ai/document-runtime`) directly inside the industrial-execution
  operation. The tool records the validation result and writes a durable
  `koala_tool_audit` row.
- Registered `ArtifactValidateTool` in `packages/opencode/src/tool/registry.ts` so
  `artifact_validate` is gated alongside the other document tools.
- Added `packages/opencode/test/tool/artifact-validate.test.ts` covering valid
  DOCX and invalid content paths.

Verification completed on 2026-09-22:

- `packages/koala`: `bun run typecheck` passed.
- `packages/document-runtime`: `bun run typecheck` passed; 90 passed, 2 skipped.
- `packages/document-runtime`: `bun run build` passed; manifest includes the
  `docx` component, dependency, and `licenses/docx-LICENSE`.
- `packages/opencode`: `bun run typecheck` passed.
- `packages/opencode`: `bun run script/build-node.ts` passed.
- `packages/opencode`: `bun test test/document --timeout 30000` passed (182
  passed, 1 skipped).
- `packages/opencode`: targeted document-tool tests passed (15 tests across
  `artifact-validate`, `docx-create`, `pdf-read`, `ocr-extract`, `vision-analyze`,
  `document-extract`, `office`, and `tool-registry-document`).
- `packages/desktop`: `bun run typecheck` passed.

## Koala Phase 12 Milestone 3: knowledge-base schema

- Added `packages/core/src/knowledge/sql.ts` with Drizzle definitions for the
  inverted-index fallback knowledge-base tables:
  - `koala_knowledge_entry` (FKs: `session(id)`, `koala_artifact(id)`);
  - `koala_knowledge_term` (composite PK on `(term, entry_id)`, FK:
    `koala_knowledge_entry(id)`).
- Generated migration `20260922025546_koala_knowledge_base` under
  `packages/core/src/database/migration/`.
- Regenerated `packages/core/src/database/schema.gen.ts`,
  `packages/core/src/database/migration.gen.ts`, and
  `packages/core/schema.json`.

Milestone 3 of Koala Phase 12 is implemented. Koala owns browser-safe `Knowledge` tool contracts (`knowledge_ingest`, `knowledge_search`, `knowledge_open`), including a branded `KnowledgeEntryID`, typed inputs, and industrial result envelopes. `DocumentEngine.KnowledgeEngine` identifies the `local-knowledge-store` engine. OpenCode provides a process-global `KnowledgeStore` service backed by the migrated `koala_knowledge_entry` and `koala_knowledge_term` tables: it chunks text (respecting newline boundaries and a 1000-character limit, with a `NormalizedDocument` path), tokenizes on lowercase alphanumeric tokens with a minimal English stop-word set, persists entries and per-entry term frequencies, and supports ranked boolean search by exact term overlap. The three knowledge tool adapters (`knowledge_ingest`, `knowledge_search`, `knowledge_open`) go through the shared `IndustrialExecution` boundary, request the correct permissions, resolve source artifacts through `ArtifactInput`, and return correlated result envelopes. The tool registry now yields all three tools and includes them in the built-in set unconditionally.

Files added:

- `packages/koala/src/knowledge/tool.ts`
- `packages/koala/src/document/engine.ts` ( KnowledgeEngine line)
- `packages/opencode/src/koala/knowledge-store.ts`
- `packages/opencode/src/tool/knowledge-ingest.ts`
- `packages/opencode/src/tool/knowledge-search.ts`
- `packages/opencode/src/tool/knowledge-open.ts`
- `packages/opencode/test/koala/knowledge-store.test.ts`
- `packages/opencode/test/tool/knowledge-fixture.ts`
- `packages/opencode/test/tool/knowledge-ingest.test.ts`
- `packages/opencode/test/tool/knowledge-search.test.ts`
- `packages/opencode/test/tool/knowledge-open.test.ts`

Files modified:

- `packages/koala/package.json` — added `./knowledge/*` export.
- `packages/koala/src/index.ts` — exported `Knowledge` namespace.
- `packages/koala/src/document/engine.ts` — added `KnowledgeEngine` constant.
- `packages/opencode/src/tool/registry.ts` — imported, yielded, initialized, registered, and added `KnowledgeStore.node` dependency for the three knowledge tools.

Verification completed on 2026-09-22:

- `packages/koala`: `bun run typecheck` passed.
- `packages/opencode`: `bun run typecheck` passed.
- `packages/opencode`: focused knowledge tests passed:
  - `test/koala/knowledge-store.test.ts`: 3 passed.
  - `test/tool/knowledge-ingest.test.ts`: 1 passed.
  - `test/tool/knowledge-search.test.ts`: 1 passed.
  - `test/tool/knowledge-open.test.ts`: 2 passed.
- `packages/opencode`: `bun test test/document --timeout 30000` returned 182 passed, 1 skipped, 0 failed.
- `packages/opencode`: `bun run script/build-node.ts` completed successfully.

## Final verification — Koala Phases 10-12

Combined verification completed on 2026-09-22 after Milestones 1–3:

- `packages/koala`: `bun run typecheck` passed.
- `packages/document-runtime`: `bun run typecheck` passed; 90 passed, 2 skipped.
- `packages/document-runtime`: `bun run build` passed; manifest includes `docx`
  component/dependency and `licenses/docx-LICENSE`.
- `packages/core`: `bun run typecheck` passed; `bun run migration --check` passed.
- `packages/opencode`: `bun run typecheck` passed.
- `packages/opencode`: `bun test test/document --timeout 30000` passed (182 passed,
  1 skipped, 0 failed).
- `packages/opencode`: targeted tool tests passed (19 tests across
  `artifact-validate`, `docx-create`, `pdf-read`, `ocr-extract`, `vision-analyze`,
  `document-extract`, `office`, `tool-registry-document`, `knowledge-ingest`,
  `knowledge-search`, and `knowledge-open`).
- `packages/opencode`: `bun run script/build-node.ts` passed.
- `packages/desktop`: `bun run typecheck` passed.

One unrelated `packages/core` effect-flock stress test has intermittent failures
under process contention; it is not caused by the document, office, or knowledge
changes.

## Commit / push

- Created `.subagent/phase-10-document-pipeline.md`,
  `.subagent/phase-11-docx-generation.md`, and `.subagent/phase-12-knowledge-base.md`
  to record what each phase's subagents did.
- Fixed `packages/enterprise/src/custom-elements.d.ts`: replaced a stale symlink
  path with a proper `/// <reference path="..." />` directive so the Husky pre-push
  `turbo typecheck` hook can pass on Windows.
- Committed everything as `phase-10-11-12`:
  `feat(koala,opencode,core): implement Phases 10-12 document, docx, and knowledge tools`.
- Pushed to `origin/phase-10-11-12`:
  https://github.com/DurveshN/koala/pull/new/phase-10-11-12

## Rebrand: OpenCode → Koala

After the user updated the desktop icon, the app still showed the old
`OpenCode` name in the window title, HTML title, app menu, updater dialogs,
favicon meta, theme picker, and electron-builder product metadata. The
following changes rebrand the visible product surface to **Koala** while
keeping internal identifiers (app IDs, URL schemes, package scopes, class
names) unchanged to avoid breaking protocols and deeplinks.

### Files changed

- `packages/desktop/src/main/windows.ts` — main window title `Koala`.
- `packages/desktop/src/renderer/index.html` — page title `Koala`.
- `packages/desktop/src/main/index.ts` — `APP_NAMES` and dev fallback to
  `Koala Dev` / `Koala Beta` / `Koala`.
- `packages/desktop/electron-builder.config.ts` — `productName` and protocol
  `name` for dev/beta/prod channels.
- `packages/desktop/scripts/copy-metainfo.ts` — generated Linux metainfo
  product name.
- `packages/desktop/resources/linux/opencode-desktop.desktop` — legacy hidden
  entry name and `/opt/Koala/` install path.
- `packages/app/src/components/windows-app-menu.tsx` — Windows app menu
  heading.
- `packages/ui/src/components/favicon.tsx` — `apple-mobile-web-app-title`.
- `packages/ui/src/theme/context.tsx` — display label for the built-in
  `opencode` theme.
- `packages/ui/src/context/marked-theme.tsx` and
  `marked-theme-register.tsx` — editor theme display name.
- `packages/desktop/src/renderer/i18n/*.ts` — updater strings in all supported
  locales (`OpenCode` → `Koala`).
- `packages/desktop/electron-builder.config.test.ts` — updated Linux legacy
  entry expectation to match `/opt/Koala/`.

### Verification

- `bun turbo typecheck` — 32/32 packages passed.
- `bun test ./electron-builder.config.test.ts --timeout 30000` from
  `packages/desktop` — 12 passed.
- `bun --cwd packages/desktop dev` launched successfully; predev copied the new
  icons (`Copied dev icons from ./icons/dev to resources/icons`) and the app
  started without main-process JS errors.

The EPERM errors seen after launch are unrelated to the rebrand; they came
from a concurrent Electron process holding the `%AppData%\ai.opencode.desktop.dev`
store files.

## Local desktop startup

Command:

```bash
bun --cwd packages/desktop dev
```

(also available as `bun dev:desktop` from the repo root).

Before launching, this runs the desktop `predev` script, which:
- copies dev icons,
- rebuilds `packages/opencode` Node output,
- runs `bun run build` in `packages/document-runtime`,
- downloads the matching native `opencode-cli` binary to `resources/opencode-cli.exe`.

Several source files were incompatible with Node's TypeScript type-stripping
mode that Electron main process uses when loading workspace `.ts` files
directly. Fixes applied:

- `packages/document-runtime/src/error.ts`, `src/manifest.ts`,
  `src/transport.ts` — removed TypeScript parameter properties.
- `packages/koala/src/document-runtime/ndjson.ts` — removed parameter property.
- Added explicit `.ts` extensions to relative imports in
  `packages/koala/src/document-runtime/*.ts` and
  `packages/document-runtime/src/**/*.ts`.
- `packages/desktop/tsconfig.json` — added `allowImportingTsExtensions: true`
  so `.ts` import extensions typecheck under `tsgo -b`.

After these fixes, `bun --cwd packages/desktop dev` launched successfully:
the Electron window opened, the sidecar started on a local port, the backend
reported `server ready`, and first-launch onboarding completed. The command
was left running during verification.
