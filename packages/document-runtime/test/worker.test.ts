import { afterEach, describe, expect, test } from "bun:test"
import { DocumentRuntimeLimits } from "@koala-ai/core/document-runtime/limits"
import { DocumentRuntimeManifest } from "@koala-ai/core/document-runtime/manifest"
import { DocumentRuntimeNdjson } from "@koala-ai/core/document-runtime/ndjson"
import { DocumentRuntimeProtocol } from "@koala-ai/core/document-runtime/protocol"
import { DocumentRuntimeTarget } from "@koala-ai/core/document-runtime/target"
import { createHash } from "node:crypto"
import { fork, spawn } from "node:child_process"
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pdfFixture } from "./fixture/pdf"
import { startWorker, type WorkerTransport } from "../src/worker"

const roots: string[] = []
const jobID = "job_123e4567-e89b-42d3-a456-426614174000" as DocumentRuntimeProtocol.JobID

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("document IPC worker", () => {
  test("renders one page at a time, publishes relative paths, waits for release, and completes", async () => {
    const jobRoot = await job()
    const input = pdfFixture(2)
    await mkdir(path.join(jobRoot, "input"), { mode: 0o700 })
    await writeFile(path.join(jobRoot, "input", "source.pdf"), input)
    const messages: DocumentRuntimeProtocol.WorkerEvent[] = []
    let receive: (input: unknown) => void = () => undefined
    let firstExisted = false
    const completed = Promise.withResolvers<void>()
    const transport: WorkerTransport = {
      onMessage: (listener) => (receive = listener),
      onDisconnect: () => undefined,
      send: async (event) => {
        messages.push(event)
        if (event.type === "page-ready") {
          expect(path.isAbsolute(event.outputPath)).toBe(false)
          firstExisted ||= await Bun.file(path.join(jobRoot, ...event.outputPath.split("/"))).exists()
          receive({ protocolVersion: 1, type: "release-page", jobID, page: event.page, pageID: event.pageID })
        }
        if (event.type === "completed") completed.resolve()
      },
      close: () => undefined,
    }
    startWorker(await config(jobRoot), transport)
    receive({
      protocolVersion: 1,
      type: "render",
      jobID,
      inputPath: "input/source.pdf",
      inputBytes: input.byteLength,
      startPage: 1,
      pageCount: 2,
      limits: DocumentRuntimeLimits.requestedHard,
    })
    await completed.promise
    expect(firstExisted).toBe(true)
    expect(messages.map((message) => message.type)).toEqual(["started", "page-ready", "page-ready", "completed"])
    expect(messages.filter((message) => message.type === "page-ready").map((message) => message.page)).toEqual([1, 2])
  })

  test("cancels while waiting for release and emits no raw error", async () => {
    const jobRoot = await job()
    const input = pdfFixture()
    await mkdir(path.join(jobRoot, "input"), { mode: 0o700 })
    await writeFile(path.join(jobRoot, "input", "source.pdf"), input)
    let receive: (input: unknown) => void = () => undefined
    const terminal = Promise.withResolvers<DocumentRuntimeProtocol.WorkerEvent>()
    const transport: WorkerTransport = {
      onMessage: (listener) => (receive = listener),
      onDisconnect: () => undefined,
      send: async (event) => {
        if (event.type === "page-ready") receive({ protocolVersion: 1, type: "cancel", jobID })
        if (event.type === "cancelled" || event.type === "failure") terminal.resolve(event)
      },
      close: () => undefined,
    }
    startWorker(await config(jobRoot), transport)
    receive({
      protocolVersion: 1,
      type: "render",
      jobID,
      inputPath: "input/source.pdf",
      inputBytes: input.byteLength,
      startPage: 1,
      pageCount: 1,
      limits: DocumentRuntimeLimits.requestedHard,
    })
    expect(await terminal.promise).toEqual({ protocolVersion: 1, type: "cancelled", jobID })
  })

  test("runs the built worker through the scrubber bootstrap over strict NDJSON", async () => {
    const jobRoot = await job()
    const input = pdfFixture()
    await mkdir(path.join(jobRoot, "input"), { mode: 0o700 })
    await writeFile(path.join(jobRoot, "input", "source.pdf"), input)
    const built = await config(jobRoot)
    const runtimeRoot = await isolatedRuntime(built.runtimeRoot)
    const workerConfig = await config(jobRoot, runtimeRoot)
    expect(await Bun.file(path.join(path.dirname(runtimeRoot), "package.json")).exists()).toBe(false)
    expect(await Bun.file(path.join(runtimeRoot, "package.json")).json()).toEqual({ type: "module" })
    const node = Bun.which("node")
    if (!node) throw new Error("Node executable is required for the built worker test")
    const child = spawn(node, [path.join(workerConfig.runtimeRoot, "worker", "bootstrap.js")], {
      env: {
        DOCUMENT_RUNTIME_ROOT: workerConfig.runtimeRoot,
        DOCUMENT_JOB_ROOT: jobRoot,
        DOCUMENT_RUNTIME_TARGET: workerConfig.target,
        DOCUMENT_RUNTIME_MANIFEST_SHA256: workerConfig.manifestSha256,
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
        PRIVATE_CANARY: "must-not-survive-bootstrap",
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    const events: DocumentRuntimeProtocol.WorkerEvent[] = []
    const decoder = DocumentRuntimeNdjson.makeDecoder()
    const encoder = DocumentRuntimeNdjson.makeEncoder()
    const terminal = Promise.withResolvers<DocumentRuntimeProtocol.WorkerEvent>()
    const exited = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>()
    const stdoutEnded = Promise.withResolvers<void>()
    const stderrEnded = Promise.withResolvers<void>()
    const stderr: Buffer[] = []
    let stderrBytes = 0
    child.on("error", (error) => {
      terminal.reject(error)
      exited.reject(error)
    })
    child.on("exit", (code, signal) => exited.resolve({ code, signal }))
    child.stdout.on("error", stdoutEnded.reject)
    child.stdout.on("end", () => {
      try {
        decoder.end()
        stdoutEnded.resolve()
      } catch (error) {
        stdoutEnded.reject(error)
      }
    })
    child.stderr.on("error", stderrEnded.reject)
    child.stderr.on("end", () => stderrEnded.resolve())
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength
      if (stderrBytes <= DocumentRuntimeLimits.MaxInnerStderrBytes) stderr.push(chunk)
      if (stderrBytes > DocumentRuntimeLimits.MaxInnerStderrBytes) child.kill()
    })
    child.stdout.on("data", (chunk: Buffer) => {
      try {
        for (const input of decoder.push(chunk)) {
          const event = DocumentRuntimeProtocol.decodeWorkerEvent(input)
          events.push(event)
          if (event.type === "page-ready") {
            child.stdin.write(
              encoder.encode({ protocolVersion: 1, type: "release-page", jobID, page: event.page, pageID: event.pageID }),
            )
          }
          if (event.type === "completed" || event.type === "failure") terminal.resolve(event)
        }
      } catch (error) {
        terminal.reject(error)
        child.kill()
      }
    })
    child.stdin.write(
      encoder.encode({
        protocolVersion: 1,
        type: "render",
        jobID,
        inputPath: "input/source.pdf",
        inputBytes: input.byteLength,
        startPage: 1,
        pageCount: 1,
        limits: DocumentRuntimeLimits.requestedHard,
      }),
    )
    try {
      expect(await terminal.promise).toEqual(expect.objectContaining({ type: "completed", pagesProcessed: 1 }))
      const status = await exited.promise
      await Promise.all([stdoutEnded.promise, stderrEnded.promise])
      expect(events.map((event) => event.type)).toEqual(["started", "page-ready", "completed"])
      expect(decoder.frames).toBe(events.length)
      expect(status).toEqual({ code: 0, signal: null })
      expect(stderrBytes).toBeLessThanOrEqual(DocumentRuntimeLimits.MaxInnerStderrBytes)
      expect(Buffer.concat(stderr).toString("utf8")).toBe("")
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill()
    }
  })

  test("keeps the direct Node IPC entrypoint as a Phase 5 compatibility path", async () => {
    const jobRoot = await job()
    const input = pdfFixture()
    await mkdir(path.join(jobRoot, "input"), { mode: 0o700 })
    await writeFile(path.join(jobRoot, "input", "source.pdf"), input)
    const workerConfig = await config(jobRoot)
    const child = fork(path.join(workerConfig.runtimeRoot, "worker", "worker.js"), [], {
      env: {
        DOCUMENT_RUNTIME_ROOT: workerConfig.runtimeRoot,
        DOCUMENT_JOB_ROOT: jobRoot,
        DOCUMENT_RUNTIME_TARGET: workerConfig.target,
        DOCUMENT_RUNTIME_MANIFEST_SHA256: workerConfig.manifestSha256,
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      },
      execArgv: [],
      serialization: "json",
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    })
    const events: DocumentRuntimeProtocol.WorkerEvent[] = []
    const terminal = Promise.withResolvers<DocumentRuntimeProtocol.WorkerEvent>()
    const exited = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>()
    child.on("error", terminal.reject)
    child.on("exit", (code, signal) => exited.resolve({ code, signal }))
    child.on("message", (input: unknown) => {
      const event = DocumentRuntimeProtocol.decodeWorkerEvent(input)
      events.push(event)
      if (event.type === "page-ready") {
        child.send({ protocolVersion: 1, type: "release-page", jobID, page: event.page, pageID: event.pageID })
      }
      if (event.type === "completed" || event.type === "failure") terminal.resolve(event)
    })
    child.send({
      protocolVersion: 1,
      type: "render",
      jobID,
      inputPath: "input/source.pdf",
      inputBytes: input.byteLength,
      startPage: 1,
      pageCount: 1,
      limits: DocumentRuntimeLimits.requestedHard,
    })
    try {
      expect(await terminal.promise).toEqual(expect.objectContaining({ type: "completed", pagesProcessed: 1 }))
      expect(await exited.promise).toEqual({ code: 0, signal: null })
      expect(events.map((event) => event.type)).toEqual(["started", "page-ready", "completed"])
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill()
    }
  })

  test("reports generated-file cleanup failure as the terminal result", async () => {
    const jobRoot = await job()
    const input = pdfFixture()
    await mkdir(path.join(jobRoot, "input"), { mode: 0o700 })
    await writeFile(path.join(jobRoot, "input", "source.pdf"), input)
    let receive: (input: unknown) => void = () => undefined
    const terminal = Promise.withResolvers<DocumentRuntimeProtocol.WorkerEvent>()
    startWorker(
      await config(jobRoot),
      {
        onMessage: (listener) => (receive = listener),
        onDisconnect: () => undefined,
        send: async (event) => {
          if (event.type === "page-ready") {
            receive({ protocolVersion: 1, type: "release-page", jobID, page: event.page, pageID: event.pageID })
          }
          if (event.type === "failure") terminal.resolve(event)
        },
        close: () => undefined,
      },
      { removeGenerated: async () => Promise.reject(new Error("private cleanup detail")) },
    )
    receive({
      protocolVersion: 1,
      type: "render",
      jobID,
      inputPath: "input/source.pdf",
      inputBytes: input.byteLength,
      startPage: 1,
      pageCount: 1,
      limits: DocumentRuntimeLimits.requestedHard,
    })
    const failure = await terminal.promise
    expect(failure).toEqual({
      protocolVersion: 1,
      type: "failure",
      jobID,
      code: "worker-failed",
      stage: "cleanup",
      retryable: false,
    })
    expect(JSON.stringify(failure)).not.toContain("private")
  })

  test("maps an excess command field to a curated terminal failure", async () => {
    const jobRoot = await job()
    const input = pdfFixture()
    await mkdir(path.join(jobRoot, "input"), { mode: 0o700 })
    await writeFile(path.join(jobRoot, "input", "source.pdf"), input)
    let receive: (input: unknown) => void = () => undefined
    const terminal = Promise.withResolvers<DocumentRuntimeProtocol.WorkerEvent>()
    const transport: WorkerTransport = {
      onMessage: (listener) => (receive = listener),
      onDisconnect: () => undefined,
      send: async (event) => {
        if (event.type === "page-ready") {
          receive({
            protocolVersion: 1,
            type: "release-page",
            jobID: "job_223e4567-e89b-42d3-a456-426614174000",
            page: event.page,
            pageID: event.pageID,
            stderr: "private-native-canary",
          })
        }
        if (event.type === "failure") terminal.resolve(event)
      },
      close: () => undefined,
    }
    startWorker(await config(jobRoot), transport)
    receive({
      protocolVersion: 1,
      type: "render",
      jobID,
      inputPath: "input/source.pdf",
      inputBytes: input.byteLength,
      startPage: 1,
      pageCount: 1,
      limits: DocumentRuntimeLimits.requestedHard,
    })
    const failure = await terminal.promise
    expect(failure).toEqual({
      protocolVersion: 1,
      type: "failure",
      jobID,
      code: "invalid-request",
      stage: "worker",
      retryable: false,
    })
    expect(JSON.stringify(failure)).not.toContain("canary")
  })

  test("requires the probe target and hash to match trusted worker configuration", async () => {
    const jobRoot = await job()
    let receive: (input: unknown) => void = () => undefined
    const terminal = Promise.withResolvers<DocumentRuntimeProtocol.WorkerEvent>()
    const workerConfig = await config(jobRoot)
    startWorker(workerConfig, {
      onMessage: (listener) => (receive = listener),
      onDisconnect: () => undefined,
      send: async (event) => {
        if (event.type === "failure") terminal.resolve(event)
      },
      close: () => undefined,
    })
    receive({
      protocolVersion: 1,
      type: "probe",
      jobID,
      target: workerConfig.target,
      manifestSha256: "0".repeat(64),
    })
    expect(await terminal.promise).toEqual(expect.objectContaining({ code: "runtime-unavailable", stage: "probe" }))
  })

  test("requires a Tesseract component in the verified manifest", async () => {
    const jobRoot = await job()
    let receive: (input: unknown) => void = () => undefined
    const terminal = Promise.withResolvers<DocumentRuntimeProtocol.WorkerEvent>()
    const workerConfig = await config(jobRoot)
    startWorker(workerConfig, {
      onMessage: (listener) => (receive = listener),
      onDisconnect: () => undefined,
      send: async (event) => {
        if (event.type === "failure") terminal.resolve(event)
      },
      close: () => undefined,
    })
    receive({
      protocolVersion: 1,
      type: "probe",
      jobID,
      target: workerConfig.target,
      manifestSha256: workerConfig.manifestSha256,
    })
    expect(await terminal.promise).toEqual(expect.objectContaining({ code: "runtime-unavailable", stage: "probe" }))
  })

  test("disconnect resolves a pending page command and removes generated output", async () => {
    const jobRoot = await job()
    const input = pdfFixture()
    await mkdir(path.join(jobRoot, "input"), { mode: 0o700 })
    await writeFile(path.join(jobRoot, "input", "source.pdf"), input)
    let receive: (input: unknown) => void = () => undefined
    let disconnect: () => void = () => undefined
    const closed = Promise.withResolvers<void>()
    let output = ""
    startWorker(await config(jobRoot), {
      onMessage: (listener) => (receive = listener),
      onDisconnect: (listener) => (disconnect = listener),
      send: async (event) => {
        if (event.type !== "page-ready") return
        output = path.join(jobRoot, ...event.outputPath.split("/"))
        disconnect()
      },
      close: () => closed.resolve(),
    })
    receive({
      protocolVersion: 1,
      type: "render",
      jobID,
      inputPath: "input/source.pdf",
      inputBytes: input.byteLength,
      startPage: 1,
      pageCount: 1,
      limits: DocumentRuntimeLimits.requestedHard,
    })
    await closed.promise
    expect(await Bun.file(output).exists()).toBe(false)
  })
})

async function job() {
  const root = await mkdtemp(path.join(os.tmpdir(), "document-worker-"))
  roots.push(root)
  return root
}

async function config(jobRoot: string, runtime?: string) {
  const target = DocumentRuntimeTarget.fromHost(
    process.platform as DocumentRuntimeTarget.HostPlatform,
    process.arch as DocumentRuntimeTarget.HostArchitecture,
  )
  const runtimeRoot = runtime ?? path.resolve(import.meta.dir, "..", "dist", target)
  const manifestSha256 = createHash("sha256")
    .update(await readFile(path.join(runtimeRoot, "manifest.json")))
    .digest("hex")
  return {
    runtimeRoot,
    jobRoot,
    target,
    manifestSha256: DocumentRuntimeManifest.Digest.make(manifestSha256),
  }
}

async function isolatedRuntime(source: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "document-worker-isolated-"))
  roots.push(root)
  const runtime = path.join(root, "runtime")
  await cp(source, runtime, { recursive: true })
  return runtime
}
