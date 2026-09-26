import { XMLParser } from "fast-xml-parser"
import JSZip from "jszip"
import mammoth from "mammoth"
import { RuntimeFailure } from "../error.ts"

const MaxCompressionRatio = 100

export type OoxmlFormat = "docx" | "pptx" | "xlsx"

const requiredParts: Record<OoxmlFormat, ReadonlyArray<string>> = {
  docx: ["word/document.xml"],
  pptx: ["ppt/presentation.xml"],
  xlsx: ["xl/workbook.xml"],
}

export interface OoxmlValidationResult {
  readonly text: string
  readonly sectionCount: number
}

export function validateOoxmlDocx(
  bytes: Uint8Array,
  expectedBytes?: number,
): Promise<OoxmlValidationResult> {
  return validateOoxml(bytes, "docx", expectedBytes)
}

/** Detects the OOXML package kind from its main part; undefined for anything else. */
export async function detectOoxmlFormat(bytes: Uint8Array): Promise<OoxmlFormat | undefined> {
  const zip = await JSZip.loadAsync(bytes).catch(() => undefined)
  if (!zip) return undefined
  return (Object.keys(requiredParts) as OoxmlFormat[]).find((format) =>
    requiredParts[format].every((part) => Boolean(zip.files[part])),
  )
}

export async function validateOoxml(
  bytes: Uint8Array,
  format: OoxmlFormat,
  expectedBytes?: number,
): Promise<OoxmlValidationResult> {
  if (expectedBytes !== undefined && bytes.byteLength !== expectedBytes) {
    throw new RuntimeFailure("invalid-request", "input")
  }
  const zip = await JSZip.loadAsync(bytes)
  const files = zip.files
  for (const part of ["[Content_Types].xml", "_rels/.rels", ...requiredParts[format]]) {
    if (!files[part]) throw new RuntimeFailure("docx-generation-failed", "worker")
  }
  rejectMacroContentTypes(zip, await readText(zip, "[Content_Types].xml"))
  // Every relationship part in the package is checked, so slide and sheet parts are covered too.
  for (const part of Object.keys(files).filter((name) => name.endsWith(".rels"))) {
    await rejectExternalAndMacroRelations(zip, part)
  }
  assertCompressionRatio(bytes, zip)
  if (format !== "docx") {
    const pattern = format === "pptx" ? /^ppt\/slides\/slide\d+\.xml$/ : /^xl\/worksheets\/sheet\d+\.xml$/
    const sectionCount = Object.keys(files).filter((name) => pattern.test(name)).length
    if (sectionCount === 0) throw new RuntimeFailure("docx-generation-failed", "worker")
    return { text: "", sectionCount }
  }
  const extracted = await mammoth.extractRawText({ buffer: Buffer.from(bytes) })
  const text = extracted.value
  const sectionCount = Math.max(1, text.split(/\n{2,}/).filter((section) => section.trim().length > 0).length)
  return { text, sectionCount }
}

async function readText(zip: JSZip, path: string): Promise<string> {
  const file = zip.files[path]
  if (!file) return ""
  return file.async("text")
}

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" })

function entries(value: unknown): ReadonlyArray<Record<string, unknown>> {
  const record = (item: unknown): item is Record<string, unknown> => typeof item === "object" && item !== null
  if (Array.isArray(value)) return value.filter(record)
  return record(value) ? [value] : []
}

// Macro presence is decided by the parts the package actually carries. SheetJS declares a
// "Default Extension="bin"" binary-workbook content type in every workbook (SheetJS #1501), so a
// substring test on "macroEnabled" would reject valid macro-free files.
function rejectMacroContentTypes(zip: JSZip, contentTypesXml: string) {
  const parts = Object.keys(zip.files).filter((name) => !zip.files[name]?.dir)
  const macro = (contentType: string) => /macroEnabled|macro-enabled|vbaProject|vbaData/i.test(contentType)
  if (parts.some((name) => /(?:^|\/)vbaProject\.bin$/i.test(name) || /(?:^|\/)vbaData\.xml$/i.test(name))) {
    throw new RuntimeFailure("docx-generation-failed", "worker")
  }
  const types = parser.parse(contentTypesXml).Types
  for (const override of entries(types?.Override)) {
    if (macro(String(override.ContentType ?? ""))) throw new RuntimeFailure("docx-generation-failed", "worker")
  }
  for (const fallback of entries(types?.Default)) {
    const extension = String(fallback.Extension ?? "").toLowerCase()
    if (!macro(String(fallback.ContentType ?? ""))) continue
    if (parts.some((name) => name.toLowerCase().endsWith(`.${extension}`))) {
      throw new RuntimeFailure("docx-generation-failed", "worker")
    }
  }
}

// Relationship targets are resolved against the source part (OPC part names are slash-separated
// and commonly relative, such as `../slideLayouts/slideLayout1.xml`) and must stay inside the
// package, point at an existing part, and never reference an external or macro resource.
async function rejectExternalAndMacroRelations(zip: JSZip, relsPath: string) {
  const xml = await readText(zip, relsPath)
  if (xml.length === 0) return
  const sourceDirectory = relsPath.replace(/(?:^|\/)_rels\/[^/]+$/, "")
  for (const relationship of entries(parser.parse(xml).Relationships?.Relationship)) {
    const target = String(relationship.Target ?? "")
    if (String(relationship.TargetMode ?? "") === "External") throw new RuntimeFailure("docx-generation-failed", "worker")
    if (/macro|vba/i.test(String(relationship.Type ?? ""))) throw new RuntimeFailure("docx-generation-failed", "worker")
    if (target.length === 0 || target.includes("\\") || /^[a-z][a-z0-9+.-]*:/i.test(target)) {
      throw new RuntimeFailure("docx-generation-failed", "worker")
    }
    const resolved = normalizePartName(target.startsWith("/") ? target : `${sourceDirectory}/${target}`)
    if (!resolved || !Object.hasOwn(zip.files, resolved) || zip.files[resolved].dir) {
      throw new RuntimeFailure("docx-generation-failed", "worker")
    }
  }
}

// Returns undefined when the path climbs above the package root.
function normalizePartName(value: string) {
  const segments: string[] = []
  for (const segment of decodePartName(value).split("/")) {
    if (segment === "" || segment === ".") continue
    if (segment !== "..") {
      segments.push(segment)
      continue
    }
    if (segments.length === 0) return undefined
    segments.pop()
  }
  return segments.join("/")
}

function decodePartName(value: string) {
  if (!value.includes("%")) return value
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

interface JSZipEntryData {
  readonly uncompressedSize?: number
}

function assertCompressionRatio(compressed: Uint8Array, zip: JSZip) {
  let uncompressed = 0
  for (const file of Object.values(zip.files)) {
    if (file.dir) continue
    const data = file as { _data?: JSZipEntryData }
    uncompressed += data._data?.uncompressedSize ?? 0
  }
  if (uncompressed > 0 && uncompressed / compressed.byteLength > MaxCompressionRatio) {
    throw new RuntimeFailure("docx-generation-failed", "worker")
  }
}
