export * as DocumentTool from "./tool"

import { Schema } from "effect"
import { IndustrialInput } from "../industrial/input"
import { IndustrialResult } from "../industrial/result"
import { DocumentNormalized } from "./normalized"

const PageRange = Schema.Struct({
  startPage: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  pageCount: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
}).annotate({ identifier: "DocumentTool.PageRange" })

export const PdfRead = {
  Input: Schema.Struct({
    source: IndustrialInput.Source,
    pages: Schema.optionalKey(PageRange),
  }).annotate({ identifier: "DocumentTool.PdfRead.Input" }),
  Result: IndustrialResult.make(
    "pdf_read",
    Schema.Struct({
      normalized: DocumentNormalized.NormalizedDocument,
    }).annotate({ identifier: "DocumentTool.PdfRead.Data" }),
  ),
}
export type PdfReadInput = typeof PdfRead.Input.Type
export type PdfReadResult = typeof PdfRead.Result.Type

export const OcrExtract = {
  Input: Schema.Struct({
    source: IndustrialInput.Source,
    page: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
    pages: Schema.optionalKey(PageRange),
  }).annotate({ identifier: "DocumentTool.OcrExtract.Input" }),
  Result: IndustrialResult.make(
    "ocr_extract",
    Schema.Struct({
      pages: Schema.Array(
        Schema.Struct({
          page: Schema.Int.check(Schema.isGreaterThan(0)),
          dimensions: DocumentNormalized.Dimensions,
          lines: Schema.Array(DocumentNormalized.OcrLine),
        }).annotate({ identifier: "DocumentTool.OcrExtract.Page" }),
      ),
    }).annotate({ identifier: "DocumentTool.OcrExtract.Data" }),
  ),
}
export type OcrExtractInput = typeof OcrExtract.Input.Type
export type OcrExtractResult = typeof OcrExtract.Result.Type

export const VisionAnalyze = {
  Input: Schema.Struct({
    source: IndustrialInput.Source,
    prompt: Schema.optionalKey(Schema.String),
  }).annotate({ identifier: "DocumentTool.VisionAnalyze.Input" }),
  Result: IndustrialResult.make(
    "vision_analyze",
    Schema.Struct({
      observations: Schema.Array(DocumentNormalized.VisualObservation),
    }).annotate({ identifier: "DocumentTool.VisionAnalyze.Data" }),
  ),
}
export type VisionAnalyzeInput = typeof VisionAnalyze.Input.Type
export type VisionAnalyzeResult = typeof VisionAnalyze.Result.Type

export const DocumentExtract = {
  Input: Schema.Struct({
    source: IndustrialInput.Source,
    includeOcr: Schema.optionalKey(Schema.Boolean),
    includeVision: Schema.optionalKey(Schema.Boolean),
    prompt: Schema.optionalKey(Schema.String),
  }).annotate({ identifier: "DocumentTool.DocumentExtract.Input" }),
  Result: IndustrialResult.make(
    "document_extract",
    Schema.Struct({
      normalized: DocumentNormalized.NormalizedDocument,
    }).annotate({ identifier: "DocumentTool.DocumentExtract.Data" }),
  ),
}
export type DocumentExtractInput = typeof DocumentExtract.Input.Type
export type DocumentExtractResult = typeof DocumentExtract.Result.Type
