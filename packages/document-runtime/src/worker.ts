import { DocumentRuntimeLimits } from "@koala-ai/core/document-runtime/limits"
import { DocumentRuntimeManifest } from "@koala-ai/core/document-runtime/manifest"
import { DocumentRuntimeProtocol } from "@koala-ai/core/document-runtime/protocol"
import { DocumentRuntimeTarget } from "@koala-ai/core/document-runtime/target"
import { Schema } from "effect"
import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { access, lstat, open, rm, writeFile } from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import path from "node:path"
import { RuntimeFailure, runtimeFailure } from "./error"
import { validateOcrImage } from "./image"
import { readDocx, readPptx, readXlsx } from "./office"
import { loadAndVerifyManifest } from "./manifest"
import { makePrivateDirectory, resolveInRoot, validateInputFile, validatePrivateJobRoot } from "./path"
import { openPdf, probeRenderer, readPdfBytes, renderPdfPage } from "./render"
import { runtimePaths, sanitizeNativeLoaderEnvironment } from "./runtime"
import { probeTesseract, runTesseract } from "./tesseract"
import { createNodeStreamTransport } from "./transport"

const decodeInitialRequest = DocumentRuntimeProtocol.decodeInitialRequest
const decodeRequest = DocumentRuntimeProtocol.decodeWorkerRequest
const encodeOutput = Schema.encodeSync(DocumentRuntimeProtocol.WorkerOutput)
const decodeOutput = DocumentRuntimeProtocol.decodeWorkerOutput
const decodeTarget = Schema.decodeUnknownSync(DocumentRuntimeTarget.Target)
const decodeDigest = Schema.decodeUnknownSync(DocumentRuntimeManifest.Digest)

export type WorkerConfig = {
  readonly runtimeRoot: string
  readonly jobRoot: string
  readonly target: DocumentRuntimeTarget.Target
  readonly manifestSha256: DocumentRuntimeManifest.Digest
}

export type WorkerTransport = {
  readonly onMessage: (listener: (input: unknown) => void) => void
  readonly onDisconnect: (listener: () => void) => void
  readonly send: (event: DocumentRuntimeProtocol.WorkerOutput) => Promise<void>
  readonly close: () => void
}

export type WorkerDependencies = {
  readonly removeGenerated?: (files: ReadonlyArray<string>) => Promise<void>
  readonly openOutput?: (value: string) => Promise<OutputHandle>
}

export interface OutputHandle {
  readonly read: (
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ) => Promise<{ readonly bytesRead: number }>
  readonly close: FileHandle["close"]
}

