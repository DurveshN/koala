import {
  loadAndVerifyManifest,
  readImageDimensions,
  runtimePaths,
  terminateProcessTree,
  type VerifiedManifest,
} from "@koala-ai/document-runtime"
import { DocumentRuntimeLimits } from "@koala-ai/core/document-runtime/limits"
import { DocumentRuntimeManifest } from "@koala-ai/core/document-runtime/manifest"
import { DocumentRuntimeProtocol } from "@koala-ai/core/document-runtime/protocol"
import { DocumentRuntimeTarget } from "@koala-ai/core/document-runtime/target"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { Context, Effect, Layer, Queue, Schema, Semaphore } from "effect"
import { randomUUID } from "node:crypto"
import type { ChildProcess } from "node:child_process"
import { constants } from "node:fs"
import { chmod, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const DiagnosticBytes = DocumentRuntimeLimits.MaxNativeStderrBytes
const SignalCapacity = 32
const jobs = Semaphore.makeUnsafe(DocumentRuntimeLimits.MaxConcurrentJobs)
const encodeRequest = Schema.encodeSync(DocumentRuntimeProtocol.WorkerRequest)

export interface Config {
  readonly runtimePath: string
  readonly manifestSha256: string
  readonly requireReleaseReady?: boolean
}

export interface NativeConfinementLauncher {
  readonly launch: (input: {
    readonly workerPath: string
    readonly cwd: string
    readonly environment: NodeJS.ProcessEnv
  }) => ChildProcess
  // The launcher owns OS-level descendant containment, including after the immediate child exits.
  readonly terminate: (child: ChildProcess, graceMs: number) => Promise<void>
}

export interface Available {
  readonly status: "available"
  readonly target: DocumentRuntimeTarget.Target
  readonly runtimeVersion: string
  readonly releaseReady: boolean
}

export interface Unavailable {
  readonly status: "unavailable"
  readonly code: "runtime-unavailable"
}

export type Availability = Available | Unavailable

export interface OcrInput {
  readonly inputPath: string
  readonly page?: number
  readonly limits?: DocumentRuntimeLimits.Requested
}

export interface OcrResult {
  readonly page: number
  readonly dimensions: DocumentRuntimeLimits.RasterDimensions
  readonly tsv: Uint8Array
  readonly tsvBytes: number
}

export interface RenderInput {
  readonly inputPath: string
  readonly startPage: number
  readonly pageCount: number
  readonly limits?: DocumentRuntimeLimits.Requested
}

export interface ScopedPage {
  readonly page: number
  readonly pagePath: string
  readonly tsvPath: string
  readonly dimensions: DocumentRuntimeLimits.RasterDimensions
  readonly pngBytes: number
  readonly tsvBytes: number
}

export interface RenderResult {
  readonly pagesProcessed: number
}

export class RuntimeError extends Schema.TaggedErrorClass<RuntimeError>()("DocumentRuntimeError", {
  code: DocumentRuntimeProtocol.FailureCode,
  stage: DocumentRuntimeProtocol.FailureStage,
  retryable: Schema.Boolean,
}) {
  override get message() {
    return `Document runtime failed: ${this.code}`
  }
}

export interface Interface {
  readonly availability: () => Effect.Effect<Availability>
  readonly probe: () => Effect.Effect<Available, RuntimeError>
  readonly ocr: (input: OcrInput) => Effect.Effect<OcrResult, RuntimeError>
  readonly renderAndOcr: <A, E, R>(
    input: RenderInput,
    callback: (page: ScopedPage) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<RenderResult, RuntimeError | E, R>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/DocumentRuntime") {}

export function layer(config: Config | undefined, launcher?: NativeConfinementLauncher) {
  const policy = config ? { ...config } : undefined
  const probe: Interface["probe"] = Effect.fn("DocumentRuntime.probe")(() =>
    limited(
      withRuntime(policy, launcher, (runtime) =>
        withJob((jobRoot) =>
          Effect.gen(function* () {
            const request = yield* decodeInput(DocumentRuntimeProtocol.ProbeRequest, {
              protocolVersion: 1,
              type: "probe",
              jobID: jobID(),
              target: runtime.target,
              manifestSha256: runtime.manifestSha256,
            })
            return yield* runWorker(runtime, jobRoot, request, (session) => probeWorker(session, runtime))
          }),
        ),
      ),
    ),
  )

  const ocr: Interface["ocr"] = Effect.fn("DocumentRuntime.ocr")((input) =>
    limited(
      Effect.gen(function* () {
        const limits = yield* requestedLimits(input.limits)
        const page = yield* decodeInput(DocumentRuntimeLimits.PageNumber, input.page ?? 1)
        const runtime = yield* verifiedRuntime(policy, launcher)
        return yield* withJob((jobRoot) =>
          Effect.gen(function* () {
            const staged = yield* stageInput(jobRoot, input.inputPath, "input/image", limits.imageInputBytes)
            const dimensions = yield* attempt(
              () => readImageDimensions(jobRoot, staged.path, staged.bytes),
              failure("invalid-request", "input"),
            )
            const currentPageID = DocumentRuntimeProtocol.PageID.make(`page_${randomUUID()}`)
            const request = yield* decodeInput(DocumentRuntimeProtocol.OcrRequest, {
              protocolVersion: 1,
              type: "ocr",
              jobID: jobID(),
              page,
              pageID: currentPageID,
              source: {
                kind: "image",
                inputPath: DocumentRuntimeManifest.RelativePath.make("input/image"),
                inputBytes: staged.bytes,
                dimensions,
              },
              limits,
            })
            return yield* runWorker(runtime, jobRoot, request, (session, request) =>
              ocrWorker(session, request, jobRoot, dimensions),
            )
          }),
        )
      }),
    ),
  )

  const renderAndOcr: Interface["renderAndOcr"] = Effect.fn("DocumentRuntime.renderAndOcr")((input, callback) =>
    limited(
      Effect.gen(function* () {
        const limits = yield* requestedLimits(input.limits)
        const runtime = yield* verifiedRuntime(policy, launcher)
        return yield* withJob((jobRoot) =>
          Effect.gen(function* () {
            const staged = yield* stageInput(jobRoot, input.inputPath, "input/document.pdf", limits.pdfInputBytes)
            const request = yield* decodeInput(DocumentRuntimeProtocol.RenderRequest, {
              protocolVersion: 1,
              type: "render",
              jobID: jobID(),
              inputPath: "input/document.pdf",
              inputBytes: staged.bytes,
              startPage: input.startPage,
              pageCount: input.pageCount,
              limits,
            })
            return yield* runWorker(runtime, jobRoot, request, (session, decoded) =>
              renderWorker(session, decoded, jobRoot, callback),
            )
          }),
        )
      }),
    ),
  )

  return Layer.succeed(
    Service,
    Service.of({
      availability: () =>
        probe().pipe(
          Effect.map((available): Availability => available),
          Effect.catch(() => Effect.succeed({ status: "unavailable", code: "runtime-unavailable" } as const)),
        ),
      probe,
      ocr,
      renderAndOcr,
    }),
  )
}

const productionConfig = configFromEnvironment(process.env)
export const node = makeGlobalNode({ service: Service, layer: layer(productionConfig), deps: [] })

export function configFromEnvironment(environment: NodeJS.ProcessEnv): Config | undefined {
  const runtimePath = environment.KOALA_DOCUMENT_RUNTIME_PATH
  const manifestSha256 = environment.KOALA_DOCUMENT_RUNTIME_MANIFEST_SHA256
  const release = environment.KOALA_DOCUMENT_RUNTIME_REQUIRE_RELEASE_READY
  if (!runtimePath || !manifestSha256 || (release !== undefined && !["0", "1", "false", "true"].includes(release))) {
    return undefined
  }
  return {
    runtimePath,
    manifestSha256,
    requireReleaseReady: release === "1" || release === "true",
  }
}

interface Runtime {
  readonly target: DocumentRuntimeTarget.Target
  readonly manifest: VerifiedManifest
  readonly manifestSha256: DocumentRuntimeManifest.Digest
  readonly paths: ReturnType<typeof runtimePaths>
  readonly launcher: NativeConfinementLauncher
}

interface Session {
  readonly child: ChildProcess
  readonly queue: Queue.Queue<Signal>
  readonly request: DocumentRuntimeProtocol.StartRequest
  readonly launcher: NativeConfinementLauncher
  order: DocumentRuntimeProtocol.OrderState
  terminal: boolean
  diagnosticBytes: number
  overflowed: boolean
}

type Signal =
  | { readonly type: "message"; readonly value: unknown }
  | { readonly type: "error" }
  | { readonly type: "disconnect" }
  | { readonly type: "exit"; readonly code: number | null; readonly signal: NodeJS.Signals | null }

function limited<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return jobs.withPermits(1)(effect)
}

function withRuntime<A, E, R>(
  config: Config | undefined,
  launcher: NativeConfinementLauncher | undefined,
  use: (runtime: Runtime) => Effect.Effect<A, E, R>,
) {
  return Effect.flatMap(verifiedRuntime(config, launcher), use)
}

function verifiedRuntime(config: Config | undefined, launcher: NativeConfinementLauncher | undefined) {
  return Effect.gen(function* () {
    if (!config || !launcher || !path.isAbsolute(config.runtimePath)) {
      return yield* failure("runtime-unavailable", "probe")
    }
    const target = yield* hostTarget()
    const digest = yield* decodeInput(DocumentRuntimeManifest.Digest, config.manifestSha256).pipe(
      Effect.mapError(() => failure("runtime-unavailable", "probe")),
    )
    const manifest = yield* attempt(
      () => loadAndVerifyManifest(config.runtimePath, target, digest, config.requireReleaseReady ?? false),
      failure("runtime-unavailable", "probe"),
    )
    const paths = runtimePaths(manifest.root, target)
    const valid = yield* attempt(
      () => validateRuntimePaths(manifest.root, paths),
      failure("runtime-unavailable", "probe"),
    )
    if (!valid) return yield* failure("runtime-unavailable", "probe")
    return { target, manifest, manifestSha256: digest, paths, launcher }
  })
}

function hostTarget() {
  return Effect.try({
    try: () => {
      const platform = Schema.decodeUnknownSync(DocumentRuntimeTarget.HostPlatform)(process.platform)
      const architecture = Schema.decodeUnknownSync(DocumentRuntimeTarget.HostArchitecture)(process.arch)
      return DocumentRuntimeTarget.fromHost(platform, architecture)
    },
    catch: () => failure("runtime-unavailable", "probe"),
  })
}

async function validateRuntimePaths(root: string, paths: ReturnType<typeof runtimePaths>) {
  const files = [
    paths.worker,
    paths.tesseract,
    path.join(paths.tessdata, "eng.traineddata"),
    path.join(paths.tessdata, "osd.traineddata"),
    path.join(paths.pdfRoot, "legacy", "build", "pdf.mjs"),
    paths.canvasEntry,
  ]
  const directories = [
    paths.tessdata,
    path.join(paths.pdfRoot, "cmaps"),
    path.join(paths.pdfRoot, "iccs"),
    path.join(paths.pdfRoot, "standard_fonts"),
    path.join(paths.pdfRoot, "wasm"),
    paths.canvasNativeRoot,
  ]
  if (!(await Promise.all(files.map((file) => safeInfo(root, file, "file")))).every(Boolean)) return false
  return (await Promise.all(directories.map((directory) => safeInfo(root, directory, "directory")))).every(Boolean)
}

async function safeInfo(root: string, value: string, kind: "file" | "directory") {
  if (!inside(root, value)) return false
  const info = await lstat(value).catch(() => undefined)
  if (!info || info.isSymbolicLink()) return false
  return kind === "file" ? info.isFile() : info.isDirectory()
}

function withJob<A, E, R>(use: (jobRoot: string) => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    attempt(
      async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), "opencode-document-"))
        await chmod(root, 0o700)
        return await realpath(root)
      },
      failure("worker-failed", "cleanup"),
    ),
    use,
    (root) => Effect.promise(() => rm(root, { recursive: true, force: true }).catch(() => undefined)),
  )
}

