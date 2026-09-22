import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Artifact } from "../artifact/artifact"
import { DocumentEngine } from "./engine"
import { DocumentNormalized } from "./normalized"
import { DocumentTool } from "./tool"

const artifactIDString = "art_123e4567-e89b-42d3-a456-426614174000"
const digestString = "0123456789abcdef".repeat(4)

const reference = {
  id: Schema.decodeUnknownSync(Artifact.ID)(artifactIDString),
  name: Schema.decodeUnknownSync(Artifact.Name)("report.pdf"),
  mime: Schema.decodeUnknownSync(Artifact.MimeType)("application/pdf"),
  size: Schema.decodeUnknownSync(Artifact.ByteSize)(1024),
  digest: Schema.decodeUnknownSync(Artifact.Digest)(digestString),
}

const source = { artifactID: reference.id }

const common = {
  contractVersion: 1 as const,
  engine: DocumentEngine.PdfReadEngine,
  sources: [reference],
  outputs: [],
  citations: [],
  producerTruncated: false,
  summary: "done",
}

const makeBounds = (left: number, top: number, right: number, bottom: number) => ({
  left,
  top,
  right,
  bottom,
})

const makeOcrLine = () =>
  Schema.decodeUnknownSync(DocumentNormalized.OcrLine)({
    text: "hello",
    words: [
      {
        text: "hello",
        confidence: 0.9,
        bounds: makeBounds(0.1, 0.1, 0.2, 0.2),
        locator: { type: "artifact", artifactID: artifactIDString },
      },
    ],
    bounds: makeBounds(0.1, 0.1, 0.2, 0.2),
  })

const makeNormalizedDocument = () =>
  Schema.decodeUnknownSync(DocumentNormalized.NormalizedDocument)({
    source: { type: "artifact", artifactID: artifactIDString },
    pages: [
      {
        pageNumber: 1,
        dimensions: { width: 612, height: 792 },
        textBlocks: [{ paragraphs: ["Hello"], lines: [] }],
        ocrLines: [],
        imageRegions: [],
        visualObservations: [],
      },
    ],
    sections: [{ type: "document", body: "Hello world" }],
    metadata: { pageCount: 1 },
    truncated: false,
  })

const makeObservation = () =>
  Schema.decodeUnknownSync(DocumentNormalized.VisualObservation)({
    description: "A logo",
    locator: { type: "artifact", artifactID: artifactIDString },
  })

describe("DocumentTool.PdfRead", () => {
  const decodeInput = Schema.decodeUnknownSync(DocumentTool.PdfRead.Input)
  const decodeResult = Schema.decodeUnknownSync(DocumentTool.PdfRead.Result)

  test("round trips input with optional page range", () => {
    expect(decodeInput({ source })).toEqual({ source })
    expect(decodeInput({ source, pages: { startPage: 1, pageCount: 5 } })).toEqual({
      source,
      pages: { startPage: 1, pageCount: 5 },
    })
  })

  test("accepts success, error, cancelled, and timeout result variants", () => {
    const data = { normalized: makeNormalizedDocument() }
    expect(() =>
      decodeResult({
        ...common,
        tool: "pdf_read" as const,
        status: "success" as const,
        cancelled: false as const,
        timedOut: false as const,
        data,
      }),
    ).not.toThrow()
    expect(() =>
      decodeResult({
        ...common,
        tool: "pdf_read" as const,
        status: "error" as const,
        cancelled: false as const,
        timedOut: false as const,
        error: { code: "engine-failed" as const, retryable: false },
      }),
    ).not.toThrow()
    expect(() =>
      decodeResult({
        ...common,
        tool: "pdf_read" as const,
        status: "error" as const,
        cancelled: true as const,
        timedOut: false as const,
        error: { code: "cancelled" as const, retryable: true as const },
      }),
    ).not.toThrow()
    expect(() =>
      decodeResult({
        ...common,
        tool: "pdf_read" as const,
        status: "error" as const,
        cancelled: false as const,
        timedOut: true as const,
        error: { code: "deadline-exceeded" as const, retryable: true as const },
      }),
    ).not.toThrow()
  })

  test("rejects a mismatched tool name", () => {
    expect(() =>
      decodeResult({
        ...common,
        tool: "ocr_extract" as const,
        status: "success" as const,
        cancelled: false as const,
        timedOut: false as const,
        data: { normalized: makeNormalizedDocument() },
      }),
    ).toThrow()
  })

  test("rejects inconsistent success state", () => {
    expect(() =>
      decodeResult({
        ...common,
        tool: "pdf_read" as const,
        status: "success" as const,
        cancelled: true as const,
        timedOut: false as const,
        data: { normalized: makeNormalizedDocument() },
      }),
    ).toThrow()
  })

  test("rejects an invalid source", () => {
    expect(() => decodeInput({ source: { artifactID: reference.id, path: "report.pdf" } })).toThrow()
  })
})