export function startWorker(config: WorkerConfig, transport: WorkerTransport, dependencies: WorkerDependencies = {}) {
  let request: DocumentRuntimeProtocol.StartRequest | undefined
  let order: DocumentRuntimeProtocol.OrderState | undefined
  let outputOrder: DocumentRuntimeProtocol.OutputOrderState | undefined
  let running = false
  let terminal = false
  let commandWaiter: ((message: DocumentRuntimeProtocol.WorkerRequest) => void) | undefined
  const commands: DocumentRuntimeProtocol.WorkerRequest[] = []
  const abort = new AbortController()
  let forcedFailure: RuntimeFailure | undefined
  let disconnected = false
  const generated = new Set<string>()
  const cleanup = () => cleanGenerated(generated, dependencies.removeGenerated)
  const openOutput =
    dependencies.openOutput ?? ((value: string) => open(value, constants.O_RDONLY | constants.O_NOFOLLOW))

  const interrupt = (failure: RuntimeFailure) => {
    forcedFailure = failure
    abort.abort()
    if (!request) return
    const message: typeof DocumentRuntimeProtocol.CancelRequest.Type = {
      protocolVersion: 1,
      type: "cancel",
      jobID: request.jobID,
    }
    if (commandWaiter) {
      const resolve = commandWaiter
      commandWaiter = undefined
      resolve(message)
      return
    }
    if (commands.length === DocumentRuntimeLimits.MaxNdjsonPendingWrites) {
      forcedFailure = new RuntimeFailure("invalid-order", "worker")
      abort.abort()
      return
    }
    commands.push(message)
  }

  const send = async (event: DocumentRuntimeProtocol.WorkerOutput) => {
    if (terminal) return
    if (order && !isOutputFrame(event)) {
      const next = DocumentRuntimeProtocol.advanceOrder(order, event)
      if (!next.ok) throw new RuntimeFailure("worker-failed", "worker")
      order = next.state
    }
    if (outputOrder) {
      const next = DocumentRuntimeProtocol.advanceOutputOrder(outputOrder, event)
      if (!next.ok) throw new RuntimeFailure("worker-failed", "worker")
      outputOrder = next.state
    }
    const encoded = decodeOutput(encodeOutput(event))
    await transport.send(encoded)
    if (event.type !== "completed" && event.type !== "cancelled" && event.type !== "failure") return
    terminal = true
    transport.close()
  }

  const fail = async (failure: RuntimeFailure) => {
    if (!request || terminal) return transport.close()
    const result = await cleanup().then(
      () => failure,
      () => new RuntimeFailure("worker-failed", "cleanup"),
    )
    try {
      await send({
        protocolVersion: 1,
        type: "failure",
        jobID: request.jobID,
        code: result.code,
        stage: result.stage,
        retryable: result.retryable,
      })
    } catch {
      terminal = true
      transport.close()
    }
  }

  const cancel = async () => {
    if (!request || terminal) return transport.close()
    try {
      await cleanup()
    } catch {
      return fail(new RuntimeFailure("worker-failed", "cleanup"))
    }
    try {
      await send({ protocolVersion: 1, type: "cancelled", jobID: request.jobID })
    } catch {
      terminal = true
      transport.close()
    }
  }

  const nextCommand = () => {
    const queued = commands.shift()
    if (queued) return Promise.resolve(queued)
    return new Promise<DocumentRuntimeProtocol.WorkerRequest>((resolve) => {
      commandWaiter = resolve
    })
  }

  transport.onDisconnect(() => {
    disconnected = true
    interrupt(new RuntimeFailure("worker-failed", "worker"))
    if (request) return
    terminal = true
    transport.close()
  })
  transport.onMessage((input) => {
    if (forcedFailure || terminal) return
    let message: DocumentRuntimeProtocol.WorkerRequest
    try {
      message = running ? decodeRequest(input) : decodeInitialRequest(input)
    } catch {
      if (!request) return transport.close()
      interrupt(new RuntimeFailure(protocolMismatch(input) ? "protocol-mismatch" : "invalid-request", "worker"))
      return
    }

    if (!running) {
      if (message.type === "release-page" || message.type === "cancel") return transport.close()
      running = true
      request = message
      order = DocumentRuntimeProtocol.beginOrder(message)
      outputOrder = DocumentRuntimeProtocol.beginOutputOrder(message)
      const jobDeadlineMs =
        message.type === "probe"
          ? 10 * 60_000
          : message.type === "read-office"
            ? DocumentRuntimeLimits.MaxJobDeadlineMs
            : message.limits.jobDeadlineMs
      const jobDeadline = setTimeout(
        () => interrupt(new RuntimeFailure("job-deadline-exceeded", "worker", true)),
        jobDeadlineMs,
      )
      void execute(message, config, abort.signal, generated, cleanup, send, nextCommand, openOutput)
        .then(
          () => clearTimeout(jobDeadline),
          async (error: unknown) => {
            clearTimeout(jobDeadline)
            if (disconnected) {
              terminal = true
              await cleanup().catch(() => undefined)
              transport.close()
              return
            }
            if (abort.signal.aborted && !forcedFailure) return cancel()
            return fail(runtimeFailure(forcedFailure ?? error, new RuntimeFailure("worker-failed", "worker")))
          },
        )
        .catch(() => transport.close())
      return
    }

    if (!request || message.jobID !== request.jobID) {
      interrupt(new RuntimeFailure("job-mismatch", "worker"))
      return
    }
    if (message.type === "probe" || message.type === "render") {
      interrupt(new RuntimeFailure("invalid-order", "worker"))
      return
    }
    if (message.type === "cancel") {
      if (!order) return
      const next = DocumentRuntimeProtocol.advanceOrder(order, message)
      if (!next.ok) {
        forcedFailure = new RuntimeFailure("invalid-order", "worker")
      } else {
        order = next.state
      }
      abort.abort()
      if (commandWaiter) {
        const resolve = commandWaiter
        commandWaiter = undefined
        resolve(message)
      } else {
        if (commands.length === DocumentRuntimeLimits.MaxNdjsonPendingWrites) {
          interrupt(new RuntimeFailure("invalid-order", "worker"))
        } else {
          commands.push(message)
        }
      }
      return
    }
    if (!order) return
    const next = DocumentRuntimeProtocol.advanceOrder(order, message)
    if (!next.ok) {
      interrupt(new RuntimeFailure(next.code === "job-mismatch" ? "job-mismatch" : "invalid-order", "worker"))
      return
    }
    order = next.state
    if (outputOrder && message.type === "release-page") {
      const outputNext = DocumentRuntimeProtocol.advanceOutputOrder(outputOrder, message)
      if (!outputNext.ok) {
        interrupt(new RuntimeFailure("invalid-order", "worker"))
        return
      }
      outputOrder = outputNext.state
    }
    if (commandWaiter) {
      const resolve = commandWaiter
      commandWaiter = undefined
      resolve(message)
      return
    }
    if (commands.length === DocumentRuntimeLimits.MaxNdjsonPendingWrites) {
      interrupt(new RuntimeFailure("invalid-order", "worker"))
      return
    }
    commands.push(message)
  })

  return { abort }
}

