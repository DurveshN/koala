import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { DocumentRuntimeLimits } from "./limits"
import { DocumentRuntimeProtocol } from "./protocol"

const jobID = "job_123e4567-e89b-42d3-a456-426614174000"
const otherJobID = "job_223e4567-e89b-42d3-a456-426614174000"
const pageID = "page_123e4567-e89b-42d3-a456-426614174000"
const resultID = "ocr_123e4567-e89b-42d3-a456-426614174000"
const hash = "0123456789abcdef".repeat(4)
const limits = DocumentRuntimeLimits.requestedHard

const render = () => ({
  protocolVersion: 1 as const,
  type: "render" as const,
  jobID,
  inputPath: "input/source.pdf",
  inputBytes: 1024,
  startPage: 1,
  pageCount: 1,
  limits,
})

const ocr = () => ({
  protocolVersion: 1 as const,
  type: "ocr" as const,
  jobID,
  page: 1,
  pageID,
  source: { kind: "rendered-page" as const },
  limits,
})

const pageReady = () => ({
  protocolVersion: 1 as const,
  type: "page-ready" as const,
  jobID,
  page: 1,
  pageID,
  outputPath: "pages/page-1.png",
  dimensions: { width: 2_000, height: 3_000 },
  pngBytes: 1024,
  temporaryBytes: 1024,
})

describe("DocumentRuntimeProtocol schemas", () => {
  const decodeRequest = Schema.decodeUnknownSync(DocumentRuntimeProtocol.WorkerRequest)
  const encodeRequest = Schema.encodeSync(DocumentRuntimeProtocol.WorkerRequest)
  const decodeEvent = Schema.decodeUnknownSync(DocumentRuntimeProtocol.WorkerEvent)
  const encodeEvent = Schema.encodeSync(DocumentRuntimeProtocol.WorkerEvent)

  test.each([
    { protocolVersion: 1, type: "probe", jobID, target: "x86_64-unknown-linux-gnu", manifestSha256: hash },
    render(),
    ocr(),
    {
      protocolVersion: 1,
      type: "ocr",
      jobID,
      page: 1,
      pageID,
      source: { kind: "image", inputPath: "input/scan.png", inputBytes: 1024, dimensions: { width: 100, height: 100 } },
      limits,
    },
    { protocolVersion: 1, type: "release-page", jobID, page: 1, pageID },
    { protocolVersion: 1, type: "cancel", jobID },
  ] as const)("round trips the $type request", (request) => {
    expect(encodeRequest(decodeRequest(request))).toEqual(request)
  })

  test.each([
    { protocolVersion: 1, type: "started", jobID, operation: "render" },
    pageReady(),
    {
      protocolVersion: 1,
      type: "ocr-result",
      jobID,
      page: 1,
      pageID,
      resultID,
      outputPath: "ocr/page-1.tsv",
      tsvBytes: 512,
      temporaryBytes: 1536,
    },
    { protocolVersion: 1, type: "completed", jobID, operation: "render", pagesProcessed: 1, temporaryBytes: 0 },
    { protocolVersion: 1, type: "cancelled", jobID },
    { protocolVersion: 1, type: "failure", jobID, code: "render-failed", stage: "render", retryable: false },
  ] as const)("round trips the $type event", (event) => {
    expect(encodeEvent(decodeEvent(event))).toEqual(event)
  })

  test.each([
    { ...render(), jobID: "job-loose" },
    { ...render(), protocolVersion: 2 },
    { ...render(), startPage: 0 },
    { ...render(), pageCount: 101 },
    { ...render(), inputPath: "../source.pdf" },
    { ...render(), inputBytes: DocumentRuntimeLimits.MaxPdfInputBytes + 1 },
    { ...render(), limits: { ...limits, pages: 1 }, pageCount: 2 },
    {
      ...ocr(),
      source: {
        kind: "image",
        inputPath: "input/scan.png",
        inputBytes: DocumentRuntimeLimits.MaxImageInputBytes + 1,
        dimensions: { width: 100, height: 100 },
      },
    },
    {
      ...ocr(),
      source: {
        kind: "image",
        inputPath: "input/scan.png",
        inputBytes: 1,
        dimensions: { width: 5_001, height: 5_000 },
      },
    },
  ])("rejects invalid request %#", (request) => {
    expect(() => decodeRequest(request)).toThrow()
  })

  test.each([
    { ...pageReady(), page: 0 },
    { ...pageReady(), outputPath: undefined },
    { ...pageReady(), dimensions: { width: 10_001, height: 1 } },
    { ...pageReady(), dimensions: { width: 5_001, height: 5_000 } },
    { ...pageReady(), pngBytes: DocumentRuntimeLimits.MaxPngBytesPerPage + 1 },
    { ...pageReady(), temporaryBytes: DocumentRuntimeLimits.MaxTemporaryBytes + 1 },
    {
      protocolVersion: 1,
      type: "ocr-result",
      jobID,
      page: 1,
      pageID,
      resultID,
      outputPath: "ocr/page-1.tsv",
      tsvBytes: DocumentRuntimeLimits.MaxTsvBytesPerPage + 1,
      temporaryBytes: 1,
    },
    {
      protocolVersion: 1,
      type: "ocr-result",
      jobID,
      page: 1,
      pageID,
      resultID,
      tsvBytes: 1,
      temporaryBytes: 1,
    },
  ])("rejects invalid event %#", (event) => {
    expect(() => decodeEvent(event)).toThrow()
  })

  test("strips raw failure causes and paths", () => {
    const failure = decodeEvent({
      protocolVersion: 1,
      type: "failure",
      jobID,
      code: "worker-failed",
      stage: "worker",
      retryable: false,
      cause: { secret: "credential-canary" },
      path: "C:\\private\\source.pdf",
      stderr: "native-canary",
    })
    const encoded = encodeEvent(failure)
    expect(encoded).toEqual({
      protocolVersion: 1,
      type: "failure",
      jobID,
      code: "worker-failed",
      stage: "worker",
      retryable: false,
    })
    expect(JSON.stringify(encoded)).not.toContain("canary")
    expect(JSON.stringify(encoded)).not.toContain("private")
  })
})

