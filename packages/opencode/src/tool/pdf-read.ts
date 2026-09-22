import { Artifact } from "@koala-ai/core/artifact/artifact"
import { ArtifactStore } from "@koala-ai/core/artifact/store"
import { DocumentEngine } from "@koala-ai/core/document/engine"
import { DocumentNormalized } from "@koala-ai/core/document/normalized"
import { DocumentTool } from "@koala-ai/core/document/tool"
import { IndustrialInput } from "@koala-ai/core/industrial/input"
import { IndustrialProjection } from "@koala-ai/core/industrial/projection"
import type { IndustrialResult } from "@koala-ai/core/industrial/result"
import type { IndustrialTool } from "@koala-ai/core/industrial/tool"
import { SandboxProtocol } from "@koala-ai/core/sandbox/protocol"
import { ArtifactInput } from "@/koala/artifact-input"
import { IndustrialExecution } from "@/koala/industrial-execution"
import { DocumentRuntime } from "@/document/runtime"
import { Effect, Schema, Scope } from "effect"
import {
  artifactReference,
  makeError,
  makeProvenance,
  makeRunID,
  mapRuntimeError,
  pageLocator,
  readPdfToNormalized,
  truncateSummary,
  writeJsonArtifact,
} from "./document-common"
import * as Tool from "./tool"

const DeadlineMs = 120_000
const PersistThresholdBytes = 128 * 1024

type Metadata = {
  readonly result: DocumentTool.PdfReadResult
  readonly projection: IndustrialProjection.Output
  readonly truncated: boolean
}

export const PdfReadTool = Tool.define<
  typeof DocumentTool.PdfRead.Input,
  Metadata,
  ArtifactInput.Service | ArtifactStore.Service | DocumentRuntime.Service | IndustrialExecution.Service
>(
  "pdf_read",
  Effect.gen(function* () {
    const execution = yield* IndustrialExecution.Service
    const runtime = yield* DocumentRuntime.Service
    const artifacts = yield* ArtifactStore.Service
    const artifactInput = yield* ArtifactInput.Service

    return {
      description: "Read a PDF document into a normalized page representation.",
      parameters: DocumentTool.PdfRead.Input,
      execute: (params, context) =>
        Effect.gen(function* () {
          const runID = makeRunID("pdf-read")
          const result = yield* execution
            .execute({
              tool: "pdf_read",
              permission: "document_read",
              engine: DocumentEngine.PdfReadEngine,
              input: params,
              inputSchema: DocumentTool.PdfRead.Input,
              inputSummary: IndustrialInput.summarize([params.source], 1),
              sourceArtifactIDs: [],
              resultSchema: DocumentTool.PdfRead.Result,
              context,
              permissionRequest: { patterns: ["*"], always: ["*"], metadata: {} },
              deadlineMs: DeadlineMs,
              sandboxRunID: runID,
              operation: (signal, commit): Effect.Effect<DocumentTool.PdfReadResult, never, Scope.Scope> =>
                Effect.gen(function* () {
                  const resolved = yield* artifactInput.resolve({
                    source: params.source,
                    provenance: makeProvenance(context, "pdf_read"),
                    context,
                  })

                  const read = yield* runtime.readPdf({ inputPath: resolved.snapshotPath })
                  const normalized = buildNormalized(read, resolved.artifact, params)

                  if (JSON.stringify({ normalized }).length <= PersistThresholdBytes) {
                    return makeSuccess(resolved.artifact, normalized, [], DocumentEngine.PdfReadEngine, runID)
                  }

                  return yield* persistLarge({
                    artifacts,
                    context,
                    signal,
                    commit,
                    source: resolved.artifact,
                    normalized,
                    engine: DocumentEngine.PdfReadEngine,
                    runID,
                  })
                }).pipe(
                  Effect.catch((error) =>
                    Effect.succeed(
                      error instanceof DocumentRuntime.RuntimeError
                        ? makeErrorResult(mapRuntimeError(error), `PDF read failed: ${error.code}`, runID)
                        : makeErrorResult(
                            error instanceof Error && error.message.includes("format")
                              ? "unsupported-format"
                              : "engine-failed",
                            error instanceof Error ? error.message : "PDF read failed",
                            runID,
                          ),
                    ),
                  ),
                ),
              mapError: () => "internal-error",
              makeError: (code) => makeErrorResult(code, `PDF read failed: ${code}`, runID),
            })
            .pipe(
              Effect.map((output) => ({
                title:
                  output.result.status === "success"
                    ? output.result.data.normalized.metadata.title ?? "PDF"
                    : "PDF",
                output: output.projection.text,
                metadata: {
                  result: output.result,
                  projection: output.projection,
                  truncated: output.projection.truncated,
                },
              })),
              Effect.scoped,
              Effect.orDie,
            )
          return result
        }),
    }
  }),
)

