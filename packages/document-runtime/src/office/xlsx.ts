import xlsx from "xlsx"
import { RuntimeFailure } from "../error"
import {
  encodeStructuredText,
  limitStructuredText,
  type Limits,
  type Section,
  type StructuredText,
  validateInputBytes,
} from "./common"

export async function readXlsx(inputPath: string, declaredBytes: number, limits?: Limits): Promise<Uint8Array> {
  validateInputBytes(declaredBytes, limits)
  let workbook: xlsx.WorkBook
  try {
    workbook = xlsx.readFile(inputPath, { type: "file" })
  } catch (error) {
    throw new RuntimeFailure("invalid-request", "input")
  }
  const sections: Section[] = []
  for (const sheetName of workbook.SheetNames) {
    const worksheet = workbook.Sheets[sheetName]
    if (!worksheet) continue
    const rows = xlsx.utils.sheet_to_json(worksheet, { header: 1 }) as ReadonlyArray<ReadonlyArray<unknown>>
    const lines = rows
      .map((row) => row.map((cell) => String(cell ?? "")).join("\t"))
      .filter((line) => line.trim().length > 0)
    if (lines.length === 0) continue
    sections.push({ type: "sheet", heading: sheetName, body: lines.join("\n") })
  }
  const output = limitStructuredText({ sections }, limits)
  return encodeStructuredText(output, limits)
}
