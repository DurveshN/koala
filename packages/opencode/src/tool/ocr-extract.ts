import { Artifact } from "@koala-ai/core/artifact/artifact"
import { ArtifactStore } from "@koala-ai/core/artifact/store"
import { DocumentEngine } from "@koala-ai/core/document/engine"
import { DocumentNormalized } from "@koala-ai/core/document/normalized"
import { DocumentRuntimeLimits } from "@koala-ai/core/document-runtime/limits"
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
  documentFormat,
  makeError,
  makeProvenance,
  makeRunID,
  mapRuntimeError,
  pageLocator,
  parseTsvLines,
  readBytes,
  truncateSummary,
  writeJsonArtifact,
} from "./document-common"
import * as Tool from "./tool"

const DeadlineMs = 180_000
const MaxOcrPages = 100
const PersistThresholdBytes = 128 * 1024

type Metadata = {
  readonly result: DocumentTool.OcrExtractResult
  readonly projection: IndustrialProjection.Output
  readonly truncated: boolean
}

type OcrPage = {
  page: number
  dimensions: DocumentRuntimeLimits.RasterDimensions
  lines: DocumentNormalized.OcrLine[]
}

export const OcrExtractTool = Tool.define<
  typeof DocumentTool.OcrExtract.Input,
  Metadata,
  ArtifactInput.Service | ArtifactStore.Service | DocumentRuntime.Service | IndustrialExecution.Service
