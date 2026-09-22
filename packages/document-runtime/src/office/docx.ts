import mammoth from "mammoth"
import {
  encodeStructuredText,
  limitStructuredText,
  type Limits,
  type StructuredText,
  validateInputBytes,
} from "./common.ts"

export async function readDocx(inputPath: string, declaredBytes: number, limits?: Limits): Promise<Uint8Array> {
  validateInputBytes(declaredBytes, limits)
  const result = await mammoth.extractRawText({ path: inputPath })
  const output = limitStructuredText(parseDocxText(result.value), limits)
  return encodeStructuredText(output, limits)
}

function parseDocxText(text: string): StructuredText {
  const sections = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => mapDocxLine(line))
  return { sections }
}

function mapDocxLine(line: string) {
  const body = line.replace(/\t+/g, "\t")
  if (body.includes("\t")) {
    return { type: "table" as const, body }
  }
  const heading = inferHeading(body)
  if (heading) return { type: "paragraph" as const, heading, body }
  return { type: "paragraph" as const, body }
}

function inferHeading(body: string): string | undefined {
  if (body.length > 120 || body.includes(".")) return undefined
  if (/^[A-Z][A-Za-z0-9\s]{2,}$/.test(body)) return body
  return undefined
}
