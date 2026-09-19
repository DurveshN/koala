export * as Artifact from "./artifact"

import { Schema } from "effect"
import { SandboxProtocol } from "../sandbox/protocol"

export const MaxOutputsPerRun = 10
export const MaxArtifactBytes = 100 * 1024 * 1024
export const MaxRunBytes = 250 * 1024 * 1024
export const MaxOutputPathLength = 1_024
export const MaxNameLength = 255
export const MaxMimeTypeLength = 127
export const MaxValidationFindings = 20
export const MaxValidationFindingLength = 1_024
export const MimeSampleBytes = 8_192
export const ValidatorName = "koala-basic"
export const ValidatorVersion = "1"

export const ID = Schema.String.check(
  Schema.isPattern(/^art_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
).pipe(Schema.brand("Artifact.ID"))
export type ID = typeof ID.Type

export const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)).pipe(Schema.brand("Artifact.Digest"))
export type Digest = typeof Digest.Type

export const OutputPath = Schema.String.check(
  Schema.isMaxLength(MaxOutputPathLength),
  Schema.makeFilter((value) => {
    if (value.length === 0) return "Output paths cannot be empty"
    if (value.includes("\0") || /[\u0001-\u001f\u007f]/.test(value))
      return "Output paths cannot contain control characters"
    if (value.includes("\\")) return "Output paths must use forward slashes"
    if (value.startsWith("/") || /^[a-zA-Z]:/.test(value)) return "Output paths must be relative"
    const segments = value.split("/")
    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
      return "Output paths must be normalized without empty or dot segments"
    }
    if (segments.some((segment) => segment.includes(":") || /[. ]$/.test(segment))) {
      return "Output paths cannot use Windows streams or trailing dots and spaces"
    }
    if (segments.some((segment) => /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/i.test(segment))) {
      return "Output paths cannot use reserved Windows device names"
    }
    return undefined
  }),
).pipe(Schema.brand("Artifact.OutputPath"))
export type OutputPath = typeof OutputPath.Type

export const OutputPaths = Schema.Array(OutputPath).check(
  Schema.isMaxLength(MaxOutputsPerRun),
  Schema.makeFilter((paths) => {
    const normalized = paths.map((outputPath) => outputPath.toLowerCase())
    return new Set(normalized).size === paths.length ? undefined : "Declared output paths must be unique ignoring case"
  }),
)
export type OutputPaths = typeof OutputPaths.Type

export const Name = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(MaxNameLength),
  Schema.makeFilter((value) =>
    value === value.trim() && !/[\u0000-\u001f\u007f/\\]/.test(value)
      ? undefined
      : "Artifact names must be trimmed file names without control characters or separators",
  ),
).pipe(Schema.brand("Artifact.Name"))
export type Name = typeof Name.Type

export const MimeType = Schema.String.check(
  Schema.isMaxLength(MaxMimeTypeLength),
  Schema.isPattern(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/),
).pipe(Schema.brand("Artifact.MimeType"))
export type MimeType = typeof MimeType.Type

export const ByteSize = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(MaxArtifactBytes),
).pipe(Schema.brand("Artifact.ByteSize"))
export type ByteSize = typeof ByteSize.Type

const BoundedIdentifier = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(128),
  Schema.makeFilter((value) =>
    value === value.trim() && !value.includes("\0") ? undefined : "Expected a trimmed identifier",
  ),
)

const ValidationFindingCode = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9._-]{0,63}$/)).pipe(
  Schema.brand("Artifact.ValidationFindingCode"),
)

const ValidationFindingMessage = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(MaxValidationFindingLength),
)

export interface ValidationFinding extends Schema.Schema.Type<typeof ValidationFinding> {}
export const ValidationFinding = Schema.Struct({
  code: ValidationFindingCode,
  message: ValidationFindingMessage,
}).annotate({ identifier: "Artifact.ValidationFinding" })

export const ValidationState = Schema.Literals(["accepted", "rejected"])
export type ValidationState = typeof ValidationState.Type

export interface Validation extends Schema.Schema.Type<typeof Validation> {}
export const Validation = Schema.Struct({
  state: ValidationState,
  validator: BoundedIdentifier,
  validatorVersion: BoundedIdentifier,
  findings: Schema.Array(ValidationFinding).check(Schema.isMaxLength(MaxValidationFindings)),
}).annotate({ identifier: "Artifact.Validation" })

export interface Provenance extends Schema.Schema.Type<typeof Provenance> {}
export const Provenance = Schema.Struct({
  sessionID: BoundedIdentifier,
  messageID: BoundedIdentifier,
  toolName: BoundedIdentifier,
  toolCallID: Schema.optionalKey(BoundedIdentifier),
  sandboxRunID: Schema.optionalKey(SandboxProtocol.RunID),
}).annotate({ identifier: "Artifact.Provenance" })

export const LineageRelation = Schema.Literal("derived-from")
export type LineageRelation = typeof LineageRelation.Type

export interface Lineage extends Schema.Schema.Type<typeof Lineage> {}
export const Lineage = Schema.Struct({
  sourceArtifactID: ID,
  relation: LineageRelation,
}).annotate({ identifier: "Artifact.Lineage" })

const ReferenceFields = {
  id: ID,
  name: Name,
  mime: MimeType,
  size: ByteSize,
  digest: Digest,
}

export interface Reference extends Schema.Schema.Type<typeof Reference> {}
export const Reference = Schema.Struct(ReferenceFields).annotate({ identifier: "Artifact.Reference" })

export interface Metadata extends Schema.Schema.Type<typeof Metadata> {}
export const Metadata = Schema.Struct({
  ...ReferenceFields,
  validation: Validation,
  provenance: Provenance,
  lineage: Schema.Array(Lineage),
  timeCreated: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
}).annotate({ identifier: "Artifact.Metadata" })
