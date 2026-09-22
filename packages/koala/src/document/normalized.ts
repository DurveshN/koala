export * as DocumentNormalized from "./normalized"

import { Schema } from "effect"
import { IndustrialCitation } from "../industrial/citation"

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))
const Coordinate = Schema.Number.check(
  Schema.isFinite(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(1),
)
const PositiveFiniteNumber = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0))

export const Confidence = Coordinate.annotate({ identifier: "DocumentNormalized.Confidence" })
export type Confidence = typeof Confidence.Type

export const BoundingBox = Schema.Struct({
  left: Coordinate,
  top: Coordinate,
  right: Coordinate,
  bottom: Coordinate,
}).check(
  Schema.makeFilter((box) =>
    box.left < box.right && box.top < box.bottom
      ? undefined
      : "Bounding box right and bottom must exceed left and top",
  ),
).annotate({ identifier: "DocumentNormalized.BoundingBox" })
export type BoundingBox = typeof BoundingBox.Type

export const OcrWord = Schema.Struct({
  text: Schema.String,
  confidence: Confidence,
  bounds: BoundingBox,
  locator: IndustrialCitation.Locator,
}).annotate({ identifier: "DocumentNormalized.OcrWord" })
export type OcrWord = typeof OcrWord.Type

export const OcrLine = Schema.Struct({
  text: Schema.String,
  words: Schema.Array(OcrWord),
  bounds: BoundingBox,
}).annotate({ identifier: "DocumentNormalized.OcrLine" })
export type OcrLine = typeof OcrLine.Type

export const PageTextBlock = Schema.Struct({
  paragraphs: Schema.Array(Schema.String),
  lines: Schema.Array(OcrLine),
}).annotate({ identifier: "DocumentNormalized.PageTextBlock" })
export type PageTextBlock = typeof PageTextBlock.Type

export const ImageRegion = Schema.Struct({
  bounds: BoundingBox,
  locator: IndustrialCitation.Locator,
}).annotate({ identifier: "DocumentNormalized.ImageRegion" })
export type ImageRegion = typeof ImageRegion.Type

export const VisualObservation = Schema.Struct({
  description: Schema.String,
  locator: IndustrialCitation.Locator,
  coordinates: Schema.optionalKey(BoundingBox),
}).annotate({ identifier: "DocumentNormalized.VisualObservation" })
export type VisualObservation = typeof VisualObservation.Type

export const Dimensions = Schema.Struct({
  width: PositiveFiniteNumber,
  height: PositiveFiniteNumber,
}).annotate({ identifier: "DocumentNormalized.Dimensions" })
export type Dimensions = typeof Dimensions.Type

export const Page = Schema.Struct({
  pageNumber: PositiveInt,
  dimensions: Dimensions,
  textBlocks: Schema.Array(PageTextBlock),
  ocrLines: Schema.Array(OcrLine),
  imageRegions: Schema.Array(ImageRegion),
  visualObservations: Schema.Array(VisualObservation),
}).annotate({ identifier: "DocumentNormalized.Page" })
export type Page = typeof Page.Type

export const Section = Schema.Struct({
  type: Schema.Literals(["document", "slide", "sheet"]),
  heading: Schema.optionalKey(Schema.String),
  body: Schema.String,
}).annotate({ identifier: "DocumentNormalized.Section" })
export type Section = typeof Section.Type

export const DocumentMetadata = Schema.Struct({
  title: Schema.optionalKey(Schema.String),
  author: Schema.optionalKey(Schema.String),
  pageCount: PositiveInt,
}).annotate({ identifier: "DocumentNormalized.DocumentMetadata" })
export type DocumentMetadata = typeof DocumentMetadata.Type

export const NormalizedDocument = Schema.Struct({
  source: IndustrialCitation.Locator,
  pages: Schema.Array(Page),
  sections: Schema.Array(Section),
  metadata: DocumentMetadata,
  truncated: Schema.Boolean,
}).annotate({ identifier: "DocumentNormalized.NormalizedDocument" })
export type NormalizedDocument = typeof NormalizedDocument.Type
