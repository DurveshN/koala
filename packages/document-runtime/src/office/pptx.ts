import { XMLParser } from "fast-xml-parser"
import JSZip from "jszip"
import { readFile } from "node:fs/promises"
import { RuntimeFailure } from "../error.ts"
import {
  encodeStructuredText,
  limitStructuredText,
  type Limits,
  type Section,
  type StructuredText,
  validateInputBytes,
} from "./common.ts"

export async function readPptx(inputPath: string, declaredBytes: number, limits?: Limits): Promise<Uint8Array> {
  validateInputBytes(declaredBytes, limits)
  const buffer = await readFile(inputPath)
  let archive: JSZip
  try {
    archive = await JSZip.loadAsync(buffer)
  } catch {
    throw new RuntimeFailure("invalid-request", "input")
  }
  const presentation = await readXmlEntry(archive, "ppt/presentation.xml")
  const slideIds = extractSlideOrder(presentation)
  const sections: Section[] = []
  for (let index = 0; index < slideIds.length; index++) {
    const slidePath = `ppt/slides/_rels/slide${index + 1}.xml.rels`
    const slideRels = await readXmlEntry(archive, slidePath).catch(() => undefined)
    const notesRef = slideRels ? findNotesReference(slideRels) : undefined
    const slideNumber = index + 1
    const slide = await readXmlEntry(archive, `ppt/slides/slide${slideNumber}.xml`)
    const bodyTexts = extractSlideTexts(slide)
    if (notesRef) {
      const notes = await readXmlEntry(archive, notesRef).catch(() => undefined)
      if (notes) bodyTexts.push(...extractNotesTexts(notes))
    }
    const body = bodyTexts.join("\n").trim()
    if (body.length > 0) {
      sections.push({ type: "slide", heading: `Slide ${slideNumber}`, body })
    }
  }
  const output = limitStructuredText({ sections }, limits)
  return encodeStructuredText(output, limits)
}

async function readXmlEntry(archive: JSZip, path: string): Promise<unknown> {
  const entry = archive.file(path)
  if (!entry) throw new RuntimeFailure("invalid-request", "input")
  const text = await entry.async("text")
  return new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" }).parse(text)
}

function extractSlideOrder(presentation: unknown): ReadonlyArray<unknown> {
  if (typeof presentation !== "object" || presentation === null) return []
  const root = (presentation as Record<string, unknown>)["p:presentation"]
  if (typeof root !== "object" || root === null) return []
  const sldIdLst = (root as Record<string, unknown>)["p:sldIdLst"]
  if (typeof sldIdLst !== "object" || sldIdLst === null) return []
  const ids = (sldIdLst as Record<string, unknown>)["p:sldId"]
  return Array.isArray(ids) ? ids : ids !== undefined ? [ids] : []
}

function findNotesReference(rels: unknown): string | undefined {
  if (typeof rels !== "object" || rels === null) return undefined
  const root = (rels as Record<string, unknown>)["Relationships"]
  if (typeof root !== "object" || root === null) return undefined
  const relationships = (root as Record<string, unknown>)["Relationship"]
  const list = Array.isArray(relationships) ? relationships : relationships !== undefined ? [relationships] : []
  const notes = list.find(
    (rel) =>
      typeof rel === "object" &&
      rel !== null &&
      (rel as Record<string, unknown>)["@_Type"] === "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide",
  )
  return notes ? String((notes as Record<string, unknown>)["@_Target"] ?? "") : undefined
}

function collectTexts(node: unknown): string[] {
  const texts: string[] = []
  walk(node, (value) => {
    if (typeof value === "object" && value !== null && "a:t" in value) {
      const text = String((value as Record<string, unknown>)["a:t"] ?? "")
      if (text.trim().length > 0) texts.push(text)
    }
  })
  return texts
}

function extractSlideTexts(slide: unknown): string[] {
  return collectTexts(slide).filter((text) => !text.startsWith("Slide "))
}

function extractNotesTexts(notes: unknown): string[] {
  return collectTexts(notes)
}

function walk(node: unknown, visit: (value: unknown) => void) {
  if (typeof node !== "object" || node === null) return
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit)
    return
  }
  visit(node)
  for (const value of Object.values(node)) walk(value, visit)
}
