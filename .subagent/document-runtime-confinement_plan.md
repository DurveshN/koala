# Document Runtime Confinement Implementation Plan

## Goal

Route every document-runtime job through one short-lived, native SRT-confined
proxy before any PDF.js, canvas, Tesseract, or document bytes are loaded. Keep
document execution unavailable unless the proxy, verified runtime, SRT assets,
and target-native evidence all pass. Remove the direct worker launch path and
clean every generated output, per-job directory, listener, timer, and child
process.

## Invariants

- One proxy process, one `SandboxManager` singleton, and one document job.
- Parent/proxy communication uses bounded Node IPC; proxy/worker communication
  uses bounded NDJSON over stdin/stdout. Strict base64 output frames have
  separate frame and payload accounting from the existing control budget.
- The verified runtime is read-only. The private job root is the only ordinary
  writable location visible to the sandbox. A parent-owned sibling pending root
  is writable by the trusted proxy and parent but is never exposed to the inner
  process. Network access is empty and strict.
- The proxy imports no document parser or native document module.
- The bootstrap clears and reconstructs the environment before dynamically
  importing the document worker.
- A worker success remains provisional until inner exit, SRT command cleanup,
  SRT reset, proxy `closed`, clean proxy exit, output checks, and verified job
  and pending-root deletion.
- The parent resolves outputs only beneath the pending root. Neither parent nor
  proxy opens a worker-reported output path.
- No direct worker, source TypeScript, system package, `PATH`, download, or host
  execution fallback exists.
- A skipped native test is not release evidence.

## Phase 1: Closed Proxy Protocol

Create:

- `packages/koala/src/document-runtime/sandbox-protocol.ts`
- `packages/koala/src/document-runtime/sandbox-protocol.test.ts`

Modify:

- `packages/koala/src/document-runtime/protocol.ts`
- `packages/koala/src/document-runtime/protocol.test.ts`
- `packages/koala/src/document-runtime/limits.ts`
- `packages/koala/src/index.ts`

Implement strict version-1 schemas for `launch`, `command`, `cancel`,
`accepted`, `event`, `failure`, and `closed`. `launch` carries canonical sibling
`jobRoot` and `pendingRoot` values. Add runtime schemas that separate initial
document requests from continuation requests and add a closed inner output union
for `output-start`, `output-chunk`, and `output-end`. Give each transfer a
branded unique `outputID`, kind, page identity, canonical worker source path,
declared bytes, exact sequence, actual bytes, and lowercase SHA-256. Add
`outputID` and `outputSha256` to normal `page-ready` and `ocr-result` events so
the proxy can publish its verified transfer identity and digest with its
rewritten pending-relative path. Every
trust-boundary decode rejects excess properties. Add pure outer, document-order,
and output-transfer state machines that validate job identity and lifecycle.

Centralize these limits:

- outer IPC message: 65,536 UTF-8 bytes;
- outer pending queue: 32 messages;
- NDJSON line and unterminated buffer: 16,384 bytes;
- NDJSON control frames: 512 per direction;
- NDJSON control aggregate: 1,048,576 bytes per direction;
- decoded output chunk: 10,240 bytes, with every non-final chunk exactly full;
- PNG dimensions: 10,000 pixels per side and 25,000,000 pixels in area;
- PNG output: requested limit, at most 67,108,864 bytes;
- TSV output: requested limit, at most 33,554,432 bytes;
- live incomplete plus completed-unreleased output: requested temporary limit,
  at most 262,144,000 bytes;
- cumulative standalone OCR payload: one requested TSV limit;
- cumulative render payload: `pageCount * (requested PNG + requested TSV)`, at
  most 10,066,329,600 bytes for 100 pages;
- inner stderr: 65,536 bytes.

Output framing messages and canonical base64 bytes do not consume the 512-frame
or 1-MiB control totals. Their exact maximum count is derived from declared
bytes and the full-chunk rule: 6,554 PNG chunks, 3,277 TSV chunks, and 983,100
chunks for a hard-limit 100-page render/OCR job, plus one start and end per
output. All frames still obey the 16,384-byte line and receive-buffer limits.

Verification from `packages/koala`:

```text
bun test src/document-runtime
bun typecheck
```

Commit boundary: `feat(koala): add document sandbox protocol`.

## Phase 2: Bounded NDJSON And Bootstrap

Create:

