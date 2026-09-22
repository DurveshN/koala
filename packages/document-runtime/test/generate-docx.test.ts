import { describe, expect, test } from "bun:test"
import JSZip from "jszip"
import { generateDocx } from "../src/generate/docx"
import { validateOoxmlDocx } from "../src/validation/ooxml"

describe("DOCX generation", () => {
  test("generates a DOCX and passes OOXML validation", async () => {
    const buffer = await generateDocx({
      title: "Test Document",
      author: "Test Author",
      sections: [
        { type: "heading", text: "Introduction", level: 1 },
        { type: "paragraph", text: "This is the first paragraph." },
        { type: "paragraph", text: "This is the second paragraph." },
        {
          type: "table",
          rows: [
            ["A", "B"],
            ["C", "D"],
          ],
        },
        { type: "page-break" },
        { type: "paragraph", text: "After the break." },
      ],
    })
    expect(buffer.byteLength).toBeGreaterThan(0)
    const result = await validateOoxmlDocx(new Uint8Array(buffer), buffer.byteLength)
    expect(result.text).toContain("Introduction")
    expect(result.text).toContain("first paragraph")
    expect(result.text).toContain("A")
    expect(result.text).toContain("D")
    expect(result.text).toContain("After the break")
    expect(result.sectionCount).toBeGreaterThan(0)
  })

  test("rejects a DOCX with external relationships", async () => {
    const buffer = await generateDocx({
      sections: [{ type: "paragraph", text: "Safe content." }],
    })
    const modified = await injectExternalRelationship(new Uint8Array(buffer))
    await expect(validateOoxmlDocx(modified, modified.byteLength)).rejects.toEqual(
      expect.objectContaining({ code: "docx-generation-failed" }),
    )
  })
})

async function injectExternalRelationship(bytes: Uint8Array): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(bytes)
  const rels = await zip.file("_rels/.rels")!.async("text")
  const injected = rels.replace(
    "</Relationships>",
    '<Relationship Id="rIdExt" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="http://example.com/" TargetMode="External"/></Relationships>',
  )
  zip.file("_rels/.rels", injected)
  return zip.generateAsync({ type: "uint8array" }) as Promise<Uint8Array>
}
