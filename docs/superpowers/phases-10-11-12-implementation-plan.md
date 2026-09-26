# Koala Phases 10, 11, 12 Implementation Plan

## Scope

This plan implements the remaining industrial-tool work mapped to the approved
`docs/plans/koala-implementation-plan.md` phases:

- **Phase 10 (Multimodal Document Pipeline)** maps to Industrial Tools subphase **9C**:
  `pdf_read`, `docx_read`/`pptx_read`/`spreadsheet_read` normalization,
  `ocr_extract`, `vision_analyze`, and `document_extract`.
- **Phase 11 (Deliverable Generation)** maps to subphase **9E**:
  validated DOCX/PPTX/XLSX/PDF creation and update, starting with the inspection
  approval-note `docx_create` workflow and OOXML validation.
- **Phase 12 (Local Knowledge Base)** maps to subphase **9F**:
  `knowledge_ingest`, `knowledge_search`, and `knowledge_open` with chunked
  citations and a fallback for the missing `node:sqlite` FTS5 extension.

Everything builds on the existing 9A/9B/9D foundation and the recently merged
Office-reader slice.

## Current Foundation (do not rebuild)

The following already exists and must be reused as-is:

- `packages/koala/src/industrial/*` — typed contracts, input, citation, result,
  audit, and the closed 22-tool inventory.
- `packages/core/src/artifact/sql.ts` — `koala_artifact_blob`,
  `koala_artifact`, `koala_artifact_lineage`.
- `packages/core/src/tool-audit/sql.ts` — `koala_tool_audit` with durable
  constraints.
- `packages/core/src/database/migration.ts` — existing migration runner; new
  tables are added through generated TypeScript migrations under
  `packages/core/src/database/migration/`.
- `packages/opencode/src/koala/artifact-input.ts` — resolves `{ artifactID }`
  and `{ path }` inputs into immutable private snapshots.
- `packages/opencode/src/koala/industrial-execution.ts` — permission, deadline,
  cancellation, audit, artifact commit, and bounded projection.
- `packages/opencode/src/koala/industrial-audit.ts` — durable redacted audit.
- `packages/opencode/src/koala/artifact-store.ts` — immutable blob promotion
  and lineage.
- `packages/opencode/src/tool/registry.ts` — V1 tool registry; new adapters are
  initialized here and gated by engine availability.
- `packages/opencode/src/document/runtime.ts` — `DocumentRuntime` coordinator
  with `ocr`, `readOffice`, and `renderAndOcr`.
- `packages/document-runtime/src/worker.ts` — pure-JS worker dispatch for
  `probe`, `render`, `ocr`, `read-office`, `release-page`, `cancel`.
- `packages/koala/src/model/router.ts` and
  `packages/opencode/src/koala/model-endpoint-client.ts` — capability-aware
  routing and pinned transport for vision requests.

## Constraints Discovered

- The existing Office reader tools (`docx_read`, `pptx_read`,
  `spreadsheet_read`) bypass the industrial boundary and take raw absolute paths.
  They must be refactored through `ArtifactInput` and `IndustrialExecution`
  before `document_extract` can reuse their output.
- `node:sqlite` reports `fts5: 0` on this repo. Phase 12 cannot rely on SQLite
  FTS5 out of the box. The plan first probes `Bun.sql`/Bun SQLite for FTS5, and
  if unavailable falls back to a pure-TypeScript inverted index over a regular
  SQLite table. The tool schemas stay identical so FTS5 can replace it later.
- Native document execution remains release-blocked by the six-target artifact
  matrix, SRT evidence, and Koala license/issuer. Tool implementations must be
  testable in the existing development build while remaining fail-closed when
  the runtime is unavailable.

---

## Milestone 1 — Phase 10: Multimodal Document Pipeline

### Goal

Add the read/OCR/vision/extraction tools and a shared normalized document
representation. Refactor the existing Office readers onto the industrial
boundary.

### New Koala schemas

| File | Purpose |
|------|---------|
| `packages/koala/src/document/normalized.ts` | `NormalizedDocument`, `Page`, `Section`, `OcrWord`, `OcrLine`, `VisualObservation`, and source locators. |
| `packages/koala/src/document/tool.ts` | `PdfRead`, `OcrExtract`, `VisionAnalyze`, `DocumentExtract` input and result schemas. |
| `packages/koala/src/document/engine.ts` | Engine identity (`document-runtime/pdfjs-tesseract`, `document-runtime/pure-js-office`, `model/vision`). |

