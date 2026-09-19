# Artifact Store Implementation

## Scope

Implemented the first durable artifact-store slice and connected explicit
outputs from `sandbox_execute`.

## Components

- Browser-safe artifact schemas, limits, references, provenance, lineage, and
  typed store errors in `packages/koala`.
- Primitive blob, artifact, and lineage tables in the existing Core database.
- Generated migrations for initial tables, sandbox-run indexing, and strengthened
  constraints.
- A process-global OpenCode artifact service for private staging, validation,
  streamed SHA-256 copying, immutable publication, deduplication, metadata,
  content streaming, and abandonment.
- An Effect service around the existing sandbox child-process adapter.
- Explicit `sandbox_execute.outputs` promotion after clean execution only.

## Security Properties

- Output paths reject absolute paths, traversal, backslashes, alternate data
  streams, trailing dots/spaces, and Windows reserved device names.
- Candidates must be stable single-link regular files beneath the selected run
  staging directory.
- The store, not its caller, derives committed per-run count and byte totals
  under a process-global promotion lock.
- Blob paths derive only from validated lowercase SHA-256 digests.
- Existing blobs are rehashed before deduplication.
- Database rows are inserted only after blob publication.
- Model-visible output and metadata omit bytes, CAS paths, and staging paths.

## Verification

- Koala artifact and sandbox contract tests: 72 passed.
- Core artifact database and migration tests: 20 passed.
- OpenCode artifact-store, sandbox, registry, and tool tests: 62 passed.
- Koala, Core, and OpenCode typechecks passed.
- Core migration generation check passed.
- Desktop production build passed.

Native sandbox execution remains deferred until the complete application and
platform sandbox setup are available. POSIX permission assertions are
platform-gated and were not run on this Windows host.
