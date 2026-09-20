import { afterEach, describe, expect, test } from "bun:test"
import { DocumentRuntimeLimits } from "@koala-ai/core/document-runtime/limits"
import { DocumentRuntimeProtocol } from "@koala-ai/core/document-runtime/protocol"
import { Schema } from "effect"
import { createHash } from "node:crypto"
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DocumentProxyOutput } from "@/document/proxy-output"
import { DocumentPendingRoot } from "@/document/pending-root"

const roots: string[] = []
const jobID = DocumentRuntimeProtocol.JobID.make("job_00000000-0000-4000-8000-000000000001")
const pageID = DocumentRuntimeProtocol.PageID.make("page_00000000-0000-4000-8000-000000000001")
const outputID = DocumentRuntimeProtocol.OutputID.make("output_00000000-0000-4000-8000-000000000001")
const request = Schema.decodeUnknownSync(DocumentRuntimeProtocol.RenderRequest)({
  protocolVersion: 1,
  type: "render",
  jobID,
  inputPath: "input/document.pdf",
  inputBytes: 1,
  startPage: 1,
  pageCount: 1,
  limits: DocumentRuntimeLimits.requestedHard,
})

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      if (process.platform !== "win32") await chmod(root, 0o700).catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    }),
  )
})

describe("document proxy output receiver", () => {
  test("streams, verifies, rewrites, and releases one stable output", async () => {
    const pending = await root()
    const receiver = DocumentProxyOutput.create(pending.evidence, request)
    const body = Buffer.alloc(DocumentRuntimeLimits.MaxOutputChunkBytes + 3, 7)
    const digest = createHash("sha256").update(body).digest("hex")
    expect(await receiver.handle(start(body.byteLength))).toBeUndefined()
    await receiver.handle(chunk(0, body.subarray(0, DocumentRuntimeLimits.MaxOutputChunkBytes)))
    await receiver.handle(chunk(1, body.subarray(DocumentRuntimeLimits.MaxOutputChunkBytes)))
    await receiver.handle(end(2, body.byteLength, digest))
    const event = await receiver.handle(pageReady(body.byteLength, digest))

    expect(event?.type).toBe("page-ready")
    if (!event || event.type !== "page-ready") return
    expect(event.outputPath).not.toBe("pages/one.png")
    expect(await readFile(path.join(pending.path, event.outputPath))).toEqual(body)
    expect(await receiver.release(release())).toBe(false)
    await rm(path.join(pending.path, event.outputPath))
    expect(await receiver.release(release())).toBe(true)
  })

  test("rejects duplicate starts, interleaving, sequence gaps, early events, and missing chunks", async () => {
    const receiver = DocumentProxyOutput.create((await root()).evidence, request)
    await receiver.handle(start(2))
    await expect(receiver.handle(start(2))).rejects.toThrow()
    await expect(receiver.handle(chunk(1, Buffer.from("a")))).rejects.toThrow()
    await expect(receiver.handle(pageReady(2, "a".repeat(64)))).rejects.toThrow()
    await expect(receiver.handle(end(1, 2, "a".repeat(64)))).rejects.toThrow()
    await receiver.cleanup()
  })

  test("rejects malformed base64, short non-final chunks, byte mismatch, and digest mismatch", async () => {
    expect(() =>
      DocumentRuntimeProtocol.decodeWorkerOutput({
        protocolVersion: 1,
        type: "output-chunk",
        jobID,
        outputID,
        sequence: 0,
        data: "not canonical",
      }),
    ).toThrow()

    const short = DocumentProxyOutput.create((await root()).evidence, request)
    await short.handle(start(DocumentRuntimeLimits.MaxOutputChunkBytes + 1))
    await expect(short.handle(chunk(0, Buffer.from("short")))).rejects.toThrow()
    await short.cleanup()

    const mismatch = DocumentProxyOutput.create((await root()).evidence, request)
    await mismatch.handle(start(1))
    await mismatch.handle(chunk(0, Buffer.from("x")))
    await expect(mismatch.handle(end(1, 1, "0".repeat(64)))).rejects.toThrow()
    await mismatch.cleanup()
  })

  test("rejects trailing chunks and mismatched normal-event correlation", async () => {
    const trailing = DocumentProxyOutput.create((await root()).evidence, request)
    const digest = createHash("sha256").update("x").digest("hex")
    await trailing.handle(start(1))
    await trailing.handle(chunk(0, Buffer.from("x")))
    await trailing.handle(end(1, 1, digest))
    await expect(trailing.handle(chunk(1, Buffer.from("x")))).rejects.toThrow()
    await expect(trailing.handle(pageReady(1, "0".repeat(64)))).rejects.toThrow()
    await trailing.cleanup()
  })

  test("accepts a zero-byte standalone TSV with no chunks", async () => {
    const pending = await root()
    const imageRequest = DocumentRuntimeProtocol.decodeInitialRequest({
      protocolVersion: 1,
      type: "ocr",
      jobID,
      page: 1,
      pageID,
      source: { kind: "image", inputPath: "input/image", inputBytes: 1, dimensions: { width: 1, height: 1 } },
      limits: DocumentRuntimeLimits.requestedHard,
    })
    const receiver = DocumentProxyOutput.create(pending.evidence, imageRequest)
    const resultID = "ocr_00000000-0000-4000-8000-000000000001"
    const digest = createHash("sha256").update("").digest("hex")
    await receiver.handle(
      DocumentRuntimeProtocol.decodeWorkerOutput({
        protocolVersion: 1,
        type: "output-start",
        jobID,
        outputID,
        kind: "ocr-tsv",
        page: 1,
        pageID,
        resultID,
        sourcePath: "ocr/one.tsv",
        declaredBytes: 0,
      }),
    )
    await receiver.handle(end(0, 0, digest))
    const event = await receiver.handle(
      DocumentRuntimeProtocol.decodeWorkerOutput({
        protocolVersion: 1,
        type: "ocr-result",
        jobID,
        page: 1,
        pageID,
        resultID,
        outputPath: "ocr/one.tsv",
        outputID,
        outputSha256: digest,
        tsvBytes: 0,
        temporaryBytes: 0,
      }),
    )
    expect(event?.type).toBe("ocr-result")
    if (!event || event.type !== "ocr-result") return
    expect(await readFile(path.join(pending.path, event.outputPath))).toEqual(Buffer.alloc(0))
    await receiver.cleanup()
  })

  test("enforces per-output and live temporary limits before creating a file", async () => {
    const limited = DocumentRuntimeProtocol.decodeInitialRequest({
      ...request,
      limits: { ...request.limits, pngBytesPerPage: 1, temporaryBytes: 1 },
    })
    const receiver = DocumentProxyOutput.create((await root()).evidence, limited)
    await expect(receiver.handle(start(2))).rejects.toThrow()
    await receiver.cleanup()
  })

  test("rejects pending-root replacement between validation and file creation", async () => {
    const pending = await root()
    let checks = 0
    let closes = 0
    let writes = 0
    let createdPath = ""
    const receiver = DocumentProxyOutput.create(pending.evidence, request, {
      ...DocumentProxyOutput.defaultDependencies,
      openFile: async (value, flags, mode) => {
        createdPath = value
        const handle = await DocumentProxyOutput.defaultDependencies.openFile(value, flags, mode)
        return {
          stat: (options) => handle.stat(options),
          write: async (buffer, offset, length) => {
            writes++
            return handle.write(buffer, offset, length)
          },
          read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
          sync: () => handle.sync(),
          close: async () => {
            closes++
            await handle.close()
          },
        }
      },
      verifyRoot: async (evidence) => {
        await DocumentPendingRoot.verify(evidence)
        checks++
        if (checks >= 2) throw new DocumentPendingRoot.EvidenceError("simulated-post-open-replacement")
      },
    })
    await expect(receiver.handle(start(1))).rejects.toBeInstanceOf(DocumentPendingRoot.EvidenceError)
    expect(closes).toBe(1)
    expect(writes).toBe(0)
    expect((await lstat(createdPath)).size).toBe(0)
    await expect(receiver.handle(chunk(0, Buffer.from("x")))).rejects.toThrow()
    expect(writes).toBe(0)
    const started = Date.now()
    await receiver.cleanup().catch(() => undefined)
    expect(Date.now() - started).toBeLessThan(500)
    expect((await lstat(createdPath)).size).toBe(0)
  })

  test.each(["root", "sync", "close"] as const)(
    "closes an active acquisition exactly once after %s failure before publication",
    async (failure) => {
      const pending = await root()
      const tracked = trackedDependencies()
      const receiver = DocumentProxyOutput.create(pending.evidence, request, tracked.dependencies)
      const body = Buffer.from("x")
      const digest = createHash("sha256").update(body).digest("hex")
      await receiver.handle(start(1))
      await receiver.handle(chunk(0, body))
      tracked.failRoot = failure === "root"
      tracked.failSync = failure === "sync"
      tracked.failClose = failure === "close"

      await expect(receiver.handle(end(1, 1, digest))).rejects.toThrow()
      expect(tracked.closes).toBe(1)
      const writes = tracked.writes
      await expect(receiver.handle(chunk(1, body))).rejects.toThrow()
      expect(tracked.writes).toBe(writes)
      await receiver.cleanup().catch(() => undefined)
      expect(tracked.closes).toBe(1)
    },
  )

  test("closes before cleanup root verification and retains a replaced-root pathname", async () => {
    const pending = await root()
    const tracked = trackedDependencies()
    const receiver = DocumentProxyOutput.create(pending.evidence, request, tracked.dependencies)
    await receiver.handle(start(1))
    tracked.failRoot = true
    const started = Date.now()
    await expect(receiver.cleanup()).rejects.toBeInstanceOf(DocumentPendingRoot.EvidenceError)
    expect(Date.now() - started).toBeLessThan(500)
    expect(tracked.closes).toBe(1)
    expect(await Bun.file(tracked.createdPath).exists()).toBe(true)
    const writes = tracked.writes
    await expect(receiver.handle(chunk(0, Buffer.from("x")))).rejects.toThrow()
    expect(tracked.writes).toBe(writes)
  })

  test.each([
    "/absolute.png",
    "../escape.png",
    "pages/../escape.png",
    "pages\\escape.png",
    "C:/escape.png",
    "pages/file.tsv",
    "ocr/file.png",
  ])("rejects hostile worker source path %s", (sourcePath) => {
    expect(() =>
      DocumentRuntimeProtocol.decodeWorkerOutput({
        ...start(1),
        sourcePath,
      }),
    ).toThrow()
  })
})

