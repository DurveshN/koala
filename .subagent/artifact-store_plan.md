# Artifact Store Implementation Plan

## Goal

Implement the approved first artifact-store slice using the existing application
database for metadata and `<Global data>/koala/artifacts` for immutable bytes.
Integrate explicit `sandbox_execute.outputs` promotion without adding an HTTP API
or renderer UI.

## 1. Koala Contracts

Add:

- `packages/koala/src/artifact/artifact.ts`
- `packages/koala/src/artifact/store.ts`
- `packages/koala/src/artifact/artifact.test.ts`

Update:

- `packages/koala/src/index.ts`
- `packages/koala/package.json`

Define browser-safe Effect schemas for artifact IDs, SHA-256 digests, normalized
relative output paths, names, MIME types, validation, provenance, lineage,
metadata, references, and fixed limits. Define a Koala-owned Effect service
interface with typed errors for staging, promotion, metadata reads, content
access, validation, corruption, limits, and abandonment.

Verify from `packages/koala` with `bun test src/artifact/artifact.test.ts` and
`bun typecheck`.

## 2. Core Database Schema

Add `packages/core/src/artifact/sql.ts` with primitive Drizzle tables:

- `koala_artifact_blob`
- `koala_artifact`
- `koala_artifact_lineage`

Add digest, size, validation-state, JSON, self-lineage, ownership, and foreign-key
constraints plus lookup indexes. Core must not import `@koala-ai/core`.

Run `bun run migration --name koala_artifact_store` from `packages/core`; do not
manually edit generated schema or migration files. Add real SQLite schema and
migration tests, then run `bun run migration --check`, focused tests, and
`bun typecheck` from `packages/core`.

## 3. Host Artifact Store

Add:

- `packages/opencode/src/koala/artifact-store.ts`
- `packages/opencode/test/koala/artifact-store.test.ts`

Implement a process-global Effect service backed by `Database`, `Global`, and
host filesystem operations. Create mode-0700 run directories containing `work/`
and `artifacts/`. Promotion must:

1. Validate the declared relative path and containment.
2. Reject directories, symbolic links, reparse points, and hard links.
3. Enforce 10 files, 100 MiB per file, and 250 MiB per run.
4. Read from one opened source handle while hashing SHA-256, collecting a bounded
   MIME sample, and copying to destination-local staging.
5. Confirm source identity and stability after copying.
6. Detect PNG, JPEG, GIF, WebP, PDF, ZIP, strict UTF-8 text, or generic binary.
7. Flush, close, chmod, and publish without replacing an existing digest.
8. Verify a pre-existing blob before deduplicating.
9. Insert blob, artifact, and lineage metadata in one SQLite transaction.

Filesystem publication happens before the metadata transaction, so failures may
leave reclaimable orphan blobs but not metadata that references absent content.
Returned values contain no bytes or absolute storage paths.

## 4. Runtime Service Seam

Update `packages/opencode/src/sandbox/runtime.ts` to expose an Effect service,
layer, and `LayerNode` around the existing child-process adapter. Keep worker
spawning and process management in OpenCode while consuming Koala-owned
contracts. Add the node to the application/tool dependency graph.

## 5. Sandbox Output Promotion

Update:

- `packages/opencode/src/tool/sandbox-execute.ts`
- `packages/opencode/src/tool/registry.ts`
- `packages/opencode/test/tool/sandbox-execute.test.ts`

Add `outputs?: Artifact.OutputPath[]` with uniqueness and a maximum of 10.
Commands run from the staged run root, with `work/` and `artifacts/` as the only
writable roots. Promote declared files sequentially only after exit code zero,
no timeout, no cancellation, no output truncation, and no sandbox violations.
Return compact references in metadata and text without bytes, data URLs, staging
paths, or content-addressed storage paths. Always abandon run staging after the
operation; cleanup failure is diagnostic and does not rewrite committed output.

## 6. Test Matrix

Use real temporary files and the repository SQLite test layer. Cover:

- contract validation and output limits;
- traversal, absolute path, directory, symlink/reparse-point, and hard-link
  rejection;
- empty files, exact size boundaries, aggregate limits, and MIME detection;
- digest path derivation, deduplication, and concurrent same-content promotion;
- distinct logical artifacts sharing one blob;
- metadata, provenance, and lineage round trips and constraints;
- validation rejection and metadata transaction rollback ordering;
- run abandonment and staging cleanup;
- sandbox promotion success and every no-promotion terminal state.

## 7. Final Verification And Records

Run package-local tests and typechecks from `packages/koala`, `packages/core`, and
`packages/opencode`. Rebuild the Node sidecar worker with
`bun run script/build-node.ts`; no client generation is needed because no public
`HttpApi` changes in this slice. Update `CONTEXT.md`, `infra.md`, `learning.md`,
and `.subagent/` with verified behavior and remaining platform limitations.

Do not claim native sandbox confinement testing until platform setup is
available. Artifact HTTP delivery, UI cards, garbage collection, deep document
validation, and a separate `koala.db` remain later slices.
