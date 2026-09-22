import { Artifact } from "@koala-ai/core/artifact/artifact"
import { ArtifactStore } from "@koala-ai/core/artifact/store"
import { DocumentEngine } from "@koala-ai/core/document/engine"
import { IndustrialInput } from "@koala-ai/core/industrial/input"
import { IndustrialProjection } from "@koala-ai/core/industrial/projection"
import type { IndustrialResult } from "@koala-ai/core/industrial/result"
import { Knowledge } from "@koala-ai/core/knowledge/tool"
import { SandboxProtocol } from "@koala-ai/core/sandbox/protocol"
import { IndustrialExecution } from "@/koala/industrial-execution"
import { KnowledgeStore, type SearchResult } from "@/koala/knowledge-store"
import { Effect } from "effect"
import { artifactReference, makeError, makeRunID, truncateSummary } from "./document-common"
import * as Tool from "./tool"

const DeadlineMs = 30_000

type Metadata = {
  readonly result: Knowledge.KnowledgeOpenResult
  readonly projection: IndustrialProjection.Output
  readonly truncated: boolean
}

export const KnowledgeOpenTool = Tool.define<
  typeof Knowledge.KnowledgeOpen.Input,
  Metadata,
  ArtifactStore.Service | KnowledgeStore.Service | IndustrialExecution.Service
>(
  "knowledge_open",
  Effect.gen(function* () {
    const execution = yield* IndustrialExecution.Service
    const knowledgeStore = yield* KnowledgeStore.Service
    const artifacts = yield* ArtifactStore.Service

    return {
      description: "Open a knowledge entry by ID.",
      parameters: Knowledge.KnowledgeOpen.Input,
      execute: (params, context) =>
        Effect.gen(function* () {
          const runID = makeRunID("knowledge-open")
          const result = yield* execution
            .execute({
              tool: "knowledge_open",
              permission: "knowledge_read",
              engine: DocumentEngine.KnowledgeEngine,
              input: params,
              inputSchema: Knowledge.KnowledgeOpen.Input,
              inputSummary: IndustrialInput.summarize([]),
              sourceArtifactIDs: [],
              resultSchema: Knowledge.KnowledgeOpen.Result,
              context,
              permissionRequest: { patterns: ["*"], always: ["*"], metadata: {} },
              deadlineMs: DeadlineMs,
              sandboxRunID: runID,
              operation: (): Effect.Effect<Knowledge.KnowledgeOpenResult, Error> =>
                Effect.gen(function* () {
                  const opened = yield* knowledgeStore.open({
                    sessionID: context.sessionID,
                    entryID: params.entryID,
                  })
                  if (!opened) return makeErrorResult("source-not-found", "Knowledge entry not found", runID)
                  const source = yield* artifacts.metadata(opened.locator.artifactID).pipe(
                    Effect.map(artifactReference),
                  )
                  return {
                    tool: "knowledge_open" as const,
                    contractVersion: 1 as const,
                    engine: DocumentEngine.KnowledgeEngine,
                    status: "success" as const,
                    cancelled: false as const,
                    timedOut: false as const,
                    sources: [source],
                    outputs: [] as Artifact.Reference[],
                    citations: [opened.locator],
                    producerTruncated: false,
                    sandboxRunID: runID,
                    summary: truncateSummary(opened.text),
                    data: {
                      entryID: opened.entryID,
                      text: opened.text,
                      locator: opened.locator,
                    },
                  }
                }).pipe(
                  Effect.catch((error: Error) =>
                    Effect.succeed(
                      makeErrorResult(
                        "engine-failed",
                        error instanceof Error ? error.message : "Knowledge open failed",
                        runID,
                      ),
                    ),
                  ),
                ),
              mapError: () => "internal-error",
              makeError: (code) => makeErrorResult(code, `Knowledge open failed: ${code}`, runID),
            })
            .pipe(
              Effect.map((output) => ({
                title: "Knowledge Open",
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

export function makeSuccess(
  opened: SearchResult,
  source: Artifact.Reference,
  runID: SandboxProtocol.RunID,
): Knowledge.KnowledgeOpenResult {
  return {
    tool: "knowledge_open" as const,
    contractVersion: 1 as const,
    engine: DocumentEngine.KnowledgeEngine,
    status: "success" as const,
    cancelled: false as const,
    timedOut: false as const,
    sources: [source],
    outputs: [],
    citations: [opened.locator],
    producerTruncated: false,
    sandboxRunID: runID,
    summary: truncateSummary(opened.text),
    data: {
      entryID: opened.entryID,
      text: opened.text,
      locator: opened.locator,
    },
  }
}

function makeErrorResult(
  code: IndustrialResult.ErrorCode,
  summary: string,
  sandboxRunID: SandboxProtocol.RunID,
): Knowledge.KnowledgeOpenResult {
  return makeError("knowledge_open", DocumentEngine.KnowledgeEngine, code, summary, sandboxRunID) as Knowledge.KnowledgeOpenResult
}

export * as KnowledgeOpen from "./knowledge-open"
