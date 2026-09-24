export * as DocumentEngine from "./engine"

import { Schema } from "effect"
import { IndustrialTool } from "../industrial/tool"

export const PdfReadEngine = Schema.decodeUnknownSync(IndustrialTool.Engine)({
  name: "pdfjs",
  version: "1",
})

export const OcrEngine = Schema.decodeUnknownSync(IndustrialTool.Engine)({
  name: "tesseract",
  version: "5.5.3",
})

export const OfficeReadEngine = Schema.decodeUnknownSync(IndustrialTool.Engine)({
  name: "pure-js-office",
  version: "1",
})

export const DocxCreateEngine = Schema.decodeUnknownSync(IndustrialTool.Engine)({
  name: "docx-writer",
  version: "1",
})

export const PptxCreateEngine = Schema.decodeUnknownSync(IndustrialTool.Engine)({
  name: "pptx-writer",
  version: "1",
})

export const XlsxCreateEngine = Schema.decodeUnknownSync(IndustrialTool.Engine)({
  name: "xlsx-writer",
  version: "1",
})

export const PdfCreateEngine = Schema.decodeUnknownSync(IndustrialTool.Engine)({
  name: "pdf-writer",
  version: "1",
})

export const VisionEngine = Schema.decodeUnknownSync(IndustrialTool.Engine)({
  name: "local-vision-model",
  version: "1",
})

export const ValidationEngine = Schema.decodeUnknownSync(IndustrialTool.Engine)({
  name: "ooxml-validator",
  version: "1",
})

export const KnowledgeEngine = Schema.decodeUnknownSync(IndustrialTool.Engine)({
  name: "local-knowledge-store",
  version: "1",
})
