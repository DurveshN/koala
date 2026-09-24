import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib"
import { DocumentGenerate } from "@koala-ai/core/document/generate"

type PdfContent = typeof DocumentGenerate.PdfContent.Type
type Section = PdfContent["sections"][number]

// A4 portrait in PDF points.
const PageWidth = 595.28
const PageHeight = 841.89
const Margin = 56
const ContentWidth = PageWidth - 2 * Margin
const BodySize = 11
const LineGap = 1.35
const CellPadding = 4
const Border = rgb(0.6, 0.65, 0.7)
const Ink = rgb(0.1, 0.1, 0.1)

interface Cursor {
  page: PDFPage
  y: number
}

export async function generatePdf(content: PdfContent): Promise<Buffer> {
  const document = await PDFDocument.create()
  document.setCreator("Koala")
  document.setProducer("Koala")
  if (content.title) document.setTitle(content.title)
  if (content.author) document.setAuthor(content.author)
  const fonts = {
    regular: await document.embedFont(StandardFonts.Helvetica),
    bold: await document.embedFont(StandardFonts.HelveticaBold),
  }
  const cursor: Cursor = { page: document.addPage([PageWidth, PageHeight]), y: PageHeight - Margin }
  const newPage = () => {
    cursor.page = document.addPage([PageWidth, PageHeight])
    cursor.y = PageHeight - Margin
  }
  for (const section of content.sections) {
    if (section.type === "page-break") {
      newPage()
      continue
    }
    if (section.type === "table") {
      drawTable(cursor, newPage, fonts, section.rows ?? [])
      continue
    }
    const heading = section.type === "heading"
    const size = heading ? headingSize(section.level) : BodySize
    const font = heading ? fonts.bold : fonts.regular
    const lines = wrap(section.text ?? "", font, size, ContentWidth)
    const lineHeight = size * LineGap
    if (cursor.y - lineHeight * Math.min(lines.length, 2) < Margin) newPage()
    for (const line of lines) {
      if (cursor.y - lineHeight < Margin) newPage()
      cursor.page.drawText(line, { x: Margin, y: cursor.y - size, size, font, color: Ink })
      cursor.y -= lineHeight
    }
    cursor.y -= heading ? size * 0.4 : BodySize * 0.6
  }
  return Buffer.from(await document.save({ useObjectStreams: false }))
}

function drawTable(
  cursor: Cursor,
  newPage: () => void,
  fonts: { regular: PDFFont; bold: PDFFont },
  rows: ReadonlyArray<ReadonlyArray<string>>,
) {
  if (rows.length === 0) return
  const columns = Math.max(1, ...rows.map((row) => row.length))
  const columnWidth = ContentWidth / columns
  const size = BodySize - 1
  const lineHeight = size * LineGap
  rows.forEach((row, rowIndex) => {
    const font = rowIndex === 0 ? fonts.bold : fonts.regular
    const cells = Array.from({ length: columns }, (_, column) =>
      wrap(row[column] ?? "", font, size, columnWidth - 2 * CellPadding),
    )
    const height = Math.max(1, ...cells.map((lines) => lines.length)) * lineHeight + 2 * CellPadding
    if (cursor.y - height < Margin) newPage()
    cells.forEach((lines, column) => {
      const x = Margin + column * columnWidth
      cursor.page.drawRectangle({
        x,
        y: cursor.y - height,
        width: columnWidth,
        height,
        borderColor: Border,
        borderWidth: 0.5,
        ...(rowIndex === 0 ? { color: rgb(0.91, 0.93, 0.95) } : {}),
      })
      lines.forEach((line, index) => {
        cursor.page.drawText(line, {
          x: x + CellPadding,
          y: cursor.y - CellPadding - size - index * lineHeight,
          size,
          font,
          color: Ink,
        })
      })
    })
    cursor.y -= height
  })
  cursor.y -= BodySize
}

function headingSize(level: number | undefined) {
  if (level === undefined || level <= 1) return 20
  if (level === 2) return 16
  if (level === 3) return 14
  return 12
}

function wrap(text: string, font: PDFFont, size: number, width: number) {
  const lines: string[] = []
  for (const paragraph of text.split(/\r?\n/)) {
    let line = ""
    for (const word of paragraph.split(/\s+/).filter(Boolean).map((word) => encodable(word, font))) {
      const candidate = line ? `${line} ${word}` : word
      if (font.widthOfTextAtSize(candidate, size) <= width) {
        line = candidate
        continue
      }
      if (line) lines.push(line)
      line = font.widthOfTextAtSize(word, size) <= width ? word : breakWord(word, font, size, width, lines)
    }
    lines.push(line)
  }
  return lines
}

function breakWord(word: string, font: PDFFont, size: number, width: number, lines: string[]) {
  let current = ""
  for (const character of word) {
    if (font.widthOfTextAtSize(current + character, size) > width && current) {
      lines.push(current)
      current = ""
    }
    current += character
  }
  return current
}

// The standard fonts only carry WinAnsi glyphs; unsupported characters are replaced rather than failing.
function encodable(text: string, font: PDFFont) {
  try {
    font.encodeText(text)
    return text
  } catch {
    return Array.from(text)
      .map((character) => {
        try {
          font.encodeText(character)
          return character
        } catch {
          return "?"
        }
      })
      .join("")
  }
}
