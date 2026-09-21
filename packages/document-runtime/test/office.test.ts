import { afterEach, describe, expect, test } from "bun:test"
import { lstat, rm } from "node:fs/promises"
import { readDocx, readPptx, readXlsx } from "../src/office"
import { createFixtures } from "./fixtures/office"

describe("office parsers", () => {
  let fixtures: Awaited<ReturnType<typeof createFixtures>> | undefined

  afterEach(async () => {
    if (fixtures) await rm(fixtures.directory, { recursive: true, force: true })
    fixtures = undefined
  })

  test("reads a DOCX into structured text", async () => {
    fixtures = await createFixtures()
    const info = await lstat(fixtures.docx)
    const result = JSON.parse(Buffer.from(await readDocx(fixtures.docx, info.size)).toString("utf8"))
    expect(result.sections.length).toBeGreaterThan(0)
    const text = result.sections.map((section: { body: string }) => section.body).join("\n")
    expect(text).toContain("First paragraph")
    expect(text).toContain("Second paragraph")
    expect(text).toContain("A")
    expect(text).toContain("D")
  })

  test("reads an XLSX into sheet sections", async () => {
    fixtures = await createFixtures()
    const info = await lstat(fixtures.xlsx)
    const result = JSON.parse(Buffer.from(await readXlsx(fixtures.xlsx, info.size)).toString("utf8"))
    expect(result.sections.length).toBe(1)
    const sheet = result.sections[0]
    expect(sheet.type).toBe("sheet")
    expect(sheet.heading).toBe("Scores")
    expect(sheet.body).toContain("Alice")
    expect(sheet.body).toContain("Bob")
  })

  test("reads a PPTX into slide sections", async () => {
    fixtures = await createFixtures()
    const info = await lstat(fixtures.pptx)
    const result = JSON.parse(Buffer.from(await readPptx(fixtures.pptx, info.size)).toString("utf8"))
    expect(result.sections.length).toBeGreaterThanOrEqual(1)
    const text = result.sections.map((section: { body: string }) => section.body).join("\n")
    expect(text).toContain("Hello Slide")
    expect(text).toContain("First note")
  })

  test("rejects unknown paths", async () => {
    await expect(readDocx("/nonexistent/file.docx", 1)).rejects.toBeTruthy()
  })
})