function runWorker<A, E, R>(
  runtime: Runtime,
  jobRoot: string,
  request: DocumentRuntimeProtocol.StartRequest,
  use: (session: Session, request: DocumentRuntimeProtocol.StartRequest) => Effect.Effect<A, E | RuntimeError, R>,
) {
  return Effect.acquireUseRelease(
    spawnWorker(runtime, jobRoot, request),
    (session) =>
      Effect.andThen(send(session, request), use(session, request)).pipe(
        Effect.timeoutOrElse({
          duration: request.type === "probe" ? DocumentRuntimeLimits.MaxJobDeadlineMs : request.limits.jobDeadlineMs,
          orElse: () => failure("job-deadline-exceeded", "worker", true),
        }),
      ),
    (session) => Effect.promise(() => stopWorker(session)),
  )
}

function spawnWorker(runtime: Runtime, jobRoot: string, request: DocumentRuntimeProtocol.StartRequest) {
  return Effect.gen(function* () {
    const queue = yield* Queue.bounded<Signal>(SignalCapacity)
    const child = yield* Effect.try({
      try: () =>
        runtime.launcher.launch({
          workerPath: runtime.paths.worker,
          cwd: jobRoot,
          environment: workerEnvironment(runtime.manifest.root, runtime.target, runtime.manifestSha256, jobRoot),
        }),
      catch: () => failure("worker-failed", "worker"),
    })
    const session: Session = {
      child,
      queue,
      request,
      launcher: runtime.launcher,
      order: DocumentRuntimeProtocol.beginOrder(request),
      terminal: false,
      diagnosticBytes: 0,
      overflowed: false,
    }
    const offer = (signal: Signal) => {
      if (Queue.offerUnsafe(queue, signal)) return
      session.overflowed = true
      child.kill("SIGKILL")
    }
    const diagnostic = (chunk: Buffer | string) => {
      session.diagnosticBytes = Math.min(DiagnosticBytes + 1, session.diagnosticBytes + Buffer.byteLength(chunk))
      if (session.diagnosticBytes <= DiagnosticBytes || session.overflowed) return
      session.overflowed = true
      child.kill("SIGKILL")
    }
    child.on("message", (value: unknown) => offer({ type: "message", value }))
    child.once("error", () => offer({ type: "error" }))
    child.once("disconnect", () => offer({ type: "disconnect" }))
    child.once("exit", (code, signal) => offer({ type: "exit", code, signal }))
    child.stdout?.on("data", diagnostic)
    child.stderr?.on("data", diagnostic)
    return session
  })
}