- `packages/koala/src/document-runtime/ndjson.ts`
- `packages/koala/src/document-runtime/ndjson.test.ts`
- `packages/document-runtime/src/transport.ts`
- `packages/document-runtime/src/bootstrap.ts`
- `packages/document-runtime/test/transport.test.ts`
- `packages/document-runtime/test/bootstrap.test.ts`

Modify:

- `packages/document-runtime/src/worker.ts`
- `packages/document-runtime/test/worker.test.ts`
- `packages/document-runtime/src/runtime.ts`
- `packages/document-runtime/src/production-profile.ts`
- `packages/document-runtime/script/build.ts`
- `packages/document-runtime/package.json`
- `packages/desktop/test/fixture/document-runtime.ts`

Implement a browser-safe byte framer with fatal UTF-8 decoding and separate
exact control and output accounting. Canonical base64 decoding is incremental
and bounded; it rejects whitespace, malformed padding, noncanonical encoding,
short non-final chunks, sequence gaps, duplicate/interleaved transfers, missing
or trailing chunks, declared/actual byte disagreement, digest mismatch, and
unterminated EOF. Node stream adapters serialize writes, honor backpressure,
pause reads until each consumer write drains, cap pending writes, and fail
permanently after malformed input, overflow, stream error, or unterminated EOF.

Build `worker/bootstrap.js` separately from `worker/worker.js`. The bootstrap
captures only the fixed handoff values, validates them, clears `process.env`,
installs the approved deterministic environment, then dynamically imports the
worker. The bootstrap path uses only strict NDJSON transport. Until the Phase 5
atomic coordinator cutover, keep the existing direct Node IPC self-start in one
isolated compatibility adapter so the current coordinator remains operational.
After a generated PNG or TSV closes, the worker opens it only within its own job
root, emits one strict start/chunk/end sequence with serialized backpressure,
then emits the matching normal event. The normal event repeats the transfer
identity, worker source path, bytes, and digest for correlation. Make generated-
file cleanup failures terminal. Require and hash both worker files plus the root
ESM `package.json` in development manifests and the production profile. Build
scripts delete the target output first so stale worker code is not retained.

Transport tests cover exact 10-KiB and final-short chunks, zero-byte TSV, maximum
PNG/TSV chunk counts without whole-output buffering, canonical base64, digest
agreement, blocked drains, cancellation during each frame type, malformed and
trailing frames, and absence of payload bytes from diagnostics.

Verification from `packages/document-runtime`:

```text
bun run build
bun test
bun typecheck
node --check dist/x86_64-pc-windows-msvc/worker/bootstrap.js
node --check dist/x86_64-pc-windows-msvc/worker/worker.js
```

Commit boundary: `feat(document): bootstrap confined document worker`.

## Phase 3: Document-Only SRT Policy

Create:

- `packages/opencode/src/document/sandbox-policy.ts`
- `packages/opencode/src/document/process.ts`
- `packages/opencode/test/document/sandbox-policy.test.ts`
- `packages/opencode/test/document/process.test.ts`

Implement canonical/disjoint root validation for the runtime, job, and sibling
pending roots, target-specific SRT asset resolution, loader-root policy, strict
dependency checks, fixed bootstrap command construction, minimal broker and
handoff environments, effective-policy inspection, bounded process-tree
termination, and observed exit.

The policy must use only parent-created, proxy-verified roots and must not reuse
the generic command policy. It grants runtime/job reads, job-only writes, empty
strict networking, and explicitly omits and denies the pending sibling while
denying runtime, SRT assets, ambient writable locations, and SRT compatibility
write paths. `pendingRoot` never enters the bootstrap command or handoff
environment. Windows rejects UNC/device/ADS, reparse, mapped/network-volume, and
unknown-volume inputs. Tests cover all six targets and command paths containing
spaces, quotes, percent signs, ampersands, carets, parentheses, dollar signs,
backticks, and trailing separators.

Do not modify generic `sandbox_execute` policy behavior. Re-run its worker and
runtime suites as regressions.

Verification from `packages/opencode`:

```text
bun test test/document/sandbox-policy.test.ts test/document/process.test.ts test/sandbox test/tool/sandbox-execute.test.ts
bun typecheck
```

Commit boundary: `feat(opencode): add document sandbox policy`.

## Phase 4: One-Job Proxy

Create:

