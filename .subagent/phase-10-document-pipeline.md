# Phase 10 — Multimodal Document Pipeline

This report documents the work implemented for **Koala Phase 10** (Industrial
Tools subphase 9C) on branch `phase-10-11-12`. Phase 10 adds the multimodal
document read/OCR/vision/extraction pipeline on top of the existing Industrial
Execution boundary. The branch also contains later Phase 11/12 work; this file
is scoped to Phase 10 only.

## Branch and baseline

- Current branch: `phase-10-11-12`
- Comparison baseline: `origin/dev`
- Phase-10-focused diff (selected paths): 27 files changed, 3,945 insertions(+),
  76 deletions(-).

The full branch diff includes Phase 11 (DOCX generation / OOXML validation) and
Phase 12 (local knowledge base). Those are documented in
`.subagent/phase-11-docx-generation.md` and
`.subagent/phase-12-knowledge-base.md` respectively.

## Scope

Phase 10 implements:

1. Browser-safe Koala document schemas and engine identities.
2. A pure-JS PDF text reader inside the confined document runtime, backed by the
   already-bundled `pdfjs-dist`.
3. Four new OpenCode tool adapters on the industrial boundary:
   `pdf_read`, `ocr_extract`, `vision_analyze`, `document_extract`.
4. A refactor of the existing Office readers (`docx_read`, `pptx_read`,
   `spreadsheet_read`) to route through `ArtifactInput` +
   `IndustrialExecution`.
5. Tool-registry gating so the new document tools are only model-visible when the
   document runtime is available or a development override is set.
6. Contract, runtime, and adapter tests.

## 1. Koala document schemas

Added browser-safe Effect schemas that all Phase 10 tools share.

### New files

- `packages/koala/src/document/engine.ts`
  - Added decoded engine identities: `PdfReadEngine` (`pdfjs/1`),
    `OcrEngine` (`tesseract/5.5.3`), `OfficeReadEngine`
    (`pure-js-office/1`), `VisionEngine` (`local-vision-model/1`),
    `DocxCreateEngine` (`docx-writer/1`), `ValidationEngine`
    (`ooxml-validator/1`), and `KnowledgeEngine`
    (`local-knowledge-store/1`).
  - The Phase 10 tools consume `PdfReadEngine`, `OcrEngine`,
    `OfficeReadEngine`, and `VisionEngine`.

- `packages/koala/src/document/normalized.ts`
  - `DocumentNormalized.Confidence` — normalized `[0,1]` confidence.
  - `DocumentNormalized.BoundingBox` — left/top/right/bottom in normalized
    coordinates, validated so right > left and bottom > top.
  - `DocumentNormalized.OcrWord`, `.OcrLine`, `.PageTextBlock`,
    `.ImageRegion`, `.VisualObservation`.
  - `DocumentNormalized.Dimensions`, `.Page`, `.Section`,
    `.DocumentMetadata`, and the top-level `DocumentNormalized.NormalizedDocument`
    binding a source locator, pages, sections, metadata, and a `truncated` flag.

- `packages/koala/src/document/tool.ts`
  - `DocumentTool.PdfRead.Input` / `.Result` — accepts `{ artifactID | path }`
    plus an optional page range and returns a `NormalizedDocument`.
  - `DocumentTool.OcrExtract.Input` / `.Result` — accepts a single image/PDF
    source, optional page or page range, and returns per-page OCR lines.
  - `DocumentTool.VisionAnalyze.Input` / `.Result` — accepts an image or PDF
    source with an optional prompt and returns structured visual observations.
  - `DocumentTool.DocumentExtract.Input` / `.Result` — accepts a source plus
    optional `includeOcr`, `includeVision`, and `prompt`, and returns a
    `NormalizedDocument`.
  - All four result schemas are built through `IndustrialResult.make`, giving
    them the standard checked-envelope shape (tool, contractVersion, engine,
    status, sources, outputs, citations, producerTruncated, sandboxRunID,
    summary, data).