function probeWorker(session: Session, runtime: Runtime): Effect.Effect<Available, RuntimeError> {
  return Effect.gen(function* () {
    yield* expectType(session, "started", (event) => event.operation === "probe")
    yield* expectType(session, "completed", (event) => event.operation === "probe" && event.pagesProcessed === 0)
    yield* cleanExit(session)
    return {
      status: "available",
      target: runtime.target,
      runtimeVersion: runtime.manifest.manifest.runtimeVersion,
      releaseReady: runtime.manifest.manifest.releaseReady,
    }
  })
}

function ocrWorker(
  session: Session,
  request: DocumentRuntimeProtocol.StartRequest,
  jobRoot: string,
  dimensions: DocumentRuntimeLimits.RasterDimensions,
): Effect.Effect<OcrResult, RuntimeError> {
  return Effect.gen(function* () {
    if (request.type !== "ocr") return yield* failure("invalid-request", "input")
    yield* expectType(session, "started", (event) => event.operation === "ocr")
    const result = yield* expectType(
      session,
      "ocr-result",
      (event) => event.page === request.page && event.pageID === request.pageID,
    )
    const output = yield* outputPath(jobRoot, result.outputPath, "ocr/", result.tsvBytes)
    const tsv = yield* attempt(() => readFile(output), failure("worker-failed", "worker"))
    if (tsv.byteLength !== result.tsvBytes) return yield* failure("worker-failed", "worker")
    yield* expectType(session, "completed", (event) => event.operation === "ocr" && event.pagesProcessed === 1)
    yield* cleanExit(session)
    return { page: request.page, dimensions, tsv, tsvBytes: result.tsvBytes }
  })
}

