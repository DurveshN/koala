# Koala Industrial Tools Design

## Scope

This program implements every industrial tool named in the Koala implementation
plan and adds format-specific readers and immutable update tools required for
practical document workflows.

The model-facing registry will contain:

```text
document_extract
ocr_extract
vision_analyze
knowledge_ingest
knowledge_search
knowledge_open
docx_read
docx_create
docx_update
pptx_read
pptx_create
pptx_update
spreadsheet_read
spreadsheet_write
spreadsheet_update
pdf_read
pdf_create
pdf_update
calculate
sandbox_execute
sandbox_test
artifact_validate
```

Spreadsheet tools cover XLSX as the primary editable workbook format and CSV as
a simpler interchange format. Duplicate `excel_*` names are not added because
Excel is one spreadsheet product/format rather than a separate tool category.

The program is delivered in dependency-ordered subphases. Tools are registered
only when their underlying engine is functional and tested; placeholder tools
are not exposed to models.

## Shared Tool Contract

Koala owns browser-safe Effect schemas for industrial inputs and results. The
active OpenCode V1 tool layer remains a thin adapter until the product performs a
separate runtime migration.

Every industrial tool has:

- a typed input schema;
- a typed structured result schema;
- a permission classification;
- cancellation and deadline behavior;
- bounded model-facing text;
- optional artifact references and source citations;
- a durable redacted audit record;
- stable engine and schema versions;
- stable, curated error codes without raw native/parser exceptions.

Binary data, data URLs, raw document content, credentials, and private storage
paths are not written into audit records or model-facing output.

## Input Boundary

Document tools accept either:

```text
{ artifactID }
{ path }
```

Artifact inputs are checked against Session ownership before use. Project-path
inputs pass the existing `read` and external-directory authorization boundary,
then are copied into private staging, validated, and snapshotted into the
artifact store. All engines operate on immutable artifacts rather than live host
paths.

The snapshot records source path metadata only when safe for local audit; model
output uses artifact IDs and source locators rather than absolute host paths.

## Durable Audit Foundation

Phase 9 introduces a minimal process-global audit service and database table so
new tools do not create incompatible ad hoc records before the Phase 13 UI.

One tool audit record contains:

- tool name and permission class;
- Session, message, and tool-call IDs;
- start, finish, and duration;
- outcome code, cancellation, timeout, and truncation flags;
- engine name/version and contract version;
- input digest and safe type/count summary;
- source and output artifact IDs;
- sandbox run ID when applicable;
- route-decision reference for model-backed tools;
- bounded safe error code.

It excludes raw commands, expressions, prompts, OCR text, document text,
credentials, URLs, native stderr, and host paths. Detailed user-visible results
remain in Session history and artifacts under their existing access controls.

## Bundled Document Runtime

Users must not install OCR or PDF-rendering software separately. Koala packages
one pinned target-specific document runtime for Windows, macOS, and Linux on x64
and arm64.

### Tesseract

Koala bundles:

- Tesseract OCR 5.5.x built from pinned source;
- Leptonica and only the native image dependencies present in the final build;
- `tessdata_fast` English and orientation/script detection models;
- a manifest containing versions, commits, target, build flags, file hashes, and
  dependency inventory;
- complete license files for every distributed component.

The installed executable and data live outside `app.asar` beneath
`process.resourcesPath`. Production resolution has no system `PATH` fallback and
does not download engines or language data. Development may use an explicit
override, but tests and release packaging use the staged runtime.

Tesseract runs through a dedicated child-process adapter with an absolute
executable path, argument array, no shell, fixed environment, bounded stdout and
stderr, cancellation, deadlines, and process-tree cleanup. OCR output uses TSV
so page, block, paragraph, line, word, bounding box, confidence, and text remain
available.

### PDF Rendering

Koala uses pinned PDF.js plus `@napi-rs/canvas` rather than a system Poppler
installation. PDF.js is loaded from local bytes and packaged CMaps/fonts; the
native canvas package is selected for the explicit release target and packaged
outside `app.asar` as needed.

Each PDF job runs in a dedicated worker/utility process. Pages render
sequentially at 300 DPI with fixed page-box, rotation, white-background,
annotation, font, hardware-acceleration, and rounding policy. The parent owns
per-page and whole-job deadlines and terminates the worker after cancellation or
grace timeout.

One call processes at most 100 pages. Larger documents use `startPage` and
`pageCount` continuation. Raster dimensions, pixel area, encoded image size,
temporary bytes, and document input size are bounded before allocation and
publication.

