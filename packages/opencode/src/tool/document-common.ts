import type { DocumentRuntime } from "@/document/runtime"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { Artifact } from "@koala-ai/core/artifact/artifact"
import { ArtifactStore } from "@koala-ai/core/artifact/store"
import { DocumentNormalized } from "@koala-ai/core/document/normalized"
import { DocumentRuntimeLimits } from "@koala-ai/core/document-runtime/limits"
import { IndustrialCitation } from "@koala-ai/core/industrial/citation"
import { IndustrialInput } from "@koala-ai/core/industrial/input"
import { IndustrialResult } from "@koala-ai/core/industrial/result"
import type { IndustrialTool } from "@koala-ai/core/industrial/tool"
import { SandboxProtocol } from "@koala-ai/core/sandbox/protocol"
import { Effect, Schema } from "effect"
import type { Tool } from "./tool"

export const SourceInput = Schema.Struct({
  source: IndustrialInput.Source,
}).annotate({ identifier: "OpenCode.DocumentCommon.SourceInput" })

export type SourceInput = typeof SourceInput.Type

export const OfficeSection = Schema.Struct({
  type: Schema.Literals(["paragraph", "table", "slide", "sheet"]),
  heading: Schema.optionalKey(Schema.String),
  body: Schema.String,
}).annotate({ identifier: "OpenCode.DocumentCommon.OfficeSection" })

export const OfficeReadData = Schema.Struct({
  sections: Schema.Array(OfficeSection),
  title: Schema.optionalKey(Schema.String),
  author: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "OpenCode.DocumentCommon.OfficeReadData" })

export function makeOfficeResultSchema<const Name extends IndustrialTool.Name>(name: Name) {
  return IndustrialResult.make(name, OfficeReadData)
}

export type OfficeReadResult<Name extends IndustrialTool.Name = IndustrialTool.Name> = ReturnType<
  typeof makeOfficeResultSchema<Name>
>["Type"]

const extensionMime: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".tiff": "image/tiff",
  ".tif": "image/tiff",
  ".bmp": "image/bmp",
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".txt": "text/plain",
}

export function mimeFromPath(filepath: string) {
  const extension = path.extname(filepath).toLowerCase()
  return extensionMime[extension] ?? "application/octet-stream"
}

const imageMimes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/tiff", "image/bmp"])

export function isImageMime(mime: string) {
  return imageMimes.has(mime)
}

export function isPdfMime(mime: string) {
  return mime === "application/pdf"
}

export function isOfficeDocxMime(mime: string) {
  return mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
}

export function isOfficePptxMime(mime: string) {
  return mime === "application/vnd.openxmlformats-officedocument.presentationml.presentation"
}

export function isOfficeXlsxMime(mime: string) {
  return mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
}

const textCodeMimes = new Set([
  "application/json",
  "application/javascript",
  "application/typescript",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/toml",
])

export function isTextMime(mime: string) {
  return mime.startsWith("text/") || textCodeMimes.has(mime)
}

export function artifactReference(metadata: Artifact.Metadata): Artifact.Reference {
  return {
    id: metadata.id,
    name: metadata.name,
    mime: metadata.mime,
    size: metadata.size,
    digest: metadata.digest,
  }
}

export function makeProvenance(ctx: Tool.Context, toolName: string): Artifact.Provenance {
  return Schema.decodeUnknownSync(Artifact.Provenance)({
    sessionID: ctx.sessionID,
    messageID: ctx.messageID,
    toolName,
    toolCallID: ctx.callID,
  })
}

