import { Artifact } from "@koala-ai/core/artifact/artifact"
import { ArtifactStore } from "@koala-ai/core/artifact/store"
import { DocumentEngine } from "@koala-ai/core/document/engine"
import { DocumentGenerate } from "@koala-ai/core/document/generate"
import { IndustrialInput } from "@koala-ai/core/industrial/input"
import { IndustrialProjection } from "@koala-ai/core/industrial/projection"
import type { IndustrialResult } from "@koala-ai/core/industrial/result"
import { SandboxProtocol } from "@koala-ai/core/sandbox/protocol"
import { validateOoxmlDocx } from "@koala-ai/document-runtime"
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

type DocxCreateResult = typeof DocumentGenerate.DocxCreate.Result.Type

type Metadata = {
  readonly result: DocxCreateResult
  readonly projection: IndustrialProjection.Output
  readonly truncated: boolean
}

const DeadlineMs = 120_000
const OutputFileName = "document.docx"

export const DocxCreateTool = Tool.define<
  typeof DocumentGenerate.DocxCreate.Input,
  Metadata,
  ArtifactStore.Service | DocumentRuntime.Service | IndustrialExecution.Service
>(
  "docx_create",
  Effect.gen(function* () {
    const execution = yield* IndustrialExecution.Service
    const runtime = yield* DocumentRuntime.Service
    const artifacts = yield* ArtifactStore.Service

    return {
      description: "Create a Microsoft Word document (.docx) from structured content.",
      parameters: DocumentGenerate.DocxCreate.Input,
      execute: (params, context) =>
        Effect.gen(function* () {
          const runID = makeRunID("docx-create")
          const output = yield* execution.execute({
            tool: "docx_create",
            permission: "document_write",
            engine: DocumentEngine.DocxCreateEngine,
            input: params,
            inputSchema: DocumentGenerate.DocxCreate.Input,
            inputSummary: IndustrialInput.summarize([]),
            sourceArtifactIDs: [],
            resultSchema: DocumentGenerate.DocxCreate.Result,
            context,
            permissionRequest: { patterns: ["*"], always: ["*"], metadata: {} },
            deadlineMs: DeadlineMs,
            sandboxRunID: runID,
            operation: (signal, commit) =>
              Effect.gen(function* () {
                const generated = yield* runtime.createDocx({ contents: params.contents })
                yield* Effect.tryPromise({
                  try: () => validateOoxmlDocx(generated.bytes, generated.bytes.byteLength),
                  catch: (error) =>
                    new Error(`DOCX validation failed: ${error instanceof Error ? error.message : String(error)}`),
                })

                const staging = yield* artifacts.stage(runID)
                const outputPath = Schema.decodeUnknownSync(Artifact.OutputPath)(OutputFileName)
                const fullPath = path.join(staging.artifacts, String(outputPath))

                yield* Effect.promise(() => mkdir(path.dirname(fullPath), { recursive: true, mode: 0o700 }))
                yield* Effect.promise(() => writeFile(fullPath, generated.bytes, { flag: "wx", mode: 0o600 }))

                const provenance = makeProvenance(context, "docx_create")

                const success = (metadata: ReadonlyArray<Artifact.Metadata>): DocxCreateResult => {
                  const output = metadata[0]
                  if (!output) {
                    return makeErrorResult(
                      "artifact-storage-failed",
                      "DOCX artifact promotion produced no output",
                      runID,
                    )
                  }
                  return {
                    tool: "docx_create" as const,
                    contractVersion: 1 as const,
                    engine: DocumentEngine.DocxCreateEngine,
                    status: "success" as const,
                    cancelled: false as const,
                    timedOut: false as const,
                    sources: [],
                    outputs: [artifactReference(output)],
                    citations: [],
                    producerTruncated: false,
                    sandboxRunID: runID,
                    summary: truncateSummary(`Created DOCX document: ${output.name}`),
                    data: { artifact: artifactReference(output) },
                  }
                }

                let committedResult: DocxCreateResult | undefined
                const promoted = yield* artifacts.promoteBatch(
                  [
                    {
                      runID,
                      outputPath,
                      provenance: { ...provenance, sandboxRunID: runID },
                      lineage: [],
                    },
                  ],
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
                      makeErrorResult(mapRuntimeError(error), `DOCX creation failed: ${error.code}`, runID),
                    )
                  }
                  if (error.message.startsWith("DOCX validation failed")) {
                    return Effect.succeed(makeErrorResult("engine-failed", error.message, runID))
                  }
                  return Effect.succeed(makeErrorResult("artifact-storage-failed", error.message, runID))
                }),
              ),
            mapError: () => "internal-error",
            makeError: (code) => makeErrorResult(code, `DOCX creation failed: ${code}`, runID),
          })

          return {
            title: "DOCX",
            output: output.projection.text,
            metadata: {
              result: output.result,
              projection: output.projection,
              truncated: output.result.producerTruncated || output.projection.truncated,
            },
          }
        }).pipe(Effect.scoped, Effect.orDie),
    }
  }),
)

function makeErrorResult(
  code: IndustrialResult.ErrorCode,
  summary: string,
  sandboxRunID: SandboxProtocol.RunID,
): DocxCreateResult {
  return makeError("docx_create", DocumentEngine.DocxCreateEngine, code, summary, sandboxRunID) as DocxCreateResult
}

export * as DocxCreate from "./docx-create"