async function execute(
  request: DocumentRuntimeProtocol.StartRequest,
  config: WorkerConfig,
  signal: AbortSignal,
  generated: Set<string>,
  cleanup: () => Promise<void>,
  send: (event: DocumentRuntimeProtocol.WorkerOutput) => Promise<void>,
  nextCommand: () => Promise<DocumentRuntimeProtocol.WorkerRequest>,
  openOutput: (value: string) => Promise<OutputHandle>,
) {
  const root = await validatePrivateJobRoot(config.jobRoot)
  if (
    request.type === "probe" &&
    (request.target !== config.target || request.manifestSha256 !== config.manifestSha256)
  ) {
    throw new RuntimeFailure("runtime-unavailable", "probe")
  }
  const verified = await loadAndVerifyManifest(config.runtimeRoot, config.target, config.manifestSha256).catch(() => {
    throw new RuntimeFailure("runtime-unavailable", "probe")
  })
  const paths = runtimePaths(verified.root, config.target)
  sanitizeNativeLoaderEnvironment()

  await send({ protocolVersion: 1, type: "started", jobID: request.jobID, operation: request.type })
  if (request.type === "probe") {
    const tesseract = verified.manifest.components.find((component) => component.name === "tesseract")
    if (!tesseract) throw new RuntimeFailure("runtime-unavailable", "probe")
    await validateRuntimeTool(paths.tesseract, paths.tessdata)
    await probeTesseract({
      executablePath: paths.tesseract,
      tessdataPath: paths.tessdata,
      jobRoot: root,
      expectedVersion: tesseract.version,
      signal,
    })
    await probeRenderer({
      pdfEntry: path.join(paths.pdfRoot, "legacy", "build", "pdf.mjs"),
      canvasEntry: paths.canvasEntry,
    })
    await send({
      protocolVersion: 1,
      type: "completed",
      jobID: request.jobID,
      operation: "probe",
      pagesProcessed: 0,
      temporaryBytes: 0,
    })
    return
  }
  if (request.type === "ocr") {
    await executeOcr(request, paths, root, signal, generated, send, openOutput)
    return
  }
  if (request.type === "read-office") {
    await executeOffice(request, root, signal, generated, send, openOutput)
    return
  }
  await executeRender(request, paths, root, signal, generated, cleanup, send, nextCommand, openOutput)
}

