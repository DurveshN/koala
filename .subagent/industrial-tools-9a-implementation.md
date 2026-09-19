# Industrial Tools Phase 9A Implementation

## Scope

Implemented the shared typed, audited, cancellable foundation and migrated
`sandbox_execute` as the proving industrial tool.

## Components

- Closed 22-tool inventory and exhaustive permission mapping.
- Artifact/path input, citation, result, projection, and audit contracts.
- Independent durable `koala_tool_audit` storage with lifecycle constraints.
- Same-Session artifact and authorized project/external path snapshot service.
- Common Industrial Execution service for canonical input hashing, audit,
  permission, cancellation, deadlines, result correlation, and projection.
- Typed `sandbox_execute` result, curated terminal codes, atomic batch artifact
  metadata publication, and separate producer/projection truncation.

## Verification

- Koala complete suite: 341 passed.
- Core focused audit/artifact/migration suites: 25 passed.
- OpenCode focused industrial/artifact/sandbox suites: 97 passed, including the
  document runtime adapter added in the same worktree.
- Koala, Core, and OpenCode typechecks passed.
- Core migration consistency check passed.
- Desktop production build remains part of final combined verification.

## Industrial Foundation Review Remediation

- Latched cancellation/deadline outcomes at abort time while retaining cleanup
  grace; delayed operation success is converted to the latched terminal result.
- Made the sandbox worker the timeout authority and added a real-time tool
  boundary test for worker timeout classification.
- Added arbitrary-scheme URI and POSIX/drive/UNC/device/mixed-path projection
  redaction tests.
- Accepted bounded, control-safe opaque tool-call IDs and returned typed boundary
  errors for invalid IDs.
- Authenticated returned source/output references against ArtifactStore metadata,
  same-Session ownership, and applicable output provenance.
- Added an abort gate before artifact publication, cross-process promotion
  locking, failed-batch blob rollback, and concurrent-dedup regression coverage.
- Added an explicit execution/store commit handshake. Pre-commit cancellation
  rolls back, while successful publication resolves cancellation races as
  committed success; deterministic before-, mid-, and post-commit tests cover
  the boundary and audit result.
- Added an interruption-safe typed-result handoff inside the uninterruptible
  publication region. A real `Fiber.interrupt` race verifies committed artifact
  rows, returned success, and audited output IDs remain identical.
- Added typed ArtifactStore reconciliation for orphan files and unreferenced blob
  rows, automatic startup reconciliation, and warning logs when startup or
  rollback cleanup needs a later retry. Reconciliation also removes aged blob
  temporary files and abandoned run staging while preserving active/recent work.
- Strengthened durable audit artifact-ID, uniqueness, error-code, and truncation
  invariants while conservatively migrating legacy rows.
- Aligned `source_project_path` database constraints with the runtime path schema.

Review verification on 2026-09-20:

- Koala focused contract/projection/artifact suites: 94 passed.
- Core focused audit/artifact/migration suites: 25 passed.
- OpenCode focused execution/audit/artifact/sandbox/calculator/registry suites:
  85 passed.
- Koala, Core, and OpenCode typechecks passed.
- Core migration consistency check passed.
