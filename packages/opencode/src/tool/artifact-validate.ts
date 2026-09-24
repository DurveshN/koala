import { Artifact } from "@koala-ai/core/artifact/artifact"
import { DocumentEngine } from "@koala-ai/core/document/engine"
import { DocumentValidation } from "@koala-ai/core/document/validation"
import { detectOoxmlFormat, validateOoxml, validatePdf } from "@koala-ai/document-runtime"
import { IndustrialInput } from "@koala-ai/core/industrial/input"
import { IndustrialProjection } from "@koala-ai/core/industrial/projection"
import { IndustrialResult } from "@koala-ai/core/industrial/result"
import { SandboxProtocol } from "@koala-ai/core/sandbox/protocol"
import { ArtifactInput } from "@/koala/artifact-input"
import { IndustrialExecution } from "@/koala/industrial-execution"
import { Effect } from "effect"
import { artifactReference, makeError, makeProvenance, makeRunID, truncateSummary } from "./document-common"
import * as Tool from "./tool"

type Metadata = {
  readonly result: DocumentValidation.ArtifactValidateResult
  readonly projection: IndustrialProjection.Output
  readonly truncated: boolean
}

export const ArtifactValidateTool = Tool.define<
  typeof DocumentValidation.ArtifactValidate.Input,
  Metadata,
  ArtifactInput.Service | IndustrialExecution.Service
>(
  "artifact_validate",
  Effect.gen(function* () {
    const execution = yield* IndustrialExecution.Service
    const artifactInput = yield* ArtifactInput.Service

    return {
      description: "Validate a DOCX, PPTX, XLSX, or PDF artifact with the basic structural profile.",
      parameters: DocumentValidation.ArtifactValidate.Input,
      execute: (params, context) =>
        Effect.gen(function* () {
          const runID = makeRunID("artifact-validate")
          const result = yield* execution
            .execute({
              tool: "artifact_validate",
              permission: "document_read",
              engine: DocumentEngine.ValidationEngine,
              input: params,
              inputSchema: DocumentValidation.ArtifactValidate.Input,
              inputSummary: IndustrialInput.summarize([params.source]),
              sourceArtifactIDs: [],
              resultSchema: DocumentValidation.ArtifactValidate.Result,
              context,
              permissionRequest: { patterns: ["*"], always: ["*"], metadata: {} },
              deadlineMs: 60_000,
              sandboxRunID: runID,
              operation: (signal) =>
                Effect.gen(function* () {
                  const resolved = yield* artifactInput.resolve({
                    source: params.source,
                    provenance: makeProvenance(context, "artifact_validate"),
                    context,
                  })

                  const bytes = yield* Effect.promise(() => Bun.file(resolved.snapshotPath).bytes())
                  if (signal.aborted) return makeErrorResult("cancelled", "Validation was cancelled", runID)
                  const validation = yield* Effect.tryPromise({
                    try: async () => {
                      if (Buffer.from(bytes.subarray(0, 5)).toString("latin1") === "%PDF-") {
                        const pdf = await validatePdf(bytes)
                        return { code: "pdf-basic", message: `Validated; ${pdf.pageCount} page(s)` }
                      }
                      const format = await detectOoxmlFormat(bytes)
                      if (!format) throw new Error("Unsupported artifact format")
                      const ooxml = await validateOoxml(bytes, format)
                      return {
                        code: "ooxml-basic",
                        message: `Validated ${format}; ${ooxml.sectionCount} ${format === "docx" ? "section" : format === "pptx" ? "slide" : "sheet"}(s)`,
                      }
                    },
                    catch: (error) => new Error(error instanceof Error ? error.message : "Artifact validation failed"),
                  })

                  return makeSuccess(
                    resolved.artifact,
                    true,
                    [validation],
                    runID,
                  )
                }).pipe(
                  Effect.catch((error) =>
                    Effect.succeed(
                      makeErrorResult(
                        error instanceof Error && /macro|Unsupported artifact format/.test(error.message)
                          ? "unsupported-format"
                          : "engine-failed",
                        error instanceof Error ? error.message : "Artifact validation failed",
                        runID,
                      ),
                    ),
                  ),
                ),
              mapError: () => "internal-error",
              makeError: (code) => makeErrorResult(code, `Artifact validation failed: ${code}`, runID),
            })
            .pipe(
              Effect.map((output) => ({
                title: "Artifact validation",
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

function makeSuccess(
  source: Artifact.Metadata,
  valid: boolean,
  findings: ReadonlyArray<{ readonly code: string; readonly message: string }>,
  sandboxRunID: SandboxProtocol.RunID,
): DocumentValidation.ArtifactValidateResult {
  return {
    tool: "artifact_validate" as const,
    contractVersion: 1 as const,
    engine: DocumentEngine.ValidationEngine,
    status: "success" as const,
    cancelled: false,
    timedOut: false,
    sources: [artifactReference(source)],
    outputs: [],
    citations: [],
    producerTruncated: false,
    sandboxRunID,
    summary: truncateSummary(`Artifact validation: ${valid ? "valid" : "invalid"} — ${findings.length} finding(s)`),
    data: { valid, findings },
  } as DocumentValidation.ArtifactValidateResult
}

function makeErrorResult(
  code: IndustrialResult.ErrorCode,
  summary: string,
  sandboxRunID: SandboxProtocol.RunID,
): DocumentValidation.ArtifactValidateResult {
  return makeError(
    "artifact_validate",
    DocumentEngine.ValidationEngine,
    code,
    summary,
    sandboxRunID,
  ) as DocumentValidation.ArtifactValidateResult
}

export * as ArtifactValidate from "./artifact-validate"