export function makeError<const Name extends IndustrialTool.Name, Data>(
  name: Name,
  engine: IndustrialTool.Engine,
  code: IndustrialResult.ErrorCode,
  summary: string,
  sandboxRunID?: SandboxProtocol.RunID,
): IndustrialResult.Checked<Data> {
  const common = {
    tool: name,
    contractVersion: 1 as const,
    engine,
    sources: [] as Artifact.Reference[],
    outputs: [] as Artifact.Reference[],
    citations: [] as IndustrialCitation.Locator[],
    producerTruncated: false,
    sandboxRunID,
    summary,
  }
  if (code === "cancelled") {
    return {
      ...common,
      status: "error" as const,
      cancelled: true as const,
      timedOut: false as const,
      error: { code: "cancelled" as const, retryable: true as const },
    } as IndustrialResult.Checked<Data>
  }
  if (code === "deadline-exceeded") {
    return {
      ...common,
      status: "error" as const,
      cancelled: false as const,
      timedOut: true as const,
      error: { code: "deadline-exceeded" as const, retryable: true as const },
    } as IndustrialResult.Checked<Data>
  }
  return {
    ...common,
    status: "error" as const,
    cancelled: false as const,
    timedOut: false as const,
    error: { code, retryable: false },
  } as IndustrialResult.Checked<Data>
}

export function mapRuntimeError(error: DocumentRuntime.RuntimeError): IndustrialResult.GeneralErrorCode {
  if (error.code === "runtime-unavailable") return "engine-unavailable"
  if (error.code === "input-too-large") return "input-too-large"
  if (
    error.code === "page-out-of-range" ||
    error.code === "page-limit-exceeded" ||
    error.code === "raster-limit-exceeded" ||
    error.code === "png-limit-exceeded" ||
    error.code === "tsv-limit-exceeded" ||
    error.code === "temporary-limit-exceeded" ||
    error.code === "office-limit-exceeded" ||
    error.code === "office-output-limit-exceeded" ||
    error.code === "pdf-output-limit-exceeded"
  ) {
    return "limit-exceeded"
  }
  if (
    error.code === "invalid-request" ||
    error.code === "protocol-mismatch" ||
    error.code === "job-mismatch" ||
    error.code === "invalid-order"
  ) {
    return "protocol-error"
  }
  return "engine-failed"
}

export function truncateSummary(text: string, maxChars = 16_000): string {
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars)
}

export function formatOffice(result: DocumentRuntime.ReadOfficeResult): string {
  const parts: string[] = []
  if (result.title) parts.push(`# ${result.title}`)
  if (result.author) parts.push(`Author: ${result.author}`)
  let previousHeading: string | undefined
  for (const section of result.sections) {
    if (section.heading && section.heading !== previousHeading) {
      parts.push(`## ${section.heading}`)
      previousHeading = section.heading
    }
    if (section.body) parts.push(section.body)
  }
  return parts.join("\n\n")
}

export function boundsFromTsv(
  left: number,
  top: number,
  width: number,
  height: number,
  dimensions: DocumentNormalized.Dimensions,
) {
  const right = Math.min((left + width) / dimensions.width, 1)
  const bottom = Math.min((top + height) / dimensions.height, 1)
  const normalizedLeft = Math.min(left / dimensions.width, right)
  const normalizedTop = Math.min(top / dimensions.height, bottom)
  return { left: normalizedLeft, top: normalizedTop, right, bottom }
}

