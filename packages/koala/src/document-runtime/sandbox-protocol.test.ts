import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { DocumentRuntimeLimits } from "./limits"
import { DocumentSandboxProtocol } from "./sandbox-protocol"

const jobID = "job_123e4567-e89b-42d3-a456-426614174000"
const otherJobID = "job_223e4567-e89b-42d3-a456-426614174000"
const pageID = "page_123e4567-e89b-42d3-a456-426614174000"
const outputID = "output_123e4567-e89b-42d3-a456-426614174000"
const resultID = "ocr_123e4567-e89b-42d3-a456-426614174000"
const target = "x86_64-unknown-linux-gnu"
const otherTarget = "aarch64-unknown-linux-gnu"
const manifestSha256 = "0123456789abcdef".repeat(4)
const otherManifestSha256 = "fedcba9876543210".repeat(4)
const limits = DocumentRuntimeLimits.requestedHard
const expectEqual = (actual: unknown, expected: unknown) => expect(actual).toEqual(expected)

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

const probe = () => ({
  protocolVersion: 1 as const,
  type: "probe" as const,
  jobID,
  target,
  manifestSha256,
})

const renderedPageOcr = () => ({
  protocolVersion: 1 as const,
  type: "ocr" as const,
  jobID,
  page: 1,
  pageID,
  source: { kind: "rendered-page" as const },
  limits,
})

const launch = () => ({
  protocolVersion: 1 as const,
  type: "launch" as const,
  jobID,
  target,
  runtimeRoot: "/opt/koala/document-runtime",
  manifestSha256,
  parentRoot: "/tmp/koala",
  parentIdentity: { dev: "1", ino: "1" },
  parentMode: 0o500,
  jobRoot: "/tmp/koala/job-1",
  jobRootIdentity: { dev: "1", ino: "2" },
  pendingRoot: "/tmp/koala/pending-1",
  pendingRootIdentity: { dev: "1", ino: "3" },
  start: render(),
})

const pageReady = () => ({
  protocolVersion: 1 as const,
  type: "page-ready" as const,
  jobID,
  page: 1,
  pageID,
  outputPath: "pages/page-1.png",
  outputID,
  outputSha256: manifestSha256,
  dimensions: { width: 2_000, height: 3_000 },
  pngBytes: 1024,
  temporaryBytes: 1024,
})

const outerEvent = (event: object) => ({
  protocolVersion: 1 as const,
  type: "event" as const,
  jobID,
  event,
})

const accepted = () => ({ protocolVersion: 1 as const, type: "accepted" as const, jobID })
const cancel = () => ({ protocolVersion: 1 as const, type: "cancel" as const, jobID })
const failure = (failureJobID: string | null = jobID) => ({
  protocolVersion: 1 as const,
  type: "failure" as const,
  jobID: failureJobID,
  code: "sandbox-unavailable" as const,
  stage: "sandbox" as const,
  retryable: false,
})
const closed = (closedJobID: string | null = jobID) => ({
  protocolVersion: 1 as const,
  type: "closed" as const,
  jobID: closedJobID,
})

