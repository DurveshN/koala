import { Artifact } from "@koala-ai/core/artifact/artifact"
import { DocumentEngine } from "@koala-ai/core/document/engine"
import { IndustrialInput } from "@koala-ai/core/industrial/input"
import { IndustrialProjection } from "@koala-ai/core/industrial/projection"
import type { IndustrialResult } from "@koala-ai/core/industrial/result"
import { Knowledge } from "@koala-ai/core/knowledge/tool"
import { SandboxProtocol } from "@koala-ai/core/sandbox/protocol"
import { ArtifactInput } from "@/koala/artifact-input"
import { IndustrialExecution } from "@/koala/industrial-execution"
import { KnowledgeStore } from "@/koala/knowledge-store"
import { Effect, Scope } from "effect"
import { artifactLocator, artifactReference, makeError, makeProvenance, makeRunID, truncateSummary } from "./document-common"
import * as Tool from "./tool"

const DeadlineMs = 120_000

type Metadata = {
  readonly result: Knowledge.KnowledgeIngestResult
  readonly projection: IndustrialProjection.Output
  readonly truncated: boolean
}

export const KnowledgeIngestTool = Tool.define<
  typeof Knowledge.KnowledgeIngest.Input,
  Metadata,
  ArtifactInput.Service | KnowledgeStore.Service | IndustrialExecution.Service
>(
  "knowledge_ingest",
  Effect.gen(function* () {
    const execution = yield* IndustrialExecution.Service
    const artifactInput = yield* ArtifactInput.Service
    const knowledgeStore = yield* KnowledgeStore.Service

    return {
      description: "Ingest an artifact into the session knowledge base for semantic search.",
      parameters: Knowledge.KnowledgeIngest.Input,
      execute: (params, context) =>
        Effect.gen(function* () {
          const runID = makeRunID("knowledge-ingest")
          const result = yield* execution
            .execute({
              tool: "knowledge_ingest",
              permission: "knowledge_write",
              engine: DocumentEngine.KnowledgeEngine,
              input: params,
              inputSchema: Knowledge.KnowledgeIngest.Input,
              inputSummary: IndustrialInput.summarize([{ artifactID: params.source }]),
              sourceArtifactIDs: [params.source],
              resultSchema: Knowledge.KnowledgeIngest.Result,
              context,
              permissionRequest: { patterns: ["*"], always: ["*"], metadata: {} },
              deadlineMs: DeadlineMs,
              sandboxRunID: runID,
              operation: (signal): Effect.Effect<Knowledge.KnowledgeIngestResult, ArtifactInput.HostError | Error, Scope.Scope> =>
                Effect.gen(function* () {
                  const resolved = yield* artifactInput.resolve({
                    source: { artifactID: params.source },
                    provenance: makeProvenance(context, "knowledge_ingest"),
                    context,
                  })
                  const text = yield* Effect.promise(() => Bun.file(resolved.snapshotPath).text())
                  const entries = yield* knowledgeStore.ingest({
                    sessionID: context.sessionID,
                    artifactID: resolved.artifact.id,
                    artifactName: resolved.artifact.name,
                    text,
                    indexProfileID: params.indexProfileID ?? "default",
                    extractorVersion: params.extractorVersion ?? "1",
                    chunkerVersion: params.chunkerVersion ?? "1",
                  })
                  return {
                    tool: "knowledge_ingest" as const,
                    contractVersion: 1 as const,
                    engine: DocumentEngine.KnowledgeEngine,
                    status: "success" as const,
                    cancelled: false as const,
                    timedOut: false as const,
                    sources: [artifactReference(resolved.artifact)],
                    outputs: [] as Artifact.Reference[],
                    citations: [artifactLocator(resolved.artifact.id)],
                    producerTruncated: false,
                    sandboxRunID: runID,
                    summary: truncateSummary(`Ingested ${entries} knowledge entries from ${resolved.artifact.name}`),
                    data: { entries },
                  }
                }).pipe(
                  Effect.catch((error: ArtifactInput.HostError | Error) =>
                    Effect.succeed(
                      error instanceof ArtifactInput.HostError
                        ? makeErrorResult(mapHostError(error.code), ingestErrorSummary(error.code), runID)
                        : makeErrorResult(
                            "engine-failed",
                            error instanceof Error ? error.message : "Knowledge ingest failed",
                            runID,
                          ),
                    ),
                  ),
                ),
              mapError: () => "internal-error",
              makeError: (code) => makeErrorResult(code, `Knowledge ingest failed: ${code}`, runID),
            })
            .pipe(
              Effect.map((output) => ({
                title: "Knowledge Ingest",
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
          return result
        }),
    }
  }),
)

function mapHostError(code: ArtifactInput.HostErrorCode): IndustrialResult.GeneralErrorCode {
  if (code === "invalid-input") return "invalid-input"
  if (code === "permission-denied") return "permission-denied"
  if (code === "source-not-found") return "source-not-found"
  if (code === "source-access-denied") return "source-access-denied"
  if (code === "source-not-owned") return "source-not-owned"
  if (code === "source-changed") return "source-changed"
  if (code === "source-invalid") return "source-invalid"
  if (code === "input-too-large") return "input-too-large"
  return "artifact-storage-failed"
}

function ingestErrorSummary(code: ArtifactInput.HostErrorCode): string {
  return `Knowledge ingest failed: ${code}`
}

function makeErrorResult(
  code: IndustrialResult.ErrorCode,
  summary: string,
  sandboxRunID: SandboxProtocol.RunID,
): Knowledge.KnowledgeIngestResult {
  return makeError("knowledge_ingest", DocumentEngine.KnowledgeEngine, code, summary, sandboxRunID) as Knowledge.KnowledgeIngestResult
}

export * as KnowledgeIngest from "./knowledge-ingest"
