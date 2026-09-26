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
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { IndustrialExecution } from "@/koala/industrial-execution"
import { DocumentRuntime } from "@/document/runtime"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { Effect, Schema } from "effect"
import { randomUUID } from "node:crypto"
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises"
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
import DOCX_DESCRIPTION from "./docx-create.txt"
import PPTX_DESCRIPTION from "./pptx-create.txt"
import XLSX_DESCRIPTION from "./spreadsheet-write.txt"
import PDF_DESCRIPTION from "./pdf-create.txt"

const DeadlineMs = 120_000

type Metadata<Result> = {
  readonly result: Result
  readonly projection: IndustrialProjection.Output
  readonly truncated: boolean
}

type ResultType = IndustrialResult.Checked<{ readonly artifact: Artifact.Reference; readonly path: string }>
type InputSchema = Schema.Decoder<{ readonly path: string; readonly contents: unknown }>

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
// only the content schema, output format, and post-generation validator differ. The validated
// bytes are saved into the project directory (the file the user opens) and promoted into the
// artifact store (the provenance record) in one operation.
function defineDocumentCreateTool(definition: Definition) {
  const validate = (
    bytes: Uint8Array,
  ): Promise<{ readonly pageCount?: number; readonly text?: string; readonly sectionCount?: number }> =>
    definition.format === "pdf"
      ? validatePdf(bytes, bytes.byteLength)
      : validateOoxml(bytes, definition.format, bytes.byteLength)
  const makeErrorResult = (code: IndustrialResult.ErrorCode, summary: string, sandboxRunID: SandboxProtocol.RunID) =>
    makeError(definition.name, definition.engine, code, summary, sandboxRunID) as ResultType

  return Tool.define<
    InputSchema,
    Metadata<ResultType>,
    ArtifactStore.Service | DocumentRuntime.Service | IndustrialExecution.Service | EventV2Bridge.Service
  >(
    definition.name,
    Effect.gen(function* () {
      const execution = yield* IndustrialExecution.Service
      const runtime = yield* DocumentRuntime.Service
      const artifacts = yield* ArtifactStore.Service
      const events = yield* EventV2Bridge.Service

      return {
        description: definition.description,
        parameters: definition.input,
        execute: (params, context) =>
          Effect.gen(function* () {
            const runID = makeRunID(definition.name.replaceAll("_", "-"))
            const instance = yield* InstanceState.context
            const target = resolveDeliverable(instance.directory, params.path, definition.format)
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
                permissionRequest: {
                  patterns: ["*"],
                  always: ["*"],
                  metadata: target ? { filepath: target.absolute } : {},
                },
                deadlineMs: DeadlineMs,
                sandboxRunID: runID,
                operation: (signal, commit) =>
                  Effect.gen(function* () {
                    if (!target) {
                      return makeErrorResult(
                        "invalid-input",
                        `${definition.label} path must be a project-relative path such as deliverables/report.${definition.format}`,
                        runID,
                      )
                    }

                    const generated = yield* runtime.createDocument({
                      format: definition.format,
                      contents: params.contents,
                    } as DocumentRuntime.CreateDocumentInput)
                    yield* Effect.tryPromise({
                      try: () => validate(generated.bytes),
                      catch: (error) => new Error(`${definition.label} validation failed: ${describe(error)}`),
                    })

                    const existed = yield* Effect.tryPromise({
                      try: () => saveDeliverable(target.absolute, generated.bytes),
                      catch: (error) =>
                        new Error(
                          `${definition.label} could not be saved to ${target.relative}: ${describe(error)}. Close the file and try again.`,
                        ),
                    })

                    const staging = yield* artifacts.stage(runID)
                    const outputPath = Schema.decodeUnknownSync(Artifact.OutputPath)(target.name)
                    const stagedPath = path.join(staging.artifacts, target.name)
                    yield* Effect.promise(() => mkdir(path.dirname(stagedPath), { recursive: true, mode: 0o700 }))
                    yield* Effect.promise(() => writeFile(stagedPath, generated.bytes, { flag: "wx", mode: 0o600 }))

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
                        summary: truncateSummary(
                          `Created ${definition.label} deliverable at ${target.relative} (${formatBytes(artifact.size)})`,
                        ),
                        data: { artifact: artifactReference(artifact), path: target.relative },
                      }
                    }

                    let committedResult: ResultType | undefined
                    const promoted = yield* artifacts
                      .promoteBatch(
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
                      .pipe(
                        Effect.tapError(() =>
                          // A deliverable without a provenance record is not delivered; undo a fresh file.
                          existed ? Effect.void : Effect.promise(() => rm(target.absolute, { force: true })),
                        ),
                      )

                    yield* events.publish(FileSystem.Event.Edited, { file: target.absolute })
                    yield* events.publish(Watcher.Event.Updated, {
                      file: target.absolute,
                      event: existed ? "change" : "add",
                    })

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
                  title: output.result.status === "success" && target ? target.relative : definition.label,
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

interface Deliverable {
  readonly relative: string
  readonly absolute: string
  readonly name: string
}

// The model supplies a project-relative path; `Artifact.OutputPath` already encodes the
// portable file-name rules (relative, forward slashes, no dot segments, no Windows device
// names), so the same filter guards the project write. The extension always matches the format.
function resolveDeliverable(directory: string, requested: string, format: DocumentGenerate.Format) {
  const trimmed = requested.trim().replaceAll("\\", "/").replace(/^(\.\/)+/, "")
  if (trimmed.length === 0 || /[<>|"?*]/.test(trimmed)) return undefined
  const relative = trimmed.toLowerCase().endsWith(`.${format}`) ? trimmed : `${trimmed}.${format}`
  if (!Schema.is(Artifact.OutputPath)(relative)) return undefined
  const absolute = path.join(directory, ...relative.split("/"))
  if (!FSUtil.contains(directory, absolute) || absolute === directory) return undefined
  return { relative, absolute, name: path.posix.basename(relative) } satisfies Deliverable
}

// Writes next to the target and renames so a reader never observes a partial deliverable.
async function saveDeliverable(absolute: string, bytes: Uint8Array) {
  const existed = await stat(absolute).then(
    (info) => info.isFile(),
    () => false,
  )
  await mkdir(path.dirname(absolute), { recursive: true })
  const temporary = `${absolute}.${randomUUID()}.tmp`
  await writeFile(temporary, bytes, { flag: "wx" })
  try {
    await rename(temporary, absolute)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
  return existed
}

function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

export const DocxCreateTool = defineDocumentCreateTool({
  name: "docx_create",
  format: "docx",
  label: "DOCX",
  description: DOCX_DESCRIPTION,
  engine: DocumentEngine.DocxCreateEngine,
  input: DocumentGenerate.DocxCreate.Input,
  result: DocumentGenerate.DocxCreate.Result,
})

export const PptxCreateTool = defineDocumentCreateTool({
  name: "pptx_create",
  format: "pptx",
  label: "PPTX",
  description: PPTX_DESCRIPTION,
  engine: DocumentEngine.PptxCreateEngine,
  input: DocumentGenerate.PptxCreate.Input,
  result: DocumentGenerate.PptxCreate.Result,
})

export const SpreadsheetWriteTool = defineDocumentCreateTool({
  name: "spreadsheet_write",
  format: "xlsx",
  label: "XLSX",
  description: XLSX_DESCRIPTION,
  engine: DocumentEngine.XlsxCreateEngine,
  input: DocumentGenerate.SpreadsheetWrite.Input,
  result: DocumentGenerate.SpreadsheetWrite.Result,
})

export const PdfCreateTool = defineDocumentCreateTool({
  name: "pdf_create",
  format: "pdf",
  label: "PDF",
  description: PDF_DESCRIPTION,
  engine: DocumentEngine.PdfCreateEngine,
  input: DocumentGenerate.PdfCreate.Input,
  result: DocumentGenerate.PdfCreate.Result,
})

export * as DocumentCreate from "./document-create"