### Document runtime extensions

| File | Purpose |
|------|---------|
| `packages/document-runtime/src/read/pdf.ts` | Extract PDF metadata, page boxes, text, links, and image references with PDF.js; no OCR. |
| `packages/document-runtime/src/read/index.ts` | Re-export read helpers. |

Modify:

- `packages/koala/src/document-runtime/protocol.ts` — add `ReadPdfRequest` and
  `PdfInfoEvent`/`PageTextEvent` output shapes.
- `packages/document-runtime/src/worker.ts` — dispatch `read-pdf` and stream
  bounded JSON text output through the existing NDJSON transfer frames.
- `packages/opencode/src/document/runtime.ts` — add `readPdf(input)` returning
  structured PDF text/pages.

### Tool adapters

All new adapters live under `packages/opencode/src/tool/` and follow the
`calculate.ts` pattern: use `IndustrialExecution.execute`, `ArtifactInput`,
`ArtifactStore`, and return typed metadata plus bounded projection.

| File | Tool | What it does |
|------|------|--------------|
| `packages/opencode/src/tool/pdf-read.ts` | `pdf_read` | Resolves input, calls `DocumentRuntime.readPdf`, stores normalized JSON as an artifact, returns bounded summary with page locators. |
| `packages/opencode/src/tool/ocr-extract.ts` | `ocr_extract` | Images go to `DocumentRuntime.ocr`; PDFs go to `DocumentRuntime.renderAndOcr` with per-page TSV parsing; returns OCR text/boxes and page locators. |
| `packages/opencode/src/tool/vision-analyze.ts` | `vision_analyze` | Routes one PNG/page at a time through `ModelRouter` (`task: "vision"`) and `ModelEndpointClient.bind`, calls `/v1/chat/completions` with a base64 image, and returns structured visual observations tied to page image locators. |
| `packages/opencode/src/tool/document-extract.ts` | `document_extract` | Sniffs format (MIME + extension), dispatches to Office/PDF readers, runs OCR on every rasterized PDF page, optionally runs one-page-at-a-time `vision_analyze` when a verified vision model exists, and assembles one artifact-backed `NormalizedDocument`. |

Refactor:

- `packages/opencode/src/tool/office.ts` — replace raw `path`-only parameters
  with `{ source: { artifactID } \| { path } }`, route through
  `ArtifactInput.resolve` and `IndustrialExecution.execute`, and return a
  bounded text summary plus the normalized artifact reference with citations.
  Keep the model-facing tool names `docx_read`, `pptx_read`, `spreadsheet_read`.

### Registry updates

- In `packages/opencode/src/tool/registry.ts`:
  - Initialize the four new tool adapters.
  - Add them to `builtin` only when `DocumentRuntime` reports `available` or a
    `KOALA_ENABLE_DOCUMENT_TOOLS` test override is set, so tests and development
    can exercise them without claiming production readiness.
  - For `vision_analyze`, additionally require at least one model profile whose
    `imageInput` capability is verified `yes`.

### Tests

| File | Coverage |
|------|----------|
| `packages/koala/test/document/normalized.test.ts` | Schema round-trips, locator validation, citation bounds. |
| `packages/document-runtime/test/read.test.ts` | PDF read fixtures and protocol order. |
| `packages/opencode/test/tool/pdf-read.test.ts` | Mocked runtime + artifact input + audit. |
| `packages/opencode/test/tool/ocr-extract.test.ts` | Mocked OCR/render pipeline. |
| `packages/opencode/test/tool/vision-analyze.test.ts` | Mocked `ModelRouter`/`ModelEndpointClient`. |
| `packages/opencode/test/tool/document-extract.test.ts` | End-to-end dispatch with mocked engines. |
| `packages/opencode/test/tool/office.test.ts` | Refactored Office readers on `ArtifactInput`. |

### Verification

- `bun typecheck` in `packages/koala`, `packages/document-runtime`,
  `packages/opencode`, `packages/core`, `packages/desktop`.
- Package-local tests pass.
- `packages/opencode` Node build passes.
- `packages/desktop` production build passes.