- `packages/opencode/src/document/proxy.ts`
- `packages/opencode/test/document/proxy.test.ts`
- bounded NDJSON fixture workers under `packages/opencode/test/document/`

The proxy must:

1. Accept and strictly decode exactly one launch.
2. Independently verify host target, runtime manifest/digest, runtime paths,
   job-root and pending-root identities, canonical sibling relationship and
   separation, bootstrap, and SRT assets.
3. Initialize its sole process-local SRT manager and reject dependency errors or
   Linux seccomp degradation.
4. Wrap and spawn the bootstrap with `shell: false`, no IPC, and bounded pipes.
5. Emit `accepted` only after all inner listeners are bound.
6. Relay only decoded and re-encoded requests/control events while independently
   enforcing document and output-transfer order.
7. For each output, ignore the worker path as an I/O location, create an
   exclusive random mode-`0600` destination beneath the verified pending root,
   decode and write chunks serially with backpressure, and stream SHA-256.
8. Require unique IDs, one active transfer, exact chunk count and sequences,
   declared/event/actual/file-size agreement, per-output and dynamic aggregate
   limits, and matching worker/proxy/re-read SHA-256. Reopen without following
   links and verify stable identity, size, and digest before publication.
9. Rewrite the normal event to the proxy-generated pending-relative path and
   proxy-verified digest. Never send transfer frames, base64, worker paths, or
   document bytes over parent IPC or diagnostics.
10. Before forwarding `release-page`, require the parent-published PNG and TSV
    destinations to be absent; then let the worker delete its job-root copies.
11. Forward cancellation once, then hard-reap after the bounded grace period.
    Close and remove partial and completed-but-unpublished pending files on every
    failure path.
12. Hold terminal worker output until child exit, `cleanupAfterCommand()`, and
    `reset()` complete.
13. Replace provisional success with the highest-priority curated teardown error
    when cleanup is uncertain.
14. Emit exactly one `closed`, disconnect, remove every listener/timer/queue,
    output handle, and digest state, and exit. Never accept a second launch.

Inject SRT, spawn, time, filesystem, and process-tree dependencies in unit tests.
Cover each failure boundary; exact control, chunk, output, cumulative payload,
and live temporary limits; duplicate/interleaved/missing/trailing frames;
hostile path fields; byte and digest mismatch; backpressure; stderr overflow;
crash and disconnect at every transfer phase; cooperative and forced
cancellation; partial/unpublished cleanup; release absence checks; exactly-once
cleanup/reset; and output/audit redaction.

Verification from `packages/opencode`:

```text
bun test test/document/proxy.test.ts test/document/sandbox-policy.test.ts test/document/process.test.ts
bun typecheck
```

Commit boundary: `feat(opencode): add document confinement proxy`.

## Phase 5: Verified Job Lifecycle And Coordinator Cutover

Create:

- `packages/opencode/src/document/job-root.ts`
- `packages/opencode/test/document/job-root.test.ts`
- proxy fixture processes under `packages/opencode/test/document/`

Modify:

- `packages/opencode/src/document/runtime.ts`
- `packages/opencode/src/document/output.ts`
- `packages/opencode/test/document/runtime.test.ts`
- `packages/opencode/test/document/output.test.ts`

Add a private parent plus random sibling job and pending roots, canonical paths
and filesystem identity recording, precreated job-local `tmp`, bounded deletion
retries, and post-delete absence checks for both children and their parent.
Supply both child roots in `launch`, but include only the job root in SRT policy
and bootstrap state. Refuse recursive deletion when either path identity was
replaced or became a link. Surface cleanup failure instead of swallowing it.

Delete the current parent copy approach completely: remove
`DocumentOutput.copy`, `CopyOptions`, source snapshots, parent reads of
`jobRoot/<worker outputPath>`, and all copy-race fixtures and call sites. There
is no compatibility fallback. Replace it with pending-only resolution that
accepts only the proxy-rewritten relative path and digest, revalidates the
recorded pending-root identity, resolves strictly beneath that root, opens with
no link following, and checks file identity, declared size, and SHA-256. Source
scans must prove the parent never opens, stats, copies, renames, or deletes a
worker-reported job-root output path.

For each rendered page, keep pending files scoped to the callback. Close and
delete the exact PNG and TSV, verify absence, and only then send `release-page`.
For standalone OCR, delete and verify the pending TSV after the bounded read and
before accepting completion. On cancellation, callback failure, protocol
failure, timeout, proxy crash, or digest mismatch, close local handles and let
the authoritative root finalizer delete every remaining pending and job-root
entry. Treat either root's cleanup uncertainty as terminal and unhealthy.