- `packages/koala/src/document/validation.ts`
  - Added `DocumentValidation.ArtifactValidate` input/result schema for the
    OOXML validation tool. It is used immediately by Phase 11 but is part of
    the shared document-validation schema surface created during this milestone.

### Modified files

- `packages/koala/src/index.ts`
  - Exported `DocumentEngine`, `DocumentGenerate`, `DocumentNormalized`,
    `DocumentTool`, `DocumentValidation`, and `Knowledge` so downstream packages
    can import them.

### Tests

- `packages/koala/src/document/normalized.test.ts` — schema round-trips,
  bounding-box validation, and confidence bounds.
- `packages/koala/src/document/tool.test.ts` — valid/invalid inputs for each
  document-tool schema and result-shape assertions.

## 2. Document runtime PDF reader

Added a pure-JS PDF text extractor that runs inside the existing confined
worker. It does not require OCR or vision.

### New files

- `packages/document-runtime/src/read/pdf.ts`
  - Exports `readPdf(inputPath, declaredBytes, options)`.
  - Reads the PDF bytes using the existing `readPdfBytes` helper, opens the
    document with `pdfjs-dist`, extracts document metadata
    (title, author, subject, creator, producer, dates), page count, and per-page
    rotation / media box / text blocks.
  - Enforces `options.limits.pdfInputBytes` and `options.limits.pages`.
  - Serializes the result as UTF-8 JSON and raises curated `RuntimeFailure`
    codes (`render-failed`, `page-limit-exceeded`, `pdf-output-limit-exceeded`).

- `packages/document-runtime/src/read/index.ts`
  - Re-exports `readPdf` and its public types (`PdfOutput`, `PdfPage`,
    `PdfTextBlock`, `ReadPdfOptions`).

- `packages/document-runtime/test/read.test.ts`
  - Exercises a real two-page PDF fixture, asserts page count, rotation,
    media box, and text content.
  - Verifies that `pages: 2` limit rejects a 5-page document with
    `page-limit-exceeded`.

### Modified files

- `packages/koala/src/document-runtime/protocol.ts`
  - Added `ReadPdfRequest` to the `InitialRequest` union.
  - Added `PdfInfoEvent` to the `WorkerEvent` union.
  - Added `PdfOutputStart` to the `OutputStart` union with kind `pdf-text`.
  - Added order phases `awaiting-pdf` and `pdf-ready`.
  - Added failure code `pdf-output-limit-exceeded`.
  - Updated `OutputSourcePath` to permit `pdf/*.json` paths.
  - Updated `beginOrder`, `advanceOrder`, `matchesExpectedOutput`,
    `cumulativePayloadLimit`, `outputLimitForStart`, and
    `temporaryLimitForRequest` to handle `read-pdf` messages. One-shot result
    events (`office-ready`, `docx-ready`, `pdf-info`) advance the order to
    `awaiting-completed` so the trailing `completed` event is accepted.

- `packages/document-runtime/src/worker.ts`
  - Imported `readPdf` from `./read/pdf`.
  - Added `executeReadPdf` dispatch in `execute()`.
  - The worker validates the input file, creates `pdf/output.json`, calls the
    reader, streams it as a single `pdf-text` output frame, emits `pdf-info`,
    removes the temp file, and sends `completed`.

- `packages/document-runtime/src/index.ts`
  - Re-exported the new `read` helpers.

- `packages/opencode/src/document/runtime.ts`
  - Added `ReadPdfInput`, `ReadPdfPage`, and `ReadPdfResult` interfaces.
  - Added `readPdf` to the `Interface` and implemented it with `pdfWorker`.
  - `readPdf` stages the source into `input/document.pdf`, builds a
    `ReadPdfRequest`, runs the document proxy, reads the streamed `pdf-text`
    output, parses JSON, verifies that `parsed.pageCount` matches the
    `pdf-info` event, and returns a typed result.

## 3. OpenCode tool adapters

All four new adapters are implemented on the Industrial Execution boundary:
permission-classified, audited, deadline-bound, artifact-aware, and returning
bounded projections.

### New shared helpers

