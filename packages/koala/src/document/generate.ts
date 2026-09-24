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

export const DocxCreate = {
  Input: Schema.Struct({ contents: DocxContent }).annotate({ identifier: "DocumentGenerate.DocxCreate.Input" }),
  Result: IndustrialResult.make("docx_create", Schema.Struct({ artifact: Artifact.Reference })).annotate({
    identifier: "DocumentGenerate.DocxCreate.Result",
  }),
}

export const PptxCreate = {
  Input: Schema.Struct({ contents: PptxContent }).annotate({ identifier: "DocumentGenerate.PptxCreate.Input" }),
  Result: IndustrialResult.make("pptx_create", Schema.Struct({ artifact: Artifact.Reference })).annotate({
    identifier: "DocumentGenerate.PptxCreate.Result",
  }),
}

export const SpreadsheetWrite = {
  Input: Schema.Struct({ contents: XlsxContent }).annotate({
    identifier: "DocumentGenerate.SpreadsheetWrite.Input",
  }),
  Result: IndustrialResult.make("spreadsheet_write", Schema.Struct({ artifact: Artifact.Reference })).annotate({
    identifier: "DocumentGenerate.SpreadsheetWrite.Result",
  }),
}

export const PdfCreate = {
  Input: Schema.Struct({ contents: PdfContent }).annotate({ identifier: "DocumentGenerate.PdfCreate.Input" }),
  Result: IndustrialResult.make("pdf_create", Schema.Struct({ artifact: Artifact.Reference })).annotate({
    identifier: "DocumentGenerate.PdfCreate.Result",
  }),
}

/** Worker-side content schema for each generated format. */
export const ContentInput = {
  docx: DocxCreate.Input,
  pptx: PptxCreate.Input,
  xlsx: SpreadsheetWrite.Input,
  pdf: PdfCreate.Input,
} as const