---

## Milestone 2 — Phase 11: Deliverable Generation (DOCX First)

### Goal

Implement `docx_create`, `docx_update`, and the inspection approval-note
acceptance path. Validate output by reopening with an independent parser and
recording validation state in the existing artifact row. PPTX, XLSX, and PDF
remain in the same milestone if DOCX lands quickly, otherwise they become a
follow-up slice.

### Dependencies

- Add a pinned `docx` npm dependency to `packages/document-runtime/package.json`
  and `packages/document-runtime/script/build.ts` (bundle + license copy).

### Koala schemas

| File | Purpose |
|------|---------|
| `packages/koala/src/document/generate.ts` | Shared generator input/result types, update-op union (`replace-text`, `insert-section`, `update-table`, etc.). |
| `packages/koala/src/document/validation-profile.ts` | OOXML validation profile names and result schema. |

### Document runtime extensions

| File | Purpose |
|------|---------|
| `packages/document-runtime/src/generate/docx.ts` | Deterministic DOCX generation from typed sections/paragraphs/tables/images using the `docx` package. |
| `packages/document-runtime/src/validation/ooxml.ts` | OOXML archive validation: ZIP structure, content types, relationships, macro/external-link rejection, compression ratio, independent reopen with `mammoth`/`jszip`. |

Modify:

- `packages/koala/src/document-runtime/protocol.ts` — add `CreateDocxRequest` /
  `UpdateDocxRequest` and output frames.
- `packages/document-runtime/src/worker.ts` — dispatch `create-docx` /
  `update-docx` and stream generated output.
- `packages/opencode/src/document/runtime.ts` — add `createDocx(input)` /
  `updateDocx(input)` methods.

### Tool adapters

| File | Tool | What it does |
|------|------|--------------|
| `packages/opencode/src/tool/docx-create.ts` | `docx_create` | Accepts structured document input, calls `DocumentRuntime.createDocx`, validates output, promotes to artifact with `derived-from` lineage, returns artifact reference. |
| `packages/opencode/src/tool/docx-update.ts` | `docx_update` | Accepts a source DOCX artifact and typed operations, calls `DocumentRuntime.updateDocx`, validates, and returns a new artifact. |

### Artifact validation history

Re-use the existing `koala_artifact.validation` JSON column for first-party
validation results. Add:

- `packages/opencode/src/koala/artifact-validator.ts` — lightweight service that
  runs a named validation profile and updates the artifact row atomically.
- `packages/opencode/src/tool/artifact-validate.ts` — `artifact_validate` tool
  adapter so the model can trigger validation explicitly.

### Registry updates

- Register `docx_create`, `docx_update`, and `artifact_validate` when the
  document runtime is available or the test override is set.

### Tests

| File | Coverage |
|------|----------|
| `packages/document-runtime/test/generate-docx.test.ts` | Generate and reopen DOCX fixtures. |
| `packages/document-runtime/test/validation-ooxml.test.ts` | Hostile/malformed OOXML fixtures. |
| `packages/opencode/test/tool/docx-create.test.ts` | End-to-end DOCX create + validation. |
| `packages/opencode/test/tool/docx-update.test.ts` | Typed update operations. |
| `packages/opencode/test/tool/artifact-validate.test.ts` | Validation profile execution. |

### Verification

- Same package-level typechecks and tests.
- A generated inspection approval-note DOCX is reopened with Mammoth and passes
  the OOXML validation profile.

---

## Milestone 3 — Phase 12: Local Knowledge Base

### Goal

Implement `knowledge_ingest`, `knowledge_search`, and `knowledge_open`. Use the
existing application SQLite database for persistence and fall back to a pure
inverted index if FTS5 is unavailable.

### FTS5 decision

1. Probe `Bun.sql`/Bun SQLite for FTS5 at runtime during service construction.
2. If FTS5 is available, create a virtual FTS5 table for chunk text.
3. If not, create regular `koala_knowledge_term` table (term, entry_id, count)
   and use `LIKE`/`term`-matching in `knowledge_search`.

The tool schemas and citation format do not depend on the chosen indexing
strategy.

### Database schema

Add one Core Drizzle schema file:

- `packages/core/src/knowledge/sql.ts`

Tables:

```text
koala_knowledge_entry
  id: text primary key
  owner_session_id: text not null references session(id) on delete cascade
  artifact_id: text not null references koala_artifact(id)
  index_profile_id: text not null
  extractor_version: text not null
  chunker_version: text not null
  chunk_index: integer not null
  chunk_text: text not null
  locator: json not null     -- IndustrialCitation.Locator
  time_created: integer not null

koala_knowledge_term (only if FTS5 unavailable)
  term: text not null
  entry_id: text not null references koala_knowledge_entry(id) on delete cascade
  count: integer not null
  primary key (term, entry_id)
```

If FTS5 is available, also create:

```text
koala_knowledge_fts(docid, chunk_text)
```

Generate the migration via the repo's standard command:

```text
bun run migration --name koala_knowledge_base
```

Do not hand-edit the generated migration, `schema.gen.ts`, or
`migration.gen.ts`.

### Koala schemas

| File | Purpose |
|------|---------|
| `packages/koala/src/knowledge/tool.ts` | `KnowledgeIngest`, `KnowledgeSearch`, `KnowledgeOpen` input/result schemas and chunk/citation types. |
| `packages/koala/src/knowledge/index.ts` | Version identity: source digest, extractor version, chunker version, index profile. |

### Knowledge store

| File | Purpose |
|------|---------|
| `packages/opencode/src/koala/knowledge-store.ts` | Effect service that chunks normalized documents, writes entries/terms or FTS5 rows, searches, resolves cited regions, and prunes per-Session indexes on re-ingest. |

### Tool adapters

| File | Tool | What it does |
|------|------|--------------|
| `packages/opencode/src/tool/knowledge-ingest.ts` | `knowledge_ingest` | Resolves source artifacts, calls `document_extract` under the hood (or reads already-extracted artifact), chunks by source structure, records index identity, writes chunks/terms. |
| `packages/opencode/src/tool/knowledge-search.ts` | `knowledge_search` | Tokenizes query, searches entries, ranks by term frequency, returns bounded excerpts with citations. |
| `packages/opencode/src/tool/knowledge-open.ts` | `knowledge_open` | Resolves a citation to source artifact content under same-Session ownership and returns the cited region text. |

### Registry updates

- Register the three knowledge tools when the Core database layer is available.
  No runtime dependency on FTS5; fallback is transparent.

### Tests

| File | Coverage |
|------|----------|
| `packages/core/test/knowledge-migration.test.ts` | Generated migration applies and rolls back cleanly (where supported). |
| `packages/opencode/test/koala/knowledge-store.test.ts` | Ingest/search/open with deterministic fixture documents. |
| `packages/opencode/test/tool/knowledge*.test.ts` | Tool adapter contracts, audit, projections, citation resolution. |

### Verification

- Core migration generator and tests pass.
- All package-local typechecks and tests pass.
- Knowledge search returns citations that `knowledge_open` can resolve.

---

## Cross-Milestone Verification

After all milestones:

1. `bun typecheck` in every touched package.
2. Run package-local tests from each package directory.
3. Build the Document Runtime and OpenCode Node artifacts.
4. Build Desktop production package.
5. Update `CONTEXT.md`, `infra.md`, `learning.md`, and `THIRD_PARTY_NOTICES.md`
   with new dependencies, design decisions, and blockers.
6. Record a `.subagent/phases-10-11-12-implementation.md` summary once complete.

## Risks and Blockers

- **Native document runtime** is not release-ready. Development builds can use
  the existing dev runtime; production remains gated by external artifacts and
  SRT evidence.
- **FTS5** is missing from `node:sqlite`. If Bun SQLite also lacks FTS5, we ship
  the inverted-index fallback and schedule FTS5 packaging separately.
- **Vision analysis** requires at least one local model profile with verified
  `imageInput: yes`. Without it, `document_extract` falls back to OCR-only and
  `vision_analyze` reports `engine-unavailable`.
- **DOCX generation** adds the `docx` package; its license must be copied into
  runtime build output and `THIRD_PARTY_NOTICES.md`.
- **Artifact validation history** stays minimal for this slice; full
  profile-driven validation UI is Phase 13 display work.

## Next Action

Begin Milestone 1 with Koala document schemas and the `pdf_read` runtime/tool
adapter, then proceed through OCR, vision, and `document_extract` before moving
into DOCX generation.
