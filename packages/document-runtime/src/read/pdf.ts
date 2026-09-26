import { DocumentRuntimeLimits } from "@koala-ai/core/document-runtime/limits"
import type { TextItem } from "pdfjs-dist/types/src/display/api.js"
import { RuntimeFailure } from "../error.ts"
import { openPdf, readPdfBytes, type PdfAssets } from "../render.ts"

export interface PdfTextBlock {
  readonly text: string
}

export interface PdfPage {
  readonly number: number
  readonly rotation: number
  readonly mediaBox: ReadonlyArray<number>
  readonly blocks: ReadonlyArray<PdfTextBlock>
}

export interface PdfOutput {
  readonly title?: string
  readonly author?: string
  readonly subject?: string
  readonly creator?: string
  readonly producer?: string
  readonly creationDate?: string
  readonly modDate?: string
  readonly pageCount: number
  readonly pages: ReadonlyArray<PdfPage>
}

export interface ReadPdfOptions {
  readonly assets: PdfAssets
  readonly limits: DocumentRuntimeLimits.Requested
  readonly signal: AbortSignal
}

export async function readPdf(inputPath: string, declaredBytes: number, options: ReadPdfOptions): Promise<Uint8Array> {
  options.signal.throwIfAborted()
  const bytes = await readPdfBytes(inputPath, declaredBytes, options.limits.pdfInputBytes)
  const pdf = await openPdf({
    bytes,
    assets: options.assets,
    limits: options.limits,
    signal: options.signal,
  })
  try {
    const metadata = await pdf.document.getMetadata().catch(() => undefined)
    const info = metadata && typeof metadata === "object" ? ((metadata as unknown as { info?: Record<string, unknown> }).info ?? {}) : {}
    const pages: PdfPage[] = []
    const maxPages = Math.min(pdf.document.numPages, options.limits.pages)
    for (let pageNumber = 1; pageNumber <= maxPages; pageNumber++) {
      options.signal.throwIfAborted()
      const page = await pdf.document.getPage(pageNumber).catch(() => {
        throw new RuntimeFailure("render-failed", "render")
      })
      try {
        const content = await page.getTextContent().catch(() => {
          throw new RuntimeFailure("render-failed", "render")
        })
        const items = content.items
          .map((item) => (item as TextItem).str)
          .filter((value): value is string => typeof value === "string")
        const text = items.join(" ").replace(/\s+/g, " ").trim()
        pages.push({
          number: pageNumber,
          rotation: page.rotate,
          mediaBox: Array.from(page.view),
          blocks: [{ text }],
        })
      } finally {
        page.cleanup()
      }
    }
    if (pdf.document.numPages > options.limits.pages) {
      throw new RuntimeFailure("page-limit-exceeded", "render")
    }
    const output: PdfOutput = {
      title: stringField(info.Title),
      author: stringField(info.Author),
      subject: stringField(info.Subject),
      creator: stringField(info.Creator),
      producer: stringField(info.Producer),
      creationDate: stringField(info.CreationDate),
      modDate: stringField(info.ModDate),
      pageCount: pdf.document.numPages,
      pages,
    }
    const encoded = Buffer.from(JSON.stringify(output), "utf8")
    if (encoded.byteLength > DocumentRuntimeLimits.MaxOfficeOutputBytes) {
      throw new RuntimeFailure("pdf-output-limit-exceeded", "worker")
    }
    return encoded
  } finally {
    await pdf.close()
  }
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}
