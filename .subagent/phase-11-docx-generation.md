# Phase 11 — Validated DOCX Deliverables

Phase 11 implements the first slice of the Industrial Tools "deliverable generation"
program (subphase 9E): validated `.docx` creation and artifact validation. The work
adds `docx_create` and `artifact_validate` to the model-visible tool inventory and
wires generation through the already-confined `@koala-ai/document-runtime` worker
boundary.

> Source-of-truth note: at the time this report was written, `origin/dev` and the
> local `HEAD` both point to `4962592`. `git diff origin/dev..HEAD` is therefore
> empty. All Phase 11 facts below were taken from the staged working tree via
> `git diff --cached`, from the listed source files, and from `CONTEXT.md` /
> `infra.md`.

## Scope

- Dependency onboarding for `docx@9.7.1` in the document runtime.
- Koala schemas for DOCX content description and validation results.
- Document-runtime protocol additions for one-shot DOCX generation.
- Worker-side generation and OOXML validation.
- `DocumentRuntime.createDocx` in OpenCode.
- OpenCode tool adapters: `docx_create` and `artifact_validate`.
- Tool-registry gating alongside the existing document tools.
- Tests for generation, protocol, and tool behavior.

## Dependencies and licensing

### Files changed

- `packages/document-runtime/package.json`
  - Adds `docx: "9.7.1"` to runtime dependencies.
- `packages/document-runtime/source-lock.json`
  - Adds integrity lock entry for `docx@9.7.1`.
- `packages/document-runtime/script/build.ts`
  - Adds `{ name: "docx", version: "9.7.1", licenseFile: "LICENSE" }` to
    `officePackages` so the build copies the package tree and its license into
    the staged runtime artifact.
  - Adds a fallback `packageRoot` resolver that walks upward from the package's
    main entry when `require.resolve("<name>/package.json")` fails (needed
    because `docx` does not export its `package.json`).
- `THIRD_PARTY_NOTICES.md`
  - Adds an MIT notice section for `docx` and notes that the license file is
    shipped at `licenses/docx-LICENSE` inside the runtime artifact.

## Koala schemas and contracts

### Added

- `packages/koala/src/document/generate.ts`
  - `DocumentGenerate.DocxContent` — schema describing a DOCX payload with
    optional `title` and `author`, plus a `sections` array of:
    - `heading` (with optional integer `level` > 0)
    - `paragraph`
    - `table` (with `rows: string[][]`)
    - `page-break`
  - `DocumentGenerate.DocxCreate.Input` — `{ contents: DocxContent }`.
  - `DocumentGenerate.DocxCreate.Result` — Industrial result wrapping
    `{ artifact: Artifact.Reference }`.

- `packages/koala/src/document/validation.ts`
  - `DocumentValidation.ArtifactFinding` — `{ code: string, message: string }`.
  - `DocumentValidation.ArtifactValidate.Input` — `{ source: IndustrialInput.Source, profile?: "ooxml-basic" }`.
  - `DocumentValidation.ArtifactValidate.Result` — Industrial result wrapping
    `{ valid: boolean, findings: ArtifactFinding[] }`.

- `packages/koala/src/document/engine.ts`
  - Adds engine constants used by the industrial audit and result envelopes:
    - `DocumentEngine.DocxCreateEngine` (`docx-writer` / `1`)
    - `DocumentEngine.ValidationEngine` (`ooxml-validator` / `1`)

- `packages/koala/src/index.ts`
  - Re-exports `DocumentGenerate`, `DocumentValidation`, `DocumentEngine`, and
    related document/knowledge namespaces.

### Modified

