import { Artifact } from "@koala-ai/core/artifact/artifact"
import { ArtifactStore } from "@koala-ai/core/artifact/store"
import { DocumentEngine } from "@koala-ai/core/document/engine"
import { DocumentGenerate } from "@koala-ai/core/document/generate"
import { IndustrialInput } from "@koala-ai/core/industrial/input"
import { IndustrialProjection } from "@koala-ai/core/industrial/projection"
import { IndustrialResult } from "@koala-ai/core/industrial/result"
import { IndustrialTool } from "@koala-ai/core/industrial/tool"
import { SandboxProtocol } from "@koala-ai/core/sandbox/protocol"
import { validateOoxml, validatePdf } from "@koala-ai/document-runtime"
import { IndustrialExecution } from "@/koala/industrial-execution"
import { DocumentRuntime } from "@/document/runtime"
import { Effect, Schema } from "effect"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import {
  artifactReference,
  makeError,
  makeProvenance,
  makeRunID,
  mapRuntimeError,
  truncateSummary,
} from "./document-common"
import * as Tool from "./tool"

const DeadlineMs = 120_000

type Metadata<Result> = {
  readonly result: Result
  readonly projection: IndustrialProjection.Output
  readonly truncated: boolean
}

type ResultType = IndustrialResult.Checked<{ readonly artifact: Artifact.Reference }>
type InputSchema = Schema.Decoder<{ readonly contents: unknown }>

interface Definition {
  readonly name: IndustrialTool.Name
  readonly format: DocumentGenerate.Format
  readonly label: string
  readonly description: string
  readonly engine: IndustrialTool.Engine
  readonly input: InputSchema
  readonly result: Schema.Decoder<ResultType>
}

// Deterministic deliverable generators share one confined worker operation and one tool shape;
// only the content schema, output format, and post-generation validator differ.
function defineDocumentCreateTool(definition: Definition) {
  const fileName = `document.${definition.format}`
  const validate = (bytes: Uint8Array) =>
    definition.format === "pdf"
      ? validatePdf(bytes, bytes.byteLength)
      : validateOoxml(bytes, definition.format, bytes.byteLength)
  const makeErrorResult = (code: IndustrialResult.ErrorCode, summary: string, sandboxRunID: SandboxProtocol.RunID) =>
    makeError(definition.name, definition.engine, code, summary, sandboxRunID) as ResultType

  return Tool.define<
    InputSchema,
    Metadata<ResultType>,
    ArtifactStore.Service | DocumentRuntime.Service | IndustrialExecution.Service
  >(
    definition.name,
    Effect.gen(function* () {
      const execution = yield* IndustrialExecution.Service
      const runtime = yield* DocumentRuntime.Service
      const artifacts = yield* ArtifactStore.Service

      return {
        description: definition.description,
        parameters: definition.input,
        execute: (params, context) =>
          Effect.gen(function* () {
            const runID = makeRunID(definition.name.replaceAll("_", "-"))
            const output = yield* execution
              .execute({
                tool: definition.name,
                permission: "document_write",
                engine: definition.engine,
                input: params,
                inputSchema: definition.input,
                inputSummary: IndustrialInput.summarize([]),
                sourceArtifactIDs: [],
                resultSchema: definition.result,
                context,
                permissionRequest: { patterns: ["*"], always: ["*"], metadata: {} },
                deadlineMs: DeadlineMs,
                sandboxRunID: runID,
                operation: (signal, commit) =>
                  Effect.gen(function* () {
                    const generated = yield* runtime.createDocument({
                      format: definition.format,
                      contents: params.contents,
                    } as DocumentRuntime.CreateDocumentInput)
                    yield* Effect.tryPromise({
                      try: () => validate(generated.bytes) as Promise<OoxmlValidationResult>,
                      catch: (error) =>
                        new Error(
                          `${definition.label} validation failed: ${error instanceof Error ? error.message : String(error)}`,
                        ),
                    })

                    const staging = yield* artifacts.stage(runID)
                    const outputPath = Schema.decodeUnknownSync(Artifact.OutputPath)(fileName)
                    const fullPath = path.join(staging.artifacts, String(outputPath))
                    yield* Effect.promise(() => mkdir(path.dirname(fullPath), { recursive: true, mode: 0o700 }))
                    yield* Effect.promise(() => writeFile(fullPath, generated.bytes, { flag: "wx", mode: 0o600 }))

                    const provenance = makeProvenance(context, definition.name)
                    const success = (metadata: ReadonlyArray<Artifact.Metadata>): ResultType => {
                      const artifact = metadata[0]
                      if (!artifact) {
                        return makeErrorResult(
                          "artifact-storage-failed",
                          `${definition.label} artifact promotion produced no output`,
                          runID,
                        )
                      }
                      return {
                        tool: definition.name,
                        contractVersion: 1 as const,
                        engine: definition.engine,
                        status: "success" as const,
                        cancelled: false,
                        timedOut: false,
                        sources: [],
                        outputs: [artifactReference(artifact)],
                        citations: [],
                        producerTruncated: false,
                        sandboxRunID: runID,
                        summary: truncateSummary(`Created ${definition.label}: ${artifact.name}`),
                        data: { artifact: artifactReference(artifact) },
                      }
                    }

                    let committedResult: ResultType | undefined
                    const promoted = yield* artifacts.promoteBatch(
                      [{ runID, outputPath, provenance: { ...provenance, sandboxRunID: runID }, lineage: [] }],
                      {
                        signal,
                        commit: {
                          boundary: commit,
                          result: (metadata) => {
                            committedResult = success(metadata)
                            return committedResult
                          },
                        },
                      },
                    )

                    return committedResult ?? success(promoted)
                  }).pipe(
                    Effect.catch((error: DocumentRuntime.RuntimeError | Error) => {
                      if (error instanceof DocumentRuntime.RuntimeError) {
                        return Effect.succeed(
                          makeErrorResult(
                            mapRuntimeError(error),
                            `${definition.label} creation failed: ${error.code}${error.detail ? ` (${error.detail})` : ""}`,
                            runID,
                          ),
                        )
                      }
                      if (error.message.includes("validation failed")) {
                        return Effect.succeed(makeErrorResult("engine-failed", error.message, runID))
                      }
                      return Effect.succeed(makeErrorResult("artifact-storage-failed", error.message, runID))
                    }),
                  ),
                mapError: () => "internal-error",
                makeError: (code) => makeErrorResult(code, `${definition.label} creation failed: ${code}`, runID),
              })
              .pipe(
                Effect.map((output) => ({
                  title: definition.label,
                  output: output.projection.text,
                  metadata: {
                    result: output.result,
                    projection: output.projection,
                    truncated: output.result.producerTruncated || output.projection.truncated,
                  },
                })),
                Effect.scoped,
                Effect.orDie,
              )
            return output
          }),
      }
    }),
  )
}

