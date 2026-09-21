import { describe, expect, test } from "bun:test"
import { DocumentRuntimeLimits } from "@koala-ai/core/document-runtime/limits"
import { DocumentRuntimeProtocol } from "@koala-ai/core/document-runtime/protocol"
import { DocumentOuterChannel, type Port } from "@/document/outer-channel"

const jobID = DocumentRuntimeProtocol.JobID.make("job_00000000-0000-4000-8000-000000000001")
const pageID = DocumentRuntimeProtocol.PageID.make("page_00000000-0000-4000-8000-000000000001")
const outputID = DocumentRuntimeProtocol.OutputID.make("output_00000000-0000-4000-8000-000000000001")
const digest = "a".repeat(64)
const launch = {
  protocolVersion: 1,
  type: "launch",
  jobID,
  target: "x86_64-unknown-linux-gnu",
  runtimeRoot: "/runtime",
  manifestSha256: digest,
  parentRoot: "/jobs",
  parentIdentity: { dev: "1", ino: "1" },
  parentMode: 0o500,
  jobRoot: "/jobs/one",
  jobRootIdentity: { dev: "1", ino: "2" },
  pendingRoot: "/jobs/pending",
  pendingRootIdentity: { dev: "1", ino: "3" },
  receiptNonce: "a".repeat(64),
  start: {
    protocolVersion: 1,
    type: "render",
    jobID,
    inputPath: "input/document.pdf",
    inputBytes: 1,
    startPage: 1,
    pageCount: 1,
    limits: DocumentRuntimeLimits.requestedHard,
  },
} as const

describe("document outer channel", () => {
  test("reserves launch before its delayed send callback", async () => {
    const channel = DocumentOuterChannel.make()
    const port = delayedPort()
    const pending = DocumentOuterChannel.send(channel, port, launch)
    expect(channel.state.phase).toBe("awaiting-accepted")

    DocumentOuterChannel.receive(channel, { protocolVersion: 1, type: "accepted", jobID, innerProcessID: 1234 })
    expect(channel.state.phase).toBe("active")
    await port.ready()
    port.complete()
    await pending
    expect(channel.state.phase).toBe("active")
  })

  test("reserves continuation before its delayed send callback", async () => {
    const channel = activeChannel()
    DocumentOuterChannel.receive(channel, {
      protocolVersion: 1,
      type: "event",
      jobID,
      event: { protocolVersion: 1, type: "started", jobID, operation: "render" },
    })
    DocumentOuterChannel.receive(channel, {
      protocolVersion: 1,
      type: "event",
      jobID,
      event: {
        protocolVersion: 1,
        type: "page-ready",
        jobID,
        page: 1,
        pageID,
        outputPath: "pages/one.png",
        outputID,
        outputSha256: digest,
        dimensions: { width: 1, height: 1 },
        pngBytes: 1,
        temporaryBytes: 1,
      },
    })
    const port = delayedPort()
    const pending = DocumentOuterChannel.send(channel, port, {
      protocolVersion: 1,
      type: "command",
      jobID,
      command: {
        protocolVersion: 1,
        type: "ocr",
        jobID,
        page: 1,
        pageID,
        source: { kind: "rendered-page" },
        limits: DocumentRuntimeLimits.requestedHard,
      },
    })
    expect(channel.state.order?.phase).toBe("awaiting-ocr-result")

    DocumentOuterChannel.receive(channel, {
      protocolVersion: 1,
      type: "event",
      jobID,
      event: {
        protocolVersion: 1,
        type: "ocr-result",
        jobID,
        page: 1,
        pageID,
        resultID: "ocr_00000000-0000-4000-8000-000000000001",
        outputPath: "ocr/one.tsv",
        outputID: "output_00000000-0000-4000-8000-000000000002",
        outputSha256: digest,
        tsvBytes: 1,
        temporaryBytes: 2,
      },
    })
    await port.ready()
    port.complete()
    await pending
    expect(channel.state.order?.phase).toBe("ocr-ready")
  })

  test("reserves cancellation and a delayed callback cannot replace terminal state", async () => {
    const channel = activeChannel()
    const port = delayedPort()
    const pending = DocumentOuterChannel.send(channel, port, { protocolVersion: 1, type: "cancel", jobID })
    expect(channel.state.cancelSent).toBe(true)

    DocumentOuterChannel.receive(channel, {
      protocolVersion: 1,
      type: "event",
      jobID,
      event: { protocolVersion: 1, type: "cancelled", jobID },
    })
    DocumentOuterChannel.receive(channel, closed())
    await port.ready()
    port.complete()
    await pending
    expect(channel.state.phase).toBe("closed")
  })

  test("uses the caller's remaining shutdown budget for a stalled send", async () => {
    const channel = DocumentOuterChannel.make()
    const port = delayedPort()
    const started = Date.now()
    await expect(DocumentOuterChannel.send(channel, port, launch, 20)).rejects.toEqual(
      expect.objectContaining({ name: "DocumentOuterChannelError", code: "send-timeout" }),
    )
    expect(Date.now() - started).toBeLessThan(500)
  })
})

function activeChannel() {
  const channel = DocumentOuterChannel.make()
  const port: Port = {
    connected: true,
    send: (_value, callback) => {
      callback(null)
      return true
    },
  }
  void DocumentOuterChannel.send(channel, port, launch)
  DocumentOuterChannel.receive(channel, { protocolVersion: 1, type: "accepted", jobID, innerProcessID: 1234 })
  return channel
}

function closed() {
  return {
    protocolVersion: 1 as const,
    type: "closed" as const,
    jobID,
    receiptNonce: "a".repeat(64),
    receiptSha256: digest,
    terminalCategory: "cancelled" as const,
    treeContained: true,
    managerInitialized: true,
    cleanupCalls: 1 as const,
    cleanupCompleted: true,
    resetCalls: 1 as const,
    resetCompleted: true,
  }
}

function delayedPort() {
  let callback: ((error: Error | null) => void) | undefined
  return {
    connected: true,
    send: (_value: unknown, done: (error: Error | null) => void) => {
      callback = done
      return true
    },
    complete: () => callback?.(null),
    ready: async () => {
      while (!callback) await new Promise<void>((resolve) => setTimeout(resolve, 0))
    },
  }
}
