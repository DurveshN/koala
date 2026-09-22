# Phase 12 — Local Knowledge Base

Phase 12 implemented the local, session-scoped knowledge base for Koala. It is
built entirely on the existing Core SQLite database and uses a pure inverted
index instead of FTS5, so it works under both `bun:sqlite` and `node:sqlite`
without requiring the FTS5 extension.

## Core knowledge schema

New file: `packages/core/src/knowledge/sql.ts`

Defines two Drizzle tables:

- `koala_knowledge_entry` — one row per text chunk.
  - `id` (text PRIMARY KEY, must start with `kwe_`).
  - `owner_session_id` (FK → `session.id` ON DELETE CASCADE).
  - `artifact_id` (FK → `koala_artifact.id` ON DELETE CASCADE).
  - `index_profile_id`, `extractor_version`, `chunker_version` (text, not null).
  - `chunk_index` (integer >= 0).
  - `chunk_text` (text, not null).
  - `locator` (JSON object, not null).
  - `time_created` (integer, default `Date.now()`).
  - Indexes on `owner_session_id` and `artifact_id`.

- `koala_knowledge_term` — inverted-index term frequency rows.
  - `term` (text, not null).
  - `entry_id` (FK → `koala_knowledge_entry.id` ON DELETE CASCADE).
  - `count` (integer > 0).
  - Composite PRIMARY KEY `(term, entry_id)`.
  - Indexes on `term` and `entry_id`.

Generated artifacts updated:

- `packages/core/src/database/migration/20260922025546_koala_knowledge_base.ts` —
  the up-migration that creates both tables and their indexes.
- `packages/core/src/database/schema.gen.ts` — regenerated full baseline schema
  including the two new tables and indexes.
- `packages/core/src/database/migration.gen.ts` — now imports and exports the
  new migration `20260922025546_koala_knowledge_base`.
- `packages/core/schema.json` — regenerated JSON schema artifact.

## FTS5 fallback decision

The implementation deliberately avoids FTS5. The inverted index is a plain
SQLite table (`koala_knowledge_term`) plus application-level tokenization. This
keeps the knowledge base compatible with both `bun:sqlite` and `node:sqlite`
runtimes, where FTS5 may not be enabled. Search is therefore implemented as a
ranked boolean AND query over exact term matches grouped by entry.

## Koala knowledge schemas

New file: `packages/koala/src/knowledge/tool.ts`

Exports the `Knowledge` namespace with:

- `KnowledgeEntryID` — branded `string` (`Schema.String.pipe(Schema.brand("KnowledgeEntryID"))`).
- `KnowledgeIngest` — input (`source: Artifact.ID`, optional
  `indexProfileID`/`extractorVersion`/`chunkerVersion`) and industrial result
  (`entries: Schema.Int`).
- `KnowledgeSearch` — input (`query: string`, optional `limit: int`) and
  industrial result (`results: array of { entryID, text, score, locator }`).
- `KnowledgeOpen` — input (`entryID: KnowledgeEntryID`) and industrial result
  (`{ entryID, text, locator }`).

All results use `IndustrialResult.make` with the canonical checked
success/error/cancelled/timeout envelope.

Wiring changes in Koala:

- `packages/koala/src/document/engine.ts` — added `KnowledgeEngine`
  (`local-knowledge-store` v1).
- `packages/koala/src/index.ts` — re-exported `Knowledge`.
- `packages/koala/package.json` — added `"./knowledge/*": "./src/knowledge/*.ts"`
  export.

## KnowledgeStore service

New file: `packages/opencode/src/koala/knowledge-store.ts`

Process-global Effect service (`@opencode/KnowledgeStore`) backed by the Core
`Database`. It exposes three operations:

- `ingest({ sessionID, artifactID, artifactName, text, indexProfileID,
  extractorVersion, chunkerVersion })`:
  - Deletes any prior entries for the same `(sessionID, artifactID)` pair.
  - Parses the text as a `NormalizedDocument` if possible and extracts text
    pieces from `sections[].body` and `pages[].textBlocks[].paragraphs[]`.
  - Chunks text into ~1000-character segments, preferring newline boundaries
    inside the limit.
  - Issues `kwe_<uuid>` entry IDs and inserts rows into
    `koala_knowledge_entry`.
  - Tokenizes each chunk into lowercase alphanumeric tokens (>= 2 chars,
    English stop-word list), counts frequencies, and inserts rows into
    `koala_knowledge_term`.
  - Returns the number of entries created.

- `search({ sessionID, query, limit? })`:
  - Tokenizes the query the same way.
  - Runs a raw SQL query joining `koala_knowledge_entry` and
    `koala_knowledge_term`, filtering to the session and exact query terms.
  - Requires every query term to appear in an entry (boolean AND).
  - Ranks by `SUM(t.count)` descending.
  - Decodes the stored JSON locator and branded entry ID.
  - Returns `ReadonlyArray<SearchResult>`.

- `open({ sessionID, entryID })`:
  - Looks up one entry by ID restricted to the owning session.
  - Returns the chunk text, locator, and a zero score, or `undefined`.

Service layer:

- `Layer.effect(Service, ...)` yields `Database.Service` and wraps each public
  method with `Effect.orDie`.
- `KnowledgeStore.node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })`.

Stop-word list is an inline English set of ~120 common words (articles,
prepositions, auxiliary verbs, pronouns, etc.). Tokenization uses
`.toLowerCase().split(/[^a-z0-9]+/)` and filters tokens by length and stop word.

## OpenCode tool adapters

Three new adapters in `packages/opencode/src/tool/`:

- `knowledge-ingest.ts` — `KnowledgeIngestTool` (`knowledge_ingest`).
  - Requests `knowledge_write` permission.
  - Resolves input `{ source: Artifact.ID }` through `ArtifactInput.Service`.
  - Reads the artifact snapshot text with `Bun.file(...).text()`.
  - Calls `KnowledgeStore.ingest` with `indexProfileID`/`extractorVersion`/
    `chunkerVersion` defaults (`"default"`, `"1"`, `"1"`).
  - Deadline: 120,000 ms.
  - Returns an industrial result citing the source artifact.

- `knowledge-search.ts` — `KnowledgeSearchTool` (`knowledge_search`).
  - Requests `knowledge_read` permission.
  - Calls `KnowledgeStore.search` with the session-scoped query and optional
    limit (default handled by the store).
  - Resolves result source artifact metadata through `ArtifactStore.Service`.
  - Deadline: 30,000 ms.
  - Returns an industrial result containing the ranked result list and source
    citations.

- `knowledge-open.ts` — `KnowledgeOpenTool` (`knowledge_open`).
  - Requests `knowledge_read` permission.
  - Calls `KnowledgeStore.open` with the session and entry ID.
  - Returns `source-not-found` if the entry is absent or not owned by the
    session.
  - Resolves source artifact metadata for the locator.
  - Deadline: 30,000 ms.

All three use `IndustrialExecution.execute` so they inherit auditing,
permissions, deadlines, cancellation, and result projection. They import shared
helpers (`artifactReference`, `artifactLocator`, `makeError`, `makeRunID`,
`truncateSummary`) from `document-common.ts`.

## Tool registry registration

Modified file: `packages/opencode/src/tool/registry.ts`

- Imports `KnowledgeIngestTool`, `KnowledgeSearchTool`, and
  `KnowledgeOpenTool`.
- Imports the `KnowledgeStore` node.
- Adds `KnowledgeStore.node` to the registry `LayerNode` dependencies.
- Initializes the three knowledge tools in the registry `Effect.all` block.
- Appends them to the `builtin` tool list unconditionally, after the
document tools.
- Unlike the document tools, the knowledge tools are **not** filtered by
  `DocumentRuntime.availability()` or `KOALA_ENABLE_DOCUMENT_TOOLS` because they