function start(declaredBytes: number) {
  return DocumentRuntimeProtocol.decodeWorkerOutput({
    protocolVersion: 1,
    type: "output-start",
    jobID,
    outputID,
    kind: "page-png",
    page: 1,
    pageID,
    sourcePath: "pages/one.png",
    declaredBytes,
  })
}

function chunk(sequence: number, bytes: Uint8Array) {
  return DocumentRuntimeProtocol.decodeWorkerOutput({
    protocolVersion: 1,
    type: "output-chunk",
    jobID,
    outputID,
    sequence,
    data: DocumentRuntimeProtocol.encodeCanonicalBase64(bytes),
  })
}

function end(chunks: number, actualBytes: number, sha256: string) {
  return DocumentRuntimeProtocol.decodeWorkerOutput({
    protocolVersion: 1,
    type: "output-end",
    jobID,
    outputID,
    chunks,
    actualBytes,
    sha256,
  })
}

function pageReady(pngBytes: number, outputSha256: string) {
  return DocumentRuntimeProtocol.decodeWorkerOutput({
    protocolVersion: 1,
    type: "page-ready",
    jobID,
    page: 1,
    pageID,
    outputPath: "pages/one.png",
    outputID,
    outputSha256,
    dimensions: { width: 1, height: 1 },
    pngBytes,
    temporaryBytes: pngBytes,
  })
}

