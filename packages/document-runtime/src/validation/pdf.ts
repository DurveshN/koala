import { PDFDocument } from "pdf-lib"
import { RuntimeFailure } from "../error.ts"

// Names that introduce script, launch, remote, or embedded-file behaviour; Koala never emits them.
const ForbiddenNames = ["/JavaScript", "/JS", "/Launch", "/OpenAction", "/AA", "/EmbeddedFile", "/RichMedia", "/GoToR", "/URI"]

export interface PdfValidationResult {
  readonly pageCount: number
}

export async function validatePdf(bytes: Uint8Array, expectedBytes?: number): Promise<PdfValidationResult> {
  if (expectedBytes !== undefined && bytes.byteLength !== expectedBytes) {
    throw new RuntimeFailure("invalid-request", "input")
  }
  const text = Buffer.from(bytes).toString("latin1")
  if (!text.startsWith("%PDF-1.") || !text.trimEnd().endsWith("%%EOF")) {
    throw new RuntimeFailure("pdf-generation-failed", "worker")
  }
  if (ForbiddenNames.some((name) => new RegExp(`${name.replace("/", "\\/")}(?![A-Za-z])`).test(text))) {
    throw new RuntimeFailure("pdf-generation-failed", "worker")
  }
  const document = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: true }).catch(() => {
    throw new RuntimeFailure("pdf-generation-failed", "worker")
  })
  if (document.isEncrypted || document.getPageCount() === 0) {
    throw new RuntimeFailure("pdf-generation-failed", "worker")
  }
  return { pageCount: document.getPageCount() }
}
