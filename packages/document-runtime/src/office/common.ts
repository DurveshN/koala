import { DocumentRuntimeLimits } from "@koala-ai/core/document-runtime/limits"
import { RuntimeFailure } from "../error"

export interface Section {
  readonly type: "paragraph" | "table" | "slide" | "sheet"
  readonly heading?: string
  readonly body: string
}

export interface StructuredText {
  readonly title?: string
  readonly author?: string
  readonly sections: ReadonlyArray<Section>
}

export interface Limits {
  readonly maxInputBytes: number
  readonly maxOutputBytes: number
  readonly maxSections: number
  readonly maxBodyLength: number
  readonly maxTotalCharacters: number
}

export const defaultLimits: Limits = {
  maxInputBytes: DocumentRuntimeLimits.MaxOfficeInputBytes,
  maxOutputBytes: DocumentRuntimeLimits.MaxOfficeOutputBytes,
  maxSections: DocumentRuntimeLimits.MaxOfficeSections,
  maxBodyLength: DocumentRuntimeLimits.MaxOfficeBodyLength,
  maxTotalCharacters: DocumentRuntimeLimits.MaxOfficeTotalCharacters,
}

export function limitStructuredText(input: StructuredText, limits: Limits = defaultLimits): StructuredText {
  let totalCharacters = 0
  const sections: Section[] = []
  for (const section of input.sections) {
    if (sections.length >= limits.maxSections) break
    let body = section.body
    if (body.length > limits.maxBodyLength) {
      body = `${body.slice(0, limits.maxBodyLength)}\n[section truncated]`
    }
    totalCharacters += body.length + (section.heading?.length ?? 0)
    if (totalCharacters > limits.maxTotalCharacters) {
      const remaining = Math.max(0, limits.maxTotalCharacters - (totalCharacters - body.length))
      body = remaining > 0 ? `${body.slice(0, remaining)}\n[output truncated]` : "[output truncated]"
      sections.push({ ...section, body })
      break
    }
    sections.push({ ...section, body })
  }
  return {
    ...input,
    sections,
  }
}

export function encodeStructuredText(output: StructuredText, limits: Limits = defaultLimits): Uint8Array {
  const encoded = Buffer.from(JSON.stringify(output), "utf8")
  if (encoded.byteLength > limits.maxOutputBytes) {
    throw new RuntimeFailure("office-output-limit-exceeded", "input")
  }
  return encoded
}

export function validateInputBytes(declaredBytes: number, limits: Limits = defaultLimits) {
  if (declaredBytes > limits.maxInputBytes) {
    throw new RuntimeFailure("input-too-large", "input")
  }
}