async function executeRender(
  request: typeof DocumentRuntimeProtocol.RenderRequest.Type,
  runtime: ReturnType<typeof runtimePaths>,
  jobRoot: string,
  signal: AbortSignal,
  generated: Set<string>,
  cleanup: () => Promise<void>,
  send: (event: DocumentRuntimeProtocol.WorkerOutput) => Promise<void>,
  nextCommand: () => Promise<DocumentRuntimeProtocol.WorkerRequest>,
  openOutput: (value: string) => Promise<OutputHandle>,
) {
  const input = resolveInRoot(jobRoot, request.inputPath)
  await validateInputFile(jobRoot, input, request.inputBytes)
  const bytes = await readPdfBytes(input, request.inputBytes, request.limits.pdfInputBytes)
  const pdf = await openPdf({
    bytes,
    assets: {
      pdfEntry: path.join(runtime.pdfRoot, "legacy", "build", "pdf.mjs"),
      canvasEntry: runtime.canvasEntry,
      cMapDirectory: path.join(runtime.pdfRoot, "cmaps"),
      iccDirectory: path.join(runtime.pdfRoot, "iccs"),
      standardFontDirectory: path.join(runtime.pdfRoot, "standard_fonts"),
      wasmDirectory: path.join(runtime.pdfRoot, "wasm"),
    },
    limits: request.limits,
    signal,
  })
  try {
    const lastPage = request.startPage + request.pageCount - 1
    if (lastPage > pdf.document.numPages) throw new RuntimeFailure("page-out-of-range", "render")
    await makePrivateDirectory(jobRoot, "pages")
    await makePrivateDirectory(jobRoot, "ocr")
    let temporaryBytes = 0
    for (const page of Array.from({ length: request.pageCount }, (_, index) => request.startPage + index)) {
      signal.throwIfAborted()
      const pageID = DocumentRuntimeProtocol.PageID.make(`page_${randomUUID()}`)
      const outputPath = `pages/page-${page}-${pageID}.png`
      const absoluteOutput = resolveInRoot(jobRoot, outputPath)
      generated.add(absoluteOutput)
      const rendered = await renderPdfPage({
        document: pdf.document,
        annotationMode: pdf.annotationMode,
        canvasEntry: pdf.canvasEntry,
        jobRoot,
        page,
        outputPath: absoluteOutput,
        currentTemporaryBytes: temporaryBytes,
        limits: request.limits,
        signal,
      })
      temporaryBytes = rendered.temporaryBytes
      const pageTransfer = await streamOutput({
        jobID: request.jobID,
        kind: "page-png",
        page,
        pageID,
        sourcePath: DocumentRuntimeProtocol.OutputSourcePath.make(outputPath),
        path: absoluteOutput,
        declaredBytes: rendered.pngBytes,
        send,
        signal,
        openOutput,
      })
      await send({
        protocolVersion: 1,
        type: "page-ready",
        jobID: request.jobID,
        page,
        pageID,
        outputPath: DocumentRuntimeManifest.RelativePath.make(outputPath),
        outputID: pageTransfer.outputID,
        outputSha256: pageTransfer.sha256,
        dimensions: { width: rendered.width, height: rendered.height },
        pngBytes: rendered.pngBytes,
        temporaryBytes,
      })

      const command = await nextCommand()
      if (command.type === "cancel") throw new RuntimeFailure("worker-failed", "worker")
      if (command.type === "ocr") {
        if (command.source.kind !== "rendered-page" || command.page !== page || command.pageID !== pageID) {
          throw new RuntimeFailure("invalid-order", "worker")
        }
        const resultID = DocumentRuntimeProtocol.ResultID.make(`ocr_${randomUUID()}`)
        const tsvPath = `ocr/page-${page}-${resultID}.tsv`
        const absoluteTsv = resolveInRoot(jobRoot, tsvPath)
        generated.add(absoluteTsv)
        const result = await runTesseract({
          executablePath: runtime.tesseract,
          tessdataPath: runtime.tessdata,
          jobRoot,
          inputPath: absoluteOutput,
          outputPath: absoluteTsv,
          currentTemporaryBytes: temporaryBytes,
          limits: command.limits,
          signal,
        })
        temporaryBytes = result.temporaryBytes
        const tsvTransfer = await streamOutput({
          jobID: request.jobID,
          kind: "ocr-tsv",
          page,
          pageID,
          resultID,
          sourcePath: DocumentRuntimeProtocol.OutputSourcePath.make(tsvPath),
          path: absoluteTsv,
          declaredBytes: result.tsvBytes,
          send,
          signal,
          openOutput,
        })
        await send({
          protocolVersion: 1,
          type: "ocr-result",
          jobID: request.jobID,
          page,
          pageID,
          resultID,
          outputPath: DocumentRuntimeManifest.RelativePath.make(tsvPath),
          outputID: tsvTransfer.outputID,
          outputSha256: tsvTransfer.sha256,
          tsvBytes: result.tsvBytes,
          temporaryBytes,
        })
      } else if (command.type !== "release-page") {
        throw new RuntimeFailure("invalid-order", "worker")
      }

      const release = command.type === "ocr" ? await nextCommand() : command
      if (release.type === "cancel") throw new RuntimeFailure("worker-failed", "worker")
      if (release.type !== "release-page" || release.page !== page || release.pageID !== pageID) {
        throw new RuntimeFailure("invalid-order", "worker")
      }
      await cleanup()
      temporaryBytes = 0
    }
    await send({
      protocolVersion: 1,
      type: "completed",
      jobID: request.jobID,
      operation: "render",
      pagesProcessed: request.pageCount,
      temporaryBytes: 0,
    })
  } finally {
    await pdf.close()
  }
}