export const DocxCreateTool = defineDocumentCreateTool({
  name: "docx_create",
  format: "docx",
  label: "DOCX",
  description: "Create a Microsoft Word document (.docx) from structured content.",
  engine: DocumentEngine.DocxCreateEngine,
  input: DocumentGenerate.DocxCreate.Input,
  result: DocumentGenerate.DocxCreate.Result,
})

export const PptxCreateTool = defineDocumentCreateTool({
  name: "pptx_create",
  format: "pptx",
  label: "PPTX",
  description:
    "Create a PowerPoint presentation (.pptx) from structured slides. Each slide may carry a title, subtitle, bullets, paragraphs, a table, and speaker notes.",
  engine: DocumentEngine.PptxCreateEngine,
  input: DocumentGenerate.PptxCreate.Input,
  result: DocumentGenerate.PptxCreate.Result,
})

export const SpreadsheetWriteTool = defineDocumentCreateTool({
  name: "spreadsheet_write",
  format: "xlsx",
  label: "XLSX",
  description:
    "Create an Excel workbook (.xlsx) from structured sheets. Cells are written as literal text, numbers, or booleans; formulas are not evaluated.",
  engine: DocumentEngine.XlsxCreateEngine,
  input: DocumentGenerate.SpreadsheetWrite.Input,
  result: DocumentGenerate.SpreadsheetWrite.Result,
})

export const PdfCreateTool = defineDocumentCreateTool({
  name: "pdf_create",
  format: "pdf",
  label: "PDF",
  description: "Create a paginated PDF document from headings, paragraphs, tables, and page breaks.",
  engine: DocumentEngine.PdfCreateEngine,
  input: DocumentGenerate.PdfCreate.Input,
  result: DocumentGenerate.PdfCreate.Result,
})

export * as DocumentCreate from "./document-create"