describe("DocumentSandboxProtocol schemas", () => {
  const encodeParent = Schema.encodeSync(DocumentSandboxProtocol.ParentRequest)
  const encodeProxy = Schema.encodeSync(DocumentSandboxProtocol.ProxyEvent)

  test.each([
    launch(),
    { ...launch(), start: probe() },
    { ...launch(), start: imageOcr() },
    { protocolVersion: 1, type: "command", jobID, command: renderedPageOcr() },
    {
      protocolVersion: 1,
      type: "command",
      jobID,
      command: { protocolVersion: 1, type: "release-page", jobID, page: 1, pageID },
    },
    cancel(),
  ] as const)("round trips the $type parent request", (request) => {
    expectEqual(encodeParent(DocumentSandboxProtocol.decodeParentRequest(request)), request)
  })

  test.each([
    accepted(),
    outerEvent({ protocolVersion: 1, type: "started", jobID, operation: "render" }),
    failure(),
    closed(),
  ] as const)("round trips the $type proxy event", (event) => {
    expectEqual(encodeProxy(DocumentSandboxProtocol.decodeProxyEvent(event)), event)
  })

  test.each([
    "invalid-launch",
    "protocol-mismatch",
    "sandbox-unavailable",
    "dependency-failed",
    "spawn-failed",
    "transport-overflow",
    "output-handoff-failed",
    "root-identity-failed",
    "worker-crashed",
    "termination-failed",
    "command-cleanup-failed",
    "reset-failed",
  ] as const)("accepts the closed failure code %s", (code) => {
    expectEqual(DocumentSandboxProtocol.decodeProxyEvent({ ...failure(), code }), { ...failure(), code })
  })

  test.each([
    "launch",
    "sandbox",
    "dependency",
    "spawn",
    "transport",
    "worker",
    "termination",
    "command-cleanup",
    "reset",
  ] as const)("accepts the closed failure stage %s", (stage) => {
    expectEqual(DocumentSandboxProtocol.decodeProxyEvent({ ...failure(), stage }), { ...failure(), stage })
  })

  test.each([
    { ...launch(), protocolVersion: 2 },
    { ...launch(), jobID: "job-invalid" },
    { ...launch(), runtimeRoot: "relative/runtime" },
    { ...launch(), jobRoot: "../job" },
    { ...launch(), pendingRoot: "../pending" },
    { ...launch(), pendingRoot: launch().jobRoot },
    { ...launch(), pendingRoot: "/other/pending" },
    { ...launch(), parentIdentity: { dev: "01", ino: "1" } },
    { ...launch(), jobRootIdentity: { dev: "-1", ino: "1" } },
    { ...launch(), pendingRootIdentity: { dev: "1", ino: "1.5" } },
    { ...launch(), pendingRootIdentity: { dev: "18446744073709551616", ino: "1" } },
    { ...launch(), excess: true },
    { ...launch(), start: { ...render(), excess: true } },
    { ...launch(), start: { ...render(), limits: { ...limits, excess: true } } },
    { ...launch(), start: renderedPageOcr() },
    { ...launch(), jobID: otherJobID },
    {
      ...launch(),
      start: {
        protocolVersion: 1,
        type: "probe",
        jobID,
        target: otherTarget,
        manifestSha256,
      },
    },
    {
      ...launch(),
      start: {
        protocolVersion: 1,
        type: "probe",
        jobID,
        target,
        manifestSha256: otherManifestSha256,
      },
    },
    {
      ...launch(),
      start: {
        ...imageOcr(),
        source: { ...imageOcr().source, excess: true },
      },
    },
    {
      ...launch(),
      start: {
        ...imageOcr(),
        source: { ...imageOcr().source, dimensions: { ...imageOcr().source.dimensions, excess: true } },
      },
    },
    { protocolVersion: 1, type: "command", jobID, command: { ...renderedPageOcr(), jobID: otherJobID } },
    { protocolVersion: 1, type: "command", jobID, command: imageOcr() },
    { protocolVersion: 1, type: "command", jobID, command: { ...renderedPageOcr(), excess: true } },
    {
      protocolVersion: 1,
      type: "command",
      jobID,
      command: { ...renderedPageOcr(), source: { kind: "rendered-page", excess: true } },
    },
    { ...cancel(), excess: true },
  ])("rejects invalid or open parent request %#", (request) => {
    expect(() => DocumentSandboxProtocol.decodeParentRequest(request)).toThrow()
  })

  test.each([
    { ...accepted(), protocolVersion: 2 },
    { ...accepted(), excess: true },
    { ...outerEvent(pageReady()), jobID: otherJobID },
    { ...outerEvent(pageReady()), excess: true },
    outerEvent({ ...pageReady(), excess: true }),
    outerEvent({ ...pageReady(), dimensions: { ...pageReady().dimensions, excess: true } }),
    { ...failure(), code: "worker-failed" },
    { ...failure(), stage: "cleanup" },
    { ...failure(), cause: "native stderr" },
    { ...closed(), path: "/private/job" },
  ])("rejects invalid or open proxy event %#", (event) => {
    expect(() => DocumentSandboxProtocol.decodeProxyEvent(event)).toThrow()
  })
})