function buildNormalized(
  read: DocumentRuntime.ReadPdfResult,
  source: Artifact.Metadata,
  params: DocumentTool.PdfReadInput,
): DocumentNormalized.NormalizedDocument {
  let normalized = readPdfToNormalized(read, source.id)
  if (params.pages) {
    const start = params.pages.startPage ?? 1
    const count = params.pages.pageCount ?? read.pageCount
    const end = Math.min(start + count - 1, read.pageCount)
    const requestedPages = normalized.pages.filter((page) => page.pageNumber >= start && page.pageNumber <= end)
    normalized = {
      ...normalized,
      pages: requestedPages,
      sections: requestedPages.map((page) => ({
        type: "document" as const,
        body: page.textBlocks.map((block) => block.paragraphs.join("\n\n")).join("\n\n"),
      })),
      truncated: requestedPages.length < normalized.pages.length || normalized.truncated,
    }
  }
  return normalized
}

function persistLarge(input: {
  artifacts: ArtifactStore.Interface
  context: Tool.Context
  signal: AbortSignal
  commit: IndustrialExecution.CommitBoundary
  source: Artifact.Metadata
  normalized: DocumentNormalized.NormalizedDocument
  engine: IndustrialTool.Engine
  runID: SandboxProtocol.RunID
}) {
  return Effect.gen(function* () {
    const staging = yield* input.artifacts.stage(input.runID)
    return yield* Effect.gen(function* () {
      yield* writeJsonArtifact(staging, "normalized.json", input.normalized)

      let committedResult: DocumentTool.PdfReadResult | undefined
      const success = (metadata: ReadonlyArray<Artifact.Metadata>): DocumentTool.PdfReadResult => {
        const output = metadata[0]
        if (!output) {
          return makeErrorResult(
            "artifact-storage-failed",
            "PDF artifact promotion produced no output",
            input.runID,
          )
        }
        return makeSuccess(input.source, input.normalized, [artifactReference(output)], input.engine, input.runID)
      }

      const promoted = yield* input.artifacts.promoteBatch(
        [
          {
            runID: input.runID,
            outputPath: Schema.decodeUnknownSync(Artifact.OutputPath)("normalized.json"),
            provenance: {
              sessionID: input.context.sessionID,
              messageID: input.context.messageID,
              toolName: "pdf_read",
              toolCallID: input.context.callID,
              sandboxRunID: input.runID,
            },
            lineage: [{ sourceArtifactID: input.source.id, relation: "derived-from" }],
          },
        ],
        {
          signal: input.signal,
          commit: {
            boundary: input.commit,
            result: (metadata) => {
              committedResult = success(metadata)
              return committedResult
            },
          },
        },
      )

      return committedResult ?? success(promoted)
    }).pipe(Effect.ensuring(input.artifacts.abandon(input.runID).pipe(Effect.catch(() => Effect.void))))
  })
}

function makeSuccess(
  source: Artifact.Metadata,
  normalized: DocumentNormalized.NormalizedDocument,
  outputs: ReadonlyArray<Artifact.Reference>,
  engine: IndustrialTool.Engine,
  sandboxRunID: SandboxProtocol.RunID,
): DocumentTool.PdfReadResult {
  const outputID = outputs[0]?.id ?? source.id
  const value = {
    tool: "pdf_read" as const,
    contractVersion: 1 as const,
    engine,
    status: "success" as const,
    cancelled: false,
    timedOut: false,
    sources: [artifactReference(source)],
    outputs,
    citations: normalized.pages.map((page) => pageLocator(outputID, page.pageNumber)),
    producerTruncated: normalized.truncated,
    sandboxRunID,
    summary: truncateSummary(
      `${normalized.metadata.title ?? "PDF"}\nPages: ${normalized.pages.length}\nSource: ${source.name}`,
    ),
    data: { normalized },
  } as DocumentTool.PdfReadResult
  return value
}

function makeErrorResult(
  code: IndustrialResult.ErrorCode,
  summary: string,
  sandboxRunID: SandboxProtocol.RunID,
): DocumentTool.PdfReadResult {
  return makeError("pdf_read", DocumentEngine.PdfReadEngine, code, summary, sandboxRunID) as DocumentTool.PdfReadResult
}

export * as PdfRead from "./pdf-read"