Rendered page images are temporary processing inputs, not automatically durable
artifacts. A caller may explicitly request selected page images as outputs.

## OCR And Vision Flow

For an image, `ocr_extract` runs Tesseract directly. For a PDF it performs one
coordinated operation:

1. validate the source artifact and requested page range;
2. render one page to PNG;
3. run Tesseract English OCR for that page;
4. parse TSV into words, lines, confidence, and normalized coordinates;
5. append page text and source locators to the normalized document result;
6. release the page raster before rendering the next page;
7. persist the bounded normalized result and provenance.

Tesseract runs on every processed page, including pages later analyzed by a
vision model.

`vision_analyze` sends one image or one rendered PDF page per request through
the existing pinned private endpoint transport. It requires a model profile
whose image-input capability is verified `yes`. It returns structured visual
observations tied to page/image coordinates and never replaces OCR text.

`document_extract` is the orchestration tool. It dispatches to the relevant
format reader, performs OCR for rendered PDF pages, and automatically adds
one-page-at-a-time vision analysis when the router selects a verified
vision-capable model. OCR-only operation remains available when no such model is
configured.

## Read Tools

### `docx_read`

Returns bounded paragraphs, runs, headings, lists, tables, headers, footers,
footnotes/endnotes, comments, hyperlinks, and embedded-image references. Source
locators identify OOXML part, structural path, and stable element identity when
available.

### `pptx_read`

Returns slides, layout metadata, text shapes, tables, notes, images, charts, and
relationships. Source locators identify slide and shape identities.

### `spreadsheet_read`

Returns workbook metadata, sheets, bounded ranges, cell values, formulas,
displayed values, merged cells, styles needed for interpretation, tables, and
charts. Source locators use sheet and cell/range coordinates. Formula execution
is not silently performed by Koala unless a selected deterministic formula
engine explicitly supports it.

### `pdf_read`

Returns page count, page boxes, rotation, available text, metadata, links,
actions, attachments, forms, and image references. It does not claim OCR text;
scanned pages are handled by `ocr_extract` or `document_extract`.

### `document_extract`

Produces one normalized representation across supported source types while
retaining format-specific source locators. Full normalized output is artifact-
backed; model-facing text is a bounded summary with citations.

## Create And Update Tools

All create tools use deterministic host-owned generators. Generated code through
`sandbox_execute` is an explicit fallback for unusual transformations, not the
routine path.

Every output is written to private staging, reopened with an independent reader,
validated with its required profile, promoted into immutable storage, and
returned as an artifact reference.

### DOCX

- `docx_create` accepts structured document sections, paragraphs, styles,
  tables, images, headers/footers, and metadata.
- `docx_update` accepts a source DOCX artifact and typed operations for replacing
  located text, adding/removing/reordering sections, updating tables/images, and
  editing headers/footers.

### PPTX

- `pptx_create` accepts slide masters/themes, slides, shapes, text, images,
  tables, charts, notes, and metadata.
- `pptx_update` accepts typed slide and shape operations, including
  add/remove/reorder and located content updates.

### Spreadsheets

- `spreadsheet_write` creates XLSX or CSV with sheets, values, formulas, styles,
  tables, merged cells, charts, validation, and metadata under fixed limits.
- `spreadsheet_update` applies typed sheet, cell/range, formula, style, table,
  chart, and metadata operations to a source workbook.

### PDF

- `pdf_create` produces final-layout PDFs from structured pages and content.
- `pdf_update` supports safe page append/remove/reorder, metadata, annotations,
  and overlays. It rejects arbitrary in-place editing of existing PDF text.
  Generated PDFs should be regenerated from the editable source artifact when
  semantic content changes.

Updates never mutate an existing artifact. They produce a new independently
validated artifact with `derived-from` lineage to the source and any additional
input artifacts. Imported files with unsupported structures or ambiguous
locators fail explicitly rather than being rewritten lossily.

## Validation

`artifact_validate` runs a named validation profile and persists a versioned
validation attempt. Storage safety remains separate from format-semantic claims.

Validation profiles include:

- artifact integrity and MIME consistency;
- PDF structure, actions, attachments, forms, encryption, and malformed object
  policy;
- OOXML archive traversal, entry count, decompressed size, compression ratio,
  content types, relationships, macros, embedded objects, external links, and
  parser reopen;
- spreadsheet external links, formulas, hidden content, workbook integrity, and
  parser reopen;
