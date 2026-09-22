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
import { ModelRouter } from "@koala-ai/core/model/router"
import { SandboxProtocol } from "@koala-ai/core/sandbox/protocol"
import { ArtifactInput } from "@/koala/artifact-input"
import { Auth } from "@/auth"
import { IndustrialExecution } from "@/koala/industrial-execution"
import { ModelEndpointClient } from "@/koala/model-endpoint-client"
import { ModelProfileStore } from "@/koala/model-profile-store"
import { DocumentRuntime } from "@/document/runtime"
import { Effect, Schema, Scope } from "effect"
import {
  artifactReference,
  artifactLocator,
  documentFormat,
  encodeFileToBase64DataURL,
  encodeRouteDecisionID,
  isImageMime,
  isPdfMime,
  makeError,
  makeProvenance,
  makeRunID,
  mapRuntimeError,
  truncateSummary,
  writeJsonArtifact,
} from "./document-common"
import * as Tool from "./tool"

const DeadlineMs = 120_000
const PersistThresholdBytes = 128 * 1024
const DefaultVisionPrompt =
  "Describe the image. Return JSON with `observations`: an array of {description, coordinates?: {left, top, right, bottom}} in normalized [0,1] coordinates."

type Metadata = {
  readonly result: DocumentTool.VisionAnalyzeResult
  readonly projection: IndustrialProjection.Output
  readonly truncated: boolean
}

const ObservationsResponse = Schema.Struct({
  observations: Schema.Array(
    Schema.Struct({
      description: Schema.String,
      coordinates: Schema.optionalKey(
        Schema.Struct({
          left: Schema.Number,
          top: Schema.Number,
          right: Schema.Number,
          bottom: Schema.Number,
        }),
      ),
    }),
  ),
}).annotate({ identifier: "VisionAnalyze.ObservationsResponse" })

export const VisionAnalyzeTool = Tool.define<
  typeof DocumentTool.VisionAnalyze.Input,
  Metadata,
  | ArtifactInput.Service
  | ArtifactStore.Service
  | DocumentRuntime.Service
  | IndustrialExecution.Service
  | ModelProfileStore.Service
  | ModelEndpointClient.Service
  | Auth.Service
