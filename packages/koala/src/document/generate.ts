export * as DocumentGenerate from "./generate"

import { Schema } from "effect"
import { Artifact } from "../artifact/artifact"
import { IndustrialResult } from "../industrial/result"

export const Format = Schema.Literals(["docx", "pptx", "xlsx", "pdf"])
export type Format = typeof Format.Type

const Rows = Schema.Array(Schema.Array(Schema.String))

const Section = Schema.Struct({
  type: Schema.Literals(["heading", "paragraph", "table", "page-break"]),
  text: Schema.optionalKey(Schema.String),
  level: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  rows: Schema.optionalKey(Rows),
})

export const DocxContent = Schema.Struct({
  title: Schema.optionalKey(Schema.String),
  author: Schema.optionalKey(Schema.String),
  sections: Schema.Array(Section),
}).annotate({ identifier: "DocumentGenerate.DocxContent" })

// The same section model produces paginated PDF deliverables.
export const PdfContent = Schema.Struct({
  title: Schema.optionalKey(Schema.String),
  author: Schema.optionalKey(Schema.String),
  sections: Schema.Array(Section),
}).annotate({ identifier: "DocumentGenerate.PdfContent" })

export const PptxContent = Schema.Struct({
  title: Schema.optionalKey(Schema.String),
  author: Schema.optionalKey(Schema.String),
  slides: Schema.Array(
    Schema.Struct({
      title: Schema.optionalKey(Schema.String),
      subtitle: Schema.optionalKey(Schema.String),
      bullets: Schema.optionalKey(Schema.Array(Schema.String)),
      paragraphs: Schema.optionalKey(Schema.Array(Schema.String)),
      table: Schema.optionalKey(Rows),
      notes: Schema.optionalKey(Schema.String),
    }),
  ).check(Schema.isMinLength(1)),
}).annotate({ identifier: "DocumentGenerate.PptxContent" })

export const CellValue = Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null])

export const XlsxContent = Schema.Struct({
  title: Schema.optionalKey(Schema.String),
  author: Schema.optionalKey(Schema.String),
  sheets: Schema.Array(
    Schema.Struct({
      name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(31), Schema.isPattern(/^[^\\/?*[\]:]+$/)),
      header: Schema.optionalKey(Schema.Array(Schema.String)),
      rows: Schema.Array(Schema.Array(CellValue)),
      columnWidths: Schema.optionalKey(Schema.Array(Schema.Int.check(Schema.isGreaterThan(0)))),
    }),
  ).check(Schema.isMinLength(1)),
}).annotate({ identifier: "DocumentGenerate.XlsxContent" })

/** Worker-side content schema for each generated format; the confined worker never sees the path. */
export const ContentInput = {
  docx: Schema.Struct({ contents: DocxContent }),
  pptx: Schema.Struct({ contents: PptxContent }),
  xlsx: Schema.Struct({ contents: XlsxContent }),
  pdf: Schema.Struct({ contents: PdfContent }),
} as const

function deliverablePath(format: Format) {
  return Schema.String.annotate({
    description: `Project-relative path for the finished file using forward slashes, for example "deliverables/approval-note.${format}". The file is saved inside the current project at this path and overwrites an existing file with the same name.`,
  })
}

// Deliverables record where they were saved so callers can hand the user a real file path.
const Delivered = Schema.Struct({ artifact: Artifact.Reference, path: Schema.String })

export const DocxCreate = {
  Input: Schema.Struct({ path: deliverablePath("docx"), contents: DocxContent }).annotate({
    identifier: "DocumentGenerate.DocxCreate.Input",
  }),
  Result: IndustrialResult.make("docx_create", Delivered).annotate({
    identifier: "DocumentGenerate.DocxCreate.Result",
  }),
}

export const PptxCreate = {
  Input: Schema.Struct({ path: deliverablePath("pptx"), contents: PptxContent }).annotate({
    identifier: "DocumentGenerate.PptxCreate.Input",
  }),
  Result: IndustrialResult.make("pptx_create", Delivered).annotate({
    identifier: "DocumentGenerate.PptxCreate.Result",
  }),
}

export const SpreadsheetWrite = {
  Input: Schema.Struct({ path: deliverablePath("xlsx"), contents: XlsxContent }).annotate({
    identifier: "DocumentGenerate.SpreadsheetWrite.Input",
  }),
  Result: IndustrialResult.make("spreadsheet_write", Delivered).annotate({
    identifier: "DocumentGenerate.SpreadsheetWrite.Result",
  }),
}

export const PdfCreate = {
  Input: Schema.Struct({ path: deliverablePath("pdf"), contents: PdfContent }).annotate({
    identifier: "DocumentGenerate.PdfCreate.Input",
  }),
  Result: IndustrialResult.make("pdf_create", Delivered).annotate({
    identifier: "DocumentGenerate.PdfCreate.Result",
  }),
}
