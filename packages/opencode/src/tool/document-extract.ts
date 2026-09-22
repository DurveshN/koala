import { Artifact } from "@koala-ai/core/artifact/artifact"
import { ArtifactStore } from "@koala-ai/core/artifact/store"
import { DocumentNormalized } from "@koala-ai/core/document/normalized"
import { DocumentTool } from "@koala-ai/core/document/tool"
import { IndustrialInput } from "@koala-ai/core/industrial/input"
import { IndustrialProjection } from "@koala-ai/core/industrial/projection"
import type { IndustrialResult } from "@koala-ai/core/industrial/result"
import { IndustrialTool } from "@koala-ai/core/industrial/tool"
import { SandboxProtocol } from "@koala-ai/core/sandbox/protocol"
import { ArtifactInput } from "@/koala/artifact-input"
import { IndustrialExecution } from "@/koala/industrial-execution"
import { DocumentRuntime } from "@/document/runtime"
import { Effect, Schema, Scope } from "effect"
import {
  artifactLocator,
  artifactReference,
  documentFormat,
  makeError,
  makeProvenance,
  makeRunID,
  mapRuntimeError,
  ocrToNormalized,
  readText,
  readOfficeToNormalized,
  readPdfToNormalized,
  truncateSummary,
  writeJsonArtifact,
} from "./document-common"
import * as Tool from "./tool"

const DeadlineMs = 120_000
const PersistThresholdBytes = 128 * 1024

const DocumentExtractEngine = Schema.decodeUnknownSync(IndustrialTool.Engine)({
  name: "document-extract",
  version: "1",
})

type Metadata = {
  readonly result: DocumentTool.DocumentExtractResult
  readonly projection: IndustrialProjection.Output
  readonly truncated: boolean
}

export const DocumentExtractTool = Tool.define<
  typeof DocumentTool.DocumentExtract.Input,
  Metadata,
  ArtifactInput.Service | ArtifactStore.Service | DocumentRuntime.Service | IndustrialExecution.Service
