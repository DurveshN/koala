import { DocumentGenerate } from "@koala-ai/core/document/generate"
import {
  loadAndVerifyManifest,
  readImageDimensions,
  runtimePaths,
  type VerifiedManifest,
} from "@koala-ai/document-runtime"
import { DocumentRuntimeLimits } from "@koala-ai/core/document-runtime/limits"
import { DocumentRuntimeManifest } from "@koala-ai/core/document-runtime/manifest"
import { DocumentRuntimeProtocol } from "@koala-ai/core/document-runtime/protocol"
import { DocumentSandboxProtocol } from "@koala-ai/core/document-runtime/sandbox-protocol"
import { DocumentRuntimeTarget } from "@koala-ai/core/document-runtime/target"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { Context, Effect, Layer, Queue, Schema, Semaphore } from "effect"
import { randomBytes, randomUUID } from "node:crypto"
import { fork, type ChildProcess } from "node:child_process"
import { constants } from "node:fs"
import { lstat, mkdir, open, realpath, writeFile } from "node:fs/promises"
import path from "node:path"
import { DocumentDiagnostics } from "./diagnostics"
import { DocumentJobRoot } from "./job-root"
import { DocumentOuterChannel } from "./outer-channel"
import { DocumentPendingOutput } from "./pending-output"
import { DocumentPendingRoot } from "./pending-root"
import { DocumentProcess } from "./process"
import { DocumentSandboxPolicy } from "./sandbox-policy"
import { DocumentTeardownReceipt } from "./teardown-receipt"

const DiagnosticBytes = DocumentRuntimeLimits.MaxInnerStderrBytes
const SignalCapacity = DocumentRuntimeLimits.MaxOuterPendingMessages
// The proxy's Windows teardown (process sweep plus SRT cleanup/reset) is bounded at 6 s + 6 s; the
// parent's closure window must stay above that worst case or a slow teardown poisons the runtime.
const CleanupWatchdogMs = process.platform === "win32" ? 20_000 : 10_000
const DeletionReserveMs = 2_000
// A probe only verifies the runtime and loads the renderer; anything longer indicates a stuck worker.
const ProbeDeadlineMs = 60_000
const jobs = Semaphore.makeUnsafe(DocumentRuntimeLimits.MaxConcurrentJobs)
const unsafeJobRoots = new Set<string>()