- generated-document conformance expected by each create/update tool.

Findings use stable codes and curated bounded messages. They do not include raw
XML, macro source, document text, external URLs, parser stacks, or host paths.

## Calculation

`calculate` uses a custom bounded expression parser over a pinned independent
`decimal.js` constructor. It does not use JavaScript `eval`, Code Mode, a shell,
or the native sandbox for routine calculations.

The first grammar supports decimal literals, parentheses, unary signs,
addition, subtraction, multiplication, division, right-associative powers,
postfix percentages, bounded functions, and a closed unit-conversion registry.
Results are canonical decimal strings, not JSON floating-point numbers.

The evaluator bounds expression length, tokens, digits, nesting, operations,
precision, exponents, function arguments, unit powers, and result size. Currency
and live-rate conversion are excluded because they require external mutable
data.

## Sandbox Diagnostics

`sandbox_test` uses a fixed host-generated self-test protocol rather than
model-authored commands. It reports stable booleans/reason codes for packaged
runtime availability and permitted/denied filesystem and network probes. It
shares the `sandbox_execute` permission class and exposes no dependency stderr,
usernames, environment values, or host paths.

## Knowledge Tools

`knowledge_ingest` accepts approved source artifacts, runs normalized extraction,
chunks by source structure, and records source digest plus extractor/chunker
versions. The initial index is SQLite FTS5.

`knowledge_search` returns ranked bounded excerpts with artifact and
page/slide/sheet/paragraph citations. `knowledge_open` resolves one cited source
region under ownership checks.

Embedding and vector search remain behind `VectorIndex` until their model and
native packaging constraints are evaluated. FTS5 remains fully functional
without embeddings.

## Implementation Order

### 9A: Shared Contracts And Audit

- industrial input/result/citation schemas;
- artifact/path snapshot input service;
- permission classifications;
- durable redacted audit service/table;
- common cancellation, deadlines, and output projection;
- sandbox structured-result/truncation cleanup.

### 9B: Bundled Document Runtime

- pinned six-target Tesseract builds and English/OSD data;
- pinned PDF.js/canvas packages and assets;
- manifests, checksums, licenses, signing, target selection, resolvers, and
  packaged smoke tests;
- OCR and render child-process protocols.

### 9C: Reading, OCR, And Vision

- `docx_read`, `pptx_read`, `spreadsheet_read`, `pdf_read`;
- `ocr_extract`, `vision_analyze`, and `document_extract`;
- normalized document artifacts and source citations.

### 9D: Calculation And Diagnostics

- `calculate`;
- `sandbox_test`;
- validation registry/history and `artifact_validate`.

### 9E: Validation, Creation, And Updates

- deep OOXML/PDF validators;
- `docx_create`, `docx_update`;
- `spreadsheet_write`, `spreadsheet_update`;
- `pptx_create`, `pptx_update`;
- `pdf_create`, `pdf_update`.

The initial acceptance deliverable remains the inspection approval-note DOCX.

### 9F: Knowledge

- FTS5 schema and version identity;
- `knowledge_ingest`, `knowledge_search`, `knowledge_open`;
- optional embedding/vector implementation only after packaging evaluation.

## Verification

Verification is package-local and includes:

- typed schema and permission tests for every tool;
- audit redaction with canary secrets and host paths;
- cancellation, timeout, truncation, malformed input, and resource limits;
- golden read/create/update fixtures for every supported format;
- hostile PDF/OOXML/archive fixtures;
- independent parser reopen for every generated artifact;
- immutable source/output lineage and ownership checks;
- OCR fixtures for text, tables, rotation, scans, and mixed visual pages;
- page-level OCR boxes/confidence and vision citations;
- no-network execution with only configured private model endpoints;
- packaged OCR/PDF-runtime checks on Windows, macOS, and Linux for x64 and
  arm64, with system Tesseract absent;
- recursive Windows signature checks, macOS codesign/notarization checks, Linux
  architecture/dependency/mode checks, and license inventory validation;
- end-to-end scanned-report, coding, and sovereignty workflows.

## Deferred From This Program

- runtime downloads of OCR/PDF engines or language packs;
- system Tesseract/Poppler fallback in production;
- unbounded PDFs or whole-document vision requests;
- arbitrary destructive mutation of existing artifacts;
- arbitrary PDF text editing;
- cloud OCR, cloud vision, internet search, or public model providers;
- artifact cards and complete audit/network UI, which remain Phase 13 display
  work over the durable records created here.
