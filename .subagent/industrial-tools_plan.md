# Industrial Tools Implementation Plan

## Goal

Implement every tool in
`docs/superpowers/specs/2026-09-19-industrial-tools-design.md` over shared typed,
audited, cancellable, artifact-backed boundaries. Begin with Phase 9A contracts
and audit plus Phase 9B bundled OCR/PDF runtime. Register each later tool only
after its real engine and hostile-input tests pass.

## Phase 9A: Contracts, Input Boundary, Audit

### 1. Browser-Safe Industrial Contracts

Add under `packages/koala/src/industrial/`:

- `tool.ts`: the closed approved tool-name inventory, contract version, engine
  identity, and exhaustive permission mapping.
- `input.ts`: exclusive `{ artifactID } | { path }` source union and safe input
  summaries.
- `citation.ts`: artifact, page/region, DOCX structural, slide/shape,
  sheet/range, and text-offset locators.
- `result.ts`: checked success/error envelope with sources, outputs, citations,
  cancellation, timeout, producer truncation, route decision, sandbox run, and
  curated errors.
- `projection.ts`: deterministic 2,000-line/50-KiB model projection that never
  serializes arbitrary structured data, bytes, URLs, or host paths.
- `audit.ts`: running/completed audit records and process-global service
  interface.
- focused contract, projection, and browser-bundle tests.

Add `packages/koala/src/sandbox/tool.ts` for the typed `sandbox_execute` input and
industrial result data. Add `./industrial/*` and needed direct exports to
`packages/koala/package.json` and `src/index.ts`.

Permission classes:

```text
document_read
document_write
vision_analyze
knowledge_read
knowledge_write
calculate
sandbox_execute
```

No Node, Core, database, filesystem, child-process, or native dependency enters
`packages/koala`.

### 2. Artifact Provenance And Snapshot Support

Extend artifact provenance with an optional normalized project-relative source
path. External files retain no absolute source path. Update:

- `packages/koala/src/artifact/artifact.ts`
- `packages/koala/src/artifact/store.ts`
- `packages/core/src/artifact/sql.ts`
- `packages/opencode/src/koala/artifact-store.ts`
- corresponding tests.

Add `packages/opencode/src/koala/artifact-input.ts` as a scoped Location-aware
service. It resolves artifact IDs with same-Session ownership checks. It resolves
project paths through existing `read` and external-directory permission logic,
then copies one stable, non-link regular-file snapshot into private staging and
promotes it. Engines receive only immutable private snapshots, never original
host paths.

### 3. Durable Redacted Tool Audit

Add primitive `koala_tool_audit` Drizzle schema in
`packages/core/src/tool-audit/sql.ts` with generated migration and database
tests. Store:

- audit ID;
- running/completed state;
- tool and permission class;
- Session/message/call IDs;
- start/finish/duration;
- terminal outcome flags/code;
- engine and contract versions;
- canonical input SHA-256 and safe count/type summary;
- source/output artifact IDs;
- optional sandbox run and route-decision references;
- curated error code.

Do not store raw commands, expressions, queries, prompts, extracted text,
credentials, URLs, native stderr, citations containing content, or host paths.
Keep audit rows independent from transcript foreign-key deletion.

Implement the process-global adapter in
`packages/opencode/src/koala/industrial-audit.ts` with `begin` and one-time
`complete` operations. Add canary redaction tests.

Run the Core migration generator once after the artifact and audit schemas are
complete:

```text
bun run migration --name koala_industrial_audit
```

Do not hand-edit generated migrations, registry, or full schema.

### 4. Common V1 Execution Adapter

Add `packages/opencode/src/koala/industrial-execution.ts` to coordinate:

1. validated input canonicalization and digest;
2. running audit insertion;
3. permission request;
4. caller cancellation plus tool deadline;
5. engine execution and cleanup grace;
6. typed result validation;
7. bounded model projection;
8. uninterruptible audit completion.

The active V1 `Tool.define` remains the outer adapter. Do not introduce another
tool registry or migrate Koala to the V2 runtime in this phase.

Expected engine/store errors map to curated industrial errors. Effect
interruption and defects remain distinguishable for audit classification. Audit
unavailability blocks side effects or surfaces after completion according to the
specified begin/complete boundary.

### 5. Migrate `sandbox_execute`

Update `packages/opencode/src/tool/sandbox-execute.ts` to use the shared sandbox
input schema, industrial result envelope, execution boundary, permission class,
and audit service.

Separate worker capture truncation from model projection truncation. Keep clean-
run-only artifact promotion. Include sandbox run ID and artifact references in
the typed result while keeping commands, stdout/stderr, and private paths out of
the audit row.