describe("DocumentTool.OcrExtract", () => {
  const decodeInput = Schema.decodeUnknownSync(DocumentTool.OcrExtract.Input)
  const decodeResult = Schema.decodeUnknownSync(DocumentTool.OcrExtract.Result)

  test("round trips input", () => {
    expect(decodeInput({ source })).toEqual({ source })
    expect(decodeInput({ source, page: 1 })).toEqual({ source, page: 1 })
  })

  test("accepts a valid result", () => {
    const data = {
      pages: [
        {
          page: 1,
          dimensions: { width: 612, height: 792 },
          lines: [makeOcrLine()],
        },
      ],
    }
    expect(() =>
      decodeResult({
        ...common,
        tool: "ocr_extract" as const,
        status: "success" as const,
        cancelled: false as const,
        timedOut: false as const,
        data,
      }),
    ).not.toThrow()
  })

  test("rejects an out-of-range coordinate inside result data", () => {
    const data = {
      pages: [
        {
          page: 1,
          dimensions: { width: 612, height: 792 },
          lines: [
            {
              text: "bad",
              words: [],
              bounds: makeBounds(0, 0, 1, 2),
            },
          ],
        },
      ],
    }
    expect(() =>
      decodeResult({
        ...common,
        tool: "ocr_extract" as const,
        status: "success" as const,
        cancelled: false as const,
        timedOut: false as const,
        data,
      }),
    ).toThrow()
  })
})

describe("DocumentTool.VisionAnalyze", () => {
  const decodeInput = Schema.decodeUnknownSync(DocumentTool.VisionAnalyze.Input)
  const decodeResult = Schema.decodeUnknownSync(DocumentTool.VisionAnalyze.Result)

  test("round trips input with optional prompt", () => {
    expect(decodeInput({ source })).toEqual({ source })
    expect(decodeInput({ source, prompt: "describe this" })).toEqual({ source, prompt: "describe this" })
  })

  test("accepts a valid result", () => {
    const data = { observations: [makeObservation()] }
    expect(() =>
      decodeResult({
        ...common,
        tool: "vision_analyze" as const,
        status: "success" as const,
        cancelled: false as const,
        timedOut: false as const,
        data,
      }),
    ).not.toThrow()
  })
})

describe("DocumentTool.DocumentExtract", () => {
  const decodeInput = Schema.decodeUnknownSync(DocumentTool.DocumentExtract.Input)
  const decodeResult = Schema.decodeUnknownSync(DocumentTool.DocumentExtract.Result)

  test("round trips input with optional flags", () => {
    expect(decodeInput({ source })).toEqual({ source })
    expect(decodeInput({ source, includeOcr: true, includeVision: false, prompt: "summarize" })).toEqual({
      source,
      includeOcr: true,
      includeVision: false,
      prompt: "summarize",
    })
  })

  test("accepts a valid result", () => {
    const data = { normalized: makeNormalizedDocument() }
    expect(() =>
      decodeResult({
        ...common,
        tool: "document_extract" as const,
        status: "success" as const,
        cancelled: false as const,
        timedOut: false as const,
        data,
      }),
    ).not.toThrow()
  })
})