- `packages/koala/src/document-runtime/protocol.ts`
  - Adds `CreateDocxRequest` with `type: "create-docx"`, `inputPath`, and
    `inputBytes`.
  - Adds `DocxReadyEvent` (`outputPath`, `outputID`, `outputSha256`, `outputBytes`).
  - Adds `DocxOutputStart` output frame of kind `docx-output`, bounded by
    `MaxOfficeOutputBytes`.
  - Adds `"create-docx"` to `Operation`.
  - Adds `"docx-generation-failed"` to `FailureCode`.
  - Adds `"awaiting-docx"` and `"docx-ready"` order phases; one-shot result events
    (`office-ready`, `docx-ready`, `pdf-info`) now advance the order to
    `"awaiting-completed"` so the following `completed` event is accepted.
  - Extends `OutputSourcePath` to accept `generate/*.docx` paths.
  - Extends output-order `published` kinds and cumulative/per-output limits to
    cover `docx-output`.

## Document-runtime worker implementation

### Added

- `packages/document-runtime/src/generate/docx.ts`
  - TypeScript interfaces `DocxContent` and `DocxSection`.
  - `generateDocx(content)` uses `docx@9.7.1` to build a `docx.Document` and
    returns `Buffer` via `docx.Packer.toBuffer`.
  - Maps sections to `docx.Paragraph`/`docx.Table`, with `headingLevel` falling
    back to `HEADING_1` for unknown levels.