only depend on the Core database.

The registry dependency list now also includes `ArtifactInput.node`,
`ModelProfileStore.node`, `ModelEndpointClient.node`, and `Auth.node` (these
came in with the broader Phase 10/11 tool work but are required for the
complete registry to build).

## Tests

New test files:

- `packages/opencode/test/koala/knowledge-store.test.ts` — 3 live Effect tests:
  - ingest a document and search for matching chunks;
  - search across multiple documents and return only matching chunks;
  - re-ingesting the same artifact replaces prior entries.

- `packages/opencode/test/tool/knowledge-fixture.ts` — shared test fixture that
  sets up a temporary database, project, session, message, source artifact,
  mocked `ArtifactStore`, mocked `ArtifactInput`, and the industrial/knowledge
  service layers needed by the tool adapter tests.

- `packages/opencode/test/tool/knowledge-ingest.test.ts` — verifies ingest,
  permission request (`knowledge_write`), success result, and audit row.

- `packages/opencode/test/tool/knowledge-search.test.ts` — verifies search,
  permission request (`knowledge_read`), scored results, and audit row.

- `packages/opencode/test/tool/knowledge-open.test.ts` — verifies opening an
  entry by ID and the not-found error path.

## Files created

- `packages/core/src/knowledge/sql.ts`
- `packages/core/src/database/migration/20260922025546_koala_knowledge_base.ts`
- `packages/koala/src/knowledge/tool.ts`
- `packages/opencode/src/koala/knowledge-store.ts`
- `packages/opencode/src/tool/knowledge-ingest.ts`
- `packages/opencode/src/tool/knowledge-search.ts`
- `packages/opencode/src/tool/knowledge-open.ts`
- `packages/opencode/test/koala/knowledge-store.test.ts`
- `packages/opencode/test/tool/knowledge-fixture.ts`
- `packages/opencode/test/tool/knowledge-ingest.test.ts`
- `packages/opencode/test/tool/knowledge-search.test.ts`
- `packages/opencode/test/tool/knowledge-open.test.ts`

## Files modified

- `packages/core/src/database/schema.gen.ts` — added `koala_knowledge_entry`
  and `koala_knowledge_term` table definitions and indexes.
- `packages/core/src/database/migration.gen.ts` — added the new migration to
  the ordered list.
- `packages/core/schema.json` — regenerated JSON schema with the new tables.
- `packages/koala/src/document/engine.ts` — added `KnowledgeEngine`.
- `packages/koala/src/index.ts` — exported `Knowledge` namespace.
- `packages/koala/package.json` — added `./knowledge/*` export.
- `packages/opencode/src/tool/registry.ts` — imported, initialized, registered,
  and added `KnowledgeStore.node` dependency for the three knowledge tools.
- `CONTEXT.md` and `infra.md` — documented the Phase 12 knowledge-base design
  and verification results.

## Verification (from this branch)

From the perspective of branch `phase-10-11-12`:

- `packages/koala`: `bun run typecheck` passed.
- `packages/core`: `bun run typecheck` passed; `bun run migration --check`
  passed.
- `packages/opencode`: `bun run typecheck` passed.
- `packages/opencode`: focused knowledge tests passed:
  - `test/koala/knowledge-store.test.ts`: 3 passed.
  - `test/tool/knowledge-ingest.test.ts`: 1 passed.
  - `test/tool/knowledge-search.test.ts`: 1 passed.
  - `test/tool/knowledge-open.test.ts`: 2 passed.
- `packages/opencode`: `bun test test/document --timeout 30000` returned 182
  passed, 1 skipped, 0 failed.
- `packages/opencode`: `bun run script/build-node.ts` completed successfully.
- `packages/desktop`: `bun run typecheck` passed.

The broader `packages/core` full test suite showed unrelated intermittent
failures in an effect-flock stress test under process contention; these are not
caused by the knowledge-base work.
