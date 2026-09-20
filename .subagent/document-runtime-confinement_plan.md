# Document Runtime Confinement Implementation Plan

## Goal

Route every document-runtime job through one short-lived, native SRT-confined
proxy before any PDF.js, canvas, Tesseract, or document bytes are loaded. Keep
document execution unavailable unless the proxy, verified runtime, SRT assets,
and target-native evidence all pass. Remove the direct worker launch path and
clean every generated worker, job directory, listener, timer, and child process.

## Invariants

- One proxy process, one `SandboxManager` singleton, and one document job.
- Parent/proxy communication uses bounded Node IPC; proxy/worker communication
  uses bounded NDJSON over stdin/stdout.
- The verified runtime is read-only. The private job root is the only ordinary
  writable location. Network access is empty and strict.
- The proxy imports no document parser or native document module.
- The bootstrap clears and reconstructs the environment before dynamically
  importing the document worker.
- A worker success remains provisional until inner exit, SRT command cleanup,
  SRT reset, proxy `closed`, clean proxy exit, output checks, and verified job
  deletion.
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
`accepted`, `event`, `failure`, and `closed`. Add runtime schemas that separate
initial document requests from continuation requests. Every trust-boundary
decode rejects excess properties. Add a pure outer state machine that validates
job identity and lifecycle while delegating page ordering to
`DocumentRuntimeProtocol.advanceOrder`.

Centralize these limits:

- outer IPC message: 65,536 UTF-8 bytes;
- outer pending queue: 32 messages;
- NDJSON line and unterminated buffer: 16,384 bytes;
- NDJSON frames: 512 per direction;
- NDJSON aggregate: 1,048,576 bytes per direction;
- inner stderr: 65,536 bytes.

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

Implement a browser-safe byte framer with fatal UTF-8 decoding and exact
line/frame/aggregate accounting. Node stream adapters serialize writes, honor
backpressure, cap pending writes, and fail permanently after malformed input,
overflow, stream error, or unterminated EOF.

Build `worker/bootstrap.js` separately from `worker/worker.js`. The bootstrap
captures only the fixed handoff values, validates them, clears `process.env`,
installs the approved deterministic environment, then dynamically imports the
worker. The bootstrap path uses only strict NDJSON transport. Until the Phase 5
atomic coordinator cutover, keep the existing direct Node IPC self-start in one
isolated compatibility adapter so the current coordinator remains operational.
Make generated-file cleanup failures terminal. Require and hash both worker
files plus the root ESM `package.json` in development manifests and the
production profile. Build scripts delete the target output first so stale worker
code is not retained.

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

Implement canonical/disjoint root validation, target-specific SRT asset
resolution, loader-root policy, strict dependency checks, fixed bootstrap
command construction, minimal broker and handoff environments, effective-policy
inspection, bounded process-tree termination, and observed exit.

The policy must use no caller-supplied roots or environment and must not reuse
the generic command policy. It grants runtime/job reads, job-only writes, empty
strict networking, and explicitly denies runtime, SRT assets, ambient writable
locations, and SRT compatibility write paths. Windows rejects UNC/device/ADS,
reparse, mapped/network-volume, and unknown-volume inputs. Tests cover all six
targets and command paths containing spaces, quotes, percent signs, ampersands,
carets, parentheses, dollar signs, backticks, and trailing separators.

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
   job-root identity/separation, bootstrap, and SRT assets.
3. Initialize its sole process-local SRT manager and reject dependency errors or
   Linux seccomp degradation.
4. Wrap and spawn the bootstrap with `shell: false`, no IPC, and bounded pipes.
5. Emit `accepted` only after all inner listeners are bound.
6. Relay only decoded and re-encoded requests/events while independently
   enforcing document order.
7. Forward cancellation once, then hard-reap after the bounded grace period.
8. Hold terminal worker output until child exit, `cleanupAfterCommand()`, and
   `reset()` complete.
9. Replace provisional success with the highest-priority curated teardown error
   when cleanup is uncertain.
10. Emit exactly one `closed`, disconnect, remove every listener/timer/queue, and
    exit. Never accept a second launch.

Inject SRT, spawn, time, and process-tree dependencies in unit tests. Cover each
failure boundary, exact transport limits, backpressure, malformed output,
stderr overflow, crash, disconnect, cooperative and forced cancellation,
exactly-once cleanup/reset, and output redaction.

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
- `packages/opencode/test/document/runtime.test.ts`

Add a private parent plus random child job root, canonical path and filesystem
identity recording, precreated job-local `tmp`, bounded deletion retries, and
post-delete absence checks. Refuse recursive deletion when the path identity was
replaced or became a link. Surface cleanup failure instead of swallowing it.

Atomically delete `src/legacy-ipc.ts`, `startLegacyIpcWorker`, its `process.send`
self-start guard, `NativeConfinementLauncher`, direct `worker.js` launch,
parent-to-worker IPC, and parent-built inner environment. The coordinator must
launch only the configured proxy, wrap document commands in the outer protocol,
require `accepted -> terminal -> closed -> disconnect -> exit 0`, and retain the
existing two-job semaphore. Add a process-global unhealthy latch for missing
closure, unconfirmed termination, command cleanup, reset, or policy revocation;
later jobs fail closed until sidecar restart.

Delete obsolete direct-worker fixtures after equivalent proxy fixtures pass.
Add source scans proving no production direct-launch path remains.

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
sibling/temp access; denied DNS/TCP/UDP/loopback/binding/socket access; child and
grandchild reaping; exactly-once cleanup/reset; and absence of job directories.
Release mode fails rather than skips when provisioning is unavailable.

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