export function parseTsvLines(
  tsv: Uint8Array,
  dimensions: DocumentRuntimeLimits.RasterDimensions,
  artifactID: Artifact.ID,
  pageNumber: number,
): DocumentNormalized.OcrLine[] {
  const text = new TextDecoder().decode(tsv)
  const rows = text.split("\n")
  let start = 0
  if (rows[0]?.startsWith("level")) start = 1

  const raw: Array<{
    text: string
    confidence: number
    bounds: DocumentNormalized.BoundingBox
    block: number
    par: number
    line: number
    top: number
    left: number
  }> = []

  for (let index = start; index < rows.length; index++) {
    const columns = rows[index].split("\t")
    if (columns.length < 12) continue
    const level = Number(columns[0])
    if (level !== 5) continue

    const left = Number(columns[6])
    const top = Number(columns[7])
    const width = Number(columns[8])
    const height = Number(columns[9])
    if (
      !Number.isFinite(left) ||
      !Number.isFinite(top) ||
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width <= 0 ||
      height <= 0
    ) {
      continue
    }

    const confidence = Math.min(Math.max(Number(columns[10]) / 100, 0), 1)
    const wordText = columns[11] ?? ""
    const right = Math.min((left + width) / dimensions.width, 1)
    const bottom = Math.min((top + height) / dimensions.height, 1)
    const normalizedLeft = Math.min(left / dimensions.width, right)
    const normalizedTop = Math.min(top / dimensions.height, bottom)

    raw.push({
      text: wordText,
      confidence,
      bounds: {
        left: normalizedLeft,
        top: normalizedTop,
        right,
        bottom,
      },
      block: Number(columns[2]),
      par: Number(columns[3]),
      line: Number(columns[4]),
      top,
      left,
    })
  }

  const groups = new Map<string, typeof raw>()
  for (const word of raw) {
    const key = `${word.block}:${word.par}:${word.line}`
    const existing = groups.get(key)
    if (existing) existing.push(word)
    else groups.set(key, [word])
  }

  return Array.from(groups.values())
    .map((words) => {
      words.sort((a, b) => a.left - b.left)
      const left = Math.min(...words.map((w) => w.bounds.left))
      const top = Math.min(...words.map((w) => w.bounds.top))
      const right = Math.max(...words.map((w) => w.bounds.right))
      const bottom = Math.max(...words.map((w) => w.bounds.bottom))
      return {
        text: words.map((w) => w.text).join(" "),
        words: words.map((w) => ({
          text: w.text,
          confidence: w.confidence,
          bounds: w.bounds,
          locator: {
            type: "page" as const,
            artifactID,
            page: pageNumber,
          },
        })),
        bounds: { left, top, right, bottom },
      }
    })
    .sort((a, b) => a.bounds.top - b.bounds.top || a.bounds.left - b.bounds.left)
}

export function parseTesseractTsv(
  tsv: Uint8Array,
  dimensions: DocumentNormalized.Dimensions,
  artifactID: Artifact.ID,
  page: number,
): DocumentNormalized.OcrLine[] {
  const lines = parseTsvLines(tsv, dimensions, artifactID, page)
  return lines.map((line) => ({
    text: line.text,
    words: line.words.map((word) => ({
      text: word.text,
      confidence: word.confidence,
      bounds: word.bounds,
      locator: Schema.decodeUnknownSync(IndustrialCitation.RegionLocator)({
        type: "region",
        artifactID,
        page,
        left: word.bounds.left,
        top: word.bounds.top,
        right: word.bounds.right,
        bottom: word.bounds.bottom,
      }),
    })),
    bounds: line.bounds,
  }))
}

export function documentFormat(name: string): "pdf" | "docx" | "pptx" | "xlsx" | "image" | "unknown" {
  const lower = name.toLowerCase()
  if (lower.endsWith(".pdf")) return "pdf"
  if (lower.endsWith(".docx")) return "docx"
  if (lower.endsWith(".pptx")) return "pptx"
  if (lower.endsWith(".xlsx")) return "xlsx"
  if (/\.(png|jpe?g|gif|webp|bmp|tiff?)$/i.test(lower)) return "image"
  return "unknown"
}

export function readPdfToNormalized(
  result: DocumentRuntime.ReadPdfResult,
  artifactID: Artifact.ID,
): DocumentNormalized.NormalizedDocument {
  const pages = result.pages.map((page) => {
    const [x0, y0, x1, y1] = page.mediaBox.length === 4 ? page.mediaBox : [0, 0, 612, 792]
    const width = Math.max(1, Math.round(x1 - x0))
    const height = Math.max(1, Math.round(y1 - y0))
    return {
      pageNumber: page.number,
      dimensions: { width, height },
      textBlocks: page.blocks.map((block) => ({
        paragraphs: [block.text],
        lines: [] as DocumentNormalized.OcrLine[],
      })),
      ocrLines: [] as DocumentNormalized.OcrLine[],
      imageRegions: [] as DocumentNormalized.ImageRegion[],
      visualObservations: [] as DocumentNormalized.VisualObservation[],
    }
  })

  const sections = result.pages.map((page) => ({
    type: "document" as const,
    body: page.blocks.map((block) => block.text).join("\n\n"),
  }))

  const metadata = {
    pageCount: result.pageCount,
    ...(result.title !== undefined && { title: result.title }),
    ...(result.author !== undefined && { author: result.author }),
  } as DocumentNormalized.DocumentMetadata

  return {
    source: { type: "artifact" as const, artifactID },
    pages,
    sections,
    metadata,
    truncated: false,
  }
}

