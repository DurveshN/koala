# Native Sandbox Implementation

## Scope

Implemented the first native execution boundary using
`@anthropic-ai/sandbox-runtime@0.0.76` without an unsandboxed fallback.

## Decisions

- Use one short-lived Node child process per availability check or execution.
- Validate every IPC request and response with versioned Koala Effect schemas.
- Use `wrapWithSandboxArgv()` and `shell: false` on every platform.
- Deny network access with an empty strict allowlist and disable weaker
  isolation, local binding, arbitrary Unix sockets, PTYs, and Apple Events.
- Deny Sandbox Runtime's shared compatibility write directories and treat Linux
  seccomp warnings as unavailable rather than accepting weaker isolation.
- Give the model a temporary writable workspace and read-only access to the
  active project; retain trusted host subprocesses for internal application
  operations.
- Bound combined stdout and stderr, support timeout and cancellation, terminate
  the process tree, and clean up/reset the upstream runtime after each run.
- Package the worker and vendor helpers outside `app.asar`.

## Verification

- Koala sandbox contract tests: 31 passed.
- OpenCode focused sandbox/tool/flag tests: 82 passed.
- Direct host-shell denial test: 1 passed.
- Desktop sandbox resource tests: 12 passed.
- Koala, OpenCode, and Desktop typechecks passed.
- OpenCode Node build and Desktop production build passed.
- Emitted worker syntax and real IPC availability checks passed.

Native command execution was not exercised because the current Windows host
reports `initialization-failed`; the worker returned that fixed status and did
not fall back to host execution.

Filesystem violation reporting remains best effort on Linux because runtime
version `0.0.76` does not expose monitor readiness. Enforcement does not depend
on the reporting monitor.