- `packages/document-runtime/src/validation/ooxml.ts`
  - `validateOoxmlDocx(bytes, expectedBytes?)` performs a basic OOXML profile
    check using `jszip` and `mammoth`:
    - Requires `[Content_Types].xml`, `_rels/.rels`, and `word/document.xml`.
    - Rejects macro-enabled content types (`macroEnabled` / `macro-enabled`).
    - Rejects external relationships (`TargetMode="External"`) and suspicious
      targets (`http`, `ftp`, `file`, `\`, `../`).
    - Rejects macro/VBA relationship types.
    - Rejects compression ratios above 100:1.
    - Uses `mammoth.extractRawText` to produce extracted `text` and a
      `sectionCount` estimate.
  - Throws `RuntimeFailure("docx-generation-failed", "worker")` on any failure.

- `packages/document-runtime/test/generate-docx.test.ts`
  - Verifies that a generated DOCX passes OOXML validation and contains the
    expected text.
  - Verifies that an injected external relationship is rejected.

### Modified

- `packages/document-runtime/src/index.ts`
  - Exports `generateDocx`, `DocxContent`, `DocxSection`.
  - Exports `validateOoxmlDocx` and `OoxmlValidationResult`.

- `packages/document-runtime/src/worker.ts`
  - Imports `generateDocx`, `DocumentGenerate`, and `validateOoxmlDocx`.
  - Adds `create-docx` to the max-job-deadline branch alongside `read-office`
    and `read-pdf`.
  - Dispatches initial requests of type `create-docx` to `executeCreateDocx`.
  - New `executeCreateDocx` function:
    1. Validates `input/content.json` path and size.
    2. Decodes the JSON through `DocumentGenerate.DocxCreate.Input`.
    3. Creates `generate/output.docx`, generates bytes, and validates them with
       `validateOoxmlDocx`.
    4. Streams the file as a `docx-output` output frame.
    5. Emits `docx-ready`.
    6. Cleans up the generated file and emits `completed`.
  - New helper `readDocxContent` decodes the worker-side input file.

## OpenCode `DocumentRuntime.createDocx`

### Modified

- `packages/opencode/src/document/runtime.ts`
  - Adds `CreateDocxInput` (`{ contents }`) and `CreateDocxResult` (`{ path, bytes }`).
  - Adds `createDocx` to the `Interface`.
  - Implements `createDocx`:
    1. Encodes input through `DocumentGenerate.DocxCreate.Input`.
    2. Writes `input/content.json` into the private job root.
    3. Builds a `CreateDocxRequest` and runs it through the confined proxy.
    4. `docxWorker` waits for `started`, then `docx-ready`, resolves the output,
       reads the streamed bytes, removes the pending output, waits for
       `completed`, and returns `{ path, bytes }`.
  - One-shot terminal events (`office-ready`, `docx-ready`, `pdf-info`) now
    transition `nextEvent` handling appropriately so the subsequent
    `completed` event is accepted.
  - Adds `request.type === "create-docx"` branches to shared timeout and
    order logic.

- `packages/opencode/test/document/runtime-create-docx.test.ts`
  - Round-trips a `CreateDocxRequest` through `WorkerRequest` encoding/decoding.
  - Walks the order state through `started` -> `awaiting-docx` ->
    `docx-ready` -> `awaiting-completed` -> `terminal`.
  - Round-trips `DocumentGenerate.DocxCreate.Input`.

## OpenCode tool adapters

### Added

- `packages/opencode/src/tool/docx-create.ts`
  - `DocxCreateTool` (`docx_create`) with permission `document_write` and engine
    `DocumentEngine.DocxCreateEngine`.
  - Validates input through `DocumentGenerate.DocxCreate.Input`.
  - Invokes `DocumentRuntime.createDocx`, then runs `validateOoxmlDocx` on the
    returned bytes.
  - Stages a file named `document.docx`, promotes it through
    `ArtifactStore.promoteBatch` inside a commit boundary, and returns a success
    result containing the artifact reference.
  - Surfaces failures as industrial result envelopes (`engine-failed`,
    `artifact-storage-failed`, `internal-error`, etc.).

- `packages/opencode/src/tool/artifact-validate.ts`
  - `ArtifactValidateTool` (`artifact_validate`) with permission `document_read`
    and engine `DocumentEngine.ValidationEngine`.
  - Resolves the artifact source through `ArtifactInput.Service`.
  - Reads the snapshot bytes and calls `validateOoxmlDocx`.
  - Returns `{ valid: true, findings: [...] }` on success or an industrial error
    envelope on failure.

### Tests added

- `packages/opencode/test/tool/docx-create.test.ts`
  - Verifies successful DOCX artifact creation with a persisted success audit
    row referencing the output artifact.
  - Verifies that invalid generated bytes produce an `engine-failed` result and
    an error audit row.

- `packages/opencode/test/tool/artifact-validate.test.ts`
  - Verifies that a valid DOCX artifact passes validation with findings.
  - Verifies that non-DOCX content fails with an error audit row.

## Registry gating

### Modified

- `packages/opencode/src/tool/registry.ts`
  - Imports `DocxCreateTool` and `ArtifactValidateTool`.
  - Adds `"docx_create"` and `"artifact_validate"` to the `documentToolIDs` set
    alongside `docx_read`, `pptx_read`, `spreadsheet_read`, `pdf_read`,
    `ocr_extract`, `vision_analyze`, and `document_extract`.
  - Instantiates both tools via `Tool.init(...)` in `documentTools`.
  - Includes both tools in the `builtin` list.
  - Keeps the existing gate: document tools are visible only when
    `DocumentRuntime` reports available **or** when
    `KOALA_ENABLE_DOCUMENT_TOOLS=1` is set in development. Knowledge tools are
    registered unconditionally.

## Documentation updates

- `CONTEXT.md`
  - Records Phase 11 Milestone 2 summary: dependency, schemas, protocol,
    worker implementation, OpenCode `createDocx`, and file/test/verification
    lists.
- `infra.md`
  - Describes `docx_create` and `artifact_validate` in the Phase 10/11 document
    tools section and notes the document-runtime pipeline.
- `THIRD_PARTY_NOTICES.md`
  - Adds the `docx` MIT notice (see Dependencies section).

## Verification (from this branch)

- `packages/koala`
  - `bun typecheck` passed.
  - Full test suite passed (`598 passed` at the time of `CONTEXT.md` update).
- `packages/document-runtime`
  - `bun typecheck` passed.
  - Full suite: `90 passed, 2 skipped, 0 failed`.
  - Build passed and emitted the Windows x64 artifact including the `docx`
    component, dependency entry, and `licenses/docx-LICENSE`.
- `packages/opencode`
  - `bun typecheck` passed.
  - Focused document/runtime and document-tool tests passed.
  - `script/build-node.ts` passed.
- `packages/desktop`
  - `bun typecheck` passed.

## Remaining out of scope

- `docx_update` / immutable DOCX update tool.
- PPTX, XLSX, and PDF generation.
- Full validation-history UI or a separate validation-history persistence table.
- Deep format-specific validators beyond the basic OOXML profile.
