import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { DocumentRuntimeLimits } from "@koala-ai/core/document-runtime/limits"
import { DocumentRuntimeTarget } from "@koala-ai/core/document-runtime/target"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { readPdf, type PdfOutput } from "../src/read"
import { pdfFixture } from "./fixture/pdf"

let root = ""

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "document-read-"))
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe("PDF text reader", () => {
  test("extracts page count, rotation, boxes, and text from a real PDF", async () => {
    const input = pdfFixture(2)
    const inputPath = path.join(root, "source.pdf")
    await writeFile(inputPath, input)

    const result = JSON.parse(
      Buffer.from(
        await readPdf(inputPath, input.byteLength, {
          assets: assets(),
          limits: DocumentRuntimeLimits.requestedHard,
          signal: new AbortController().signal,
        }),
      ).toString("utf8"),
    ) as PdfOutput

    expect(result.pageCount).toBe(2)
    expect(result.pages).toHaveLength(2)
    expect(result.pages[0].number).toBe(1)
    expect(result.pages[1].number).toBe(2)
    expect(result.pages[0].rotation).toBe(0)
    expect(result.pages[0].mediaBox).toEqual([0, 0, 612, 792])
    const text = result.pages.map((page) => page.blocks.map((block) => block.text).join(" ")).join(" ")
    expect(text).toContain("HELLO PAGE 1")
    expect(text).toContain("HELLO PAGE 2")
  })

  test("enforces the requested page limit", async () => {
    const input = pdfFixture(5)
    const inputPath = path.join(root, "limited.pdf")
    await writeFile(inputPath, input)

    await expect(
      readPdf(inputPath, input.byteLength, {
        assets: assets(),
        limits: { ...DocumentRuntimeLimits.requestedHard, pages: 2 },
        signal: new AbortController().signal,
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "page-limit-exceeded" }))
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