Atomically delete `src/legacy-ipc.ts`, `startLegacyIpcWorker`, its `process.send`
self-start guard, `NativeConfinementLauncher`, direct `worker.js` launch,
parent-to-worker IPC, and parent-built inner environment. The coordinator must
launch only the configured proxy, wrap document commands in the outer protocol,
require `accepted -> terminal -> closed -> disconnect -> exit 0`, and retain the
existing two-job semaphore. Add a service-layer unhealthy latch, retained
process-globally by the production node, for missing
closure, unconfirmed termination, command cleanup, reset, or policy revocation;
later jobs fail closed until sidecar restart.

Delete obsolete direct-worker fixtures after equivalent proxy fixtures pass.
Add source scans proving no production direct-launch path or parent worker-output
copy remains.

Phase 5 tests must cover:

- pending-root launch identity, sibling/disjoint checks, replacement and link
  attacks, and confirmed deletion of job, pending, and private parent roots;
- worker event paths using traversal, absolute, backslash, drive, UNC, device,
  ADS, NUL, wrong-prefix, wrong-extension, and normalized-alias forms, with
  instrumentation proving no trusted parent filesystem operation targets them;
- exact-size and digest pending reads, file/root replacement after event,
  duplicate pending names, changed files, and no-follow opens;
- PNG/TSV deletion before release, standalone TSV deletion before completion,
  callback cancellation/failure, missing deletion, held handles, and bounded
  cleanup failure;
- proxy cancellation or crash before output start, mid-chunk, after end, after
  stable completion, after event publication, and during release;
- no base64, raw binary, worker path, pending host path, document text, or raw
  stderr in parent IPC failures, diagnostics, or audit fixtures;
- retained 100/101-page, 64-MiB PNG, 32-MiB TSV, 250-MiB live temporary,
  9,600-MiB dynamic cumulative formula, page ordering, deadline, and two-job
  concurrency behavior without allocating hard-limit fixtures in memory.

Verification from `packages/opencode`:

```text
bun test test/document test/sandbox test/tool/sandbox-execute.test.ts
bun typecheck
```

Commit boundary: `refactor(opencode): route documents through sandbox proxy`.

## Phase 6: Build And Desktop Packaging

Modify:

- `packages/opencode/script/build-node.ts`
- `packages/opencode/test/document/build.test.ts`
- `packages/desktop/src/main/sandbox-runtime.ts`
- `packages/desktop/src/main/sandbox-runtime.test.ts`
- `packages/desktop/src/main/document-runtime.ts`
- `packages/desktop/src/main/document-runtime.test.ts`
- `packages/desktop/src/main/sidecar-env.ts`
- `packages/desktop/src/main/sidecar-env.test.ts`
- `packages/desktop/src/main/server.ts`
- `packages/desktop/scripts/document-runtime.ts`
- `packages/desktop/scripts/document-runtime.test.ts`
- `packages/desktop/electron-builder.config.ts`
- `packages/desktop/electron-builder.config.test.ts`

Emit `sandbox-runtime/document-runtime-proxy.mjs` beside the generic worker and
copy one clean shared SRT vendor tree. Assert the proxy bundle does not import
PDF.js, canvas, Tesseract, or source TypeScript. Resolve only built proxy/assets
paths in development and only verified paths beneath `process.resourcesPath` in
packaged builds. Add these resolver-owned sidecar values:

- `KOALA_DOCUMENT_RUNTIME_PROXY_PATH`
- `KOALA_DOCUMENT_RUNTIME_PROXY_ASSETS_ROOT`

Strip inherited values before adding trusted ones. A partial runtime/proxy/assets
set means document execution is unavailable. Package proxy, generic worker, SRT
assets/license, document bootstrap/runtime, and detached attestation outside
`app.asar`. Clean generated/staged directories before every build and assert no
obsolete proxy/bootstrap remains.