export interface Config {
  readonly runtimePath: string
  readonly manifestSha256: string
  readonly proxyPath: string
  readonly proxyAssetsRoot: string
  readonly requireReleaseReady?: boolean
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

export interface ReadOfficeInput {
  readonly inputPath: string
  readonly format: "docx" | "pptx" | "xlsx"
}

export interface OfficeSection {
  readonly type: "paragraph" | "table" | "slide" | "sheet"
  readonly heading?: string
  readonly body: string
}

export interface ReadOfficeResult {
  readonly title?: string
  readonly author?: string
  readonly sections: ReadonlyArray<OfficeSection>
}

export interface CreateDocxInput {
  readonly contents: typeof DocumentGenerate.DocxContent.Type
}

export type CreateDocumentInput = {
  readonly [Format in DocumentGenerate.Format]: {
    readonly format: Format
    readonly contents: (typeof DocumentGenerate.ContentInput)[Format]["Type"]["contents"]
  }
}[DocumentGenerate.Format]

export interface CreateDocxResult {
  readonly path: string
  readonly bytes: Uint8Array
}

export interface ReadPdfInput {
  readonly inputPath: string
  readonly limits?: DocumentRuntimeLimits.Requested
}

export interface ReadPdfPage {
  readonly number: number
  readonly rotation: number
  readonly mediaBox: ReadonlyArray<number>
  readonly blocks: ReadonlyArray<{ readonly text: string }>
}

export interface ReadPdfResult {
  readonly title?: string
  readonly author?: string
  readonly subject?: string
  readonly creator?: string
  readonly producer?: string
  readonly creationDate?: string
  readonly modDate?: string
  readonly pageCount: number
  readonly pages: ReadonlyArray<ReadPdfPage>
}

export class RuntimeError extends Schema.TaggedErrorClass<RuntimeError>()("DocumentRuntimeError", {
  code: DocumentRuntimeProtocol.FailureCode,
  stage: DocumentRuntimeProtocol.FailureStage,
  retryable: Schema.Boolean,
  detail: Schema.optionalKey(Schema.String),
}) {
  override get message() {
    return `Document runtime failed: ${this.code}${this.detail ? ` (${this.detail})` : ""}`
  }
}

export interface Interface {
  readonly availability: () => Effect.Effect<Availability>
  readonly probe: () => Effect.Effect<Available, RuntimeError>
  readonly ocr: (input: OcrInput) => Effect.Effect<OcrResult, RuntimeError>
  readonly readOffice: (input: ReadOfficeInput) => Effect.Effect<ReadOfficeResult, RuntimeError>
  readonly readPdf: (input: ReadPdfInput) => Effect.Effect<ReadPdfResult, RuntimeError>
  readonly createDocx: (input: CreateDocxInput) => Effect.Effect<CreateDocxResult, RuntimeError>
  readonly createDocument: (input: CreateDocumentInput) => Effect.Effect<CreateDocxResult, RuntimeError>
  readonly renderAndOcr: <A, E, R>(
    input: RenderInput,
    callback: (page: ScopedPage) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<RenderResult, RuntimeError | E, R>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/DocumentRuntime") {}

export function layer(config: Config | undefined) {
  const policy = config ? { ...config } : undefined
  const health = makeHealth()
  const probe: Interface["probe"] = Effect.fn("DocumentRuntime.probe")(() =>
    limited(
      withRuntime(health, policy, (runtime) =>
        withJob(health, (job) =>
          Effect.gen(function* () {
            const request = yield* decodeInput(DocumentRuntimeProtocol.ProbeRequest, {
              protocolVersion: 1,
              type: "probe",
              jobID: jobID(),
              target: runtime.target,
              manifestSha256: runtime.manifestSha256,
            })
            return yield* runProxy(health, runtime, job, request, (session) => probeWorker(session, runtime))
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
        const runtime = yield* verifiedRuntime(health, policy)
        return yield* withJob(health, (job) =>
          Effect.gen(function* () {
            const staged = yield* stageInput(job.path, input.inputPath, "input/image", limits.imageInputBytes)
            const dimensions = yield* attempt(
              () => readImageDimensions(job.path, staged.path, staged.bytes),
              failure("invalid-request", "input"),
            )
            const request = yield* decodeInput(DocumentRuntimeProtocol.ImageOcrRequest, {
              protocolVersion: 1,
              type: "ocr",
              jobID: jobID(),
              page,
              pageID: DocumentRuntimeProtocol.PageID.make(`page_${randomUUID()}`),
              source: {
                kind: "image",
                inputPath: DocumentRuntimeManifest.RelativePath.make("input/image"),
                inputBytes: staged.bytes,
                dimensions,
              },
              limits,
            })
            return yield* runProxy(health, runtime, job, request, (session, decoded) =>
              ocrWorker(session, decoded, dimensions),
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
        const runtime = yield* verifiedRuntime(health, policy)
        return yield* withJob(health, (job) =>
          Effect.gen(function* () {
            const staged = yield* stageInput(job.path, input.inputPath, "input/document.pdf", limits.pdfInputBytes)
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
            return yield* runProxy(health, runtime, job, request, (session, decoded) =>
              renderWorker(session, decoded, callback),
            )
          }),
        )
      }),
    ),
  )

  const readOffice: Interface["readOffice"] = Effect.fn("DocumentRuntime.readOffice")((input) =>
    limited(
      Effect.gen(function* () {
        const runtime = yield* verifiedRuntime(health, policy)
        return yield* withJob(health, (job) =>
          Effect.gen(function* () {
            const staged = yield* stageInput(
              job.path,
              input.inputPath,
              `input/document.${input.format}`,
              DocumentRuntimeLimits.MaxOfficeInputBytes,
            )
            const request = yield* decodeInput(DocumentRuntimeProtocol.ReadOfficeRequest, {
              protocolVersion: 1,
              type: "read-office",
              jobID: jobID(),
              format: input.format,
              inputPath: DocumentRuntimeManifest.RelativePath.make(`input/document.${input.format}`),
              inputBytes: staged.bytes,
            })
            return yield* runProxy(health, runtime, job, request, (session) => officeWorker(session, input.format))
          }),
        )
      }),
    ),
  )

  const readPdf: Interface["readPdf"] = Effect.fn("DocumentRuntime.readPdf")((input) =>
    limited(
      Effect.gen(function* () {
        const limits = yield* requestedLimits(input.limits)
        const runtime = yield* verifiedRuntime(health, policy)
        return yield* withJob(health, (job) =>
          Effect.gen(function* () {
            const staged = yield* stageInput(job.path, input.inputPath, "input/document.pdf", limits.pdfInputBytes)
            const request = yield* decodeInput(DocumentRuntimeProtocol.ReadPdfRequest, {
              protocolVersion: 1,
              type: "read-pdf",
              jobID: jobID(),
              inputPath: DocumentRuntimeManifest.RelativePath.make("input/document.pdf"),
              inputBytes: staged.bytes,
              limits,
            })
            return yield* runProxy(health, runtime, job, request, (session) => pdfWorker(session))
          }),
        )
      }),
    ),
  )

  const createDocument: Interface["createDocument"] = Effect.fn("DocumentRuntime.createDocument")((input) =>
    limited(
      Effect.gen(function* () {
        const runtime = yield* verifiedRuntime(health, policy)
        return yield* withJob(health, (job) =>
          Effect.gen(function* () {
            const content = yield* decodeInput(DocumentGenerate.ContentInput[input.format], { contents: input.contents })
            const contentBytes = Buffer.from(JSON.stringify(content), "utf8")
            const contentPath = "input/content.json"
            const absoluteContentPath = path.join(job.path, ...contentPath.split("/"))
            yield* attempt(
              async () => {
                await mkdir(path.dirname(absoluteContentPath), { recursive: true, mode: 0o700 })
                await writeFile(absoluteContentPath, contentBytes, { flag: "wx", mode: 0o600 })
              },
              failure("invalid-request", "input"),
            )
            const request = yield* decodeInput(DocumentRuntimeProtocol.CreateDocxRequest, {
              protocolVersion: 1,
              type: "create-docx",
              format: input.format,
              jobID: jobID(),
              inputPath: DocumentRuntimeManifest.RelativePath.make(contentPath),
              inputBytes: contentBytes.byteLength,
            })
            return yield* runProxy(health, runtime, job, request, (session) => docxWorker(session, input.format))
          }),
        )
      }),
    ),
  )

  const createDocx: Interface["createDocx"] = (input) => createDocument({ format: "docx", contents: input.contents })

  return Layer.succeed(
    Service,
    Service.of({
      availability: () =>
        probe().pipe(
          Effect.map((available): Availability => available),
          Effect.catch((error) =>
            Effect.sync(() => {
              process.stderr.write(`document runtime unavailable: ${error.message} [stage ${error.stage}]\n`)
              return { status: "unavailable", code: "runtime-unavailable" } as const
            }),
          ),
        ),
      probe,
      ocr,
      readOffice,
      readPdf,
      createDocx,
      createDocument,
      renderAndOcr,
    }),
  )
}

const productionConfig = configFromEnvironment(process.env)
export const node = makeGlobalNode({ service: Service, layer: layer(productionConfig), deps: [] })

export function configFromEnvironment(environment: NodeJS.ProcessEnv): Config | undefined {
  const runtimePath = environment.KOALA_DOCUMENT_RUNTIME_PATH
  const manifestSha256 = environment.KOALA_DOCUMENT_RUNTIME_MANIFEST_SHA256
  const proxyPath = environment.KOALA_DOCUMENT_RUNTIME_PROXY_PATH
  const proxyAssetsRoot = environment.KOALA_DOCUMENT_RUNTIME_PROXY_ASSETS_ROOT
  const release = environment.KOALA_DOCUMENT_RUNTIME_REQUIRE_RELEASE_READY
  if (
    !runtimePath ||
    !manifestSha256 ||
    !proxyPath ||
    !proxyAssetsRoot ||
    (release !== undefined && !["0", "1", "false", "true"].includes(release))
  ) {
    return undefined
  }
  return {
    runtimePath,
    manifestSha256,
    proxyPath,
    proxyAssetsRoot,
    requireReleaseReady: release === "1" || release === "true",
  }
}

interface Runtime {
  readonly target: DocumentRuntimeTarget.Target
  readonly manifest: VerifiedManifest
  readonly manifestSha256: DocumentRuntimeManifest.Digest
  readonly proxyPath: string
  readonly proxyAssetsRoot: string
}

interface Health {
  readonly read: () => boolean
  readonly poison: () => void
}

interface Session {
  readonly health: Health
  readonly child: ChildProcess
  readonly queue: Queue.Queue<Signal>
  readonly request: DocumentRuntimeProtocol.InitialRequest
  readonly job: DocumentJobRoot.Root
  readonly channel: DocumentOuterChannel.Channel
  diagnostics?: DocumentDiagnostics.Tracker
  cleanup?: () => void
  complete: boolean
  accepted: boolean
  innerProcessID?: number
  diagnosticBytes: number
  overflowed: boolean
  spawnAbsenceConfirmed: boolean
  shutdownDeadline?: number
  readonly outputIDs: Set<DocumentRuntimeProtocol.OutputID>
  readonly outputPaths: Set<DocumentRuntimeManifest.RelativePath>
  readonly receiptNonce: DocumentSandboxProtocol.ReceiptNonce
}

type Signal =
  | { readonly type: "message"; readonly value: unknown }
  | { readonly type: "error" }
  | { readonly type: "disconnect" }
  | { readonly type: "exit"; readonly code: number | null; readonly signal: NodeJS.Signals | null }

function limited<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return jobs.withPermits(1)(effect)
}

function makeHealth(): Health {
  let poisoned = false
  return {
    read: () => poisoned,
    poison: () => {
      poisoned = true
    },
  }
}

function withRuntime<A, E, R>(
  health: Health,
  config: Config | undefined,
  use: (runtime: Runtime) => Effect.Effect<A, E, R>,
) {
  return Effect.flatMap(verifiedRuntime(health, config), use)
}

function verifiedRuntime(health: Health, config: Config | undefined) {
  return Effect.gen(function* () {
    if (health.read()) {
      return yield* failure("runtime-unavailable", "probe", false, "runtime poisoned by an earlier job")
    }
    if (!config) {
      return yield* failure(
        "runtime-unavailable",
        "probe",
        false,
        "no document runtime configured (KOALA_DOCUMENT_RUNTIME_* absent)",
      )
    }
    if (
      !path.isAbsolute(config.runtimePath) ||
      !path.isAbsolute(config.proxyPath) ||
      !path.isAbsolute(config.proxyAssetsRoot)
    ) {
      return yield* failure("runtime-unavailable", "probe", false, "document runtime paths are not absolute")
    }
    const target = yield* hostTarget()
    const digest = yield* decodeInput(DocumentRuntimeManifest.Digest, config.manifestSha256).pipe(
      Effect.mapError(() => failure("runtime-unavailable", "probe", false, "invalid manifest digest")),
    )
    const manifest = yield* Effect.tryPromise({
      try: () => loadAndVerifyManifest(config.runtimePath, target, digest, config.requireReleaseReady ?? false),
      catch: (error) => failure("runtime-unavailable", "probe", false, `manifest verification: ${describe(error)}`),
    })
    const proxy = yield* Effect.tryPromise({
      try: () => validateProxyPaths(config.proxyPath, config.proxyAssetsRoot, manifest.root),
      catch: (error) => failure("runtime-unavailable", "probe", false, `proxy paths: ${describe(error)}`),
    })
    const valid = yield* Effect.tryPromise({
      try: () => validateRuntimePaths(manifest.root, runtimePaths(manifest.root, target)),
      catch: (error) => failure("runtime-unavailable", "probe", false, `runtime paths: ${describe(error)}`),
    })
    if (!valid) {
      return yield* failure("runtime-unavailable", "probe", false, "runtime is missing required files")
    }
    return {
      target,
      manifest,
      manifestSha256: digest,
      proxyPath: proxy.proxyPath,
      proxyAssetsRoot: proxy.proxyAssetsRoot,
    }
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

async function validateProxyPaths(proxyPath: string, proxyAssetsRoot: string, runtimeRoot: string) {
  const canonicalAssets = await realpath(proxyAssetsRoot)
  const assets = await lstat(canonicalAssets)
  if (!assets.isDirectory() || assets.isSymbolicLink() || !samePath(canonicalAssets, path.normalize(proxyAssetsRoot))) {
    throw new Error("invalid-proxy-assets")
  }
  const canonicalProxy = await realpath(proxyPath)
  const proxy = await lstat(canonicalProxy)
  if (
    !proxy.isFile() ||
    proxy.isSymbolicLink() ||
    !samePath(canonicalProxy, path.normalize(proxyPath)) ||
    !inside(canonicalAssets, canonicalProxy) ||
    overlaps(canonicalAssets, runtimeRoot)
  ) {
    throw new Error("invalid-proxy")
  }
  return { proxyPath: canonicalProxy, proxyAssetsRoot: canonicalAssets }
}

async function validateRuntimePaths(root: string, paths: ReturnType<typeof runtimePaths>) {
  const files = [
    path.join(root, "package.json"),
    paths.bootstrap,
    paths.worker,
    path.join(paths.pdfRoot, "legacy", "build", "pdf.mjs"),
    paths.canvasEntry,
  ]
  const directories = [
    path.join(paths.pdfRoot, "cmaps"),
    path.join(paths.pdfRoot, "iccs"),
    path.join(paths.pdfRoot, "standard_fonts"),
    path.join(paths.pdfRoot, "wasm"),
    paths.canvasNativeRoot,
  ]
  // Development runtimes may omit Tesseract; OCR then fails per request while other operations work.
  const ocr = await Promise.all([
    safeInfo(root, paths.tesseract, "file"),
    safeInfo(root, path.join(paths.tessdata, "eng.traineddata"), "file"),
    safeInfo(root, path.join(paths.tessdata, "osd.traineddata"), "file"),
    safeInfo(root, paths.tessdata, "directory"),
  ])
  if (ocr.some(Boolean) && !ocr.every(Boolean)) return false
  if (!(await Promise.all(files.map((file) => safeInfo(root, file, "file")))).every(Boolean)) return false
  return (await Promise.all(directories.map((directory) => safeInfo(root, directory, "directory")))).every(Boolean)
}

async function safeInfo(root: string, value: string, kind: "file" | "directory") {
  if (!inside(root, value)) return false
  const info = await lstat(value).catch(() => undefined)
  if (!info || info.isSymbolicLink()) return false
  return kind === "file" ? info.isFile() : info.isDirectory()
}

function withJob<A, E, R>(health: Health, use: (job: DocumentJobRoot.Root) => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => DocumentJobRoot.create(),
      catch: (error) => {
        if (error instanceof DocumentJobRoot.LifecycleError && error.unhealthy) health.poison()
        return failure("worker-failed", "cleanup")
      },
    }),
    use,
    (job) =>
      Effect.tryPromise({
        try: () => {
          if (unsafeJobRoots.delete(job.path)) {
            throw new DocumentJobRoot.LifecycleError({ code: "deletion-failed", unhealthy: true })
          }
          return DocumentJobRoot.remove(job, { deadline: job.cleanupDeadline ?? Date.now() + CleanupWatchdogMs })
        },
        catch: () => {
          health.poison()
          return failure("worker-failed", "cleanup")
        },
      }),
  )
}

function runProxy<A, E, R>(
  health: Health,
  runtime: Runtime,
  job: DocumentJobRoot.Root,
  request: DocumentRuntimeProtocol.InitialRequest,
  use: (session: Session, request: DocumentRuntimeProtocol.InitialRequest) => Effect.Effect<A, E | RuntimeError, R>,
) {
  return Effect.acquireUseRelease(
    spawnProxy(health, runtime, job, request),
    (session) =>
      Effect.andThen(
        sendParent(session, {
          protocolVersion: 1,
          type: "launch",
          jobID: request.jobID,
          target: runtime.target,
          runtimeRoot: runtime.manifest.root,
          manifestSha256: runtime.manifestSha256,
          parentRoot: job.parent,
          parentIdentity: DocumentPendingRoot.identityToWire(job.parentIdentity),
          parentMode: job.parentMode ?? null,
          jobRoot: job.path,
          jobRootIdentity: DocumentPendingRoot.identityToWire(job.identity),
          pendingRoot: job.pending,
          pendingRootIdentity: DocumentPendingRoot.identityToWire(job.pendingIdentity),
          receiptNonce: session.receiptNonce,
          start: request,
        }),
        Effect.andThen(expectAccepted(session), use(session, request)),
      ).pipe(
        Effect.timeoutOrElse({
          duration:
            request.type === "probe"
              ? ProbeDeadlineMs
              : request.type === "read-office" || request.type === "read-pdf" || request.type === "create-docx"
                ? DocumentRuntimeLimits.MaxJobDeadlineMs
                : request.limits.jobDeadlineMs,
          orElse: () => failure("job-deadline-exceeded", "worker", true),
        }),
      ),
    (session) => stopProxy(session, job),
  )
}

function spawnProxy(
  health: Health,
  runtime: Runtime,
  job: DocumentJobRoot.Root,
  request: DocumentRuntimeProtocol.InitialRequest,
) {
  return Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () => DocumentJobRoot.verifyForLaunch(job),
      catch: () => {
        health.poison()
        return failure("worker-failed", "cleanup")
      },
    })
    const queue = yield* Queue.bounded<Signal>(SignalCapacity)
    const child = yield* Effect.try({
      try: () =>
        fork(runtime.proxyPath, [], {
          cwd: job.parent,
          detached: process.platform !== "win32",
          env: DocumentSandboxPolicy.brokerEnvironment(runtime.proxyAssetsRoot),
          execArgv: [],
          serialization: "json",
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        }),
      catch: () => failure("worker-failed", "worker"),
    })
    const session: Session = {
      health,
      child,
      queue,
      request,
      job,
      channel: DocumentOuterChannel.make(),
      complete: false,
      accepted: false,
      diagnosticBytes: 0,
      overflowed: false,
      spawnAbsenceConfirmed: false,
      outputIDs: new Set(),
      outputPaths: new Set(),
      receiptNonce: DocumentSandboxProtocol.ReceiptNonce.make(randomBytes(32).toString("hex")),
    }
    const offer = (signal: Signal) => {
      if (Queue.offerUnsafe(queue, signal)) return
      session.overflowed = true
      health.poison()
      try {
        child.kill("SIGKILL")
      } catch {}
    }
    const diagnostic = (chunk: unknown) => {
      if (typeof chunk !== "string" && !(chunk instanceof Uint8Array)) {
        session.overflowed = true
        health.poison()
        return
      }
      session.diagnosticBytes = Math.min(DiagnosticBytes + 1, session.diagnosticBytes + Buffer.byteLength(chunk))
      if (session.diagnosticBytes <= DiagnosticBytes || session.overflowed) {
        // Proxy diagnostics reach the desktop log through the sidecar's stderr.
        if (session.diagnosticBytes <= DiagnosticBytes) process.stderr.write(chunk)
        return
      }
      session.overflowed = true
      health.poison()
      try {
        child.kill("SIGKILL")
      } catch {}
    }
    child.on("message", onMessage)
    child.once("error", onError)
    child.once("disconnect", onDisconnect)
    child.once("exit", onExit)
    session.diagnostics = DocumentDiagnostics.track(child.stdout, child.stderr, diagnostic)
    function onMessage(value: unknown) {
      offer({ type: "message", value })
    }
    function onError() {
      if (!child.pid) session.spawnAbsenceConfirmed = true
      offer({ type: "error" })
    }
    function onDisconnect() {
      offer({ type: "disconnect" })
    }
    function onExit(code: number | null, signal: NodeJS.Signals | null) {
      offer({ type: "exit", code, signal })
    }
    session.cleanup = () => cleanupSession(session, onMessage, onError, onDisconnect, onExit)
    return session
  })
}

function expectAccepted(session: Session) {
  return Effect.gen(function* () {
    const message = yield* nextProxyMessage(session)
    if (message.type === "failure") return yield* proxyFailure(message)
    if (message.type !== "accepted") return yield* closureFailure()
    session.accepted = true
    session.innerProcessID = message.innerProcessID
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
  request: DocumentRuntimeProtocol.InitialRequest,
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
    const output = yield* resolveOutput(
      session.health,
      pendingEvidence(session.job),
      result.outputPath,
      result.tsvBytes,
      result.outputSha256,
    )
    const tsv = yield* pendingAttempt(session.health, () => DocumentPendingOutput.read(output))
    yield* pendingAttempt(session.health, () => DocumentPendingOutput.remove(output))
    yield* expectType(session, "completed", (event) => event.operation === "ocr" && event.pagesProcessed === 1)
    yield* cleanExit(session)
    return { page: request.page, dimensions, tsv, tsvBytes: result.tsvBytes }
  })
}

function renderWorker<A, E, R>(
  session: Session,
  request: DocumentRuntimeProtocol.InitialRequest,
  callback: (page: ScopedPage) => Effect.Effect<A, E, R>,
): Effect.Effect<RenderResult, RuntimeError | E, R> {
  return Effect.gen(function* () {
    if (request.type !== "render") return yield* failure("invalid-request", "input")
    yield* expectType(session, "started", (event) => event.operation === "render")
    const seen = new Set<number>()
    for (const page of Array.from({ length: request.pageCount }, (_, index) => request.startPage + index)) {
      const rendered = yield* expectType(session, "page-ready", (event) => event.page === page && !seen.has(page))
      seen.add(page)
      const pageOutput = yield* resolveOutput(
        session.health,
        pendingEvidence(session.job),
        rendered.outputPath,
        rendered.pngBytes,
        rendered.outputSha256,
      )
      const ocrRequest: typeof DocumentRuntimeProtocol.RenderedPageOcrRequest.Type = {
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
      const tsvOutput = yield* resolveOutput(
        session.health,
        pendingEvidence(session.job),
        ocr.outputPath,
        ocr.tsvBytes,
        ocr.outputSha256,
      )
      yield* callback({
        page,
        pagePath: pageOutput.path,
        tsvPath: tsvOutput.path,
        dimensions: rendered.dimensions,
        pngBytes: rendered.pngBytes,
        tsvBytes: ocr.tsvBytes,
      })
      yield* pendingAttempt(session.health, () =>
        Promise.all([DocumentPendingOutput.remove(pageOutput), DocumentPendingOutput.remove(tsvOutput)]).then(
          () => undefined,
        ),
      )
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

function officeWorker(
  session: Session,
  format: "docx" | "pptx" | "xlsx",
): Effect.Effect<ReadOfficeResult, RuntimeError> {
  return Effect.gen(function* () {
    yield* expectType(session, "started", (event) => event.operation === "read-office")
    const ready = yield* expectType(session, "office-ready", (event) => event.format === format)
    const output = yield* resolveOutput(
      session.health,
      pendingEvidence(session.job),
      ready.outputPath,
      ready.outputBytes,
      ready.outputSha256,
    )
    const bytes = yield* pendingAttempt(session.health, () => DocumentPendingOutput.read(output))
    yield* pendingAttempt(session.health, () => DocumentPendingOutput.remove(output))
    const parsed = yield* decodeOfficeOutput(bytes)
    yield* expectType(
      session,
      "completed",
      (event) => event.operation === "read-office" && event.pagesProcessed === 0,
    )
    yield* cleanExit(session)
    return parsed
  })
}

function pdfWorker(session: Session): Effect.Effect<ReadPdfResult, RuntimeError> {
  return Effect.gen(function* () {
    yield* expectType(session, "started", (event) => event.operation === "read-pdf")
    const ready = yield* expectType(session, "pdf-info", () => true)
    const output = yield* resolveOutput(
      session.health,
      pendingEvidence(session.job),
      ready.outputPath,
      ready.outputBytes,
      ready.outputSha256,
    )
    const bytes = yield* pendingAttempt(session.health, () => DocumentPendingOutput.read(output))
    yield* pendingAttempt(session.health, () => DocumentPendingOutput.remove(output))
    const parsed = yield* decodePdfOutput(bytes)
    if (parsed.pageCount !== ready.pageCount) return yield* failure("invalid-order", "worker")
    yield* expectType(
      session,
      "completed",
      (event) => event.operation === "read-pdf" && event.pagesProcessed === 0,
    )
    yield* cleanExit(session)
    return parsed
  })
}

function docxWorker(
  session: Session,
  format: DocumentGenerate.Format,
): Effect.Effect<CreateDocxResult, RuntimeError> {
  return Effect.gen(function* () {
    yield* expectType(session, "started", (event) => event.operation === "create-docx")
    const ready = yield* expectType(session, "docx-ready", (event) => event.outputPath.endsWith(`.${format}`))
    const output = yield* resolveOutput(
      session.health,
      pendingEvidence(session.job),
      ready.outputPath,
      ready.outputBytes,
      ready.outputSha256,
    )
    const bytes = yield* pendingAttempt(session.health, () => DocumentPendingOutput.read(output))
    yield* pendingAttempt(session.health, () => DocumentPendingOutput.remove(output))
    yield* expectType(
      session,
      "completed",
      (event) => event.operation === "create-docx" && event.pagesProcessed === 0,
    )
    yield* cleanExit(session)
    return { path: output.path, bytes }
  })
}

function decodePdfOutput(bytes: Uint8Array) {
  return Effect.try({
    try: () => JSON.parse(Buffer.from(bytes).toString("utf8")) as ReadPdfResult,
    catch: () => failure("invalid-order", "worker"),
  })
}

function decodeOfficeOutput(bytes: Uint8Array) {
  return Effect.try({
    try: () => JSON.parse(Buffer.from(bytes).toString("utf8")) as ReadOfficeResult,
    catch: () => failure("invalid-order", "worker"),
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
    const message = yield* nextProxyMessage(session)
    if (message.type === "failure") return yield* proxyFailure(message)
    if (message.type !== "event") return yield* closureFailure()
    const event = message.event
    if (
      event.type === "page-ready" ||
      event.type === "ocr-result" ||
      event.type === "office-ready" ||
      event.type === "docx-ready" ||
      event.type === "pdf-info"
    ) {
      const extension =
        event.type === "page-ready"
          ? ".png"
          : event.type === "ocr-result"
            ? ".tsv"
            : event.type === "docx-ready"
              ? (/\.(?:docx|pptx|xlsx|pdf)$/.exec(event.outputPath)?.[0] ?? ".docx")
              : ".json"
      if (
        !event.outputPath.endsWith(extension) ||
        session.outputIDs.has(event.outputID) ||
        session.outputPaths.has(event.outputPath)
      ) {
        return yield* failure("invalid-order", "worker")
      }
      session.outputIDs.add(event.outputID)
      session.outputPaths.add(event.outputPath)
    }
    if (event.type === "failure") {
      return yield* new RuntimeError({ code: event.code, stage: event.stage, retryable: event.retryable })
    }
    if (event.type === "cancelled") {
      return yield* failure("worker-failed", "worker")
    }
    return event
  })
}

function sendCommand(session: Session, command: DocumentRuntimeProtocol.ContinuationRequest) {
  return sendParent(session, {
    protocolVersion: 1,
    type: "command",
    jobID: session.request.jobID,
    command,
  })
}

function sendParent(session: Session, input: unknown) {
  const timeoutMs = session.shutdownDeadline
    ? Math.max(1, session.shutdownDeadline - DeletionReserveMs - Date.now())
    : DocumentRuntimeLimits.MaxCancellationGraceMs
  return Effect.tryPromise({
    try: () =>
      DocumentOuterChannel.send(
        session.channel,
        {
          get connected() {
            return session.child.connected
          },
          send: (value, callback) => session.child.send(value, callback),
        },
        input,
        timeoutMs,
      ),
    catch: () => failure("worker-failed", "cleanup"),
  })
}

function nextProxyMessage(session: Session): Effect.Effect<DocumentSandboxProtocol.ProxyEvent, RuntimeError> {
  return Effect.gen(function* () {
    const signal = yield* Queue.take(session.queue)
    if (session.overflowed || signal.type !== "message") {
      return yield* closureFailure()
    }
    const message = yield* Effect.try({
      try: () => DocumentOuterChannel.receive(session.channel, signal.value),
      catch: (error) =>
        failure(
          error instanceof DocumentOuterChannel.ChannelError && error.code === "job-mismatch"
            ? "job-mismatch"
            : error instanceof DocumentOuterChannel.ChannelError && error.code === "invalid-order"
              ? "invalid-order"
              : "protocol-mismatch",
          "worker",
        ),
    })
    if (
      message.type === "failure" &&
      ["root-identity-failed", "termination-failed", "command-cleanup-failed", "reset-failed"].includes(message.code)
    ) {
      session.health.poison()
    }
    return message
  })
}

function cleanExit(session: Session) {
  return finishClosure(session)
}

function finishClosure(session: Session): Effect.Effect<void, RuntimeError> {
  const deadline = ensureShutdownDeadline(session)
  return Effect.gen(function* () {
    while (session.channel.state.phase !== "terminal") {
      const message = yield* nextProxyMessage(session)
      if (message.type === "failure" || (message.type === "event" && isTerminal(message.event))) continue
      if (message.type === "accepted" && session.channel.state.cancelSent) continue
      return yield* closureFailure()
    }
    const closed = yield* nextProxyMessage(session)
    if (closed.type !== "closed") return yield* closureFailure()
    if (
      !closed.treeContained ||
      (session.accepted
        ? !DocumentSandboxProtocol.teardownCompleted(closed)
        : closed.managerInitialized && !DocumentSandboxProtocol.teardownCompleted(closed))
    ) {
      session.health.poison()
      return yield* closureFailure()
    }
    const stopped = [yield* Queue.take(session.queue), yield* Queue.take(session.queue)]
    const exited = stopped.find((signal) => signal.type === "exit")
    if (
      session.overflowed ||
      !stopped.some((signal) => signal.type === "disconnect") ||
      !exited ||
      exited.type !== "exit" ||
      exited.code !== 0 ||
      exited.signal !== null
    ) {
      return yield* closureFailure()
    }
    const receipt = yield* pendingAttempt(session.health, () =>
      DocumentTeardownReceipt.read(pendingEvidence(session.job), session.receiptNonce, closed.receiptSha256 ?? undefined),
    )
    if (
      !DocumentTeardownReceipt.matchesClosed(receipt, closed) ||
      receipt.terminalCategory !== session.channel.state.terminalCategory
    ) {
      session.health.poison()
      return yield* closureFailure()
    }
    const diagnostics = session.diagnostics
    if (!diagnostics) return yield* closureFailure()
    const drained = yield* Effect.promise(() =>
      settleWithin(diagnostics.drain, Math.max(1, deadline - DeletionReserveMs - Date.now())),
    )
    if (!drained || session.overflowed) {
      session.health.poison()
      return yield* closureFailure()
    }
    session.complete = true
  }).pipe(
    Effect.timeoutOrElse({
      duration: Math.max(1, deadline - DeletionReserveMs - Date.now()),
      orElse: closureFailure,
    }),
  )
}

function stopProxy(session: Session, job: DocumentJobRoot.Root) {
  const deadline = ensureShutdownDeadline(session)
  job.cleanupDeadline = deadline
  if (session.complete) {
    session.cleanup?.()
    return Effect.void
  }
  return Effect.gen(function* () {
    if (
      (session.channel.state.phase === "awaiting-accepted" || session.channel.state.phase === "active") &&
      !session.channel.state.cancelSent &&
      session.child.connected
    ) {
      yield* sendParent(session, { protocolVersion: 1, type: "cancel", jobID: session.request.jobID }).pipe(
        Effect.catch(() => Effect.void),
      )
    }
    const closed = yield* finishClosure(session).pipe(
      Effect.timeoutOrElse({
        duration: Math.max(1, deadline - DeletionReserveMs - Date.now()),
        orElse: closureFailure,
      }),
      Effect.match({ onFailure: () => false, onSuccess: () => true }),
    )
    if (closed) {
      session.cleanup?.()
      return
    }
    const observed = yield* Effect.promise(() =>
      DocumentProcess.waitForObservedExit(
        session.child,
        Math.min(DocumentRuntimeLimits.MaxCancellationGraceMs, Math.max(1, deadline - DeletionReserveMs - Date.now())),
      ),
    )
    const termination =
      observed.status === "exited"
        ? observed
        : yield* Effect.promise(() =>
            DocumentProcess.terminateProcessTree(session.child, {
              timeoutMs: Math.max(1, deadline - DeletionReserveMs - Date.now()),
              systemRoot: process.env.SystemRoot,
            }).catch(() => undefined),
          )
    const innerProcessID = session.innerProcessID
    const innerContained = innerProcessID
      ? yield* Effect.promise(() => DocumentProcess.terminateProcessGroup(innerProcessID, Math.max(1, deadline - Date.now())))
      : session.spawnAbsenceConfirmed
    if (!session.spawnAbsenceConfirmed && termination?.status !== "exited") {
      session.health.poison()
      unsafeJobRoots.add(job.path)
      session.cleanup?.()
      return yield* closureFailure()
    }
    if (!innerContained) session.health.poison()
    const reconciled = yield* pendingAttempt(session.health, () =>
      DocumentTeardownReceipt.read(pendingEvidence(job), session.receiptNonce),
    ).pipe(
      Effect.map(
        (receipt) =>
          receipt.jobID === session.request.jobID &&
          receipt.terminalCategory === (session.channel.state.terminalCategory ?? "failure") &&
          DocumentSandboxProtocol.teardownCompleted(receipt),
      ),
      Effect.catch(() => Effect.succeed(false)),
    )
    if (!reconciled || !innerContained) session.health.poison()
    session.cleanup?.()
    if (!reconciled || !innerContained) return yield* closureFailure()
  })
}

function ensureShutdownDeadline(session: Session) {
  session.shutdownDeadline ??= Date.now() + CleanupWatchdogMs
  session.job.cleanupDeadline ??= session.shutdownDeadline
  return session.shutdownDeadline
}

function cleanupSession(
  session: Session,
  onMessage: (value: unknown) => void,
  onError: () => void,
  onDisconnect: () => void,
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void,
) {
  session.child.off("message", onMessage)
  session.child.off("error", onError)
  session.child.off("disconnect", onDisconnect)
  session.child.off("exit", onExit)
  session.diagnostics?.cleanup()
}

function resolveOutput(
  health: Health,
  root: DocumentPendingRoot.Evidence,
  relative: DocumentRuntimeManifest.RelativePath,
  bytes: number,
  sha256: DocumentRuntimeManifest.Digest,
) {
  return pendingAttempt(health, () => DocumentPendingOutput.resolve(root, relative, bytes, sha256))
}

function pendingEvidence(job: DocumentJobRoot.Root): DocumentPendingRoot.Evidence {
  return {
    parentRoot: job.parent,
    parentIdentity: job.parentIdentity,
    pendingRoot: job.pending,
    pendingRootIdentity: job.pendingIdentity,
    parentMode: job.parentMode ?? null,
  }
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
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > maximumBytes) {
    throw new Error("invalid source")
  }
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

function proxyFailure(message: typeof DocumentSandboxProtocol.FailureEvent.Type) {
  const detail = `proxy reported ${message.code} during ${message.stage}`
  if (message.code === "protocol-mismatch") return failure("protocol-mismatch", "worker", false, detail)
  if (message.code === "sandbox-unavailable" || message.code === "dependency-failed") {
    return failure("runtime-unavailable", "probe", false, detail)
  }
  return failure("worker-failed", message.stage === "worker" ? "worker" : "cleanup", false, detail)
}

function closureFailure() {
  return failure("worker-failed", "cleanup", false, "proxy closure was not clean")
}

function failure(
  code: DocumentRuntimeProtocol.FailureCode,
  stage: DocumentRuntimeProtocol.FailureStage,
  retryable = false,
  detail?: string,
) {
  return new RuntimeError({ code, stage, retryable, ...(detail ? { detail } : {}) })
}

function attempt<A>(tryPromise: () => PromiseLike<A>, error: RuntimeError) {
  return Effect.tryPromise({ try: tryPromise, catch: () => error })
}

function describe(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 512)
}

function pendingAttempt<A>(health: Health, tryPromise: () => PromiseLike<A>) {
  return Effect.tryPromise({
    try: tryPromise,
    catch: (error) => {
      if (error instanceof DocumentPendingRoot.EvidenceError) health.poison()
      return failure("worker-failed", "cleanup")
    },
  })
}

function inside(root: string, value: string) {
  const relation = path.relative(root, value)
  return relation !== "" && relation !== ".." && !relation.startsWith(`..${path.sep}`) && !path.isAbsolute(relation)
}

function overlaps(left: string, right: string) {
  return samePath(left, right) || inside(left, right) || inside(right, left)
}

function samePath(left: string, right: string) {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right
}

function isTerminal(event: DocumentRuntimeProtocol.WorkerEvent) {
  return event.type === "completed" || event.type === "cancelled" || event.type === "failure"
}

function settleWithin(promise: Promise<boolean>, timeoutMs: number) {
  return new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (value: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    void promise.then(finish, () => finish(false))
  })
}

export * as DocumentRuntime from "./runtime"
