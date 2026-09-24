import * as xlsx from "xlsx"
import JSZip from "jszip"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export async function createFixtures(prefix = "office-fixture-") {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix))
  await mkdir(directory, { recursive: true })
  await Promise.all([
    writeDocx(directory),
    writeXlsx(directory),
    writePptx(directory),
  ])
  return {
    directory,
    docx: path.join(directory, "document.docx"),
    xlsx: path.join(directory, "workbook.xlsx"),
    pptx: path.join(directory, "presentation.pptx"),
  }
}

async function writeDocx(directory: string) {
  const archive = new JSZip()
  archive.file("[Content_Types].xml", contentTypes("document"))
  archive.file("word/document.xml", docxDocumentXml())
  archive.file("_rels/.rels", packageRels("word/document.xml"))
  archive.file("word/_rels/document.xml.rels", documentRels())
  const buffer = await archive.generateAsync({ type: "nodebuffer" })
  await writeFile(path.join(directory, "document.docx"), Buffer.from(buffer))
}

async function writeXlsx(directory: string) {
  const book = xlsx.utils.book_new()
  const sheet = xlsx.utils.aoa_to_sheet([
    ["Name", "Score"],
    ["Alice", 10],
    ["Bob", 20],
  ])
  xlsx.utils.book_append_sheet(book, sheet, "Scores")
  xlsx.writeFile(book, path.join(directory, "workbook.xlsx"))
}

async function writePptx(directory: string) {
  const archive = new JSZip()
  archive.file("[Content_Types].xml", contentTypes("presentation"))
  archive.file("ppt/presentation.xml", pptxPresentationXml())
  archive.file("ppt/slides/slide1.xml", pptxSlideXml("Hello Slide", "First note"))
  archive.file("ppt/slides/slide2.xml", pptxSlideXml("Second Slide", "Second note"))
  archive.file("_rels/.rels", packageRels("ppt/presentation.xml"))
  archive.file("ppt/_rels/presentation.xml.rels", presentationRels())
  archive.file("ppt/slides/_rels/slide1.xml.rels", slideRels(1))
  archive.file("ppt/slides/_rels/slide2.xml.rels", slideRels(2))
  const buffer = await archive.generateAsync({ type: "nodebuffer" })
  await writeFile(path.join(directory, "presentation.pptx"), Buffer.from(buffer))
}

function contentTypes(kind: "document" | "presentation") {
  const override =
    kind === "document"
      ? '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
      : '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>'
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  ${override}
</Types>`
}

function packageRels(target: string) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${target}"/>
</Relationships>`
}

function documentRels() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
</Relationships>`
}

function docxDocumentXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Document Title</w:t></w:r></w:p>
    <w:p><w:r><w:t>First paragraph.</w:t></w:r></w:p>
    <w:p><w:r><w:t>Second paragraph.</w:t></w:r></w:p>
    <w:tbl>
      <w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc></w:tr>
      <w:tr><w:tc><w:p><w:r><w:t>C</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>D</w:t></w:r></w:p></w:tc></w:tr>
    </w:tbl>
  </w:body>
</w:document>`
}

function pptxPresentationXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:sldIdLst>
    <p:sldId id="256" r:id="rId1"/>
    <p:sldId id="257" r:id="rId2"/>
  </p:sldIdLst>
</p:presentation>`
}

function presentationRels() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>
</Relationships>`
}

function slideRels(index: number) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdNotes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide${index}.xml"/>
</Relationships>`
}

function pptxSlideXml(title: string, note: string) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:sp><p:txBody><a:bodyPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"/><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp>
    </p:spTree>
  </p:cSld>
  <p:notesSlides>
    <p:notesSlide>
      <p:cSld>
        <p:spTree>
          <p:sp><p:txBody><a:bodyPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"/><a:p><a:r><a:t>${note}</a:t></a:r></a:p></p:txBody></p:sp>
        </p:spTree>
      </p:cSld>
    </p:notesSlide>
  </p:notesSlides>
</p:sld>`
}