describe("DocumentRuntimeProtocol ordering", () => {
  const request = Schema.decodeUnknownSync(DocumentRuntimeProtocol.RenderRequest)(render())
  const event = Schema.decodeUnknownSync(DocumentRuntimeProtocol.WorkerEvent)
  const command = Schema.decodeUnknownSync(DocumentRuntimeProtocol.WorkerRequest)

  test("accepts one-page render, OCR, release, and terminal order", () => {
    const messages = [
      event({ protocolVersion: 1, type: "started", jobID, operation: "render" }),
      event(pageReady()),
      command(ocr()),
      event({
        protocolVersion: 1,
        type: "ocr-result",
        jobID,
        page: 1,
        pageID,
        resultID,
        outputPath: "ocr/page-1.tsv",
        tsvBytes: 512,
        temporaryBytes: 1536,
      }),
      command({ protocolVersion: 1, type: "release-page", jobID, page: 1, pageID }),
      event({
        protocolVersion: 1,
        type: "completed",
        jobID,
        operation: "render",
        pagesProcessed: 1,
        temporaryBytes: 0,
      }),
    ]
    const final = messages.reduce(
      (result, message) => {
        if (!result.ok) return result
        return DocumentRuntimeProtocol.advanceOrder(result.state, message)
      },
      { ok: true, state: DocumentRuntimeProtocol.beginOrder(request) } as DocumentRuntimeProtocol.OrderResult,
    )

    expect(final).toEqual({
      ok: true,
      state: expect.objectContaining({ phase: "terminal", operation: "render", jobID }),
    })
  })

  test("rejects skipped start, wrong jobs, duplicate pages, early completion, and repeated terminal events", () => {
    const initial = DocumentRuntimeProtocol.beginOrder(request)
    expect(DocumentRuntimeProtocol.advanceOrder(initial, event(pageReady()))).toEqual({
      ok: false,
      code: "invalid-order",
    })
    expect(
      DocumentRuntimeProtocol.advanceOrder(
        initial,
        event({ protocolVersion: 1, type: "started", jobID: otherJobID, operation: "render" }),
      ),
    ).toEqual({ ok: false, code: "job-mismatch" })

    const started = DocumentRuntimeProtocol.advanceOrder(
      initial,
      event({ protocolVersion: 1, type: "started", jobID, operation: "render" }),
    )
    if (!started.ok) throw new Error(started.code)
    const ready = DocumentRuntimeProtocol.advanceOrder(started.state, event(pageReady()))
    if (!ready.ok) throw new Error(ready.code)
    expect(DocumentRuntimeProtocol.advanceOrder(ready.state, event(pageReady()))).toEqual({
      ok: false,
      code: "invalid-order",
    })
    expect(
      DocumentRuntimeProtocol.advanceOrder(
        ready.state,
        event({
          protocolVersion: 1,
          type: "completed",
          jobID,
          operation: "render",
          pagesProcessed: 1,
          temporaryBytes: 0,
        }),
      ),
    ).toEqual({ ok: false, code: "invalid-order" })
  })

  test("requires cancellation before a cancelled terminal event", () => {
    const initial = DocumentRuntimeProtocol.beginOrder(request)
    const cancelled = event({ protocolVersion: 1, type: "cancelled", jobID })
    expect(DocumentRuntimeProtocol.advanceOrder(initial, cancelled)).toEqual({ ok: false, code: "invalid-order" })
    const cancelling = DocumentRuntimeProtocol.advanceOrder(
      initial,
      command({ protocolVersion: 1, type: "cancel", jobID }),
    )
    if (!cancelling.ok) throw new Error(cancelling.code)
    const terminal = DocumentRuntimeProtocol.advanceOrder(cancelling.state, cancelled)
    expect(terminal).toEqual({ ok: true, state: expect.objectContaining({ phase: "terminal" }) })
    if (!terminal.ok) throw new Error(terminal.code)
    expect(DocumentRuntimeProtocol.advanceOrder(terminal.state, cancelled)).toEqual({
      ok: false,
      code: "invalid-order",
    })
  })
})