async function executeOffice(
  request: typeof DocumentRuntimeProtocol.ReadOfficeRequest.Type,
  jobRoot: string,
  signal: AbortSignal,
  generated: Set<string>,
  send: (event: DocumentRuntimeProtocol.WorkerOutput) => Promise<void>,
  openOutput: (value: string) => Promise<OutputHandle>,
) {
  const input = resolveInRoot(jobRoot, request.inputPath)
  await validateInputFile(jobRoot, input, request.inputBytes)
  signal.throwIfAborted()
  await makePrivateDirectory(jobRoot, "office")
  const sourcePath = DocumentRuntimeProtocol.OutputSourcePath.make("office/output.json")
  const output = resolveInRoot(jobRoot, sourcePath)
  generated.add(output)
  const bytes = await (async () => {
    if (request.format === "docx") return readDocx(input, request.inputBytes)
    if (request.format === "xlsx") return readXlsx(input, request.inputBytes)
    return readPptx(input, request.inputBytes)
  })().catch((error) => {
    if (error instanceof RuntimeFailure) throw error
    throw new RuntimeFailure("invalid-request", "input")
  })
  await writeFileAtomic(output, bytes)
  const pageID = DocumentRuntimeProtocol.PageID.make(`page_${randomUUID()}`)
  const transfer = await streamOutput({
    jobID: request.jobID,
    kind: "office-text",
    page: 1,
    pageID,
    sourcePath,
    path: output,
    declaredBytes: bytes.byteLength,
    send,
    signal,
    openOutput,
  })
  const sectionCount = Math.min(
    estimateSectionCount(bytes),
    DocumentRuntimeLimits.MaxOfficeSections,
  )
  await send({
    protocolVersion: 1,
    type: "office-ready",
    jobID: request.jobID,
    format: request.format,
    outputPath: sourcePath,
    outputID: transfer.outputID,
    outputSha256: transfer.sha256,
    outputBytes: bytes.byteLength,
    sectionCount,
  })
  await rm(output)
  generated.delete(output)
  await send({
    protocolVersion: 1,
    type: "completed",
    jobID: request.jobID,
    operation: "read-office",
    pagesProcessed: 0,
    temporaryBytes: 0,
  })
}

async function writeFileAtomic(file: string, bytes: Uint8Array) {
  await writeFile(file, bytes, { flag: "wx", mode: 0o600 })
}

function estimateSectionCount(bytes: Uint8Array): number {
  try {
    const parsed = JSON.parse(Buffer.from(bytes).toString("utf8"))
    return Array.isArray(parsed?.sections) ? parsed.sections.length : 0
  } catch {
    return 0
  }
}

