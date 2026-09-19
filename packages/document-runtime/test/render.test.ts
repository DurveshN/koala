import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { DocumentRuntimeLimits } from "@koala-ai/core/document-runtime/limits"
import { DocumentRuntimeTarget } from "@koala-ai/core/document-runtime/target"
import { mkdtemp, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { openPdf, probeRenderer, renderPdfPage } from "../src/render"
import { pdfFixture } from "./fixture/pdf"

let root = ""

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "document-render-"))
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe("PDF rendering", () => {
  test("probes pinned renderer entries with a sanitized environment", async () => {
    const loaded: string[] = []
    process.env.NODE_OPTIONS = "credential-canary"
    process.env.NAPI_RS_NATIVE_LIBRARY_PATH = "credential-canary"
    await probeRenderer({
      pdfEntry: path.join(root, "pdf.mjs"),
      canvasEntry: path.join(root, "canvas.js"),
      loadModule: async (specifier) => {
        loaded.push(specifier)
        expect(process.env.NODE_OPTIONS).toBeUndefined()
        expect(process.env.NAPI_RS_NATIVE_LIBRARY_PATH).toBeUndefined()
        expect(process.env.DISABLE_SYSTEM_FONTS_LOAD).toBe("1")
        if (specifier.endsWith("pdf.mjs")) return { getDocument: () => undefined, AnnotationMode: { DISABLE: 0 } }
        return {
          createCanvas: () => ({ getContext: () => ({}), encodeStream: () => undefined }),
        }
      },
    })
    expect(loaded).toEqual([expect.stringContaining("pdf.mjs"), expect.stringContaining("canvas.js")])
  })

  test.each(["load", "api"] as const)("rejects renderer %s failure", async (scenario) => {
    await expect(
      probeRenderer({
        pdfEntry: path.join(root, "pdf.mjs"),
        canvasEntry: path.join(root, "canvas.js"),
        loadModule: async () => {
          if (scenario === "load") throw new Error("private-renderer-error")
          return {}
        },
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "runtime-unavailable", stage: "probe" }))
  })

  test("renders real PDF bytes to a bounded 300-DPI PNG", async () => {
    const abort = new AbortController()
    const pdf = await openPdf({
      bytes: pdfFixture(),
      assets: assets(),
      limits: DocumentRuntimeLimits.requestedHard,
      signal: abort.signal,
    })
    const output = path.join(root, "page.png")
    try {
      const page = await renderPdfPage({
        document: pdf.document,
        annotationMode: pdf.annotationMode,
        canvasEntry: pdf.canvasEntry,
        jobRoot: root,
        page: 1,
        outputPath: output,
        currentTemporaryBytes: 0,
        limits: DocumentRuntimeLimits.requestedHard,
        signal: abort.signal,
      })
      expect(page).toEqual(expect.objectContaining({ width: 2550, height: 3300 }))
      expect(page.pngBytes).toBe((await stat(output)).size)
      expect(await Bun.file(output).slice(0, 8).arrayBuffer()).toEqual(
        new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer,
      )
    } finally {
      await pdf.close()
    }
  })

  test("rejects raster dimensions before canvas allocation", async () => {
    const abort = new AbortController()
    const limits = { ...DocumentRuntimeLimits.requestedHard, rasterSidePixels: 2_000, rasterAreaPixels: 4_000_000 }
    const pdf = await openPdf({ bytes: pdfFixture(), assets: assets(), limits, signal: abort.signal })
    try {
      await expect(
        renderPdfPage({
          document: pdf.document,
          annotationMode: pdf.annotationMode,
          canvasEntry: pdf.canvasEntry,
          jobRoot: root,
          page: 1,
          outputPath: path.join(root, "too-large.png"),
          currentTemporaryBytes: 0,
          limits,
          signal: abort.signal,
        }),
      ).rejects.toEqual(expect.objectContaining({ code: "raster-limit-exceeded" }))
    } finally {
      await pdf.close()
    }
  })

  test("rejects encoded PNG overflow and cancellation", async () => {
    const abort = new AbortController()
    const limits = { ...DocumentRuntimeLimits.requestedHard, pngBytesPerPage: 1 }
    const pdf = await openPdf({ bytes: pdfFixture(), assets: assets(), limits, signal: abort.signal })
    try {
      await expect(
        renderPdfPage({
          document: pdf.document,
          annotationMode: pdf.annotationMode,
          canvasEntry: pdf.canvasEntry,
          jobRoot: root,
          page: 1,
          outputPath: path.join(root, "overflow.png"),
          currentTemporaryBytes: 0,
          limits,
          signal: abort.signal,
        }),
      ).rejects.toEqual(expect.objectContaining({ code: "png-limit-exceeded" }))
      abort.abort()
      await expect(
        renderPdfPage({
          document: pdf.document,
          annotationMode: pdf.annotationMode,
          canvasEntry: pdf.canvasEntry,
          jobRoot: root,
          page: 1,
          outputPath: path.join(root, "cancelled.png"),
          currentTemporaryBytes: 0,
          limits: DocumentRuntimeLimits.requestedHard,
          signal: abort.signal,
        }),
      ).rejects.toBeDefined()
    } finally {
      await pdf.close()
    }
  })
})

function assets() {
  const target = DocumentRuntimeTarget.fromHost(
    process.platform as DocumentRuntimeTarget.HostPlatform,
    process.arch as DocumentRuntimeTarget.HostArchitecture,
  )
  const runtimeRoot = path.resolve(import.meta.dir, "..", "dist", target, "node_modules")
  const root = path.join(runtimeRoot, "pdfjs-dist")
  return {
    pdfEntry: path.join(root, "legacy", "build", "pdf.mjs"),
    canvasEntry: path.join(runtimeRoot, "@napi-rs", "canvas", "index.js"),
    cMapDirectory: path.join(root, "cmaps"),
    iccDirectory: path.join(root, "iccs"),
    standardFontDirectory: path.join(root, "standard_fonts"),
    wasmDirectory: path.join(root, "wasm"),
  }
}
