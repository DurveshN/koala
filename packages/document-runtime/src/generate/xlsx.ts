import * as xlsx from "xlsx"
import { DocumentGenerate } from "@koala-ai/core/document/generate"
import { RuntimeFailure } from "../error.ts"

type XlsxContent = typeof DocumentGenerate.XlsxContent.Type

export function generateXlsx(content: XlsxContent): Buffer {
  const workbook = xlsx.utils.book_new()
  workbook.Props = {
    ...(content.title ? { Title: content.title } : {}),
    ...(content.author ? { Author: content.author } : {}),
  }
  const names = new Set<string>()
  for (const sheet of content.sheets) {
    if (names.has(sheet.name.toLowerCase())) throw new RuntimeFailure("invalid-request", "input")
    names.add(sheet.name.toLowerCase())
    // aoa_to_sheet stores strings as text cells, so "=..." content never becomes a formula.
    const rows = [...(sheet.header ? [sheet.header] : []), ...sheet.rows]
    const worksheet = xlsx.utils.aoa_to_sheet(rows.map((row) => row.map((cell) => (cell === null ? undefined : cell))))
    if (sheet.columnWidths) worksheet["!cols"] = sheet.columnWidths.map((wch) => ({ wch }))
    xlsx.utils.book_append_sheet(workbook, worksheet, sheet.name)
  }
  const output: unknown = xlsx.write(workbook, { type: "buffer", bookType: "xlsx", compression: true })
  if (!(output instanceof Uint8Array)) throw new RuntimeFailure("docx-generation-failed", "worker")
  return Buffer.from(output)
}
