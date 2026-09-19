# Document Runtime Phase 9B Foundation

## Scope

Implemented the browser-safe contracts, local PDF/OCR worker, OpenCode
coordinator, and Desktop trust/packaging gates. Native six-target OCR artifacts
remain a release prerequisite.

## Components

- Six-target mapping, hard limits, release manifest, and ordered IPC contracts.
- `@koala-ai/document-runtime` with PDF.js/canvas rendering and bounded
  Tesseract TSV process execution.
- Detached release attestation plus strict manifest/file/profile verification
  before dynamic native loading.
- One-job workers with page-ready, OCR-result, release-page, cancellation,
  deadlines, and cleanup.
- OpenCode process-global two-job coordinator with scoped page/TSV callbacks.
- Desktop development/packaged resolver, trusted sidecar environment, explicit
  `RUST_TARGET`, offline release probe boundary, and beta/prod artifact gate.
- A fail-closed native-confinement launcher boundary. No production document
  worker starts until an equivalent OS-sandbox launcher is supplied.

## Verification

- Document runtime package: 48 passed.
- Koala complete suite: 341 passed.
- OpenCode combined focused suite: 97 passed.
- Desktop focused runtime/packaging suite: 21 passed.
- Document runtime, Koala, OpenCode, and Desktop typechecks passed.
- Real PDF.js/native-canvas rendering passed.

## Release Gate

The current development manifest is `releaseReady: false`. It lacks target-
specific Tesseract 5.5.3, Leptonica 1.87.0, English/OSD trained data, native
dependency inspection, signatures, the complete notice inventory, a selected
Koala license, and the native-confinement launcher. Native Tesseract OCR and
six-target packaged Electron smoke tests are not claimed.
