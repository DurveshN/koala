import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { DocumentRuntimeLimits } from "./limits"
import { DocumentRuntimeProtocol } from "./protocol"

const jobID = "job_123e4567-e89b-42d3-a456-426614174000"
const otherJobID = "job_223e4567-e89b-42d3-a456-426614174000"
const pageID = "page_123e4567-e89b-42d3-a456-426614174000"
const resultID = "ocr_123e4567-e89b-42d3-a456-426614174000"
const outputID = "output_123e4567-e89b-42d3-a456-426614174000"
const hash = "0123456789abcdef".repeat(4)
const limits = DocumentRuntimeLimits.requestedHard
const expectEqual = (actual: unknown, expected: unknown) => expect(actual).toEqual(expected)
const configurableLimitKeys: Array<Exclude<keyof DocumentRuntimeLimits.Requested, "dpi">> = [
  "pdfInputBytes",
  "imageInputBytes",
  "pages",
  "rasterSidePixels",
  "rasterAreaPixels",
  "pngBytesPerPage",
  "temporaryBytes",
  "tsvBytesPerPage",
  "nativeStderrBytes",
  "renderDeadlineMsPerPage",
  "ocrDeadlineMsPerPage",
  "jobDeadlineMs",
]

const probe = () => ({
  protocolVersion: 1 as const,
  type: "probe" as const,
  jobID,
  target: "x86_64-unknown-linux-gnu" as const,
  manifestSha256: hash,
})

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

const imageOcr = () => ({
  protocolVersion: 1 as const,
  type: "ocr" as const,
  jobID,
  page: 1,
  pageID,
  source: {
    kind: "image" as const,
    inputPath: "input/scan.png",
    inputBytes: 1024,
    dimensions: { width: 100, height: 100 },
  },
  limits,
})

const pageReady = () => ({
  protocolVersion: 1 as const,
  type: "page-ready" as const,
  jobID,
  page: 1,
  pageID,
  outputPath: "pages/page-1.png",
  outputID,
  outputSha256: hash,
  dimensions: { width: 2_000, height: 3_000 },
  pngBytes: 1024,
  temporaryBytes: 1024,
})

