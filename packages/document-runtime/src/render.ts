import { DocumentRuntimeLimits } from "@koala-ai/core/document-runtime/limits"
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from "pdfjs-dist/types/src/display/api.js"
import { open, readFile, rm } from "node:fs/promises"
import path from "node:path"
import type { ReadableStream } from "node:stream/web"
import { pathToFileURL } from "node:url"
import { RuntimeFailure } from "./error.ts"
import { pdfjsCanvas } from "./pdfjs-canvas.ts"
import { validateOutputFile } from "./path.ts"
import { sanitizeNativeLoaderEnvironment } from "./runtime.ts"

export type PdfAssets = {
  readonly pdfEntry: string
  readonly canvasEntry: string
  readonly cMapDirectory: string
  readonly iccDirectory: string
  readonly standardFontDirectory: string
  readonly wasmDirectory: string
}

export type OpenPdfOptions = {
  readonly bytes: Uint8Array
  readonly assets: PdfAssets
  readonly limits: DocumentRuntimeLimits.Requested
  readonly signal: AbortSignal
}

export type PdfHandle = {
  readonly document: PDFDocumentProxy
  readonly annotationMode: number
  readonly canvasEntry: string
  readonly close: () => Promise<void>
}

export type RenderPageOptions = {
  readonly document: PDFDocumentProxy
  readonly annotationMode: number
  readonly canvasEntry: string
  readonly jobRoot: string
  readonly page: number
  readonly outputPath: string
  readonly currentTemporaryBytes: number
  readonly limits: DocumentRuntimeLimits.Requested
  readonly signal: AbortSignal
}

export type RenderedPage = {
  readonly width: number
  readonly height: number
  readonly pngBytes: number
  readonly temporaryBytes: number
}

export type RendererProbeOptions = Pick<PdfAssets, "pdfEntry" | "canvasEntry"> & {
  readonly loadModule?: (specifier: string) => Promise<unknown>
}

export async function probeRenderer(options: RendererProbeOptions): Promise<void> {
  if (!path.isAbsolute(options.pdfEntry) || !path.isAbsolute(options.canvasEntry)) {
    throw new RuntimeFailure("runtime-unavailable", "probe")
  }
  sanitizeNativeLoaderEnvironment()
  const loadModule = options.loadModule ?? loadRendererModule
  try {
    const pdfjs = await loadModule(pathToFileURL(options.pdfEntry).href)
    const canvasModule = await loadModule(pathToFileURL(options.canvasEntry).href)
    if (!moduleRecord(pdfjs) || typeof pdfjs.getDocument !== "function") {
      throw new RuntimeFailure("runtime-unavailable", "probe")
    }
    if (
      !moduleRecord(pdfjs.AnnotationMode) ||
      typeof pdfjs.AnnotationMode.DISABLE !== "number" ||
      !moduleRecord(canvasModule) ||
      typeof canvasModule.createCanvas !== "function"
    ) {
      throw new RuntimeFailure("runtime-unavailable", "probe")
    }
    const canvas = canvasModule.createCanvas(1, 1)
    if (
      !moduleRecord(canvas) ||
      typeof canvas.getContext !== "function" ||
      typeof canvas.encodeStream !== "function" ||
      !moduleRecord(canvas.getContext("2d"))
    ) {
      throw new RuntimeFailure("runtime-unavailable", "probe")
    }
  } catch {
    throw new RuntimeFailure("runtime-unavailable", "probe")
  }
}

