import PptxGenJS from "pptxgenjs"
import { DocumentGenerate } from "@koala-ai/core/document/generate"

type PptxContent = typeof DocumentGenerate.PptxContent.Type
type Slide = PptxContent["slides"][number]

// LAYOUT_16x9 is 10 in x 5.625 in.
const SlideWidth = 10
const Margin = 0.5
const ContentWidth = SlideWidth - 2 * Margin
const SlideBottom = 5.625 - Margin

export async function generatePptx(content: PptxContent): Promise<Buffer> {
  const presentation = new PptxGenJS()
  presentation.layout = "LAYOUT_16x9"
  if (content.title) presentation.title = content.title
  if (content.author) presentation.author = content.author
  content.slides.forEach((slide, index) => addSlide(presentation, slide, index === 0))
  const output = await presentation.write({ outputType: "nodebuffer" })
  if (typeof output === "string") return Buffer.from(output, "base64")
  if (output instanceof Uint8Array) return Buffer.from(output)
  return Buffer.from(await new Response(output).arrayBuffer())
}

function addSlide(presentation: PptxGenJS, slide: Slide, first: boolean) {
  const target = presentation.addSlide()
  const hasBody = Boolean(slide.bullets?.length || slide.paragraphs?.length || slide.table?.length)
  const titleOnly = first && !hasBody
  let y = titleOnly ? 1.8 : Margin
  if (slide.title) {
    target.addText(slide.title, {
      x: Margin,
      y,
      w: ContentWidth,
      h: titleOnly ? 1.2 : 0.9,
      fontSize: titleOnly ? 36 : 28,
      bold: true,
      align: titleOnly ? "center" : "left",
      valign: "middle",
      fit: "shrink",
    })
    y += titleOnly ? 1.3 : 1.0
  }
  if (slide.subtitle) {
    target.addText(slide.subtitle, {
      x: Margin,
      y,
      w: ContentWidth,
      h: 0.6,
      fontSize: 18,
      color: "555555",
      align: titleOnly ? "center" : "left",
      valign: "middle",
      fit: "shrink",
    })
    y += 0.7
  }
  const remaining = () => Math.max(0.5, SlideBottom - y)
  if (slide.bullets?.length) {
    const h = Math.min(remaining(), 0.42 * slide.bullets.length + 0.2)
    target.addText(
      slide.bullets.map((text) => ({ text, options: { bullet: true, breakLine: true } })),
      { x: Margin, y, w: ContentWidth, h, fontSize: 18, valign: "top", fit: "shrink" },
    )
    y += h + 0.2
  }
  if (slide.paragraphs?.length) {
    const h = Math.min(remaining(), 0.6 * slide.paragraphs.length + 0.2)
    target.addText(
      slide.paragraphs.map((text) => ({ text, options: { breakLine: true, paraSpaceAfter: 8 } })),
      { x: Margin, y, w: ContentWidth, h, fontSize: 16, valign: "top", fit: "shrink" },
    )
    y += h + 0.2
  }
  if (slide.table?.length) {
    const columns = Math.max(1, ...slide.table.map((row) => row.length))
    target.addTable(
      slide.table.map((row, rowIndex) =>
        Array.from({ length: columns }, (_, column) => ({
          text: row[column] ?? "",
          options: rowIndex === 0 ? { bold: true, fill: { color: "E7EEF3" } } : {},
        })),
      ),
      {
        x: Margin,
        y,
        w: ContentWidth,
        colW: Array.from({ length: columns }, () => ContentWidth / columns),
        fontSize: 12,
        border: { type: "solid", pt: 0.5, color: "9AA5B1" },
        autoPage: true,
        autoPageRepeatHeader: true,
      },
    )
  }
  if (slide.notes) target.addNotes(slide.notes)
}