describe("DocumentRuntimeProtocol schemas", () => {
  const decodeRequest = DocumentRuntimeProtocol.decodeWorkerRequest
  const encodeRequest = Schema.encodeSync(DocumentRuntimeProtocol.WorkerRequest)
  const decodeEvent = DocumentRuntimeProtocol.decodeWorkerEvent
  const encodeEvent = Schema.encodeSync(DocumentRuntimeProtocol.WorkerEvent)

  test.each([
    probe(),
    render(),
    ocr(),
    imageOcr(),
    { protocolVersion: 1, type: "release-page", jobID, page: 1, pageID },
    { protocolVersion: 1, type: "cancel", jobID },
  ] as const)("round trips the $type request", (request) => {
    expect(encodeRequest(decodeRequest(request))).toEqual(request)
  })

  test("separates initial requests from continuation requests", () => {
    expectEqual(DocumentRuntimeProtocol.decodeInitialRequest(probe()), probe())
    expectEqual(DocumentRuntimeProtocol.decodeInitialRequest(render()), render())
    expectEqual(DocumentRuntimeProtocol.decodeInitialRequest(imageOcr()), imageOcr())
    expect(() => DocumentRuntimeProtocol.decodeInitialRequest(ocr())).toThrow()

    expectEqual(DocumentRuntimeProtocol.decodeContinuationRequest(ocr()), ocr())
    expectEqual(
      DocumentRuntimeProtocol.decodeContinuationRequest({
        protocolVersion: 1,
        type: "release-page",
        jobID,
        page: 1,
        pageID,
      }),
      { protocolVersion: 1, type: "release-page", jobID, page: 1, pageID },
    )
    expect(() => DocumentRuntimeProtocol.decodeContinuationRequest(imageOcr())).toThrow()
    expect(() => DocumentRuntimeProtocol.decodeContinuationRequest(render())).toThrow()
  })

  test("preserves rendered-page OCR in the legacy StartRequest type", () => {
    const request: DocumentRuntimeProtocol.StartRequest = Schema.decodeUnknownSync(DocumentRuntimeProtocol.OcrRequest)(
      ocr(),
    )
    expect(request.source.kind).toBe("rendered-page")
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
      outputID,
      outputSha256: hash,
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

  test.each([
    { ...render(), excess: true },
    { ...render(), limits: { ...limits, excess: true } },
    { ...imageOcr(), source: { ...imageOcr().source, excess: true } },
    {
      ...imageOcr(),
      source: { ...imageOcr().source, dimensions: { ...imageOcr().source.dimensions, excess: true } },
    },
    { ...ocr(), source: { kind: "rendered-page", excess: true } },
  ])("rejects excess request fields %#", (request) => {
    expect(() => decodeRequest(request)).toThrow()
  })

  test.each([
    { ...pageReady(), excess: true },
    { ...pageReady(), dimensions: { ...pageReady().dimensions, excess: true } },
    {
      protocolVersion: 1,
      type: "failure",
      jobID,
      code: "worker-failed",
      stage: "worker",
      retryable: false,
      cause: { secret: "credential-canary" },
    },
  ])("rejects excess event fields %#", (event) => {
    expect(() => decodeEvent(event)).toThrow()
  })
})

describe("DocumentRuntimeProtocol ordering", () => {
  const request = Schema.decodeUnknownSync(DocumentRuntimeProtocol.RenderRequest)(render())
  const event = DocumentRuntimeProtocol.decodeWorkerEvent
  const command = DocumentRuntimeProtocol.decodeWorkerRequest

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
        outputID,
        outputSha256: hash,
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
    const initial: DocumentRuntimeProtocol.OrderResult = {
      ok: true,
      state: DocumentRuntimeProtocol.beginOrder(request),
    }
    const final = messages.reduce<DocumentRuntimeProtocol.OrderResult>((result, message) => {
      if (!result.ok) return result
      return DocumentRuntimeProtocol.advanceOrder(result.state, message)
    }, initial)

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

  test.each(configurableLimitKeys)("rejects a rendered-page continuation with substituted %s", (field) => {
    const initial = DocumentRuntimeProtocol.beginOrder(request)
    const started = DocumentRuntimeProtocol.advanceOrder(
      initial,
      event({ protocolVersion: 1, type: "started", jobID, operation: "render" }),
    )
    if (!started.ok) throw new Error(started.code)
    const ready = DocumentRuntimeProtocol.advanceOrder(started.state, event(pageReady()))
    if (!ready.ok) throw new Error(ready.code)

    expect(
      DocumentRuntimeProtocol.advanceOrder(
        ready.state,
        command({
          ...ocr(),
          limits: { ...limits, [field]: limits[field] - 1 },
        }),
      ),
    ).toEqual({ ok: false, code: "invalid-order" })
  })

  test("rejects a rendered-page continuation that raises a retained launch limit", () => {
    const lowerLimits = { ...limits, pages: limits.pages - 1 }
    const initial = DocumentRuntimeProtocol.beginOrder(
      Schema.decodeUnknownSync(DocumentRuntimeProtocol.RenderRequest)({ ...render(), limits: lowerLimits }),
    )
    const started = DocumentRuntimeProtocol.advanceOrder(
      initial,
      event({ protocolVersion: 1, type: "started", jobID, operation: "render" }),
    )
    if (!started.ok) throw new Error(started.code)
    const ready = DocumentRuntimeProtocol.advanceOrder(started.state, event(pageReady()))
    if (!ready.ok) throw new Error(ready.code)

    expect(DocumentRuntimeProtocol.advanceOrder(ready.state, command(ocr()))).toEqual({
      ok: false,
      code: "invalid-order",
    })
  })
})

describe("DocumentRuntimeProtocol output transfer", () => {
  const outputID = DocumentRuntimeProtocol.OutputID.make("output_123e4567-e89b-42d3-a456-426614174000")
  const request = Schema.decodeUnknownSync(DocumentRuntimeProtocol.RenderRequest)(render())
  const start = DocumentRuntimeProtocol.decodeOutputFrame({
    protocolVersion: 1,
    type: "output-start",
    jobID,
    outputID,
    kind: "page-png",
    page: 1,
    pageID,
    sourcePath: "pages/page-1.png",
    declaredBytes: DocumentRuntimeLimits.MaxOutputChunkBytes + 1,
  })
  const chunk = (sequence: number, bytes: number) =>
    DocumentRuntimeProtocol.decodeOutputFrame({
      protocolVersion: 1,
      type: "output-chunk",
      jobID,
      outputID,
      sequence,
      data: DocumentRuntimeProtocol.encodeCanonicalBase64(new Uint8Array(bytes)),
    })
  const end = DocumentRuntimeProtocol.decodeOutputFrame({
    protocolVersion: 1,
    type: "output-end",
    jobID,
    outputID,
    chunks: 2,
    actualBytes: DocumentRuntimeLimits.MaxOutputChunkBytes + 1,
    sha256: hash,
  })

  test("round trips strict transfer frames and canonical base64", () => {
    for (const frame of [start, chunk(0, DocumentRuntimeLimits.MaxOutputChunkBytes), chunk(1, 1), end]) {
      expect(DocumentRuntimeProtocol.decodeWorkerOutput(frame)).toEqual(frame)
    }
    expect(DocumentRuntimeProtocol.decodeCanonicalBase64("a29hbGE=")).toEqual(new TextEncoder().encode("koala"))
    for (const value of ["a29hbGE", "a29h bGE=", "a29hbGE===", "A==="]) {
      expect(() => DocumentRuntimeProtocol.decodeCanonicalBase64(value)).toThrow()
    }
  })

  test("accepts exact chunks then requires a matching normal event", () => {
    const messages = [start, chunk(0, DocumentRuntimeLimits.MaxOutputChunkBytes), chunk(1, 1), end]
    const transferred = messages.reduce<DocumentRuntimeProtocol.OutputOrderResult>(
      (result, message) => (result.ok ? DocumentRuntimeProtocol.advanceOutputOrder(result.state, message) : result),
      { ok: true, state: DocumentRuntimeProtocol.beginOutputOrder(request) },
    )
    expect(transferred.ok).toBe(true)
    if (!transferred.ok) return
    const published = DocumentRuntimeProtocol.advanceOutputOrder(
      transferred.state,
      DocumentRuntimeProtocol.decodeWorkerEvent({
        ...pageReady(),
        outputID,
        outputSha256: hash,
        pngBytes: DocumentRuntimeLimits.MaxOutputChunkBytes + 1,
        temporaryBytes: DocumentRuntimeLimits.MaxOutputChunkBytes + 1,
      }),
    )
    expect(published.ok).toBe(true)
  })

  test("rejects interleaving, sequence gaps, short non-final chunks, missing end, and limit overflow", () => {
    const active = DocumentRuntimeProtocol.advanceOutputOrder(DocumentRuntimeProtocol.beginOutputOrder(request), start)
    expect(active.ok).toBe(true)
    if (!active.ok) return
    expect(DocumentRuntimeProtocol.advanceOutputOrder(active.state, start)).toEqual({
      ok: false,
      code: "invalid-output-order",
    })
    expect(DocumentRuntimeProtocol.advanceOutputOrder(active.state, chunk(1, 1))).toEqual({
      ok: false,
      code: "invalid-output-order",
    })
    expect(DocumentRuntimeProtocol.advanceOutputOrder(active.state, chunk(0, 1))).toEqual({
      ok: false,
      code: "invalid-output-order",
    })
    expect(DocumentRuntimeProtocol.advanceOutputOrder(active.state, end)).toEqual({
      ok: false,
      code: "invalid-output-order",
    })
    const tiny = Schema.decodeUnknownSync(DocumentRuntimeProtocol.RenderRequest)({
      ...render(),
      limits: { ...limits, pngBytesPerPage: 1, temporaryBytes: 1 },
    })
    expect(DocumentRuntimeProtocol.advanceOutputOrder(DocumentRuntimeProtocol.beginOutputOrder(tiny), start)).toEqual({
      ok: false,
      code: "output-limit-exceeded",
    })
  })

  test("rejects malformed and noncanonical chunk schemas", () => {
    for (const data of ["", "a29h bGE=", "a29hbGE===", "a29hbGE"]) {
      expect(() =>
        DocumentRuntimeProtocol.decodeOutputFrame({
          protocolVersion: 1,
          type: "output-chunk",
          jobID,
          outputID,
          sequence: 0,
          data,
        }),
      ).toThrow()
    }
  })
})
