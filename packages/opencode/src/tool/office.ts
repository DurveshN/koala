import { DocumentRuntime } from "@/document/runtime"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"

export const DocxParameters = Schema.Struct({
  path: Schema.String.annotate({ description: "Absolute path to the .docx file" }),
})

export const PptxParameters = Schema.Struct({
  path: Schema.String.annotate({ description: "Absolute path to the .pptx file" }),
})

export const SpreadsheetParameters = Schema.Struct({
  path: Schema.String.annotate({ description: "Absolute path to the .xlsx file" }),
})

function formatOffice(result: DocumentRuntime.ReadOfficeResult) {
  const parts: string[] = []
  if (result.title) parts.push(`# ${result.title}`)
  if (result.author) parts.push(`Author: ${result.author}`)
  let previousHeading: string | undefined
  for (const section of result.sections) {
    if (section.heading && section.heading !== previousHeading) {
      parts.push(`## ${section.heading}`)
      previousHeading = section.heading
    }
    if (section.body) parts.push(section.body)
  }
  return parts.join("\n\n")
}

function readOfficeTool(
  id: string,
  parameters: typeof DocxParameters,
  format: "docx" | "pptx" | "xlsx",
  description: string,
) {
  return Tool.define(
    id,
    Effect.gen(function* () {
      const runtime = yield* DocumentRuntime.Service
      return {
        description,
        parameters,
        execute: (params: Schema.Schema.Type<typeof parameters>, ctx: Tool.Context) =>
          Effect.gen(function* () {
            yield* ctx.ask({
              permission: "read",
              patterns: [params.path],
              always: [params.path],
              metadata: { path: params.path },
            })
            const result = yield* runtime.readOffice({ inputPath: params.path, format }).pipe(Effect.orDie)
            return {
              title: result.title ?? params.path,
              output: formatOffice(result),
              metadata: {
                path: params.path,
                sections: result.sections.length,
                author: result.author,
              },
            }
          }),
      }
    }),
  )
}

export const DocxReadTool = readOfficeTool(
  "docx_read",
  DocxParameters,
  "docx",
  "Reads the text content of a Microsoft Word document (.docx).",
)

export const PptxReadTool = readOfficeTool(
  "pptx_read",
  PptxParameters,
  "pptx",
  "Reads slide text and notes from a Microsoft PowerPoint presentation (.pptx).",
)

export const SpreadsheetReadTool = readOfficeTool(
  "spreadsheet_read",
  SpreadsheetParameters,
  "xlsx",
  "Reads cells from a Microsoft Excel spreadsheet (.xlsx) and returns their tabular text.",
)