>(
  "vision_analyze",
  Effect.gen(function* () {
    const execution = yield* IndustrialExecution.Service
    const runtime = yield* DocumentRuntime.Service
    const artifacts = yield* ArtifactStore.Service
    const profiles = yield* ModelProfileStore.Service
    const endpointClient = yield* ModelEndpointClient.Service
    const artifactInput = yield* ArtifactInput.Service
    const auth = yield* Auth.Service

    return {
      description: "Analyze an image or PDF page with a vision model and return structured observations.",
      parameters: DocumentTool.VisionAnalyze.Input,
      execute: (params, context) =>
        Effect.gen(function* () {
          const runID = makeRunID("vision-analyze")
          const profileList = yield* profiles.list().pipe(Effect.orDie)
          const route = ModelRouter.route({
            task: "vision",
            requiredCapabilities: [],
            profiles: profileList,
          })
          const selected = route.selected
          const provider = selected ? profileList.find((p) => p.id === selected.providerID) : undefined
          const routeDecisionID = selected && provider ? encodeRouteDecisionID(selected.providerID, selected.profile.id) : undefined

          const result = yield* execution
            .execute({
              tool: "vision_analyze",
              permission: "vision_analyze",
              engine: DocumentEngine.VisionEngine,
              input: params,
              inputSchema: DocumentTool.VisionAnalyze.Input,
              inputSummary: IndustrialInput.summarize([params.source], 0),
              sourceArtifactIDs: [],
              resultSchema: DocumentTool.VisionAnalyze.Result,
              context,
              permissionRequest: { patterns: ["*"], always: ["*"], metadata: {} },
              deadlineMs: DeadlineMs,
              sandboxRunID: runID,
              routeDecisionID,
              operation: (signal, commit): Effect.Effect<DocumentTool.VisionAnalyzeResult, never, Scope.Scope> =>
                Effect.gen(function* () {
                  if (!selected || !provider) {
                    return makeErrorResult("engine-unavailable", "No vision model available", runID)
                  }

                  const innerRouteDecisionID = encodeRouteDecisionID(selected.providerID, selected.profile.id)

                  const resolved = yield* artifactInput.resolve({
                    source: params.source,
                    provenance: makeProvenance(context, "vision_analyze"),
                    context,
                  })

                  const sourceMime = resolved.artifact.mime ?? "application/octet-stream"
                  const format = documentFormat(resolved.artifact.name)
                  const isImage = isImageMime(sourceMime) || format === "image"
                  const isPdf = isPdfMime(sourceMime) || format === "pdf"

                  if (!isImage && !isPdf) {
                    return makeErrorResult("unsupported-format", `Unsupported vision source: ${sourceMime}`, runID)
                  }

                  const imageDataUrl = yield* prepareImageDataUrl({
                    runtime,
                    snapshotPath: resolved.snapshotPath,
                    sourceMime,
                    isImage,
                    isPdf,
                  })

                  const client = yield* endpointClient.bind({
                    providerID: selected.providerID,
                    baseURL: provider.baseURL,
                  })

                  const authInfo = yield* auth.get(selected.providerID).pipe(Effect.orDie)
                  const apiKey = authInfo?.type === "api" ? authInfo.key : undefined

                  const prompt = params.prompt ?? DefaultVisionPrompt
                  const body = {
                    model: selected.profile.id,
                    messages: [
                      {
                        role: "user",
                        content: [
                          { type: "text", text: prompt },
                          { type: "image_url", image_url: { url: imageDataUrl } },
                        ],
                      },
                    ],
                    max_tokens: selected.profile.maxOutput,
                    stream: false,
                  }

                  const response = yield* Effect.tryPromise({
                    try: (abortSignal) =>
                      client.fetch(`${client.baseURL.replace(/\/+$/, "")}/chat/completions`, {
                        method: "POST",
                        headers: {
                          "content-type": "application/json",
                          accept: "application/json",
                          ...(apiKey !== undefined && { authorization: `Bearer ${apiKey}` }),
                        },
                        body: JSON.stringify(body),
                        signal: abortSignal,
                      }),
                    catch: () => new Error("Vision request failed"),
                  })

                  if (!response.ok) {
                    return makeErrorResult(
                      response.status === 503 || response.status === 429 ? "engine-unavailable" : "engine-failed",
                      `Vision model returned HTTP ${response.status}`,
                      runID,
                    )
                  }

                  const text = yield* Effect.tryPromise({
                    try: () => response.text(),
                    catch: () => new Error("Could not read vision response"),
                  })

                  const observations = yield* parseVisionObservations(text, resolved.artifact.id)
                  const data = { observations }

                  if (JSON.stringify(data).length <= PersistThresholdBytes) {
                    return makeSuccess(
                      resolved.artifact,
                      data,
                      [],
                      DocumentEngine.VisionEngine,
                      innerRouteDecisionID,
                      runID,
                    )
                  }

                  return yield* persistLarge({
                    artifacts,
                    context,
                    signal,
                    commit,
                    source: resolved.artifact,
                    data,
                    engine: DocumentEngine.VisionEngine,
                    routeDecisionID: innerRouteDecisionID,
                    runID,
                  })
                }).pipe(
                  Effect.catch((error) =>
                    Effect.succeed(
                      error instanceof DocumentRuntime.RuntimeError
                        ? makeErrorResult(mapRuntimeError(error), `Vision analysis failed: ${error.code}`, runID)
                        : makeErrorResult(
                            error instanceof Error && error.message.includes("format")
                              ? "unsupported-format"
                              : "engine-failed",
                            error instanceof Error ? error.message : "Vision analysis failed",
                            runID,
                          ),
                    ),
                  ),
                ),
              mapError: () => "internal-error",
              makeError: (code) => makeErrorResult(code, `Vision analysis failed: ${code}`, runID),
            })
            .pipe(
              Effect.map((output) => ({
                title: "Vision analysis",
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

function persistLarge(input: {
  artifacts: ArtifactStore.Interface
  context: Tool.Context
  signal: AbortSignal
  commit: IndustrialExecution.CommitBoundary
  source: Artifact.Metadata
  data: { observations: DocumentNormalized.VisualObservation[] }
  engine: IndustrialTool.Engine
  routeDecisionID: ReturnType<typeof encodeRouteDecisionID>
  runID: SandboxProtocol.RunID
}) {
  return Effect.gen(function* () {
    const staging = yield* input.artifacts.stage(input.runID)
    return yield* Effect.gen(function* () {
      yield* writeJsonArtifact(staging, "observations.json", input.data)

      let committedResult: DocumentTool.VisionAnalyzeResult | undefined
      const success = (metadata: ReadonlyArray<Artifact.Metadata>): DocumentTool.VisionAnalyzeResult => {
        const output = metadata[0]
        if (!output) {
          return makeErrorResult(
            "artifact-storage-failed",
            "Vision artifact promotion produced no output",
            input.runID,
          )
        }
        return makeSuccess(
          input.source,
          input.data,
          [artifactReference(output)],
          input.engine,
          input.routeDecisionID,
          input.runID,
        )
      }

      const promoted = yield* input.artifacts.promoteBatch(
        [
          {
            runID: input.runID,
            outputPath: Schema.decodeUnknownSync(Artifact.OutputPath)("observations.json"),
            provenance: {
              sessionID: input.context.sessionID,
              messageID: input.context.messageID,
              toolName: "vision_analyze",
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
  data: { observations: DocumentNormalized.VisualObservation[] },
  outputs: ReadonlyArray<Artifact.Reference>,
  engine: IndustrialTool.Engine,
  routeDecisionID: ReturnType<typeof encodeRouteDecisionID>,
  sandboxRunID: SandboxProtocol.RunID,
): DocumentTool.VisionAnalyzeResult {
  return {
    tool: "vision_analyze" as const,
    contractVersion: 1 as const,
    engine,
    status: "success" as const,
    cancelled: false,
    timedOut: false,
    sources: [artifactReference(source)],
    outputs,
    citations: outputs.map((output) => artifactLocator(output.id)),
    producerTruncated: false,
    routeDecisionID,
    sandboxRunID,
    summary: truncateSummary(
      `Vision analysis completed: ${data.observations.length} observation(s) for ${source.name}`,
    ),
    data,
  } as DocumentTool.VisionAnalyzeResult
}

function makeErrorResult(
  code: IndustrialResult.ErrorCode,
  summary: string,
  sandboxRunID: SandboxProtocol.RunID,
): DocumentTool.VisionAnalyzeResult {
  return makeError(
    "vision_analyze",
    DocumentEngine.VisionEngine,
    code,
    summary,
    sandboxRunID,
  ) as DocumentTool.VisionAnalyzeResult
}

function prepareImageDataUrl(input: {
  runtime: DocumentRuntime.Interface
  snapshotPath: string
  sourceMime: string
  isImage: boolean
  isPdf: boolean
}) {
  return Effect.gen(function* () {
    if (input.isImage) {
      return yield* encodeFileToBase64DataURL(input.snapshotPath, input.sourceMime)
    }
    if (!input.isPdf) {
      return yield* Effect.fail(new Error(`Unsupported vision source: ${input.sourceMime}`))
    }

    let renderedPath: string | undefined
    yield* input.runtime
      .renderAndOcr(
        {
          inputPath: input.snapshotPath,
          startPage: 1,
          pageCount: 1,
          limits: DocumentRuntimeLimits.requestedHard,
        },
        (scopedPage) =>
          Effect.gen(function* () {
            renderedPath = scopedPage.pagePath
          }),
      )
      .pipe(Effect.mapError((error) => new Error(`PDF render failed: ${error.code}`)))

    if (!renderedPath) return yield* Effect.fail(new Error("PDF page render produced no image"))
    return yield* encodeFileToBase64DataURL(renderedPath, "image/png")
  })
}

function parseVisionObservations(text: string, artifactID: Artifact.ID) {
  return Effect.gen(function* () {
    const decoded = yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(text).pipe(
      Effect.mapError(() => new Error("Vision response is not valid JSON")),
    )
    const content = extractContent(decoded)
    if (content === undefined) {
      return yield* Effect.fail(new Error("Vision response missing content"))
    }
    const parsed = Schema.decodeUnknownOption(ObservationsResponse)(JSON.parse(content))
    if (parsed._tag === "Some") {
      return parsed.value.observations
        .map((observation) => buildObservation(observation.description, observation.coordinates, artifactID))
        .filter((value): value is DocumentNormalized.VisualObservation => value !== undefined)
    }
    const fallback = buildObservation(content, undefined, artifactID)
    return fallback ? [fallback] : []
  })
}

function extractContent(json: unknown): string | undefined {
  if (typeof json !== "object" || json === null) return undefined
  const choices = Reflect.get(json, "choices")
  if (!Array.isArray(choices) || choices.length === 0) return undefined
  const first = choices[0]
  if (typeof first !== "object" || first === null) return undefined
  const message = Reflect.get(first, "message")
  if (typeof message === "object" && message !== null) {
    const content = Reflect.get(message, "content")
    if (typeof content === "string") return content
  }
  const content = Reflect.get(first, "content")
  if (typeof content === "string") return content
  return undefined
}

function buildObservation(
  description: string,
  coordinates: { left: number; top: number; right: number; bottom: number } | undefined,
  artifactID: Artifact.ID,
): DocumentNormalized.VisualObservation | undefined {
  const locator = artifactLocator(artifactID)
  const decoded = Schema.decodeUnknownOption(DocumentNormalized.VisualObservation)({
    description,
    locator,
    ...(coordinates && {
      coordinates: Schema.decodeUnknownSync(DocumentNormalized.BoundingBox)({
        left: coordinates.left,
        top: coordinates.top,
        right: coordinates.right,
        bottom: coordinates.bottom,
      }),
    }),
  })
  return decoded._tag === "Some" ? decoded.value : undefined
}

export * as VisionAnalyze from "./vision-analyze"