- `packages/opencode/src/tool/document-common.ts`
  - `SourceInput`, `OfficeSection`, `OfficeReadData`, and
    `makeOfficeResultSchema`.
  - MIME / extension sniffing: `mimeFromPath`, `isImageMime`, `isPdfMime`,
    office MIME predicates, `isTextMime`.
  - `documentFormat` maps a filename to `pdf | docx | pptx | xlsx | image |
    unknown`.
  - `artifactReference`, `makeProvenance`, `makeError`, `mapRuntimeError`,
    `truncateSummary`.
  - Formatters: `formatOffice`.
  - OCR TSV parsing: `boundsFromTsv`, `parseTsvLines`, `parseTesseractTsv`.
  - Normalizers: `readPdfToNormalized`, `readOfficeToNormalized`,
    `ocrToNormalized` — each produce a `NormalizedDocument` with page-level
    dimensions and source locators.
  - Citation helpers: `pageLocator`, `artifactLocator`, `makeRunID`.
  - Artifact staging helpers: `writeJsonArtifact`, `encodeFileToBase64DataURL`,
    `readText`, `readBytes`.
  - `encodeRouteDecisionID` for vision model routing.

### `pdf_read`

- File: `packages/opencode/src/tool/pdf-read.ts`
- Requests permission `document_read`, engine `PdfReadEngine`.
- Resolves `{ artifactID } | { path }` through `ArtifactInput.Service`.
- Calls `DocumentRuntime.readPdf({ inputPath: resolved.snapshotPath })`.
- Builds a `NormalizedDocument` from the runtime result, optionally filters to
  the requested page range.
- Small results are embedded in the checked result; results above
  `PersistThresholdBytes` (128 KiB) are promoted as a `normalized.json`
  artifact with `derived-from` lineage.
- Returns `pages.length`, source citations (`pageLocator`), and a bounded summary.

### `ocr_extract`

- File: `packages/opencode/src/tool/ocr-extract.ts`
- Requests permission `document_read`, engine `OcrEngine`.
- Resolves the source, sniffs the format:
  - Single image or explicit `page` → `DocumentRuntime.ocr`.
  - PDF → `DocumentRuntime.renderAndOcr` over the requested range (defaults to
    100 pages).
- Parses Tesseract TSV into `OcrLine` / `OcrWord` with normalized bounds and page
  locators.
- Persists large results as `ocr.json` artifacts.

### `vision_analyze`

- File: `packages/opencode/src/tool/vision-analyze.ts`
- Requests permission `vision_analyze`, engine `VisionEngine`.
- Uses `ModelRouter.route({ task: "vision" })` with the current profile list to
  select a vision-capable model.
- Receives the source artifact, supports both images and PDFs:
  - Images are base64-encoded directly.
  - PDFs are rendered to page 1 via `DocumentRuntime.renderAndOcr` and then
    base64-encoded.
- Binds a pinned `ModelEndpointClient`, reads the provider API key through the
  existing `Auth.Service`, and POSTs a non-streaming chat-completions request
  with the image URL.
- Parses the response: first tries the structured `ObservationsResponse`
  schema, falling back to treating the entire content as one observation.
- Builds `VisualObservation` values with optional normalized bounding boxes and
  source locators.
- Large observation sets are persisted as `observations.json` artifacts.

### `document_extract`

- File: `packages/opencode/src/tool/document-extract.ts`
- Requests permission `document_read`, local engine `document-extract/1`.
- Sniffs format, then dispatches:
  - PDF → `readPdf` → `readPdfToNormalized`.
  - Image → `ocr` → `ocrToNormalized`.
  - DOCX/PPTX/XLSX → `readOffice` → `readOfficeToNormalized`.
  - Known text-like formats → `readText` → `textToNormalized`.
- Persists large `NormalizedDocument` results as `normalized.json` artifacts.

### Tests

- `packages/opencode/test/tool/pdf-read.test.ts` — mocked runtime, asserts
  normalized pages, audit row, and page-range filtering.
- `packages/opencode/test/tool/ocr-extract.test.ts` — mocked OCR TSV parsing,
  verifies line grouping and audit.
