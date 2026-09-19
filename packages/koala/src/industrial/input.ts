export * as IndustrialInput from "./input"

import { Schema } from "effect"
import { Artifact } from "../artifact/artifact"

export const MaxSources = 100

export const Path = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(4_096),
  Schema.makeFilter((value) => {
    if (value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
      return "Expected a trimmed path without control characters"
    }
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? "URLs are not valid artifact input paths" : undefined
  }),
).pipe(Schema.brand("IndustrialInput.Path"))
export type Path = typeof Path.Type

export interface ArtifactSource extends Schema.Schema.Type<typeof ArtifactSource> {}
export const ArtifactSource = Schema.Struct({
  artifactID: Artifact.ID,
  path: Schema.optionalKey(Schema.Never),
}).annotate({ identifier: "IndustrialInput.ArtifactSource" })

export interface PathSource extends Schema.Schema.Type<typeof PathSource> {}
export const PathSource = Schema.Struct({
  artifactID: Schema.optionalKey(Schema.Never),
  path: Path,
}).annotate({ identifier: "IndustrialInput.PathSource" })

export const Source = Schema.Union([ArtifactSource, PathSource]).annotate({
  identifier: "IndustrialInput.Source",
})
export type Source = typeof Source.Type

export const Sources = Schema.Array(Source).check(Schema.isMaxLength(MaxSources))
export type Sources = typeof Sources.Type

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(MaxSources))

export interface Summary extends Schema.Schema.Type<typeof Summary> {}
export const Summary = Schema.Struct({
  sourceCount: Count,
  artifactCount: Count,
  pathCount: Count,
  declaredOutputCount: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(Artifact.MaxOutputsPerRun),
  ),
})
  .check(
    Schema.makeFilter((summary) =>
      summary.sourceCount === summary.artifactCount + summary.pathCount
        ? undefined
        : "Source count must equal artifact and path counts",
    ),
  )
  .annotate({ identifier: "IndustrialInput.Summary" })

export function summarize(sources: ReadonlyArray<Source>, declaredOutputCount = 0): Summary {
  return Schema.decodeUnknownSync(Summary)({
    sourceCount: sources.length,
    artifactCount: sources.filter((source) => "artifactID" in source).length,
    pathCount: sources.filter((source) => "path" in source).length,
    declaredOutputCount,
  })
}