async function executeOcr(
  request: typeof DocumentRuntimeProtocol.OcrRequest.Type,
  runtime: ReturnType<typeof runtimePaths>,
  jobRoot: string,
  signal: AbortSignal,
  generated: Set<string>,
  send: (event: DocumentRuntimeProtocol.WorkerOutput) => Promise<void>,
  openOutput: (value: string) => Promise<OutputHandle>,
) {
  if (request.source.kind !== "image") throw new RuntimeFailure("invalid-order", "input")
  const input = resolveInRoot(jobRoot, request.source.inputPath)
  await validateOcrImage(jobRoot, input, request.source.inputBytes, request.source.dimensions, request.limits)
  await makePrivateDirectory(jobRoot, "ocr")
  const resultID = DocumentRuntimeProtocol.ResultID.make(`ocr_${randomUUID()}`)
  const tsvPath = `ocr/page-${request.page}-${resultID}.tsv`
  const output = resolveInRoot(jobRoot, tsvPath)
  generated.add(output)
  const result = await runTesseract({
    executablePath: runtime.tesseract,
    tessdataPath: runtime.tessdata,
    jobRoot,
    inputPath: input,
    outputPath: output,
    currentTemporaryBytes: 0,
    limits: request.limits,
    signal,
  })
  const transfer = await streamOutput({
    jobID: request.jobID,
    kind: "ocr-tsv",
    page: request.page,
    pageID: request.pageID,
    resultID,
    sourcePath: DocumentRuntimeProtocol.OutputSourcePath.make(tsvPath),
    path: output,
    declaredBytes: result.tsvBytes,
    send,
    signal,
    openOutput,
  })
  await send({
    protocolVersion: 1,
    type: "ocr-result",
    jobID: request.jobID,
    page: request.page,
    pageID: request.pageID,
    resultID,
    outputPath: DocumentRuntimeManifest.RelativePath.make(tsvPath),
    outputID: transfer.outputID,
    outputSha256: transfer.sha256,
    tsvBytes: result.tsvBytes,
    temporaryBytes: result.temporaryBytes,
  })
  await rm(output)
  generated.delete(output)
  await send({
    protocolVersion: 1,
    type: "completed",
    jobID: request.jobID,
    operation: "ocr",
    pagesProcessed: 1,
    temporaryBytes: 0,
  })
}

async function streamOutput(input: {
  readonly jobID: DocumentRuntimeProtocol.JobID
  readonly kind: "page-png" | "ocr-tsv" | "office-text"
  readonly page: number
  readonly pageID: DocumentRuntimeProtocol.PageID
  readonly resultID?: DocumentRuntimeProtocol.ResultID
  readonly sourcePath: DocumentRuntimeProtocol.OutputSourcePath
  readonly path: string
  readonly declaredBytes: number
  readonly send: (event: DocumentRuntimeProtocol.WorkerOutput) => Promise<void>
  readonly signal: AbortSignal
  readonly openOutput: (value: string) => Promise<OutputHandle>
}) {
  const outputID = DocumentRuntimeProtocol.OutputID.make(`output_${randomUUID()}`)
  const start = makeOutputStart(input, outputID)
  await input.send(start)
  const handle = await input.openOutput(input.path)
  const digest = createHash("sha256")
  let actualBytes = 0
  let chunks = 0
  try {
    const buffer = Buffer.allocUnsafe(DocumentRuntimeLimits.MaxOutputChunkBytes)
    while (true) {
      input.signal.throwIfAborted()
      const read = await readLogicalChunk(handle, buffer)
      if (read.bytesRead === 0) break
      actualBytes += read.bytesRead
      if (actualBytes > input.declaredBytes) throw new RuntimeFailure("worker-failed", "worker")
      const bytes = buffer.subarray(0, read.bytesRead)
      digest.update(bytes)
      await input.send({
        protocolVersion: 1,
        type: "output-chunk",
        jobID: input.jobID,
        outputID,
        sequence: chunks,
        data: DocumentRuntimeProtocol.encodeCanonicalBase64(bytes),
      })
      chunks++
      if (read.eof) break
    }
  } finally {
    await handle.close()
  }
  if (actualBytes !== input.declaredBytes) throw new RuntimeFailure("worker-failed", "worker")
  const sha256 = DocumentRuntimeManifest.Digest.make(digest.digest("hex"))
  await input.send({
    protocolVersion: 1,
    type: "output-end",
    jobID: input.jobID,
    outputID,
    chunks,
    actualBytes,
    sha256,
  })
  return { outputID, sha256 }
}

export async function readLogicalChunk(handle: OutputHandle, buffer: Uint8Array) {
  let bytesRead = 0
  let eof = false
  while (bytesRead < buffer.byteLength) {
    const result = await handle.read(buffer, bytesRead, buffer.byteLength - bytesRead, null)
    if (result.bytesRead === 0) {
      eof = true
      break
    }
    bytesRead += result.bytesRead
  }
  return { bytesRead, eof }
}

