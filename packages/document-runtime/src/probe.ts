import { DocumentRuntimeLimits } from "@koala-ai/core/document-runtime/limits"
import { DocumentRuntimeTarget } from "@koala-ai/core/document-runtime/target"
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { VerifiedManifest } from "./manifest.ts"
import { openPdf, probeRenderer, renderPdfPage } from "./render.ts"
import { runtimePaths } from "./runtime.ts"
import { probeTesseract, runTesseract } from "./tesseract.ts"

export type ProductionProbeResult =
  | { readonly performed: true }
  | { readonly performed: false; readonly reason: "cross-target" }

export async function probeProductionRuntime(runtime: VerifiedManifest): Promise<ProductionProbeResult> {
  if (runtime.manifest.target !== hostTarget()) return { performed: false, reason: "cross-target" }

  const paths = runtimePaths(runtime.root, runtime.manifest.target)
  const jobRoot = await mkdtemp(path.join(os.tmpdir(), "document-runtime-probe-"))
  await chmod(jobRoot, 0o700)
  const abort = AbortSignal.timeout(DocumentRuntimeLimits.MaxJobDeadlineMs)
  try {
    await probeTesseract({
      executablePath: paths.tesseract,
      tessdataPath: paths.tessdata,
      jobRoot,
      expectedVersion: "5.5.3",
      signal: abort,
    })
    await probeRenderer({
      pdfEntry: path.join(paths.pdfRoot, "legacy", "build", "pdf.mjs"),
      canvasEntry: paths.canvasEntry,
    })
    await mkdir(path.join(jobRoot, "pages"), { mode: 0o700 })
    const pdf = await openPdf({
      bytes: smokePdf(),
      assets: {
        pdfEntry: path.join(paths.pdfRoot, "legacy", "build", "pdf.mjs"),
        canvasEntry: paths.canvasEntry,
        cMapDirectory: path.join(paths.pdfRoot, "cmaps"),
        iccDirectory: path.join(paths.pdfRoot, "iccs"),
        standardFontDirectory: path.join(paths.pdfRoot, "standard_fonts"),
        wasmDirectory: path.join(paths.pdfRoot, "wasm"),
      },
      limits: DocumentRuntimeLimits.requestedHard,
      signal: abort,
    })
    try {
      const image = path.join(jobRoot, "pages", "smoke.png")
      const rendered = await renderPdfPage({
        document: pdf.document,
        annotationMode: pdf.annotationMode,
        canvasEntry: pdf.canvasEntry,
        jobRoot,
        page: 1,
        outputPath: image,
        currentTemporaryBytes: 0,
        limits: DocumentRuntimeLimits.requestedHard,
        signal: abort,
      })
      const output = path.join(jobRoot, "smoke.tsv")
      const ocr = await runTesseract({
        executablePath: paths.tesseract,
        tessdataPath: paths.tessdata,
        jobRoot,
        inputPath: image,
        outputPath: output,
        currentTemporaryBytes: rendered.temporaryBytes,
        limits: DocumentRuntimeLimits.requestedHard,
        signal: abort,
      })
      if (ocr.tsvBytes === 0 || !(await readFile(output, "utf8")).toUpperCase().includes("HELLO")) {
        throw new Error("Offline document runtime OCR probe did not recognize the fixture")
      }
    } finally {
      await pdf.close()
    }
    return { performed: true }
  } finally {
    await rm(jobRoot, { recursive: true, force: true })
  }
}

function hostTarget() {
  if (process.platform !== "darwin" && process.platform !== "win32" && process.platform !== "linux") return
  if (process.arch !== "x64" && process.arch !== "arm64") return
  return DocumentRuntimeTarget.fromHost(process.platform, process.arch)
}

function smokePdf() {
  const content = "BT /F1 28 Tf 72 700 Td (HELLO) Tj ET"
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [4 0 R] >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ]
  const chunks = ["%PDF-1.7\n%\xE2\xE3\xCF\xD3\n"]
  const offsets = objects.map((object, index) => {
    const offset = Buffer.byteLength(chunks.join(""), "binary")
    chunks.push(`${index + 1} 0 obj\n${object}\nendobj\n`)
    return offset
  })
  const xref = Buffer.byteLength(chunks.join(""), "binary")
  chunks.push("xref\n0 6\n0000000000 65535 f \n")
  chunks.push(offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join(""))
  chunks.push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
  return Buffer.from(chunks.join(""), "binary")
}