export function readOfficeToNormalized(
  result: DocumentRuntime.ReadOfficeResult,
  artifactID: Artifact.ID,
): DocumentNormalized.NormalizedDocument {
  const metadata = {
    pageCount: 1,
    ...(result.title !== undefined && { title: result.title }),
    ...(result.author !== undefined && { author: result.author }),
  } as DocumentNormalized.DocumentMetadata

  return {
    source: { type: "artifact" as const, artifactID },
    pages: [] as DocumentNormalized.Page[],
    sections: result.sections.map((section) => ({
      type:
        section.type === "slide" ? "slide" : section.type === "sheet" ? "sheet" : ("document" as const),
      heading: section.heading,
      body: section.body,
    })),
    metadata,
    truncated: false,
  }
}

export function ocrToNormalized(
  pageNumber: number,
  dimensions: DocumentRuntimeLimits.RasterDimensions,
  tsv: Uint8Array,
  artifactID: Artifact.ID,
): DocumentNormalized.NormalizedDocument {
  const lines = parseTsvLines(tsv, dimensions, artifactID, pageNumber)
  const page = {
    pageNumber,
    dimensions,
    textBlocks: [{ paragraphs: [lines.map((line) => line.text).join("\n")], lines: [] as DocumentNormalized.OcrLine[] }],
    ocrLines: lines,
    imageRegions: [] as DocumentNormalized.ImageRegion[],
    visualObservations: [] as DocumentNormalized.VisualObservation[],
  }
  return {
    source: { type: "artifact" as const, artifactID },
    pages: [page],
    sections: [{ type: "document" as const, body: lines.map((line) => line.text).join("\n") }],
    metadata: { pageCount: 1 },
    truncated: false,
  }
}

export function pageLocator(artifactID: Artifact.ID, page: number): IndustrialCitation.Locator {
  return Schema.decodeUnknownSync(IndustrialCitation.PageLocator)({ type: "page", artifactID, page })
}

export function artifactLocator(artifactID: Artifact.ID): IndustrialCitation.Locator {
  return Schema.decodeUnknownSync(IndustrialCitation.ArtifactLocator)({ type: "artifact", artifactID })
}

export function makeRunID(prefix: string) {
  return Schema.decodeUnknownSync(SandboxProtocol.RunID)(`${prefix}-${randomUUID()}`)
}

export function sha256Digest(input: string) {
  return createHash("sha256").update(input).digest("hex")
}

export const writeJsonArtifact = (
  staging: ArtifactStore.Staging,
  outputPath: string,
  value: unknown,
) =>
  Effect.gen(function* () {
    const normalized = path.posix.normalize(outputPath)
    const fullPath = path.join(staging.artifacts, ...normalized.split("/"))
    const json = JSON.stringify(value)
    yield* Effect.promise(() => mkdir(path.dirname(fullPath), { recursive: true, mode: 0o700 }))
    yield* Effect.promise(() => writeFile(fullPath, json, { flag: "wx", mode: 0o600 }))
    return normalized
  })

export function encodeRouteDecisionID(providerID: string, modelID: string): IndustrialResult.RouteDecisionID {
  const sanitized = modelID.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100)
  const value = `vision.${providerID}.${sanitized}`
  return Schema.decodeUnknownSync(IndustrialResult.RouteDecisionID)(value)
}

export const encodeFileToBase64DataURL = (filepath: string, mime: string) =>
  Effect.gen(function* () {
    const bytes = yield* Effect.promise(() => Bun.file(filepath).bytes())
    const base64 = Buffer.from(bytes).toString("base64")
    return `data:${mime};base64,${base64}`
  })

export const readText = (filepath: string) => Effect.gen(function* () {
  return yield* Effect.promise(() => Bun.file(filepath).text())
})

export const readBytes = (filepath: string) => Effect.gen(function* () {
  return yield* Effect.promise(() => Bun.file(filepath).bytes())
})

export function countLines(text: string) {
  return text.split("\n").length
}

export * as DocumentCommon from "./document-common"