function renderWorker<A, E, R>(
  session: Session,
  request: DocumentRuntimeProtocol.StartRequest,
  jobRoot: string,
  callback: (page: ScopedPage) => Effect.Effect<A, E, R>,
): Effect.Effect<RenderResult, RuntimeError | E, R> {
  return Effect.gen(function* () {
    if (request.type !== "render") return yield* failure("invalid-request", "input")
    yield* expectType(session, "started", (event) => event.operation === "render")
    const seen = new Set<number>()
    for (const page of Array.from({ length: request.pageCount }, (_, index) => request.startPage + index)) {
      const rendered = yield* expectType(session, "page-ready", (event) => event.page === page && !seen.has(page))
      seen.add(page)
      const pagePath = yield* outputPath(jobRoot, rendered.outputPath, "pages/", rendered.pngBytes)
      const ocrRequest: typeof DocumentRuntimeProtocol.OcrRequest.Type = {
        protocolVersion: 1,
        type: "ocr",
        jobID: request.jobID,
        page,
        pageID: rendered.pageID,
        source: { kind: "rendered-page" },
        limits: request.limits,
      }
      yield* sendCommand(session, ocrRequest)
      const ocr = yield* expectType(
        session,
        "ocr-result",
        (event) => event.page === page && event.pageID === rendered.pageID,
      )
      const tsvPath = yield* outputPath(jobRoot, ocr.outputPath, "ocr/", ocr.tsvBytes)
      yield* callback({
        page,
        pagePath,
        tsvPath,
        dimensions: rendered.dimensions,
        pngBytes: rendered.pngBytes,
        tsvBytes: ocr.tsvBytes,
      })
      yield* sendCommand(session, {
        protocolVersion: 1,
        type: "release-page",
        jobID: request.jobID,
        page,
        pageID: rendered.pageID,
      })
    }
    yield* expectType(
      session,
      "completed",
      (event) => event.operation === "render" && event.pagesProcessed === request.pageCount,
    )
    yield* cleanExit(session)
    return { pagesProcessed: request.pageCount }
  })
}

