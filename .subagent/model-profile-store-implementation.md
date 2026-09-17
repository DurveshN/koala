# Model Profile Store Implementation

## Objective

Add a sidecar-owned repository for versioned Koala model profiles at `<Global.Service.data>/koala/model-profiles.json`.

## Files

- `packages/opencode/package.json`
- `bun.lock`
- `packages/opencode/src/koala/model-profile-store.ts`
- `packages/opencode/test/koala/model-profile-store.test.ts`
- `.subagent/model-profile-store-implementation.md`

## Design

- Expose a `LayerNode` service with disk-backed `list`, `create`, `update`, and `remove` operations using `ModelProfile.Provider` and `ModelProfile.ProviderID` types.
- Derive the repository and lock location from the injected `Global.Service` so tests and sidecar deployments can isolate the data root.
- Treat only a missing document as empty. Decode every existing file through `ModelProfileDocument.Document` and report malformed JSON, unsupported versions, duplicate IDs, and invalid nested profiles as `ReadError` without including document contents.
- Acquire one `EffectFlock` in the Koala data directory for each mutation, then reread and validate under that lock. Reads do not use an in-memory cache.
- Reject duplicate creates, missing updates and removals, and update ID mismatches with distinct `Schema.TaggedErrorClass` failures.
- Sort profiles by provider ID, decode and encode through the document schema, and serialize only canonical fields. This removes excess credential-like data before persistence.
- Write through a UUID-named temporary file in the destination directory using exclusive creation and mode `0600`, apply POSIX permissions explicitly, rename over the destination, and remove the temporary path on every exit.

## Tests And Results

- Focused tests cover missing storage, create/list, stable ordering, duplicate rejection, exact update, identity mismatch, missing update/remove, deletion preserving other profiles, malformed JSON retention, unsupported version retention, invalid nested profiles, concurrent creates, canonical field stripping, and POSIX file mode where available.
- `bun test test/koala/model-profile-store.test.ts`: 14 passed and 0 failed from `packages/opencode`.
- `bun typecheck`: passed from `packages/opencode`.
- `bun test`: 42 passed and 0 failed from `packages/koala`.
- `bun typecheck`: passed from `packages/koala`.
- `git diff --check`: passed from the repository root.

## Unresolved Platform Risks

- The POSIX `0600` assertion is skipped on Windows because Windows does not expose equivalent Unix permission bits. The store still requests mode `0600` when creating the temporary file on Windows.
- Atomic replacement behavior ultimately depends on the filesystem implementation. The focused suite exercises replacement on the current Windows filesystem, but does not cover network filesystems with weaker rename semantics.
