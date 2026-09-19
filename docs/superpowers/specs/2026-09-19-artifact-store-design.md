# Koala Artifact Store Design

## Scope

This phase introduces durable, content-addressed storage for files produced by
Koala tools. The first producer is `sandbox_execute`. Artifact bytes remain
outside chat history and SQLite; persisted records contain identity, ownership,
provenance, validation, lineage, digest, MIME, and size metadata.

This phase does not add an artifact HTTP API, renderer cards, garbage
collection, archive expansion, or deep Office/PDF validation. Those capabilities
build on this store in later phases.

## Storage Ownership

Artifact metadata uses the existing application database and migration
lifecycle. Creating a separate `koala.db` now would split Session ownership
across databases and require a second migration system. Renaming or separating
the application database remains a future storage migration.

Artifact bytes use this layout beneath the configured global data directory:

```text
koala/artifacts/
  blobs/sha256/<first-two-digest-characters>/<digest>
  staging/<run-id>/work/
  staging/<run-id>/artifacts/
```

Blob paths are always derived from validated digests and are never persisted as
absolute paths.

## Domain Model

`packages/koala` owns browser-safe Effect schemas for:

- `Artifact.ID`: an opaque logical artifact identifier.
- `Artifact.Digest`: exactly 64 lowercase hexadecimal SHA-256 characters.
- `Artifact.Reference`: ID, display name, detected MIME, byte size, and digest.
- `Artifact.Metadata`: reference fields plus validation and provenance.
- `Artifact.Validation`: state, validator name, validator version, and bounded
  findings.
- `Artifact.Provenance`: owning Session/message, producing tool/tool call, and
  optional sandbox run.
- `Artifact.Lineage`: source artifact and relation.

Logical identity is separate from content identity. Two artifacts may reference
one digest while retaining separate owners, provenance, names, and lineage.

## Database Model

The existing application database gains three tables:

```text
koala_artifact_blob
  digest primary key
  size
  time_created

koala_artifact
  id primary key
  digest foreign key -> koala_artifact_blob.digest
  name
  mime
  validation_state
  validator
  validator_version
  validation JSON
  owner_session_id
  owner_message_id
  tool_name
  tool_call_id nullable
  sandbox_run_id nullable
  time_created

koala_artifact_lineage
  artifact_id foreign key -> koala_artifact.id
  source_artifact_id foreign key -> koala_artifact.id
  relation
  primary key (artifact_id, source_artifact_id, relation)
```

The Core schema uses primitive column types and does not depend on
`@koala-ai/core`. The OpenCode adapter validates rows against Koala schemas.

## Sandbox Contract

`sandbox_execute` accepts an optional `outputs` array. Each item is a relative
path beneath a reserved `artifacts/` directory in that run. The command starts
in the run root and can use `work/` for temporary files and `artifacts/` for
declared deliverables.

Only explicitly listed outputs are promoted. Koala does not recursively infer
which generated files are deliverables.

Limits for the first slice are:

- 10 declared outputs per run.
- 100 MiB per artifact.
- 250 MiB total promoted bytes per run.
- Existing sandbox command and output limits remain unchanged.

Promotion occurs only when the command exits normally without timeout,
cancellation, or a sandbox violation. A nonzero process exit may return textual
diagnostics but does not publish artifacts.

## Validation

Every candidate must satisfy all of these checks:

1. The declared path is relative, normalized, non-empty, and contains no parent
   traversal.
2. The resolved path remains beneath the selected run's artifact staging root.
3. The candidate is a regular file with one filesystem link, not a directory,
   symbolic link, reparse point, or hard-linked alias.
4. File count, per-file size, and aggregate size limits are respected.
5. The file remains stable while one opened handle is hashed and copied.
6. MIME is detected from bounded leading bytes, with conservative text
   detection and `application/octet-stream` fallback.
7. The basic validator records its name and version and returns an accepted or
   rejected result with bounded findings.

The basic validator establishes storage safety, not document semantic safety.
Deep PDF, Office, archive, macro, relationship, and embedded-object checks are
required before later tools label those formats fully validated.

## Promotion Protocol

For each candidate:

1. Stop the sandboxed process tree, reject links from filesystem metadata, then
   open the source without following links where the platform supports it.
2. Validate metadata and containment from the opened source.
3. Stream bytes once into a uniquely named file in the destination digest
   directory while calculating SHA-256.
4. Flush and close the destination staging file.
5. Set restrictive permissions.
6. Publish with a no-overwrite operation. If the digest already exists, verify
   the existing blob size and digest before reusing it.
7. Insert blob, artifact, and lineage metadata in one SQLite transaction.
8. Remove run staging after successful promotion or explicit abandonment.

Filesystem publication precedes the metadata transaction. A database failure
may leave an unreferenced immutable blob for later reconciliation, but a
committed artifact row must not reference a missing blob.

## Service Boundary

`packages/koala` defines the artifact values and store interface.
`packages/opencode` implements the host filesystem and database adapter as a
process-global Effect service.

The initial service operations are:

- create a run staging directory;
- promote one explicitly named file with provenance and optional lineage;
- read artifact metadata by ID;
- resolve/open accepted blob content internally;
- abandon a staging run.

The store returns typed errors for invalid paths, missing candidates, policy
limits, validation rejection, corrupt existing blobs, missing artifacts, and
storage failures. Raw filesystem and database errors do not cross the boundary.

## Session Representation

The first integration returns compact artifact references in
`sandbox_execute` metadata and model-facing text. It does not put bytes, data
URLs, or absolute blob paths in Session history. A typed shared Session
attachment representation and authenticated artifact content API are separate
follow-up slices because both legacy and current Session projections must be
migrated together.

## Failure And Recovery

- Invalid output declarations fail before command execution.
- Validation rejection publishes neither metadata nor a blob.
- Concurrent promotion of identical bytes reuses one physical blob.
- Metadata transaction failure may leave an orphan blob; it must not leave a
  row whose blob is absent.
- Cleanup failure is reported diagnostically but does not rewrite an already
  committed artifact result.
- Startup reconciliation and garbage collection are deferred, so orphan blobs
  remain harmless but may consume disk space until that work lands.

## Verification

Tests cover:

- schema and identifier validation;
- relative-path and traversal rejection;
- symlink/reparse-point and directory rejection;
- file-count, per-file, and aggregate limits;
- MIME detection and basic validation states;
- deterministic digest path derivation;
- duplicate and concurrent blob promotion;
- distinct logical artifacts sharing one blob;
- metadata and lineage constraints;
- validation and database failure ordering;
- staging cleanup and abandonment;
- sandbox promotion only after successful execution;
- absence of binary data and absolute CAS paths in returned references.

Tests use real temporary files and the repository's SQLite test layer. Native
sandbox confinement remains platform-gated and will be exercised after the
application and platform setup are complete.
