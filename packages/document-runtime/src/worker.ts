import { DocumentRuntimeLimits } from "@koala-ai/core/document-runtime/limits"
import { DocumentRuntimeManifest } from "@koala-ai/core/document-runtime/manifest"
import { DocumentRuntimeProtocol } from "@koala-ai/core/document-runtime/protocol"
import { DocumentRuntimeTarget } from "@koala-ai/core/document-runtime/target"
import { Schema } from "effect"
import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { access, lstat, rm } from "node:fs/promises"
import path from "node:path"
import { RuntimeFailure, runtimeFailure } from "./error"
import { validateOcrImage } from "./image"
import { createLegacyIpcTransport } from "./legacy-ipc"
import { loadAndVerifyManifest } from "./manifest"
import { makePrivateDirectory, resolveInRoot, validateInputFile, validatePrivateJobRoot } from "./path"
import { openPdf, probeRenderer, readPdfBytes, renderPdfPage } from "./render"
import { runtimePaths, sanitizeNativeLoaderEnvironment } from "./runtime"
import { probeTesseract, runTesseract } from "./tesseract"
import { createNodeStreamTransport } from "./transport"

const decodeInitialRequest = DocumentRuntimeProtocol.decodeInitialRequest
const decodeRequest = DocumentRuntimeProtocol.decodeWorkerRequest
const encodeEvent = Schema.encodeSync(DocumentRuntimeProtocol.WorkerEvent)
const decodeEvent = DocumentRuntimeProtocol.decodeWorkerEvent
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
  readonly send: (event: DocumentRuntimeProtocol.WorkerEvent) => Promise<void>
  readonly close: () => void
}

export type WorkerDependencies = {
  readonly removeGenerated?: (files: ReadonlyArray<string>) => Promise<void>
}

export function startWorker(config: WorkerConfig, transport: WorkerTransport, dependencies: WorkerDependencies = {}) {
  let request: DocumentRuntimeProtocol.StartRequest | undefined
  let order: DocumentRuntimeProtocol.OrderState | undefined
  let running = false
  let terminal = false
  let commandWaiter: ((message: DocumentRuntimeProtocol.WorkerRequest) => void) | undefined
  const commands: DocumentRuntimeProtocol.WorkerRequest[] = []
  const abort = new AbortController()
  let forcedFailure: RuntimeFailure | undefined
  let disconnected = false
  const generated = new Set<string>()
  const cleanup = () => cleanGenerated(generated, dependencies.removeGenerated)

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

  const send = async (event: DocumentRuntimeProtocol.WorkerEvent) => {
    if (terminal) return
    if (order) {
      const next = DocumentRuntimeProtocol.advanceOrder(order, event)
      if (!next.ok) throw new RuntimeFailure("worker-failed", "worker")
      order = next.state
    }
    const encoded = decodeEvent(encodeEvent(event))
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
      const jobDeadline = setTimeout(
        () => interrupt(new RuntimeFailure("job-deadline-exceeded", "worker", true)),
        message.type === "probe" ? 10 * 60_000 : message.limits.jobDeadlineMs,
      )
      void execute(message, config, abort.signal, generated, cleanup, send, nextCommand).then(
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
      ).catch(() => transport.close())
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
  send: (event: DocumentRuntimeProtocol.WorkerEvent) => Promise<void>,
  nextCommand: () => Promise<DocumentRuntimeProtocol.WorkerRequest>,
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
    await executeOcr(request, paths, root, signal, generated, send)
    return
  }
  await executeRender(request, paths, root, signal, generated, cleanup, send, nextCommand)
}

async function executeRender(
  request: typeof DocumentRuntimeProtocol.RenderRequest.Type,
  runtime: ReturnType<typeof runtimePaths>,
  jobRoot: string,
  signal: AbortSignal,
  generated: Set<string>,
  cleanup: () => Promise<void>,
  send: (event: DocumentRuntimeProtocol.WorkerEvent) => Promise<void>,
  nextCommand: () => Promise<DocumentRuntimeProtocol.WorkerRequest>,
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
      await send({
        protocolVersion: 1,
        type: "page-ready",
        jobID: request.jobID,
        page,
        pageID,
        outputPath: DocumentRuntimeManifest.RelativePath.make(outputPath),
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
        await send({
          protocolVersion: 1,
          type: "ocr-result",
          jobID: request.jobID,
          page,
          pageID,
          resultID,
          outputPath: DocumentRuntimeManifest.RelativePath.make(tsvPath),
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

async function executeOcr(
  request: typeof DocumentRuntimeProtocol.OcrRequest.Type,
  runtime: ReturnType<typeof runtimePaths>,
  jobRoot: string,
  signal: AbortSignal,
  generated: Set<string>,
  send: (event: DocumentRuntimeProtocol.WorkerEvent) => Promise<void>,
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
  await send({
    protocolVersion: 1,
    type: "ocr-result",
    jobID: request.jobID,
    page: request.page,
    pageID: request.pageID,
    resultID,
    outputPath: DocumentRuntimeManifest.RelativePath.make(tsvPath),
    tsvBytes: result.tsvBytes,
    temporaryBytes: result.temporaryBytes,
  })
  await send({
    protocolVersion: 1,
    type: "completed",
    jobID: request.jobID,
    operation: "ocr",
    pagesProcessed: 1,
    temporaryBytes: result.temporaryBytes,
  })
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

export function startWorkerProcess(environment: NodeJS.ProcessEnv = process.env) {
  return startWorker(workerConfigFromEnvironment(environment), createNodeStreamTransport(process.stdin, process.stdout))
}

export function startLegacyIpcWorker(environment: NodeJS.ProcessEnv = process.env) {
  return startWorker(workerConfigFromEnvironment(environment), createLegacyIpcTransport())
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

if (process.send) {
  try {
    startLegacyIpcWorker()
  } catch {
    if (process.connected) process.disconnect()
  }
}