export async function readPdfBytes(file: string, declaredBytes: number, limit: number) {
  if (declaredBytes > limit) throw new RuntimeFailure("input-too-large", "input")
  const bytes = await readFile(file).catch(() => undefined)
  if (!bytes || bytes.byteLength !== declaredBytes || bytes.byteLength > limit) {
    throw new RuntimeFailure("invalid-request", "input")
  }
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

export async function openPdf(options: OpenPdfOptions): Promise<PdfHandle> {
  if (options.bytes.byteLength > options.limits.pdfInputBytes) throw new RuntimeFailure("input-too-large", "input")
  options.signal.throwIfAborted()
  sanitizeNativeLoaderEnvironment()
  const pdfjs = await import(pathToFileURL(options.assets.pdfEntry).href)
  const data = Buffer.isBuffer(options.bytes) ? new Uint8Array(options.bytes) : options.bytes
  const loadingTask = pdfjs.getDocument({
    data,
    cMapUrl: directoryPath(options.assets.cMapDirectory),
    cMapPacked: true,
    iccUrl: directoryPath(options.assets.iccDirectory),
    standardFontDataUrl: directoryPath(options.assets.standardFontDirectory),
    wasmUrl: directoryPath(options.assets.wasmDirectory),
    useWorkerFetch: false,
    useSystemFonts: false,
    useWasm: true,
    stopAtErrors: true,
    maxImageSize: options.limits.rasterAreaPixels,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    canvasMaxAreaInBytes: options.limits.rasterAreaPixels * 4,
    disableFontFace: true,
    enableXfa: false,
    enableHWA: false,
  })
  const onAbort = () => void loadingTask.destroy()
  options.signal.addEventListener("abort", onAbort, { once: true })
  try {
    const document = await loadingTask.promise
    return {
      document,
      annotationMode: pdfjs.AnnotationMode.DISABLE,
      canvasEntry: options.assets.canvasEntry,
      close: async () => {
        options.signal.removeEventListener("abort", onAbort)
        await destroyPdf(loadingTask, document)
      },
    }
  } catch {
    options.signal.removeEventListener("abort", onAbort)
    await loadingTask.destroy().catch(() => undefined)
    if (options.signal.aborted) throw new RuntimeFailure("render-failed", "render")
    throw new RuntimeFailure("render-failed", "render")
  }
}

export async function renderPdfPage(options: RenderPageOptions): Promise<RenderedPage> {
  options.signal.throwIfAborted()
  if (options.page < 1 || options.page > options.document.numPages) {
    throw new RuntimeFailure("page-out-of-range", "render")
  }

  const page = await options.document.getPage(options.page).catch(() => {
    throw new RuntimeFailure("render-failed", "render")
  })
  const viewport = page.getViewport({ scale: DocumentRuntimeLimits.FixedDpi / 72, rotation: page.rotate })
  const width = Math.ceil(viewport.width - 1e-7)
  const height = Math.ceil(viewport.height - 1e-7)
  if (
    width > options.limits.rasterSidePixels ||
    height > options.limits.rasterSidePixels ||
    width * height > options.limits.rasterAreaPixels
  ) {
    page.cleanup()
    throw new RuntimeFailure("raster-limit-exceeded", "render")
  }

  sanitizeNativeLoaderEnvironment()
  const canvasModule = (await import(pathToFileURL(options.canvasEntry).href)) as typeof import("@napi-rs/canvas")
  const canvas = canvasModule.createCanvas(width, height)
  const context = canvas.getContext("2d")
  context.fillStyle = "#ffffff"
  context.fillRect(0, 0, width, height)
  const renderTask = page.render({
    canvas: pdfjsCanvas(canvas),
    viewport,
    annotationMode: options.annotationMode,
    background: "rgb(255,255,255)",
  })

  try {
    await awaitRender(renderTask, options.limits.renderDeadlineMsPerPage, options.signal)
    const pngBytes = await writePngStream(
      canvas.encodeStream("png"),
      options.outputPath,
      options.currentTemporaryBytes,
      options.limits,
      options.signal,
    )
    await validateOutputFile(options.jobRoot, options.outputPath, pngBytes)
    return { width, height, pngBytes, temporaryBytes: options.currentTemporaryBytes + pngBytes }
  } finally {
    page.cleanup()
  }
}

async function writePngStream(
  stream: ReadableStream<Buffer>,
  outputPath: string,
  currentTemporaryBytes: number,
  limits: DocumentRuntimeLimits.Requested,
  signal: AbortSignal,
) {
  const output = await open(outputPath, "wx", 0o600)
  const reader = stream.getReader()
  let bytes = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      if (chunk.done) break
      const next = bytes + chunk.value.byteLength
      if (next > limits.pngBytesPerPage) throw new RuntimeFailure("png-limit-exceeded", "render")
      if (currentTemporaryBytes + next > limits.temporaryBytes) {
        throw new RuntimeFailure("temporary-limit-exceeded", "render")
      }
      for (let offset = 0; offset < chunk.value.byteLength; ) {
        const result = await output.write(chunk.value, offset, chunk.value.byteLength - offset)
        offset += result.bytesWritten
      }
      bytes = next
    }
    return bytes
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    await output.close().catch(() => undefined)
    await rm(outputPath, { force: true }).catch(() => undefined)
    throw error
  } finally {
    await output.close().catch(() => undefined)
  }
}

async function awaitRender(task: RenderTask, deadlineMs: number, signal: AbortSignal) {
  const cancel = () => task.cancel(0)
  signal.addEventListener("abort", cancel, { once: true })
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    cancel()
  }, deadlineMs)
  try {
    await task.promise
  } catch {
    if (timedOut) throw new RuntimeFailure("render-deadline-exceeded", "render", true)
    throw new RuntimeFailure("render-failed", "render")
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener("abort", cancel)
  }
}

async function destroyPdf(task: PDFDocumentLoadingTask, document: PDFDocumentProxy) {
  document.cleanup()
  await task.destroy().catch(() => undefined)
}

function directoryPath(directory: string) {
  const resolved = path.resolve(directory).replaceAll("\\", "/")
  return resolved.endsWith("/") ? resolved : `${resolved}/`
}

function loadRendererModule(specifier: string) {
  return import(specifier)
}

function moduleRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
