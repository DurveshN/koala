# Phase 9D Sandbox Test Implementation

## Scope

Implemented the approved `sandbox_test` Industrial Tool without changing the
public HTTP API, adding runtime downloads, or adding a host execution fallback.

## Contract

- Added the browser-safe `SandboxTestTool` contract under
  `packages/koala/src/sandbox/test-tool.ts` and exported it from the Koala root.
- Input is an object with no permitted properties.
- Output uses the shared Industrial Result envelope with no sources, outputs, or
  citations and a fixed set of ten required probe outcomes.
- Outcomes contain only a boolean and a closed stable reason code.
- Input audit summary contains four zero counts. The summary renderer enumerates
  fixed probe names and cannot render unknown decoded properties.
- The Anthropic sandbox runtime name/version now has one shared definition used
  by `sandbox_execute` and `sandbox_test`.

## Adapter

- Added `packages/opencode/src/tool/sandbox-test.ts` using
  `SandboxRuntime.availability`, `SandboxRuntime.execute`,
  `SandboxPolicy.buildRequest`, `ArtifactStore.stage`/`abandon`, and
  `IndustrialExecution`.
- Permission data contains only the fixed `sandbox_test` token. The model cannot
  provide a command, path, URL, timeout, or output declaration.
- Runtime unavailability returns successful diagnostic observation data, marks
  execution probes `not-run`, and performs no execute call.
- The policy run uses host-created nonce canaries and scripts to check staging
  read/write, project read/write denial, separate external-temporary read/write
  denial, and loopback TCP denial. The host separately verifies filesystem
  effects and whether its listener accepted a connection.
- The cancellation run waits for a nonce-bound readiness file with bounded
  polling, then aborts through a local signal. Only `cancelled=true` and
  `timedOut=false` pass.
- Result, projection, permission request, and audit exclude commands, paths,
  nonces, URLs, stdout, stderr, and violation targets. No artifact is promoted.
- Explicit cleanup and an idempotent finalizer close the listener, abort local
  controllers, remove canaries and external temporary storage, abandon staging,
  and verify absence. A failed normal cleanup receives `cleanup-failed`.

## Review Remediation

- Staging, project-directory, external-directory, listener, and host-file setup
  now use scoped acquisitions. Their releases are registered before preparation
  advances, including when cancellation interrupts a pending test hook.
- The project probe creates one UUID-named directory atomically and places its
  read and write canaries beneath it. Cleanup tracks and removes only that owned
  directory; prospective paths are never registered as owned.
- Windows command construction uses a fixed PowerShell `-EncodedCommand`
  launcher. Executable and script paths are base64-encoded in that launcher;
  script arguments use base64 JSON in the allowlisted
  `KOALA_SANDBOX_TEST_ARGUMENTS` environment field and never enter `cmd.exe`
  syntax. The fixed `ELECTRON_RUN_AS_NODE=1` environment entry supports the
  packaged Desktop utility process without exposing model-controlled values.
- Pure encoding tests cover Windows and POSIX metacharacters. A Windows-only
  execution test runs through real `cmd.exe` with percent syntax, spaces,
  ampersand, caret, parentheses, a quote-bearing argument, and a trailing
  backslash.
- Deterministic tests interrupt at all four externally owned acquisition
  boundaries, verify immediate cleanup, release the still-pending asynchronous
  hook, and verify that no path is recreated afterward.

No native CI job was added. The repository contains no sandbox provisioning
script or action. Windows requires an elevated upstream `windows-install` that
creates the dedicated account and machine-wide WFP filters. Ubuntu requires
`bubblewrap`, `socat`, `ripgrep`, and an AppArmor profile or privileged sysctl
change for capability-bearing unprivileged user namespaces. Existing hosted
jobs do not establish those prerequisites. The native test remains gated by
`KOALA_RUN_NATIVE_SANDBOX_TEST=1`, and this report does not claim OS enforcement
was exercised.

Remediation verification:

- `packages/koala`: complete suite, 438 passed; `bun typecheck` passed.
- `packages/opencode`: focused `sandbox_test` suite, 11 passed and 1 native
  capability-gated test skipped.
- `packages/opencode`: relevant sandbox/tool/industrial suites, 113 passed and 1
  native capability-gated test skipped; `bun typecheck` passed.
- `packages/opencode`: single-target Windows x64 build and smoke test passed.
- `packages/desktop`: targeted sandbox/sidecar/document-runtime tests, 11 passed;
  typecheck and production build passed.

## Registration

The registry places `sandbox_test` beside `sandbox_execute` only when
`agentExecution` is `sandbox` or `both`. Host-only mode exposes neither sandbox
tool.

## Verification

- `packages/koala`: focused contract/browser/policy/protocol tests, 41 passed.
- `packages/koala`: complete suite, 438 passed.
- `packages/koala`: `bun typecheck` passed.
- `packages/opencode`: focused adapter/registry tests, 24 passed and 1 native
  capability-gated test skipped.
- `packages/opencode`: sandbox, registry, calculator, artifact, audit, and
  Industrial Execution suites, 113 passed and 1 capability-gated test skipped.
- `packages/opencode`: `bun typecheck` passed.
- `packages/opencode`: `bun run script/build-node.ts` passed.
- `packages/opencode`: `bun run build --single --skip-install
  --skip-embed-web-ui` passed, including its Windows x64 smoke test.
- `packages/desktop`: sandbox-runtime, sidecar-environment, and document-runtime
  tests, 11 passed.
- `packages/desktop`: `bun typecheck` passed.
- `packages/desktop`: `bun run build` passed.
- Direct native availability check returned `initialization-failed`; the native
  execution test was not run and no passing result was fabricated.

## Broad-Suite Blocker

A broader OpenCode tool/sandbox/industrial sweep produced 471 passes and 1 skip,
but 8 Windows path-normalization tests failed. They compare temporary paths
through different drive/case views (`C:\Users\...` versus `E:\users\...`). The
affected suites are `external-directory`, `read`, and `shell`; no files in those
areas were changed.