- `packages/opencode/test/tool/vision-analyze.test.ts` — mocked model router,
  endpoint client, and auth service; covers image and PDF paths, observation
  parsing, and audit.
- `packages/opencode/test/tool/document-extract.test.ts` — end-to-end dispatch
  with mocked runtime engines.
- `packages/opencode/test/tool/document-tool-fixture.ts` — shared test fixture
  providing in-memory `ArtifactStore`, `ArtifactInput`, `DocumentRuntime`, audit
  database, and required context (created during Phase 10 and reused by
  Phase 11/12 tool tests).

## 4. Refactored Office readers

The existing `docx_read`, `pptx_read`, and `spreadsheet_read` tools were
rewritten to sit on the industrial boundary and accept artifact/path sources
instead of raw absolute paths.

### Modified file

- `packages/opencode/src/tool/office.ts`
  - Replaced per-tool `Schema.Struct({ path: ... })` parameters with the shared
    `SourceInput` schema (`{ source: { artifactID } | { path } }`).
  - Introduced `makeOfficeTool<ID, Format>(id, format, description)` factory
    that produces each of the three tools.
  - Each tool now:
    1. Yields `IndustrialExecution.Service`, `DocumentRuntime.Service`, and
       `ArtifactInput.Service`.
    2. Resolves the source through `ArtifactInput.resolve` with provenance.
    3. Calls `execution.execute` with permission `document_read`, engine
       `OfficeReadEngine`, and the typed `makeOfficeResultSchema(id)` result
       schema.
    4. Calls `runtime.readOffice({ inputPath, format })` inside the operation.
    5. Returns a checked result with sections, title, author, bounded text
       projection, and source/reference metadata.
    6. Maps runtime failures through `mapRuntimeError` and returns typed
       industrial errors.

### Tests

- `packages/opencode/test/tool/office.test.ts` — verifies all three Office tools
  resolve artifact sources, call `readOffice`, produce normalized sections, and
  write durable audit rows.

## 5. Tool registry gating

### Modified file

- `packages/opencode/src/tool/registry.ts`
  - Imported the four new Phase 10 adapters plus the Phase 11 `docx_create`
    and `artifact_validate` adapters and Phase 12 knowledge tools.
  - Added `documentToolIDs` set:
    `docx_create, docx_read, pptx_read, spreadsheet_read, pdf_read,
    ocr_extract, vision_analyze, document_extract, artifact_validate`.
    (`docx_create`, `artifact_validate`, and the knowledge tools are Phase
    11/12 tools but share the same gating set.)
  - Added `Auth.node` to registry dependencies so `vision_analyze` can access
    provider API keys.
  - Added a runtime-availability check:
    ```ts
    const documentRuntime = yield* DocumentRuntime.Service
    const availability = yield* documentRuntime.availability()
    const documentsEnabled =
      availability.status === "available" ||
      process.env.KOALA_ENABLE_DOCUMENT_TOOLS === "1"
    ```
  - The document tools are initialized separately and appended to `builtin`,
    but `ToolRegistry.all()` filters them out unless `documentsEnabled` is true.
  - `ToolRegistry.node` deps were extended with `DocumentRuntime.node`,
    `ArtifactInput.node`, `ModelProfileStore.node`, `ModelEndpointClient.node`,
    `Auth.node`, and `KnowledgeStore.node`.

### Tests

- `packages/opencode/test/tool/tool-registry-document.test.ts`
  - Confirms document tools are hidden when runtime is unavailable and the env
    flag is unset.
  - Confirms they appear when `KOALA_ENABLE_DOCUMENT_TOOLS=1`.
  - Confirms they appear under sandbox execution when runtime reports
    `available`.

## 6. Verification

From the perspective of branch `phase-10-11-12`, Phase 10 verification
completed on 2026-09-22. The following results are recorded in `CONTEXT.md`
(lines 774–779):

- `packages/koala`: `bun typecheck` passed; full suite 598 passed.
- `packages/document-runtime`: `bun typecheck` passed; full suite 88 passed,
  2 skipped (existing symlink-capability skips on Windows), 0 failed.