describe("DocumentSandboxProtocol lifecycle", () => {
  const parent = DocumentSandboxProtocol.decodeParentRequest
  const proxy = DocumentSandboxProtocol.decodeProxyEvent

  const advance = (
    state: DocumentSandboxProtocol.LifecycleState,
    message: DocumentSandboxProtocol.ParentRequest | DocumentSandboxProtocol.ProxyEvent,
  ) => {
    const result = DocumentSandboxProtocol.advanceLifecycle(state, message)
    if (!result.ok) throw new Error(result.code)
    return result.state
  }

  const launched = () => advance(DocumentSandboxProtocol.beginLifecycle(), parent(launch()))
  const active = () => advance(launched(), proxy(accepted()))
  const started = () =>
    advance(active(), proxy(outerEvent({ protocolVersion: 1, type: "started", jobID, operation: "render" })))

  test("accepts the full render, OCR, release, terminal, and closed sequence", () => {
    const messages = [
      parent(launch()),
      proxy(accepted()),
      proxy(outerEvent({ protocolVersion: 1, type: "started", jobID, operation: "render" })),
      proxy(outerEvent(pageReady())),
      parent({ protocolVersion: 1, type: "command", jobID, command: renderedPageOcr() }),
      proxy(
        outerEvent({
          protocolVersion: 1,
          type: "ocr-result",
          jobID,
          page: 1,
          pageID,
          resultID,
          outputPath: "ocr/page-1.tsv",
          outputID,
          outputSha256: manifestSha256,
          tsvBytes: 512,
          temporaryBytes: 1536,
        }),
      ),
      parent({
        protocolVersion: 1,
        type: "command",
        jobID,
        command: { protocolVersion: 1, type: "release-page", jobID, page: 1, pageID },
      }),
      proxy(
        outerEvent({
          protocolVersion: 1,
          type: "completed",
          jobID,
          operation: "render",
          pagesProcessed: 1,
          temporaryBytes: 0,
        }),
      ),
      proxy(closed()),
    ]
    const state = messages.reduce(advance, DocumentSandboxProtocol.beginLifecycle())
    expect(state).toEqual(expect.objectContaining({ phase: "closed", jobID, terminalJobID: jobID }))
  })

  test("accepts a successful probe lifecycle", () => {
    const messages = [
      parent({ ...launch(), start: probe() }),
      proxy(accepted()),
      proxy(outerEvent({ protocolVersion: 1, type: "started", jobID, operation: "probe" })),
      proxy(
        outerEvent({
          protocolVersion: 1,
          type: "completed",
          jobID,
          operation: "probe",
          pagesProcessed: 0,
          temporaryBytes: 0,
        }),
      ),
      proxy(closed()),
    ]
    const state = messages.reduce(advance, DocumentSandboxProtocol.beginLifecycle())
    expect(state.phase).toBe("closed")
  })

  test("accepts a successful standalone image OCR lifecycle", () => {
    const messages = [
      parent({ ...launch(), start: imageOcr() }),
      proxy(accepted()),
      proxy(outerEvent({ protocolVersion: 1, type: "started", jobID, operation: "ocr" })),
      proxy(
        outerEvent({
          protocolVersion: 1,
          type: "ocr-result",
          jobID,
          page: 1,
          pageID,
          resultID,
          outputPath: "ocr/page-1.tsv",
          outputID,
          outputSha256: manifestSha256,
          tsvBytes: 512,
          temporaryBytes: 512,
        }),
      ),
      proxy(
        outerEvent({
          protocolVersion: 1,
          type: "completed",
          jobID,
          operation: "ocr",
          pagesProcessed: 1,
          temporaryBytes: 512,
        }),
      ),
      proxy(closed()),
    ]
    const state = messages.reduce(advance, DocumentSandboxProtocol.beginLifecycle())
    expect(state.phase).toBe("closed")
  })

  test.each([null, jobID] as const)(
    "accepts a pre-acceptance failure and matching closure for job %p",
    (failureJobID) => {
      const terminal = advance(launched(), proxy(failure(failureJobID)))
      expect(terminal.phase).toBe("terminal")
      expect(advance(terminal, proxy(closed(failureJobID))).phase).toBe("closed")
    },
  )

  test("accepts cancellation before acceptance and delegates it to document order", () => {
    const cancelling = advance(launched(), parent(cancel()))
    expect(cancelling.order?.phase).toBe("cancelling")
    const acceptedState = advance(cancelling, proxy(accepted()))
    const terminal = advance(acceptedState, proxy(outerEvent({ protocolVersion: 1, type: "cancelled", jobID })))
    expect(advance(terminal, proxy(closed())).phase).toBe("closed")
  })

  test("accepts cancellation after acceptance", () => {
    const cancelling = advance(active(), parent(cancel()))
    expect(cancelling.order?.phase).toBe("cancelling")
    const terminal = advance(cancelling, proxy(outerEvent({ protocolVersion: 1, type: "cancelled", jobID })))
    expect(advance(terminal, proxy(closed())).phase).toBe("closed")
  })

  test("accepts a proxy failure after acceptance only with the launch job", () => {
    const terminal = advance(active(), proxy(failure()))
    expect(advance(terminal, proxy(closed())).phase).toBe("closed")
    expect(DocumentSandboxProtocol.advanceLifecycle(active(), proxy(failure(null)))).toEqual({
      ok: false,
      code: "job-mismatch",
    })
  })

  test.each([
    proxy(accepted()),
    parent(cancel()),
    proxy(failure()),
    proxy(closed()),
    proxy(outerEvent({ protocolVersion: 1, type: "started", jobID, operation: "render" })),
  ])("rejects $type before launch", (message) => {
    expect(DocumentSandboxProtocol.advanceLifecycle(DocumentSandboxProtocol.beginLifecycle(), message)).toEqual({
      ok: false,
      code: "invalid-order",
    })
  })

  test("rejects duplicate launch, command, event, or closure before acceptance", () => {
    const state = launched()
    expect(DocumentSandboxProtocol.advanceLifecycle(state, parent(launch()))).toEqual({
      ok: false,
      code: "invalid-order",
    })
    expect(
      DocumentSandboxProtocol.advanceLifecycle(
        state,
        parent({ protocolVersion: 1, type: "command", jobID, command: renderedPageOcr() }),
      ),
    ).toEqual({ ok: false, code: "invalid-order" })
    expect(
      DocumentSandboxProtocol.advanceLifecycle(
        state,
        proxy(outerEvent({ protocolVersion: 1, type: "started", jobID, operation: "render" })),
      ),
    ).toEqual({ ok: false, code: "invalid-order" })
    expect(DocumentSandboxProtocol.advanceLifecycle(state, proxy(closed()))).toEqual({
      ok: false,
      code: "invalid-order",
    })
  })

  test("rejects duplicate acceptance, cancellation, terminal values, and post-close messages", () => {
    expect(DocumentSandboxProtocol.advanceLifecycle(active(), proxy(accepted()))).toEqual({
      ok: false,
      code: "invalid-order",
    })

    const cancelling = advance(active(), parent(cancel()))
    expect(DocumentSandboxProtocol.advanceLifecycle(cancelling, parent(cancel()))).toEqual({
      ok: false,
      code: "invalid-order",
    })

    const terminal = advance(active(), proxy(failure()))
    expect(DocumentSandboxProtocol.advanceLifecycle(terminal, proxy(failure()))).toEqual({
      ok: false,
      code: "invalid-order",
    })
    expect(DocumentSandboxProtocol.advanceLifecycle(terminal, parent(cancel()))).toEqual({
      ok: false,
      code: "invalid-order",
    })

    const finished = advance(terminal, proxy(closed()))
    expect(DocumentSandboxProtocol.advanceLifecycle(finished, proxy(closed()))).toEqual({
      ok: false,
      code: "invalid-order",
    })
  })

  test("rejects substituted outer job identities", () => {
    expect(
      DocumentSandboxProtocol.advanceLifecycle(
        active(),
        proxy({ protocolVersion: 1, type: "accepted", jobID: otherJobID }),
      ),
    ).toEqual({ ok: false, code: "job-mismatch" })
    expect(
      DocumentSandboxProtocol.advanceLifecycle(
        active(),
        parent({ protocolVersion: 1, type: "cancel", jobID: otherJobID }),
      ),
    ).toEqual({ ok: false, code: "job-mismatch" })

    const terminal = advance(active(), proxy(failure()))
    expect(DocumentSandboxProtocol.advanceLifecycle(terminal, proxy(closed(otherJobID)))).toEqual({
      ok: false,
      code: "job-mismatch",
    })
  })

  test("rejects invalid delegated page order and requested-limit excess", () => {
    expect(DocumentSandboxProtocol.advanceLifecycle(started(), proxy(outerEvent({ ...pageReady(), page: 2 })))).toEqual(
      { ok: false, code: "invalid-order" },
    )

    const limitedLaunch = parent({
      ...launch(),
      start: { ...render(), limits: { ...limits, pngBytesPerPage: 1 } },
    })
    const limitedStarted = advance(
      advance(advance(DocumentSandboxProtocol.beginLifecycle(), limitedLaunch), proxy(accepted())),
      proxy(outerEvent({ protocolVersion: 1, type: "started", jobID, operation: "render" })),
    )
    expect(DocumentSandboxProtocol.advanceLifecycle(limitedStarted, proxy(outerEvent(pageReady())))).toEqual({
      ok: false,
      code: "limit-exceeded",
    })
  })

  test("rejects cancelled without outer cancellation and early completion", () => {
    expect(
      DocumentSandboxProtocol.advanceLifecycle(
        active(),
        proxy(outerEvent({ protocolVersion: 1, type: "cancelled", jobID })),
      ),
    ).toEqual({ ok: false, code: "invalid-order" })
    expect(
      DocumentSandboxProtocol.advanceLifecycle(
        active(),
        proxy(
          outerEvent({
            protocolVersion: 1,
            type: "completed",
            jobID,
            operation: "render",
            pagesProcessed: 1,
            temporaryBytes: 0,
          }),
        ),
      ),
    ).toEqual({ ok: false, code: "invalid-order" })
  })
})
