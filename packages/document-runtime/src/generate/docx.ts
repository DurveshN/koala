import * as docx from "docx"

export interface DocxContent {
  readonly title?: string
  readonly author?: string
  readonly sections: ReadonlyArray<DocxSection>
}

export interface DocxSection {
  readonly type: "heading" | "paragraph" | "table" | "page-break"
  readonly text?: string
  readonly level?: number
  readonly rows?: ReadonlyArray<ReadonlyArray<string>>
}

export async function generateDocx(content: DocxContent): Promise<Buffer> {
  const children = content.sections.flatMap((section) => sectionToDocx(section))
  const document = new docx.Document({
    creator: content.author ?? "",
    title: content.title ?? "",
    sections: [
      {
        properties: {},
        children,
      },
    ],
  })
  return docx.Packer.toBuffer(document)
}

function sectionToDocx(section: DocxSection): docx.Paragraph | docx.Table {
  if (section.type === "page-break") return new docx.Paragraph({ children: [new docx.PageBreak()] })
  if (section.type === "heading") {
    return new docx.Paragraph({
      text: section.text ?? "",
      heading: headingLevel(section.level),
    })
  }
  if (section.type === "table") {
    return new docx.Table({
      rows:
        section.rows?.map(
          (row) =>
            new docx.TableRow({
              children: row.map(
                (cell) =>
                  new docx.TableCell({
                    children: [new docx.Paragraph(cell)],
                  }),
              ),
            }),
        ) ?? [],
    })
  }
  return new docx.Paragraph(section.text ?? "")
}

function headingLevel(level: number | undefined): (typeof docx.HeadingLevel)[keyof typeof docx.HeadingLevel] {
  if (level === 2) return docx.HeadingLevel.HEADING_2
  if (level === 3) return docx.HeadingLevel.HEADING_3
  if (level === 4) return docx.HeadingLevel.HEADING_4
  if (level === 5) return docx.HeadingLevel.HEADING_5
  if (level === 6) return docx.HeadingLevel.HEADING_6
  return docx.HeadingLevel.HEADING_1
}
