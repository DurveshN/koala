export * as IndustrialCitation from "./citation"

import { Schema } from "effect"
import { Artifact } from "../artifact/artifact"

export const MaxCitations = 200
export const MaxDocxStructuralDepth = 32

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))
const Offset = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Identifier = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/))
const SheetName = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(31),
  Schema.makeFilter((value) =>
    value === value.trim() && !/[\u0000-\u001f\u007f\[\]:*?/\\]/.test(value)
      ? undefined
      : "Expected a safe spreadsheet sheet name",
  ),
)
const CellRange = Schema.String.check(Schema.isPattern(/^[A-Z]{1,3}[1-9][0-9]*(?::[A-Z]{1,3}[1-9][0-9]*)?$/))
const Coordinate = Schema.Number.check(
  Schema.isFinite(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(1),
)

const SourceField = { artifactID: Artifact.ID }

export const ArtifactLocator = Schema.Struct({
  type: Schema.Literal("artifact"),
  ...SourceField,
})

export const PageLocator = Schema.Struct({
  type: Schema.Literal("page"),
  ...SourceField,
  page: PositiveInt,
})

export const RegionLocator = Schema.Struct({
  type: Schema.Literal("region"),
  ...SourceField,
  page: PositiveInt,
  left: Coordinate,
  top: Coordinate,
  right: Coordinate,
  bottom: Coordinate,
}).check(
  Schema.makeFilter((region) =>
    region.left < region.right && region.top < region.bottom
      ? undefined
      : "Region right and bottom coordinates must exceed left and top coordinates",
  ),
)

export const DocxPart = Schema.Literals(["document", "header", "footer", "footnote", "endnote", "comment"])
export const DocxNode = Schema.Literals([
  "section",
  "paragraph",
  "run",
  "list-item",
  "table",
  "row",
  "cell",
  "header",
  "footer",
  "footnote",
  "endnote",
  "comment",
])

export const DocxStructuralStep = Schema.Struct({
  node: DocxNode,
  index: Offset,
})

export const DocxLocator = Schema.Struct({
  type: Schema.Literal("docx"),
  ...SourceField,
  part: DocxPart,
  path: Schema.Array(DocxStructuralStep).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MaxDocxStructuralDepth),
  ),
  elementID: Schema.optionalKey(Identifier),
})

export const SlideLocator = Schema.Struct({
  type: Schema.Literal("slide"),
  ...SourceField,
  slide: PositiveInt,
  shapeID: Schema.optionalKey(Identifier),
})

export const SheetLocator = Schema.Struct({
  type: Schema.Literal("sheet"),
  ...SourceField,
  sheet: SheetName,
  range: Schema.optionalKey(CellRange),
})

export const TextLocator = Schema.Struct({
  type: Schema.Literal("text"),
  ...SourceField,
  start: Offset,
  end: Offset,
}).check(
  Schema.makeFilter((locator) =>
    locator.end >= locator.start ? undefined : "Text offset end must be greater than or equal to start",
  ),
)

export const Locator = Schema.Union([
  ArtifactLocator,
  PageLocator,
  RegionLocator,
  DocxLocator,
  SlideLocator,
  SheetLocator,
  TextLocator,
]).annotate({ discriminator: "type", identifier: "IndustrialCitation.Locator" })
export type Locator = typeof Locator.Type

export const Citations = Schema.Array(Locator).check(Schema.isMaxLength(MaxCitations))
export type Citations = typeof Citations.Type