- `packages/opencode`: `bun typecheck` passed;
  focused `packages/opencode/test/document` suite 179 passed, 1 skipped, 0
  failed.
- The broader `packages/opencode` full test run timed out and showed
  pre-existing unrelated failures in `project/vcs.test.ts` (carriage-return diff
  parsing) and `provider/cf-ai-gateway-e2e.test.ts` (unsupported provider).

Additional Phase 10-specific test coverage that passed as part of the branch:

- `packages/koala/src/document/normalized.test.ts`
- `packages/koala/src/document/tool.test.ts`
- `packages/document-runtime/test/read.test.ts`
- `packages/opencode/test/tool/pdf-read.test.ts`
- `packages/opencode/test/tool/ocr-extract.test.ts`
- `packages/opencode/test/tool/vision-analyze.test.ts`
- `packages/opencode/test/tool/document-extract.test.ts`
- `packages/opencode/test/tool/office.test.ts`
- `packages/opencode/test/tool/tool-registry-document.test.ts`

## Files changed for Phase 10

### Added

- `packages/koala/src/document/engine.ts`
- `packages/koala/src/document/normalized.ts`
- `packages/koala/src/document/tool.ts`
- `packages/koala/src/document/validation.ts`
- `packages/koala/src/document/normalized.test.ts`
- `packages/koala/src/document/tool.test.ts`
- `packages/document-runtime/src/read/pdf.ts`
- `packages/document-runtime/src/read/index.ts`
- `packages/document-runtime/test/read.test.ts`
- `packages/opencode/src/tool/pdf-read.ts`
- `packages/opencode/src/tool/ocr-extract.ts`
- `packages/opencode/src/tool/vision-analyze.ts`
- `packages/opencode/src/tool/document-extract.ts`
- `packages/opencode/src/tool/document-common.ts`
- `packages/opencode/test/tool/pdf-read.test.ts`
- `packages/opencode/test/tool/ocr-extract.test.ts`
- `packages/opencode/test/tool/vision-analyze.test.ts`
- `packages/opencode/test/tool/document-extract.test.ts`
- `packages/opencode/test/tool/office.test.ts`
- `packages/opencode/test/tool/tool-registry-document.test.ts`
- `packages/opencode/test/tool/document-tool-fixture.ts`

### Modified

- `packages/koala/src/index.ts` — exported document modules.
- `packages/koala/src/document-runtime/protocol.ts` — added `read-pdf`,
  `pdf-info`, `pdf-text` frames, order/output wiring, and failure code.
- `packages/document-runtime/src/index.ts` — re-exported read helpers.
- `packages/document-runtime/src/worker.ts` — added `executeReadPdf` dispatch.
- `packages/opencode/src/document/runtime.ts` — added `readPdf` / `pdfWorker`.
- `packages/opencode/src/tool/office.ts` — refactored to ArtifactInput +
  IndustrialExecution.
- `packages/opencode/src/tool/registry.ts` — initialized adapters and gated them
  on runtime availability / `KOALA_ENABLE_DOCUMENT_TOOLS`.

## Notes

- Native document execution (PDF.js rendering + Tesseract OCR inside SRT policy)
  remains release-blocked by the Phase 9B/9D native-confinement gates. The
  Phase 10 code is exercised in development via unit tests and, where a
  development runtime is available, via the same `DocumentRuntime` coordinator.
- `document_extract` does not yet run OCR on PDF pages or invoke vision by
  default; the schemas include the toggles for later phases. In this branch it
  dispatches to the appropriate reader based on format.
- The `vision_analyze` adapter requires a model profile whose `imageInput`
  capability is verified `yes`; routing fails closed when none exists.

## References

- `CONTEXT.md` — current milestone summary and verification results.
- `infra.md` — Phase 10/11/12 tool infrastructure description and registry gating
  notes.
- `docs/superpowers/phases-10-11-12-implementation-plan.md` — Milestone 1
  (Phase 10) design.