function expectType<Type extends DocumentRuntimeProtocol.WorkerEvent["type"]>(
  session: Session,
  type: Type,
  matches: (event: Extract<DocumentRuntimeProtocol.WorkerEvent, { readonly type: Type }>) => boolean,
) {
  return Effect.gen(function* () {
    const event = yield* nextEvent(session)
    if (event.type !== type) return yield* failure("invalid-order", "worker")
    const narrowed = event as Extract<DocumentRuntimeProtocol.WorkerEvent, { readonly type: Type }>
    if (!matches(narrowed)) return yield* failure("invalid-order", "worker")
    return narrowed
  })
}

function nextEvent(session: Session): Effect.Effect<DocumentRuntimeProtocol.WorkerEvent, RuntimeError> {
  return Effect.gen(function* () {
    const signal = yield* Queue.take(session.queue)
    if (session.overflowed) return yield* failure("worker-failed", "worker")
    if (signal.type !== "message") return yield* failure("worker-failed", "worker")
    const event = yield* decodeInput(DocumentRuntimeProtocol.WorkerEvent, signal.value).pipe(
      Effect.mapError(() => failure(protocolMismatch(signal.value) ? "protocol-mismatch" : "worker-failed", "worker")),
    )
    const next = DocumentRuntimeProtocol.advanceOrder(session.order, event)
    if (!next.ok) return yield* failure(next.code === "job-mismatch" ? "job-mismatch" : "invalid-order", "worker")
    session.order = next.state
    if (event.type === "failure") {
      session.terminal = true
      return yield* new RuntimeError({ code: event.code, stage: event.stage, retryable: event.retryable })
    }
    if (event.type === "cancelled") {
      session.terminal = true
      return yield* failure("worker-failed", "worker")
    }
    if (event.type === "completed") session.terminal = true
    return event
  })
}

