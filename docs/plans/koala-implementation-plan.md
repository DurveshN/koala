# Koala Implementation Plan

## Product Goal

Koala is a local-only sovereign agentic AI workbench for confidential industrial
work. It retains OpenCode Desktop's interface and agent runtime while replacing
cloud connectivity with user-configured OpenAI-compatible local or on-premise
model endpoints.

Koala must support multi-step tool use, multimodal documents, local knowledge
grounding, native sandboxed code execution, editable Office deliverables, model
routing, durable audit records, and visible network activity.

## Baseline

- Upstream: `https://github.com/anomalyco/opencode`
- Release: `v1.18.31`
- Commit: `014614d35b397775e5d397a490fc72368c894ec2`
- Koala baseline commit: `41880aa`
- Branch: `dev`
- Initial runtime: OpenCode Desktop's embedded sidecar
- Packaging: deferred until the local development build is complete

## Architecture

```text
Electron Desktop
      |
Authenticated loopback sidecar
      |
OpenCode agent and session runtime
      |
Koala domain services
      +-- Local model registry and router
      +-- Industrial tool registry
      +-- Native sandbox workers
      +-- Artifact store
      +-- Document and OCR pipeline
      +-- Local knowledge base
      +-- Audit and network policy
```

New product logic belongs in `packages/koala`. Existing OpenCode packages should
receive narrow adapters and UI integration changes rather than owning Koala
domain behavior.

The first Koala release will use the stable embedded Desktop sidecar path. It
will not combine product development with an OpenCode V1-to-V2 migration. Hybrid
runtime dependencies remain until the local build proves they are removable.

## Phase 0: Independent Baseline

- Import OpenCode `v1.18.31` at the pinned commit.
- Remove the upstream Git metadata and initialize an independent `dev` history.
- Commit the untouched source before any Koala changes.
- Record upstream provenance and third-party notices.
- Build and launch the untouched Desktop application.
- Record baseline typecheck and test results.

## Phase 1: Desktop-Only Source Boundary

Trace the actual Electron build graph before deleting packages. The Desktop
renderer uses `packages/app`, `packages/ui`, and `packages/session-ui`; the
embedded sidecar is built from `packages/opencode/src/node.ts`.

Candidate removals include standalone CLI, TUI, web, console, Slack, stats,
hosted function, and IDE packages. Do not delete CLI-named server modules or
terminal/PTY modules until their Desktop references are removed and verified.

Critical paths:

```text
packages/desktop/src/main/index.ts
packages/desktop/src/main/sidecar.ts
packages/desktop/src/main/server.ts
packages/desktop/src/preload/index.ts
packages/desktop/src/renderer/index.tsx
packages/desktop/electron.vite.config.ts
packages/opencode/src/node.ts
packages/opencode/src/server/server.ts
packages/app/src/app.tsx
```

## Phase 2: Koala Identity

- Product name: Koala
- Descriptor: Sovereign AI Workbench
- Identity: professional geometric mark with a friendly mascot
- Palette: eucalyptus green and charcoal
- Theme: follow the operating system with Light and Dark overrides
- Keep the OpenCode layout and interaction model initially

Update visible branding through localized strings and shared theme tokens. Use a
temporary original geometric mark until final artwork is approved.

## Phase 3: Remove External Features

Remove cloud model providers, provider OAuth, OpenCode accounts, Zen/Go,
sharing, public updates, telemetry, crash reporting, web search, web fetch,
remote MCP, remote OpenCode server selection, automatic package installation,
and external title-generation fallbacks.

Primary audit paths:

```text
packages/opencode/src/provider
packages/opencode/src/auth
packages/opencode/src/account
packages/opencode/src/share
packages/opencode/src/control-plane
packages/opencode/src/sync
packages/opencode/src/mcp
packages/opencode/src/tool/registry.ts
packages/opencode/src/tool/webfetch.ts
packages/opencode/src/tool/websearch.ts
packages/app/src/components/dialog-connect-provider.tsx
packages/app/src/components/dialog-select-server.tsx
packages/app/src/components/dialog-select-mcp.tsx
packages/app/src/updater.ts
packages/desktop/src/main/updater*
```

## Phase 4: Local-Only Network Policy

Add a single policy-aware HTTP boundary under `packages/koala/src/network`.
Allow loopback and explicitly approved private organization endpoints. Reject
public destinations, unconfigured private hosts, cloud metadata addresses, and
redirects to disallowed destinations.

Network audit records contain origin, destination, decision, policy rule,
duration, status, and byte counts. They exclude credentials, prompts, cookies,
and document content.

## Phase 5: Local Model Profiles

Replace provider onboarding with a local `/connect` workflow containing:

```text
Provider display name
OpenAI-compatible base URL
Optional API key
Model ID and display name
Text / Text + Vision / Don't know
Tool calling: Yes / No / Don't know
Streaming: Yes / No / Don't know
Structured output: Yes / No / Don't know
Reasoning: Yes / No / Don't know
Required context window and maximum output
Preferred model roles
```

Call `GET /v1/models` when available and allow manual model IDs. Probe only
capabilities marked `Don't know`. Keep API credentials behind a `SecretStore`
boundary.

