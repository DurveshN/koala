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
  rejectMacroContentTypes(await readText(zip, "[Content_Types].xml"))
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

function rejectMacroContentTypes(contentTypesXml: string) {
  if (contentTypesXml.includes("macroEnabled") || contentTypesXml.includes("macro-enabled")) {
    throw new RuntimeFailure("docx-generation-failed", "worker")
  }
}

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" })

async function rejectExternalAndMacroRelations(zip: JSZip, path: string) {
  if (!zip.files[path]) return
  const xml = await readText(zip, path)
  if (xml.length === 0) return
  const parsed = parser.parse(xml)
  const relationships = parsed.Relationships?.Relationship
  const items = Array.isArray(relationships) ? relationships : relationships ? [relationships] : []
  for (const rel of items) {
    const target = String(rel.Target ?? "")
    const targetMode = String(rel.TargetMode ?? "")
    const type = String(rel.Type ?? "")
    if (targetMode === "External") throw new RuntimeFailure("docx-generation-failed", "worker")
    if (/^(https?|ftp|file|\\|\.\.\/)/i.test(target)) throw new RuntimeFailure("docx-generation-failed", "worker")
    if (/macro|vba/i.test(type)) throw new RuntimeFailure("docx-generation-failed", "worker")
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