## Phase 9B: Bundled Document Runtime

### 6. Runtime Contracts

Add `packages/koala/src/document-runtime/`:

- `target.ts`: exact six-target mapping.
- `manifest.ts`: versioned component/file hashes, modes, architecture, and
  dependency inventory.
- `protocol.ts`: one-job worker protocol for probe, render, OCR, page release,
  cancellation, and stable failures.
- `limits.ts`: hard ceilings and lower caller-requested limits.
- schema, ordering, manifest, and browser-safety tests.

Supported targets:

```text
x86_64-apple-darwin
aarch64-apple-darwin
x86_64-pc-windows-msvc
aarch64-pc-windows-msvc
x86_64-unknown-linux-gnu
aarch64-unknown-linux-gnu
```

Reject target/architecture substitution.

Initial hard limits:

```text
PDF input: 100 MiB
image input: 64 MiB
pages per call: 100
raster side: 10,000 px
raster area: 25,000,000 pixels
PNG per page: 64 MiB
temporary bytes: 250 MiB
TSV per page: 32 MiB
native stderr: 64 KiB
render deadline per page: 60 seconds
OCR deadline per page: 120 seconds
whole job: 10 minutes
cancellation grace: 2 seconds
concurrent jobs: 2
```

### 7. Build-Only Document Runtime Package

Create `packages/document-runtime` for acquisition, native builds, worker source,
staging, manifests, signing, verification, licenses, and target archives.

Pin:

- Tesseract `5.5.3` from signed source tag;
- Leptonica `1.87.0`;
- `tessdata_fast` commit
  `87416418657359cb625c412a48b6e1d6d41c29bd` with `eng` and `osd` only;
- `pdfjs-dist` `6.3.289`;
- `@napi-rs/canvas` `1.0.9` and its matching exact target-native package;
- exact codec/toolchain inputs and content hashes.

Build Tesseract from pinned source for each target with training tools, tests,
curl, archive support, OpenMP, legacy engine, and host-native optimization
disabled. Statically link the selected Leptonica image dependencies where
practical. The final target artifact contains only the needed executable,
trained data, PDF.js assets, one canvas native package, worker files, manifest,
and complete licenses/notices.

No runtime download, package installation, system Tesseract, Poppler, Homebrew,
apt, registry lookup, or `PATH` fallback is permitted in production.

### 8. PDF/OCR Worker

Implement one short-lived Node worker per document job:

- load PDF from local bytes only;
- render sequential pages at fixed 300 DPI using PDF.js and native canvas;
- fixed CropBox/rotation, white background, local fonts/CMaps/WASM, CPU path,
  and no system fonts;
- emit one bounded page-ready event and wait for release before allocating the
  next page;
- invoke bundled Tesseract using an absolute path, argument array, no shell,
  English plus OSD, 300 DPI, TSV output, fixed environment, and one thread;
- stream TSV into bounded private staging;
- parse no raw native error into IPC;
- cancel render tasks, terminate Tesseract/process trees, delete temporary
  files, and exit after one terminal event.

Parent IPC validates version, job ID, page ordering, byte limits, and one terminal
result. It owns deadlines and force-terminates after the grace period.

### 9. OpenCode And Desktop Integration

Add process-global document runtime service/resolver under
`packages/opencode/src/document/` without registering model-facing document
tools yet.

Add Desktop packaged/development resolver and trusted sidecar environment. Stage
the target runtime outside `app.asar` using `extraResources`, selected by
`RUST_TARGET`, not build-host architecture. Extend predev/prebuild/prepare and
release CI to require and verify the matching target artifact.

Windows signs and recursively verifies every `.exe`, `.dll`, and `.node`.
macOS signs nested binaries, verifies the app, and checks notarization. Linux
checks ELF target, RPATH, dependencies, and executable modes. Every target runs
an offline OCR fixture and PDF-render fixture with no system Tesseract available.

## Phase 9C: Readers, OCR, Vision, Extraction

### 10. Document Contracts

Define normalized document, page/slide/sheet locators, continuation, tables,
images, OCR words/lines, and visual-observation schemas in `packages/koala`.
Define `DocumentReader`, `PdfRenderer`, `OcrEngine`, and `VisionEngine`
interfaces.

### 11. Format Readers

Implement an archive guard and streaming XML layer, then functional:

- `docx_read`
- `pptx_read`
- `spreadsheet_read` for XLSX and CSV
- `pdf_read`

Inputs are artifact IDs or authorized project paths resolved through 9A. Large
structured output is persisted as an artifact with bounded summaries and source
citations.