## Phase 6: Model Routing

Create model profile, capability, probe, router, and route-decision modules in
`packages/koala/src/model`.

Routing order:

1. User override.
2. Required modality.
3. Required tool support.
4. Required context size.
5. Task category.
6. Preferred role.
7. Endpoint availability.
8. Deterministic fallback order.

Record selected and rejected candidates with reasons. Initial categories are
general chat, coding, document analysis, document generation, vision, knowledge
retrieval, and calculation.

## Phase 7: Native Sandbox

Use `@anthropic-ai/sandbox-runtime` pinned to `0.0.76` behind a Koala-owned
`SandboxRuntime` interface. Start with a short-lived worker process per run
because the upstream `SandboxManager` has process-global mutable state.

Strict policy:

```text
Network allowlist: empty
Unsandboxed retry: unavailable
Read access: runtime libraries and explicit task inputs
Write access: temporary workspace and artifact output
Environment: minimal allowlist with credentials removed
Host shell fallback: unavailable
```

Expose `sandbox_execute` instead of the host-level shell tool. Refuse execution
when the strict platform sandbox is unavailable. Capture timeouts, cancellation,
bounded output, exit status, and sandbox violations.

## Phase 8: Artifact Store

Store binary artifacts outside chat history and SQLite blobs:

```text
<Koala data>/artifacts/blobs/sha256/<prefix>/<digest>
<Koala data>/artifacts/staging/<run-id>/
<Koala data>/koala.db
```

Persist metadata, ownership, tool provenance, source lineage, validation state,
digest, MIME, and size. Move files into immutable blob storage only after
validation.

## Phase 9: Industrial Tools

Initial tool registry:

```text
document_extract
ocr_extract
vision_analyze
knowledge_ingest
knowledge_search
knowledge_open
docx_create
pptx_create
spreadsheet_read
spreadsheet_write
pdf_create
calculate
sandbox_execute
sandbox_test
artifact_validate
```

Every tool has a typed schema, permission classification, cancellation support,
bounded model-facing output, artifact references for binary data, and an audit
record. Routine deliverables use deterministic generators; generated code is a
sandboxed fallback for unusual transformations and calculations.

## Phase 10: Multimodal Document Pipeline

```text
Input artifact
    -> format sniffing and limits
    -> structured extraction
    -> page and image rendering
    -> OCR for low-text pages
    -> local vision analysis where needed
    -> normalized document representation
    -> source locators and citations
```

Support text and scanned PDF, images, DOCX, PPTX, XLSX, text, and source code.
Select the first OCR engine through an offline benchmark covering printed
reports, handwriting, engineering scans, and tables. Keep it replaceable behind
`OcrEngine`.

## Phase 11: Deliverable Generation

Implement validated DOCX, PPTX, XLSX, and PDF generation. Start with the
inspection approval-note DOCX workflow. Validate MIME, container structure,
archive traversal, compression ratio, macros, external relationships, embedded
objects, workbook links, and PDF actions before accepting an artifact.

## Phase 12: Local Knowledge Base

Extract and chunk approved local documents, use a configured local embedding
profile, and preserve artifact and page/slide/sheet citations. Start with SQLite
FTS5 lexical retrieval. Keep vector search behind `VectorIndex` until its native
packaging constraints are evaluated.

Index identity includes source digest, extractor version, chunker version, and
embedding profile so updates are explicit and repeatable.

## Phase 13: Audit And Network UI

Add durable, redacted records for model requests, route decisions, tool calls,
permissions, files, sandbox runs, knowledge sources, artifacts, and network
decisions.

Add a global Audit page, session Activity panel, Network panel, artifact cards,
sandbox result cards, citation cards, and route cards. REST pagination is the
history source; live events append current activity.

## Acceptance Workflows

### Scanned Inspection Report

Attach a scanned report, extract and OCR it, analyze relevant images, retrieve
SOP material, draft an approval note, generate and validate a DOCX, and show its
citations, tool trace, model route, and network record.

### Coding Task

Route to a coding model, create source in a task workspace, execute and test it
in the native sandbox, iterate on failures, and export source plus an execution
report.

### Sovereignty Evidence

Run with public network blocked and only the configured local/private model
endpoint available. Attempt an external canary request and record its denial.
Display all allowed and denied application and sandbox destinations.

## Verification

- Run package-local typechecks with `bun typecheck`.
- Run package-local tests, never tests from the repository root.
- Verify Desktop sidecar startup and session persistence.
- Test text, vision, streaming, tool-calling, and capability-probe flows.
- Test model routing with deterministic fixtures.
- Test sandbox denial of home-directory reads, external writes, public network,
  inherited credentials, symlink traversal, and surviving child processes.
- Test malformed and hostile document fixtures.
- Test generated artifacts by reopening them with independent parsers.
- Test audit redaction with canary secrets.
- Run the three acceptance workflows end to end.

## Deferred Scope

- Windows, macOS, and Linux installers
- Public or internal automatic updates
- Centralized multi-user deployment
- Organization identity providers
- Cloud models and cloud sharing
- Internet tools
- Mobile and browser clients