>(
  "ocr_extract",
  Effect.gen(function* () {
    const execution = yield* IndustrialExecution.Service
    const runtime = yield* DocumentRuntime.Service
    const artifacts = yield* ArtifactStore.Service
    const artifactInput = yield* ArtifactInput.Service

    return {
      description: "Extracts text from images or PDF pages using OCR.",
      parameters: DocumentTool.OcrExtract.Input,
      execute: (params, context) =>
        Effect.gen(function* () {
          const runID = makeRunID("ocr-extract")
          const result = yield* execution
            .execute({
              tool: "ocr_extract",
              permission: "document_read",
              engine: DocumentEngine.OcrEngine,
              input: params,
              inputSchema: DocumentTool.OcrExtract.Input,
              inputSummary: IndustrialInput.summarize([params.source], 1),
              sourceArtifactIDs: [],
              resultSchema: DocumentTool.OcrExtract.Result,
              context,
              permissionRequest: { patterns: ["*"], always: ["*"], metadata: {} },
              deadlineMs: DeadlineMs,
              sandboxRunID: runID,
              operation: (signal, commit): Effect.Effect<DocumentTool.OcrExtractResult, never, Scope.Scope> =>
                Effect.gen(function* () {
                  const resolved = yield* artifactInput.resolve({
                    source: params.source,
                    provenance: makeProvenance(context, "ocr_extract"),
                    context,
                  })

                  const format = documentFormat(resolved.artifact.name)
                  const pages = yield* params.page !== undefined || format === "image"
                    ? ocrImage(runtime, resolved.snapshotPath, resolved.artifact, params.page ?? 1)
                    : format === "pdf"
                      ? ocrPdf(
                          runtime,
                          resolved.snapshotPath,
                          resolved.artifact,
                          params.pages?.startPage ?? 1,
                          params.pages?.pageCount ?? MaxOcrPages,
                        )
                      : Effect.fail(new Error(`Unsupported OCR source: ${resolved.artifact.name}`))

                  const data = { pages }

                  if (JSON.stringify(data).length <= PersistThresholdBytes) {
                    return makeSuccess(resolved.artifact, data, [], DocumentEngine.OcrEngine, runID)
                  }

                  return yield* persistLarge({
                    artifacts,
                    context,
                    signal,
                    commit,
                    source: resolved.artifact,
                    data,
                    engine: DocumentEngine.OcrEngine,
                    runID,
                  })
                }).pipe(
                  Effect.catch((error) =>
                    Effect.succeed(
                      error instanceof DocumentRuntime.RuntimeError
                        ? makeErrorResult(mapRuntimeError(error), `OCR failed: ${error.code}`, runID)
                        : makeErrorResult(
                            error instanceof Error && error.message.includes("format")
                              ? "unsupported-format"
                              : "engine-failed",
                            error instanceof Error ? error.message : "OCR failed",
                            runID,
                          ),
                    ),
                  ),
                ),
              mapError: () => "internal-error",
              makeError: (code) => makeErrorResult(code, `OCR failed: ${code}`, runID),
            })
            .pipe(
              Effect.map((output) => ({
                title: "OCR",
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

function ocrImage(
  runtime: DocumentRuntime.Interface,
  snapshotPath: string,
  source: Artifact.Metadata,
  page: number,
) {
  return runtime.ocr({ inputPath: snapshotPath, page }).pipe(
    Effect.map(
      (result): OcrPage[] => [
        {
          page: result.page,
          dimensions: result.dimensions,
          lines: parseTsvLines(result.tsv, result.dimensions, source.id, result.page),
        },
      ],
    ),
  )
}

function ocrPdf(
  runtime: DocumentRuntime.Interface,
  snapshotPath: string,
  source: Artifact.Metadata,
  startPage: number,
  pageCount: number,
) {
  return Effect.gen(function* () {
    const pages: OcrPage[] = []
    yield* runtime.renderAndOcr(
      { inputPath: snapshotPath, startPage, pageCount },
      (scopedPage) =>
        Effect.gen(function* () {
          const tsv = yield* readBytes(scopedPage.tsvPath)
          const lines = parseTsvLines(tsv, scopedPage.dimensions, source.id, scopedPage.page)
          pages.push({ page: scopedPage.page, dimensions: scopedPage.dimensions, lines })
        }),
    )
    return pages
  })
}

function persistLarge(input: {
  artifacts: ArtifactStore.Interface
  context: Tool.Context
  signal: AbortSignal
  commit: IndustrialExecution.CommitBoundary
  source: Artifact.Metadata
  data: { pages: OcrPage[] }
  engine: IndustrialTool.Engine
  runID: SandboxProtocol.RunID
}) {
  return Effect.gen(function* () {
    const staging = yield* input.artifacts.stage(input.runID)
    return yield* Effect.gen(function* () {
      yield* writeJsonArtifact(staging, "ocr.json", input.data)

      let committedResult: DocumentTool.OcrExtractResult | undefined
      const success = (metadata: ReadonlyArray<Artifact.Metadata>): DocumentTool.OcrExtractResult => {
        const output = metadata[0]
        if (!output) {
          return makeErrorResult(
            "artifact-storage-failed",
            "OCR artifact promotion produced no output",
            input.runID,
          )
        }
        return makeSuccess(input.source, input.data, [artifactReference(output)], input.engine, input.runID)
      }

      const promoted = yield* input.artifacts.promoteBatch(
        [
          {
            runID: input.runID,
            outputPath: Schema.decodeUnknownSync(Artifact.OutputPath)("ocr.json"),
            provenance: {
              sessionID: input.context.sessionID,
              messageID: input.context.messageID,
              toolName: "ocr_extract",
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
  data: { pages: OcrPage[] },
  outputs: ReadonlyArray<Artifact.Reference>,
  engine: IndustrialTool.Engine,
  sandboxRunID: SandboxProtocol.RunID,
): DocumentTool.OcrExtractResult {
  const outputID = outputs[0]?.id ?? source.id
  return {
    tool: "ocr_extract" as const,
    contractVersion: 1 as const,
    engine,
    status: "success" as const,
    cancelled: false,
    timedOut: false,
    sources: [artifactReference(source)],
    outputs,
    citations: data.pages.map((page) => pageLocator(outputID, page.page)),
    producerTruncated: false,
    sandboxRunID,
    summary: truncateSummary(
      `OCR completed: ${data.pages.length} page(s), ${data.pages.reduce(
        (total, page) => total + page.lines.length,
        0,
      )} line(s)`,
    ),
    data,
  } as DocumentTool.OcrExtractResult
}

function makeErrorResult(
  code: IndustrialResult.ErrorCode,
  summary: string,
  sandboxRunID: SandboxProtocol.RunID,
): DocumentTool.OcrExtractResult {
  return makeError("ocr_extract", DocumentEngine.OcrEngine, code, summary, sandboxRunID) as DocumentTool.OcrExtractResult
}

export * as OcrExtract from "./ocr-extract"