function release() {
  return {
    protocolVersion: 1,
    type: "release-page",
    jobID,
    page: 1,
    pageID,
  } as const
}

async function root() {
  const parentRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "document-proxy-output-")))
  roots.push(parentRoot)
  const pendingRoot = path.join(parentRoot, "pending")
  await mkdir(pendingRoot)
  const parentMode = process.platform === "win32" ? null : 0o500
  if (parentMode !== null) await chmod(parentRoot, parentMode)
  const parent = await lstat(parentRoot, { bigint: true })
  const pending = await lstat(pendingRoot, { bigint: true })
  return {
    path: pendingRoot,
    evidence: {
      parentRoot,
      parentIdentity: { dev: parent.dev, ino: parent.ino },
      parentMode,
      pendingRoot,
      pendingRootIdentity: { dev: pending.dev, ino: pending.ino },
    },
  }
}

function trackedDependencies() {
  const state = {
    closes: 0,
    writes: 0,
    createdPath: "",
    failRoot: false,
    failSync: false,
    failClose: false,
    dependencies: {
      ...DocumentProxyOutput.defaultDependencies,
      verifyRoot: async (evidence: DocumentPendingRoot.Evidence) => {
        if (state.failRoot) throw new DocumentPendingRoot.EvidenceError("simulated-root-replacement")
        return DocumentPendingRoot.verify(evidence)
      },
      openFile: async (value: string, flags: number, mode?: number) => {
        state.createdPath = value
        const handle = await DocumentProxyOutput.defaultDependencies.openFile(value, flags, mode)
        return {
          stat: (options: { readonly bigint: true }) => handle.stat(options),
          write: async (buffer: Uint8Array, offset: number, length: number) => {
            state.writes++
            return handle.write(buffer, offset, length)
          },
          read: (buffer: Uint8Array, offset: number, length: number, position: number | null) =>
            handle.read(buffer, offset, length, position),
          sync: async () => {
            if (state.failSync) throw new Error("sync-failed")
            await handle.sync()
          },
          close: async () => {
            state.closes++
            await handle.close()
            if (state.failClose) throw new Error("close-failed")
          },
        }
      },
    },
  }
  return state
}
