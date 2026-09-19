export function pdfFixture(pageCount = 1) {
  const pageIDs = Array.from({ length: pageCount }, (_, index) => 4 + index * 2)
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Count ${pageCount} /Kids [${pageIDs.map((id) => `${id} 0 R`).join(" ")}] >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ...pageIDs.flatMap((pageID, index) => {
      const contentID = pageID + 1
      const content = `BT /F1 28 Tf 72 700 Td (HELLO PAGE ${index + 1}) Tj ET`
      return [
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentID} 0 R >>`,
        `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
      ]
    }),
  ]
  const chunks = ["%PDF-1.7\n%\xE2\xE3\xCF\xD3\n"]
  const offsets = objects.map((object, index) => {
    const offset = Buffer.byteLength(chunks.join(""), "binary")
    chunks.push(`${index + 1} 0 obj\n${object}\nendobj\n`)
    return offset
  })
  const xref = Buffer.byteLength(chunks.join(""), "binary")
  chunks.push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`)
  chunks.push(offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join(""))
  chunks.push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
  return Buffer.from(chunks.join(""), "binary")
}
