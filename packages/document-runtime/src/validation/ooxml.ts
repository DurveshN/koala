import { XMLParser } from "fast-xml-parser"
import JSZip from "jszip"
import mammoth from "mammoth"
import { RuntimeFailure } from "../error"

const MaxCompressionRatio = 100

export interface OoxmlValidationResult {
  readonly text: string
  readonly sectionCount: number
}

export async function validateOoxmlDocx(
  bytes: Uint8Array,
  expectedBytes?: number,
): Promise<OoxmlValidationResult> {
  if (expectedBytes !== undefined && bytes.byteLength !== expectedBytes) {
    throw new RuntimeFailure("invalid-request", "input")
  }
  const zip = await JSZip.loadAsync(bytes)
  const files = zip.files
  if (!files["[Content_Types].xml"]) throw new RuntimeFailure("docx-generation-failed", "worker")
  if (!files["_rels/.rels"]) throw new RuntimeFailure("docx-generation-failed", "worker")
  if (!files["word/document.xml"]) throw new RuntimeFailure("docx-generation-failed", "worker")
  rejectMacroContentTypes(await readText(zip, "[Content_Types].xml"))
  await rejectExternalAndMacroRelations(zip, "_rels/.rels")
  await rejectExternalAndMacroRelations(zip, "word/_rels/document.xml.rels")
  assertCompressionRatio(bytes, zip)
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