function makeOutputStart(
  input: {
    readonly jobID: DocumentRuntimeProtocol.JobID
    readonly kind: "page-png" | "ocr-tsv" | "office-text"
    readonly page: number
    readonly pageID: DocumentRuntimeProtocol.PageID
    readonly resultID?: DocumentRuntimeProtocol.ResultID
    readonly sourcePath: DocumentRuntimeProtocol.OutputSourcePath
    readonly declaredBytes: number
  },
  outputID: DocumentRuntimeProtocol.OutputID,
): DocumentRuntimeProtocol.OutputStart {
  const common = {
    protocolVersion: 1 as const,
    type: "output-start" as const,
    jobID: input.jobID,
    outputID,
    page: input.page,
    pageID: input.pageID,
    sourcePath: input.sourcePath,
    declaredBytes: input.declaredBytes,
  }
  if (input.kind === "page-png") return { ...common, kind: input.kind }
  if (input.kind === "office-text") return { ...common, kind: input.kind }
  if (!input.resultID) throw new RuntimeFailure("worker-failed", "worker")
  return { ...common, kind: input.kind, resultID: input.resultID }
}

async function validateRuntimeTool(tesseractExecutable: string, tessdataPath: string) {
  const executable = await lstat(tesseractExecutable).catch(() => undefined)
  const tessdata = await lstat(tessdataPath).catch(() => undefined)
  if (!executable?.isFile() || executable.isSymbolicLink() || !tessdata?.isDirectory() || tessdata.isSymbolicLink()) {
    throw new RuntimeFailure("runtime-unavailable", "probe")
  }
  const data = await Promise.all(
    ["eng.traineddata", "osd.traineddata"].map((file) => lstat(path.join(tessdataPath, file)).catch(() => undefined)),
  )
  if (data.some((info) => !info?.isFile() || info.isSymbolicLink())) {
    throw new RuntimeFailure("runtime-unavailable", "probe")
  }
  if (process.platform !== "win32") {
    await access(tesseractExecutable, constants.X_OK).catch(() => {
      throw new RuntimeFailure("runtime-unavailable", "probe")
    })
  }
}

async function cleanGenerated(files: Set<string>, remove?: (files: ReadonlyArray<string>) => Promise<void>) {
  const generated = Array.from(files)
  await (remove ? remove(generated) : Promise.all(generated.map((file) => rm(file, { force: true }))))
  files.clear()
}

function isOutputFrame(event: DocumentRuntimeProtocol.WorkerOutput): event is DocumentRuntimeProtocol.OutputFrame {
  return event.type === "output-start" || event.type === "output-chunk" || event.type === "output-end"
}

export function startWorkerProcess(environment: NodeJS.ProcessEnv = process.env) {
  return startWorker(workerConfigFromEnvironment(environment), createNodeStreamTransport(process.stdin, process.stdout))
}

function protocolMismatch(input: unknown) {
  if (typeof input !== "object" || input === null || !("protocolVersion" in input)) return false
  return input.protocolVersion !== 1
}

export function workerConfigFromEnvironment(environment: NodeJS.ProcessEnv): WorkerConfig {
  if (
    !environment.DOCUMENT_RUNTIME_ROOT ||
    !environment.DOCUMENT_JOB_ROOT ||
    !environment.DOCUMENT_RUNTIME_TARGET ||
    !environment.DOCUMENT_RUNTIME_MANIFEST_SHA256
  ) {
    throw new RuntimeFailure("runtime-unavailable", "worker")
  }
  const paths = [environment.DOCUMENT_RUNTIME_ROOT, environment.DOCUMENT_JOB_ROOT]
  if (paths.some((value) => !path.isAbsolute(value))) throw new RuntimeFailure("runtime-unavailable", "worker")
  return {
    runtimeRoot: path.resolve(environment.DOCUMENT_RUNTIME_ROOT),
    jobRoot: path.resolve(environment.DOCUMENT_JOB_ROOT),
    target: decodeTarget(environment.DOCUMENT_RUNTIME_TARGET),
    manifestSha256: decodeDigest(environment.DOCUMENT_RUNTIME_MANIFEST_SHA256),
  }
}
