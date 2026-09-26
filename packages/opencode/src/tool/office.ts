import { DocumentRuntime } from "@/document/runtime"
import { ArtifactInput } from "@/koala/artifact-input"
import { IndustrialExecution } from "@/koala/industrial-execution"
import { DocumentEngine } from "@koala-ai/core/document/engine"
import { IndustrialInput } from "@koala-ai/core/industrial/input"
import { IndustrialProjection } from "@koala-ai/core/industrial/projection"
import { Effect } from "effect"
import {
  artifactReference,
  formatOffice,
  makeError,
  makeOfficeResultSchema,
  makeProvenance,
  mapRuntimeError,
  SourceInput,
  truncateSummary,
} from "./document-common"
import * as Tool from "./tool"

type OfficeFormat = "docx" | "pptx" | "xlsx"

type Metadata<Name extends "docx_read" | "pptx_read" | "spreadsheet_read"> = {
  readonly result: ReturnType<typeof makeOfficeResultSchema<Name>>["Type"]
  readonly projection: IndustrialProjection.Output
  readonly truncated: boolean
}

function makeOfficeTool<const ID extends "docx_read" | "pptx_read" | "spreadsheet_read">(
  id: ID,
  format: OfficeFormat,
  description: string,
) {
  type ResultSchema = ReturnType<typeof makeOfficeResultSchema<ID>>
  type Checked = ResultSchema["Type"]

  return Tool.define<
    typeof SourceInput,
    Metadata<ID>,
    ArtifactInput.Service | IndustrialExecution.Service | DocumentRuntime.Service
  >(
    id,
    Effect.gen(function* () {
      const execution = yield* IndustrialExecution.Service
      const runtime = yield* DocumentRuntime.Service
      const artifactInput = yield* ArtifactInput.Service

      return {
        description,
        parameters: SourceInput,
        execute: (params, context) =>
          Effect.gen(function* () {
            const resolved = yield* artifactInput.resolve({
              source: params.source,
              provenance: makeProvenance(context, id),
              context,
            })
            const result = yield* execution.execute({
              tool: id,
              permission: "document_read",
              engine: DocumentEngine.OfficeReadEngine,
              input: params,
              inputSchema: SourceInput,
              inputSummary: IndustrialInput.summarize([params.source]),
              sourceArtifactIDs: [resolved.artifact.id],
              resultSchema: makeOfficeResultSchema(id),
              context,
              permissionRequest: { patterns: ["*"], always: ["*"], metadata: {} },
              operation: () =>
                runtime.readOffice({ inputPath: resolved.snapshotPath, format }).pipe(
                  Effect.map((read) => ({
                    tool: id,
                    contractVersion: 1 as const,
                    engine: DocumentEngine.OfficeReadEngine,
                    status: "success" as const,
                    cancelled: false as const,
                    timedOut: false as const,
                    sources: [artifactReference(resolved.artifact)],
                    outputs: [],
                    citations: [],
                    producerTruncated: false,
                    summary: truncateSummary(formatOffice(read)),
                    data: {
                      sections: read.sections,
                      title: read.title,
                      author: read.author,
                    },
                  })),
                  Effect.catch((error: DocumentRuntime.RuntimeError) =>
                    Effect.succeed(
                      makeError(
                        id,
                        DocumentEngine.OfficeReadEngine,
                        mapRuntimeError(error),
                        `Office read failed: ${error.code}`,
                      ) as Checked,
                    ),
                  ),
                ),
              mapError: mapRuntimeError,
              makeError: (code) =>
                makeError(
                  id,
                  DocumentEngine.OfficeReadEngine,
                  code,
                  `Office read failed: ${code}`,
                ) as Checked,
            })

            return {
              title: result.result.status === "success" ? result.result.data.title ?? id : id,
              output: result.projection.text,
              metadata: {
                result: result.result,
                projection: result.projection,
                truncated: result.projection.truncated,
              },
            }
          }).pipe(Effect.scoped, Effect.orDie),
      }
    }),
  )
}

export const DocxReadTool = makeOfficeTool(
  "docx_read",
  "docx",
  "Reads the text content of a Microsoft Word document (.docx).",
)

export const PptxReadTool = makeOfficeTool(
  "pptx_read",
  "pptx",
  "Reads slide text and notes from a Microsoft PowerPoint presentation (.pptx).",
)

export const SpreadsheetReadTool = makeOfficeTool(
  "spreadsheet_read",
  "xlsx",
  "Reads cells from a Microsoft Excel spreadsheet (.xlsx) and returns their tabular text.",
)
