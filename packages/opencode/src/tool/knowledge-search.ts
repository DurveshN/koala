import { Artifact } from "@koala-ai/core/artifact/artifact"
import { ArtifactStore } from "@koala-ai/core/artifact/store"
import { DocumentEngine } from "@koala-ai/core/document/engine"
import { IndustrialCitation } from "@koala-ai/core/industrial/citation"
import { IndustrialInput } from "@koala-ai/core/industrial/input"
import { IndustrialProjection } from "@koala-ai/core/industrial/projection"
import type { IndustrialResult } from "@koala-ai/core/industrial/result"
import { Knowledge } from "@koala-ai/core/knowledge/tool"
import { SandboxProtocol } from "@koala-ai/core/sandbox/protocol"
import { IndustrialExecution } from "@/koala/industrial-execution"
import { KnowledgeStore } from "@/koala/knowledge-store"
import type { SearchResult } from "@/koala/knowledge-store"
import { Effect } from "effect"
import { artifactReference, makeError, makeRunID, truncateSummary } from "./document-common"
import * as Tool from "./tool"

const DeadlineMs = 30_000

type Metadata = {
  readonly result: Knowledge.KnowledgeSearchResult
  readonly projection: IndustrialProjection.Output
  readonly truncated: boolean
}

export const KnowledgeSearchTool = Tool.define<
  typeof Knowledge.KnowledgeSearch.Input,
  Metadata,
  ArtifactStore.Service | KnowledgeStore.Service | IndustrialExecution.Service
>(
  "knowledge_search",
  Effect.gen(function* () {
    const execution = yield* IndustrialExecution.Service
    const knowledgeStore = yield* KnowledgeStore.Service
    const artifacts = yield* ArtifactStore.Service

    return {
      description: "Search the session knowledge base for semantically relevant text chunks.",
      parameters: Knowledge.KnowledgeSearch.Input,
      execute: (params, context) =>
        Effect.gen(function* () {
          const runID = makeRunID("knowledge-search")
          const result = yield* execution
            .execute({
              tool: "knowledge_search",
              permission: "knowledge_read",
              engine: DocumentEngine.KnowledgeEngine,
              input: params,
              inputSchema: Knowledge.KnowledgeSearch.Input,
              inputSummary: IndustrialInput.summarize([]),
              sourceArtifactIDs: [],
              resultSchema: Knowledge.KnowledgeSearch.Result,
              context,
              permissionRequest: { patterns: ["*"], always: ["*"], metadata: {} },
              deadlineMs: DeadlineMs,
              sandboxRunID: runID,
              operation: (): Effect.Effect<Knowledge.KnowledgeSearchResult, Error> =>
                Effect.gen(function* () {
                  const results = yield* knowledgeStore.search({
                    sessionID: context.sessionID,
                    query: params.query,
                    limit: params.limit,
                  })
                  if (results.length === 0) {
                    return makeSuccess([], [], runID)
                  }
                  const sourceIDs = [...new Set(results.map((result) => result.locator.artifactID))]
                  const sources = yield* Effect.forEach(sourceIDs, (artifactID) =>
                    artifacts.metadata(artifactID).pipe(Effect.map(artifactReference)),
                  )
                  return makeSuccess(results, sources, runID)
                }).pipe(
                  Effect.catch((error: Error) =>
                    Effect.succeed(
                      makeErrorResult(
                        "engine-failed",
                        error instanceof Error ? error.message : "Knowledge search failed",
                        runID,
                      ),
                    ),
                  ),
                ),
              mapError: () => "internal-error",
              makeError: (code) => makeErrorResult(code, `Knowledge search failed: ${code}`, runID),
            })
            .pipe(
              Effect.map((output) => ({
                title: "Knowledge Search",
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

function makeSuccess(
  results: ReadonlyArray<SearchResult>,
  sources: ReadonlyArray<Artifact.Reference>,
  sandboxRunID: SandboxProtocol.RunID,
): Knowledge.KnowledgeSearchResult {
  return {
    tool: "knowledge_search" as const,
    contractVersion: 1 as const,
    engine: DocumentEngine.KnowledgeEngine,
    status: "success" as const,
    cancelled: false as const,
    timedOut: false as const,
    sources,
    outputs: [],
    citations: results.map((result) => result.locator),
    producerTruncated: false,
    sandboxRunID,
    summary: truncateSummary(`Found ${results.length} knowledge result(s)`),
    data: { results: [...results] },
  }
}

function makeErrorResult(
  code: IndustrialResult.ErrorCode,
  summary: string,
  sandboxRunID: SandboxProtocol.RunID,
): Knowledge.KnowledgeSearchResult {
  return makeError("knowledge_search", DocumentEngine.KnowledgeEngine, code, summary, sandboxRunID) as Knowledge.KnowledgeSearchResult
}

export * as KnowledgeSearch from "./knowledge-search"