function sendCommand(session: Session, request: DocumentRuntimeProtocol.WorkerRequest) {
  return Effect.gen(function* () {
    const next = DocumentRuntimeProtocol.advanceOrder(session.order, request)
    if (!next.ok) return yield* failure(next.code === "job-mismatch" ? "job-mismatch" : "invalid-order", "worker")
    yield* send(session, request)
    session.order = next.state
  })
}

function send(session: Session, request: DocumentRuntimeProtocol.WorkerRequest) {
  return attempt(
    () =>
      new Promise<void>((resolve, reject) => {
        if (!session.child.connected) return reject(new Error("disconnected"))
        session.child.send(encodeRequest(request), (error) => (error ? reject(error) : resolve()))
      }),
    failure("worker-failed", "worker"),
  )
}

function cleanExit(session: Session): Effect.Effect<void, RuntimeError> {
  return Effect.gen(function* () {
    while (true) {
      const signal = yield* Queue.take(session.queue)
      if (session.overflowed || signal.type === "error" || signal.type === "message") {
        return yield* failure("worker-failed", "worker")
      }
      if (signal.type === "disconnect") continue
      if (signal.code !== 0 || signal.signal !== null) return yield* failure("worker-failed", "worker")
      return
    }
  })
}

function outputPath(jobRoot: string, relative: DocumentRuntimeManifest.RelativePath, prefix: string, bytes: number) {
  return Effect.gen(function* () {
    if (!relative.startsWith(prefix)) return yield* failure("invalid-request", "cleanup")
    const output = path.resolve(jobRoot, ...relative.split("/"))
    if (!inside(jobRoot, output)) return yield* failure("invalid-request", "cleanup")
    const valid = yield* attempt(
      async () => {
        const info = await lstat(output)
        return info.isFile() && !info.isSymbolicLink() && info.size === bytes && inside(jobRoot, await realpath(output))
      },
      failure("invalid-request", "cleanup"),
    )
    if (!valid) return yield* failure("invalid-request", "cleanup")
    return output
  })
}

function requestedLimits(input: DocumentRuntimeLimits.Requested | undefined) {
  return decodeInput(DocumentRuntimeLimits.Requested, input ?? DocumentRuntimeLimits.requestedHard)
}

function decodeInput<A>(schema: Schema.Decoder<A>, value: unknown) {
  return Effect.try({
    try: () => Schema.decodeUnknownSync(schema)(value),
    catch: () => failure("invalid-request", "input"),
  })
}

function jobID() {
  return DocumentRuntimeProtocol.JobID.make(`job_${randomUUID()}`)
}

async function validateSource(source: string, maximumBytes: number) {
  if (!path.isAbsolute(source)) throw new Error("invalid source")
  const info = await lstat(source)
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > maximumBytes)
    throw new Error("invalid source")
  const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const bytes = await handle.readFile()
    const after = await handle.stat()
    if (!after.isFile() || bytes.byteLength !== info.size || after.size !== info.size) throw new Error("changed source")
    return bytes
  } finally {
    await handle.close()
  }
}

function stageInput(jobRoot: string, source: string, relative: string, maximumBytes: number) {
  return attempt(
    async () => {
      const bytes = await validateSource(source, maximumBytes)
      const destination = path.join(jobRoot, ...relative.split("/"))
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
      await writeFile(destination, bytes, { flag: "wx", mode: 0o600 })
      return { path: destination, bytes: bytes.byteLength }
    },
    failure("invalid-request", "input"),
  )
}