Phase 6 review amendment: development resolves only the built host-target
runtime and built proxy/assets tree. Beta/prod staging and package configuration
must reject absent or mismatched versioned confinement evidence before
packaging. That evidence binds the runtime and sandbox manifests, proxy, native
test report, packaged smoke report, signing report, exact signed-file inventory,
and dependency report by SHA-256; Boolean pass claims are insufficient. The
sandbox manifest has a code-owned exact mode profile (`0644` for JavaScript,
JAR, license, and manifest inputs; `0755` for native helpers), and helper parsing
requires complete target-correct PE or ELF64 little-endian headers. Inherited
runtime/proxy keys and `KOALA_SANDBOX_WORKER_PATH` are removed before trusted
resolver values are added. The pinned SRT patch accepts only explicit assets,
rechecks their identity and digest before wrapping, and provides no ambient
asset lookup fallback.

Verification:

```text
# packages/opencode
bun run script/build-node.ts
bun test test/document/build.test.ts test/document
bun typecheck
node --check dist/node/sandbox-runtime/document-runtime-proxy.mjs

# packages/desktop
bun test src/main/sandbox-runtime.test.ts src/main/document-runtime.test.ts src/main/sidecar-env.test.ts scripts/document-runtime.test.ts electron-builder.config.test.ts
bun typecheck
bun run build
```

Commit boundary: `feat(desktop): package document confinement`.

## Phase 7: Teardown Evidence And Native Gates

Create:

- `packages/opencode/test/document/confinement-native.test.ts`
- hostile child fixtures under `packages/opencode/test/document/`
- `packages/desktop/scripts/document-runtime-smoke.ts`

Modify:

- `packages/koala/src/document-runtime/attestation.ts`
- `packages/koala/src/document-runtime/attestation.test.ts`
- `packages/desktop/package.json`
- `.github/workflows/publish.yml`
- `THIRD_PARTY_NOTICES.md`

Extend detached production evidence with target, runtime manifest digest, proxy
digest, SRT version/assets, policy version, native test report digest, packaged
smoke result, and signature/dependency checks. Do not accept an environment
Boolean as evidence.

Native tests must prove allowed job operations and denied project/home/runtime/
sibling/temp access, including denial of the pending sibling from the sandbox;
proxy-only pending writes; denied DNS/TCP/UDP/loopback/binding/socket access;
child and grandchild reaping; exactly-once cleanup/reset; and absence of job,
pending, and private parent directories. Release mode fails rather than skips
when provisioning is unavailable.

Stock SRT `0.0.76` does not surface every Windows ACL/reset anomaly. Before
enabling Windows, either pin a reviewed SRT revision with structured teardown
status or add a reviewed post-reset ACL/WFP reconciliation check. If neither is
available, Windows document execution remains unavailable. Apply a package patch
only after a target-native failing test demonstrates the exact gap.

The release workflow must acquire independently attested six-target document
runtimes, provision SRT prerequisites, run target-native confinement tests,
package, inspect nested resources/signatures/architecture, and run installed-app
offline render/OCR. A target without a native runner remains disabled.

Commit boundary: `test(document): gate native confinement`.

## Phase 8: Final Review And Records

Update:

- `CONTEXT.md`
- `infra.md`
- `learning.md`
- `.subagent/document-runtime-confinement-implementation.md`

Run independent reviews of the proxy trust boundary, cleanup state machine, and
packaging/evidence gate. Record native skips separately from passes. Do not
register OCR/document tools until their target is release-ready.

Final verification:

```text
# packages/koala
bun test
bun typecheck

# packages/document-runtime
bun run build
bun test
bun typecheck

# packages/opencode
bun test test/document test/sandbox
bun typecheck
bun run script/build-node.ts

# packages/desktop
bun test src/main/document-runtime.test.ts src/main/sandbox-runtime.test.ts src/main/sidecar-env.test.ts scripts/document-runtime.test.ts electron-builder.config.test.ts
bun typecheck
bun run build
```

Commit boundary: `docs: record document confinement status`.

## Release Blockers That Remain External

- Authentic Tesseract 5.5.3, Leptonica 1.87.0, English/OSD tessdata, and native
  canvas artifacts for all six targets.
- Complete target-specific native dependency and license inventories.
- Release signatures, notarization, and independently issued attestations.
- A selected Koala license.
- Provisioned native runners, including Windows account/WFP setup and Linux
  bubblewrap/seccomp/AppArmor or user-namespace setup.
- Target-native evidence for every enabled architecture.

The pre-native protocol, transport, proxy, coordinator, cleanup, build, and
packaging slices may be implemented and committed while the runtime remains
fail-closed. No target is release-enabled until all external evidence gates pass.
