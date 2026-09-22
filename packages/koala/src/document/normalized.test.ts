import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { IndustrialCitation } from "../industrial/citation"
import { DocumentNormalized } from "./normalized"

const artifactID = "art_123e4567-e89b-42d3-a456-426614174000"

const artifactLocator = Schema.decodeUnknownSync(IndustrialCitation.Locator)({
  type: "artifact",
  artifactID,
})

const bounds = (left: number, top: number, right: number, bottom: number) => ({
  left,
  top,
  right,
  bottom,
})

const validWord = {
  text: "hello",
  confidence: 0.95,
  bounds: bounds(0.1, 0.2, 0.3, 0.4),
  locator: artifactLocator,
}

const validLine = {
  text: "hello world",
  words: [validWord],
  bounds: bounds(0.1, 0.2, 0.4, 0.4),
}

const validPage = (pageNumber = 1) => ({
  pageNumber,
  dimensions: { width: 612, height: 792 },
  textBlocks: [{ paragraphs: ["Hello"], lines: [validLine] }],
  ocrLines: [validLine],
  imageRegions: [{ bounds: bounds(0, 0, 1, 1), locator: artifactLocator }],
  visualObservations: [{ description: "A heading", locator: artifactLocator }],
})

const validDocument = () =>
  ({
    source: artifactLocator,
    pages: [validPage(1)],
    sections: [{ type: "document" as const, body: "Hello world" }],
    metadata: { title: "Test", author: "Koala", pageCount: 1 },
    truncated: false,
  }) satisfies DocumentNormalized.NormalizedDocument

describe("DocumentNormalized", () => {
  test("round trips a complete normalized document", () => {
    const input = validDocument()
    const decoded = Schema.decodeUnknownSync(DocumentNormalized.NormalizedDocument)(input)
    const encoded = Schema.encodeSync(DocumentNormalized.NormalizedDocument)(decoded)
    expect(encoded).toEqual(input)
  })

  test.each([
    bounds(0.5, 0, 0.2, 1),
    bounds(0, 0.8, 1, 0.1),
    bounds(-0.1, 0, 1, 1),
    bounds(0, 0, 1, 1.01),
  ])("rejects an invalid bounding box %#", (box) => {
    expect(() => Schema.decodeUnknownSync(DocumentNormalized.BoundingBox)(box)).toThrow()
  })

  test("rejects a degenerate region locator embedded in a word", () => {
    const locator = {
      type: "region" as const,
      artifactID,
      page: 1,
      left: 0.2,
      top: 0.2,
      right: 0.2,
      bottom: 0.8,
    }
    expect(() =>
      Schema.decodeUnknownSync(DocumentNormalized.OcrWord)({
        ...validWord,
        locator,
      }),
    ).toThrow()
  })

  test("rejects an out-of-range confidence value", () => {
    expect(() => Schema.decodeUnknownSync(DocumentNormalized.OcrWord)({ ...validWord, confidence: 1.5 })).toThrow()
  })

  test("rejects a page with non-positive dimensions", () => {
    expect(() =>
      Schema.decodeUnknownSync(DocumentNormalized.Page)({
        ...validPage(),
        dimensions: { width: 0, height: 792 },
      }),
    ).toThrow()
  })

  test("requires metadata pageCount to be positive", () => {
    expect(() =>
      Schema.decodeUnknownSync(DocumentNormalized.NormalizedDocument)({
        ...validDocument(),
        metadata: { pageCount: 0 },
      }),
    ).toThrow()
  })

  test("rejects an unsupported section type", () => {
    expect(() =>
      Schema.decodeUnknownSync(DocumentNormalized.Section)({
        type: "spreadsheet",
        body: "",
      }),
    ).toThrow()
  })
})