### 12. OCR And Vision Tools

Implement:

- `ocr_extract`: deterministic image OCR and coordinated PDF render/OCR for up
  to 100 pages per call with continuation;
- `vision_analyze`: exactly one image or PDF page per local model request,
  requiring verified image capability and durable route-decision reference;
- `document_extract`: format dispatch, Tesseract on every selected PDF page, and
  optional one-page-at-a-time vision while preserving OCR as separate evidence.

## Phase 9D: Calculation, Sandbox Test, Validation

### 13. `calculate`

Implement a Koala-owned bounded lexer, Pratt parser, evaluator, and closed unit
registry using an isolated `decimal.js@10.5.0` constructor. Support decimal
arithmetic, right-associative powers, percentages, bounded functions, and unit
conversion. Return canonical decimal strings. Do not use `eval`, `Function`,
Code Mode, shell, or sandbox execution.

### 14. `sandbox_test`

Add fixed host-generated self-test probes for runtime availability, permitted
temporary I/O, denied project/external I/O, denied network, cancellation, and
cleanup. Accept no model-authored command or path. Share the `sandbox_execute`
permission and return only stable diagnostic codes.

### 15. `artifact_validate`

Add validation profile registry and durable validation-attempt history. Keep
storage-safe, format-safe, generated-document, PDF-safe, and Office-safe claims
distinct. Revalidation never mutates artifact bytes.

## Phase 9E: Deep Validation, Creation, Updates

Implement a safe OOXML ZIP/XML layer and PDF validation before exposing
generators. Prove selected libraries behind Koala interfaces before committing
to each vertical slice:

1. `docx_create`, then `docx_update`.
2. `spreadsheet_write`, then `spreadsheet_update`.
3. `pptx_create`, then `pptx_update`.
4. `pdf_create`, then constrained `pdf_update`.

All updates consume immutable source artifacts, apply typed format-specific
patches, preserve supported untouched structures, independently reopen and
validate output, and publish a new `derived-from` artifact. Arbitrary PDF text
replacement and ambiguous/lossy imported-document rewrites are rejected.

The first acceptance output is the inspection approval-note DOCX.

## Phase 9F: Knowledge

Verify and package an FTS5-capable SQLite runtime before persistence work. Add
versioned normalized extraction/chunking, project authorization, and deterministic
index identity, then implement:

- `knowledge_ingest`
- `knowledge_search`
- `knowledge_open`

FTS5 works without embeddings. Keep optional vectors behind `VectorIndex` until
their model and native packaging requirements are proven.

## Verification Gates

### Phase 9A

- Koala schema round-trip, exhaustive tool/permission mapping, projection, and
  browser-bundle tests.
- Core audit/artifact migration and constraint tests.
- OpenCode ownership, permission, stable-snapshot, cancellation/deadline, audit
  redaction, projection, and migrated sandbox tests.
- Koala/Core/OpenCode typechecks and Desktop production build.

### Phase 9B

- Manifest target/hash/mode/license validation.
- Real Tesseract TSV fixture and real PDF render fixture.
- Protocol order, crash, timeout, cancellation, output overflow, and process-tree
  tests.
- 100/101-page, raster, PNG, TSV, temporary-byte, and input-size boundaries.
- One-page-at-a-time allocation and release.
- No-network/no-system-engine test.
- Six-target architecture, dependency, signature, permission, license, and
  packaged Electron smoke checks.

### Later Tools

- Golden and hostile fixtures for every reader/validator.
- Independent reopen for every created/updated artifact.
- Immutable source/output lineage and no partial publication.
- OCR text/boxes/confidence, rotation, scans, and page citations.
- One image per vision request through the private pinned transport.
- Calculator grammar, precision, unit, complexity, cancellation, and no-eval
  checks.
- Sandbox diagnostic redaction and fixed probes.
- FTS5 availability, deterministic chunking/search, project isolation, and
  citation resolution.

## First Execution Slice

Implement Phase 9A completely before registering any additional industrial
tool. Phase 9B contracts and build package may proceed in parallel, but release
packaging is accepted only after six-target artifacts, signing, license inventory,
and offline smoke tests exist. After 9A, `calculate`, `sandbox_test`, validation
history, and document contracts can proceed in parallel while the native OCR
artifact matrix is completed.

Update `CONTEXT.md`, `infra.md`, `learning.md`, `THIRD_PARTY_NOTICES.md`, and a
subagent implementation record at the end of each accepted subphase. Generate
the Client only if a later subphase changes public Protocol/Server `HttpApi`.