>(
  "document_extract",
  Effect.gen(function* () {
    const execution = yield* IndustrialExecution.Service
    const runtime = yield* DocumentRuntime.Service
    const artifacts = yield* ArtifactStore.Service
    const artifactInput = yield* ArtifactInput.Service

    return {
      description: "Convert a document into normalized structured text and metadata.",
      parameters: DocumentTool.DocumentExtract.Input,
      execute: (params, context) =>
        Effect.gen(function* () {
          const runID = makeRunID("document-extract")
          const result = yield* execution
            .execute({
              tool: "document_extract",
              permission: "document_read",
              engine: DocumentExtractEngine,
              input: params,
              inputSchema: DocumentTool.DocumentExtract.Input,
              inputSummary: IndustrialInput.summarize([params.source], 1),
              sourceArtifactIDs: [],
              resultSchema: DocumentTool.DocumentExtract.Result,
              context,
              permissionRequest: { patterns: ["*"], always: ["*"], metadata: {} },
              deadlineMs: DeadlineMs,
              sandboxRunID: runID,
              operation: (signal, commit): Effect.Effect<DocumentTool.DocumentExtractResult, never, Scope.Scope> =>
                Effect.gen(function* () {
                  const resolved = yield* artifactInput.resolve({
                    source: params.source,
                    provenance: makeProvenance(context, "document_extract"),
                    context,
                  })

                  const { format, normalized } = yield* normalizeDocument({
                    runtime,
                    snapshotPath: resolved.snapshotPath,
                    sourceID: resolved.artifact.id,
                    artifactName: resolved.artifact.name,
                  })

                  if (JSON.stringify({ normalized }).length <= PersistThresholdBytes) {
                    return makeSuccess(resolved.artifact, normalized, [], runID)
                  }

                  return yield* persistLarge({
                    artifacts,
                    context,
                    signal,
                    commit,
                    source: resolved.artifact,
                    normalized,
                    runID,
                  })
                }).pipe(
                  Effect.catch((error) =>
                    Effect.succeed(
                      error instanceof DocumentRuntime.RuntimeError
                        ? makeErrorResult(mapRuntimeError(error), `Document extraction failed: ${error.code}`, runID)
                        : makeErrorResult(
                            error instanceof Error && error.message.includes("format")
                              ? "unsupported-format"
                              : "engine-failed",
                            error instanceof Error ? error.message : "Document extraction failed",
                            runID,
                          ),
                    ),
                  ),
                ),
              mapError: () => "internal-error",
              makeError: (code) => makeErrorResult(code, `Document extraction failed: ${code}`, runID),
            })
            .pipe(
              Effect.map((output) => ({
                title:
                  output.result.status === "success"
                    ? output.result.data.normalized.metadata.title ?? "Document"
                    : "Document",
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

function normalizeDocument(input: {
  runtime: DocumentRuntime.Interface
  snapshotPath: string
  sourceID: Artifact.ID
  artifactName: string
}) {
  return Effect.gen(function* () {
    const format = documentFormat(input.artifactName)
    switch (format) {
      case "pdf": {
        const read = yield* input.runtime.readPdf({ inputPath: input.snapshotPath })
        return { format, normalized: readPdfToNormalized(read, input.sourceID) }
      }
      case "image": {
        const ocr = yield* input.runtime.ocr({ inputPath: input.snapshotPath, page: 1 })
        return { format, normalized: ocrToNormalized(ocr.page, ocr.dimensions, ocr.tsv, input.sourceID) }
      }
      case "docx":
      case "pptx":
      case "xlsx": {
        const office = yield* input.runtime.readOffice({ inputPath: input.snapshotPath, format })
        return { format, normalized: readOfficeToNormalized(office, input.sourceID) }
      }
      default: {
        if (format !== "unknown") {
          const text = yield* readText(input.snapshotPath)
          return { format, normalized: textToNormalized(input.sourceID, text, input.artifactName) }
        }
        return yield* Effect.fail(new Error(`Unsupported document format: ${input.artifactName}`))
      }
    }
  })
}

function textToNormalized(
  sourceID: Artifact.ID,
  text: string,
  artifactName: string,
): DocumentNormalized.NormalizedDocument {
  const title = extractTitle(artifactName)
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  return {
    source: { type: "artifact", artifactID: sourceID } as DocumentNormalized.NormalizedDocument["source"],
    pages: [
      {
        pageNumber: 1,
        dimensions: { width: 1, height: 1 },
        textBlocks: [{ paragraphs: lines, lines: [] }],
        ocrLines: [],
        imageRegions: [],
        visualObservations: [],
      },
    ],
    sections: [{ type: "document", body: lines.join("\n\n") }],
    metadata: { title, pageCount: 1 },
    truncated: false,
  }
}

function extractTitle(name: string): string {
  const segments = name.replace(/\\/g, "/").split("/")
  const file = segments[segments.length - 1] ?? "document"
  return file.replace(/\.(\w+)$/, "")
}

function persistLarge(input: {
  artifacts: ArtifactStore.Interface
  context: Tool.Context
  signal: AbortSignal
  commit: IndustrialExecution.CommitBoundary
  source: Artifact.Metadata
  normalized: DocumentNormalized.NormalizedDocument
  runID: SandboxProtocol.RunID
}) {
  return Effect.gen(function* () {
    const staging = yield* input.artifacts.stage(input.runID)
    return yield* Effect.gen(function* () {
      yield* writeJsonArtifact(staging, "normalized.json", input.normalized)

      let committedResult: DocumentTool.DocumentExtractResult | undefined
      const success = (metadata: ReadonlyArray<Artifact.Metadata>): DocumentTool.DocumentExtractResult => {
        const output = metadata[0]
        if (!output) {
          return makeErrorResult(
            "artifact-storage-failed",
            "Document extract artifact promotion produced no output",
            input.runID,
          )
        }
        return makeSuccess(input.source, input.normalized, [artifactReference(output)], input.runID)
      }

      const promoted = yield* input.artifacts.promoteBatch(
        [
          {
            runID: input.runID,
            outputPath: Schema.decodeUnknownSync(Artifact.OutputPath)("normalized.json"),
            provenance: {
              sessionID: input.context.sessionID,
              messageID: input.context.messageID,
              toolName: "document_extract",
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
  sandboxRunID: SandboxProtocol.RunID,
): DocumentTool.DocumentExtractResult {
  return {
    tool: "document_extract" as const,
    contractVersion: 1 as const,
    engine: DocumentExtractEngine,
    status: "success" as const,
    cancelled: false,
    timedOut: false,
    sources: [artifactReference(source)],
    outputs,
    citations: [artifactLocator(source.id)],
    producerTruncated: normalized.truncated,
    sandboxRunID,
    summary: truncateSummary(
      `${normalized.metadata.title ?? "Document"}\nPages: ${normalized.pages.length}\nSource: ${source.name}`,
    ),
    data: { normalized },
  } as DocumentTool.DocumentExtractResult
}

function makeErrorResult(
  code: IndustrialResult.ErrorCode,
  summary: string,
  sandboxRunID: SandboxProtocol.RunID,
): DocumentTool.DocumentExtractResult {
  return makeError("document_extract", DocumentExtractEngine, code, summary, sandboxRunID) as DocumentTool.DocumentExtractResult
}

export * as DocumentExtract from "./document-extract"