function failure(
  code: DocumentRuntimeProtocol.FailureCode,
  stage: DocumentRuntimeProtocol.FailureStage,
  retryable = false,
) {
  return new RuntimeError({ code, stage, retryable })
}

function attempt<A>(tryPromise: () => PromiseLike<A>, error: RuntimeError) {
  return Effect.tryPromise({ try: tryPromise, catch: () => error })
}

async function stopWorker(session: Session) {
  if (session.child.exitCode !== null || session.child.signalCode !== null) {
    if (
      !session.terminal &&
      !(await settleWithin(
        Promise.resolve().then(() =>
          session.launcher.terminate(session.child, DocumentRuntimeLimits.MaxCancellationGraceMs),
        ),
        DocumentRuntimeLimits.MaxCancellationGraceMs,
      ))
    ) {
      throw failure("worker-failed", "cleanup")
    }
    return
  }
  if (!session.terminal && session.child.connected) {
    try {
      session.child.send(
        encodeRequest({ protocolVersion: 1, type: "cancel", jobID: session.request.jobID }),
        () => undefined,
      )
    } catch {}
  }
  const exited = await waitForExit(session.child, DocumentRuntimeLimits.MaxCancellationGraceMs)
  if (exited) return
  if (!(await terminateWithDeadline(session))) throw failure("worker-failed", "cleanup")
}

async function terminateWithDeadline(session: Session) {
  const grace = DocumentRuntimeLimits.MaxCancellationGraceMs
  const confined = await settleWithin(Promise.resolve().then(() => session.launcher.terminate(session.child, grace)), grace)
  if (confined && (await waitForExit(session.child, grace))) return true
  const fallback = await settleWithin(
    terminateProcessTree(session.child, process.platform, process.env.SystemRoot, Math.floor(grace / 2)),
    grace,
  )
  return fallback && (session.child.exitCode !== null || session.child.signalCode !== null)
}

function settleWithin(promise: Promise<void>, timeoutMs: number) {
  return new Promise<boolean>((resolve) => {
    let settled = false
    const complete = (result: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(result)
    }
    const timeout = setTimeout(() => complete(false), timeoutMs)
    void promise.then(() => complete(true), () => complete(false))
  })
}

function waitForExit(child: ChildProcess, timeoutMs: number) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise<boolean>((resolve) => {
    let settled = false
    const complete = (exited: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      child.off("exit", onExit)
      resolve(exited)
    }
    const onExit = () => complete(true)
    const timeout = setTimeout(() => complete(false), timeoutMs)
    child.once("exit", onExit)
    if (child.exitCode !== null || child.signalCode !== null) complete(true)
  })
}

export function workerEnvironment(
  runtimeRoot: string,
  target: DocumentRuntimeTarget.Target,
  manifestSha256: DocumentRuntimeManifest.Digest,
  jobRoot: string,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    DISABLE_SYSTEM_FONTS_LOAD: "1",
    DOCUMENT_JOB_ROOT: jobRoot,
    DOCUMENT_RUNTIME_MANIFEST_SHA256: manifestSha256,
    DOCUMENT_RUNTIME_ROOT: runtimeRoot,
    DOCUMENT_RUNTIME_TARGET: target,
    ELECTRON_RUN_AS_NODE: "1",
    LANG: "C",
    LC_ALL: "C",
    TEMP: jobRoot,
    TMP: jobRoot,
    TMPDIR: jobRoot,
    TZ: "UTC",
    ...(process.platform === "win32" && source.SystemRoot && path.isAbsolute(source.SystemRoot)
      ? { SystemRoot: source.SystemRoot, WINDIR: source.SystemRoot }
      : {}),
  }
}

function inside(root: string, value: string) {
  const relation = path.relative(root, value)
  return relation !== "" && relation !== ".." && !relation.startsWith(`..${path.sep}`) && !path.isAbsolute(relation)
}

function protocolMismatch(value: unknown) {
  return typeof value === "object" && value !== null && "protocolVersion" in value && value.protocolVersion !== 1
}

export * as DocumentRuntime from "./runtime"
