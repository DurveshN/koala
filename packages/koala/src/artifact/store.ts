export * as ArtifactStore from "./store"

import { Context, Effect, Schema, Stream } from "effect"
import { Artifact } from "./artifact"
import { SandboxProtocol } from "../sandbox/protocol"

export interface Staging {
  readonly runID: SandboxProtocol.RunID
  readonly root: string
  readonly work: string
  readonly artifacts: string
}

export interface PromoteInput {
  readonly runID: SandboxProtocol.RunID
  readonly outputPath: Artifact.OutputPath
  readonly provenance: Artifact.Provenance
  readonly lineage?: ReadonlyArray<Artifact.Lineage>
}

export class StagingError extends Schema.TaggedErrorClass<StagingError>()("ArtifactStoreStagingError", {
  runID: SandboxProtocol.RunID,
}) {
  override get message() {
    return `Failed to create artifact staging for run: ${this.runID}`
  }
}

export class InvalidOutputPathError extends Schema.TaggedErrorClass<InvalidOutputPathError>()(
  "ArtifactStoreInvalidOutputPathError",
  { path: Schema.String },
) {
  override get message() {
    return `Invalid artifact output path: ${this.path}`
  }
}

export class CandidateNotFoundError extends Schema.TaggedErrorClass<CandidateNotFoundError>()(
  "ArtifactStoreCandidateNotFoundError",
  {
    runID: SandboxProtocol.RunID,
    outputPath: Artifact.OutputPath,
  },
) {
  override get message() {
    return `Artifact output was not found: ${this.outputPath}`
  }
}

export const LimitKind = Schema.Literals(["output-count", "artifact-size", "run-size"])
export type LimitKind = typeof LimitKind.Type

export class LimitError extends Schema.TaggedErrorClass<LimitError>()("ArtifactStoreLimitError", {
  kind: LimitKind,
  maximum: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  actual: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
}) {
  override get message() {
    return `Artifact ${this.kind} limit exceeded: ${this.actual} > ${this.maximum}`
  }
}

export class ValidationError extends Schema.TaggedErrorClass<ValidationError>()("ArtifactStoreValidationError", {
  outputPath: Artifact.OutputPath,
  validation: Artifact.Validation,
}) {
  override get message() {
    return `Artifact validation rejected: ${this.outputPath}`
  }
}

export class CorruptionError extends Schema.TaggedErrorClass<CorruptionError>()("ArtifactStoreCorruptionError", {
  digest: Artifact.Digest,
}) {
  override get message() {
    return `Artifact blob is corrupt: ${this.digest}`
  }
}

export class PromotionError extends Schema.TaggedErrorClass<PromotionError>()("ArtifactStorePromotionError", {
  runID: SandboxProtocol.RunID,
  outputPath: Artifact.OutputPath,
}) {
  override get message() {
    return `Failed to promote artifact output: ${this.outputPath}`
  }
}

export class ArtifactNotFoundError extends Schema.TaggedErrorClass<ArtifactNotFoundError>()(
  "ArtifactStoreArtifactNotFoundError",
  { artifactID: Artifact.ID },
) {
  override get message() {
    return `Artifact not found: ${this.artifactID}`
  }
}

export class MetadataReadError extends Schema.TaggedErrorClass<MetadataReadError>()("ArtifactStoreMetadataReadError", {
  artifactID: Artifact.ID,
}) {
  override get message() {
    return `Failed to read artifact metadata: ${this.artifactID}`
  }
}

export class ContentAccessError extends Schema.TaggedErrorClass<ContentAccessError>()(
  "ArtifactStoreContentAccessError",
  { artifactID: Artifact.ID },
) {
  override get message() {
    return `Failed to access artifact content: ${this.artifactID}`
  }
}

export class AbandonmentError extends Schema.TaggedErrorClass<AbandonmentError>()("ArtifactStoreAbandonmentError", {
  runID: SandboxProtocol.RunID,
}) {
  override get message() {
    return `Failed to abandon artifact staging for run: ${this.runID}`
  }
}

export type PromoteError =
  | InvalidOutputPathError
  | CandidateNotFoundError
  | LimitError
  | ValidationError
  | CorruptionError
  | PromotionError

export type ReadError = ArtifactNotFoundError | MetadataReadError
export type ContentError = ArtifactNotFoundError | ContentAccessError | CorruptionError

export interface Interface {
  readonly stage: (runID: SandboxProtocol.RunID) => Effect.Effect<Staging, StagingError>
  readonly promote: (input: PromoteInput) => Effect.Effect<Artifact.Metadata, PromoteError>
  readonly metadata: (artifactID: Artifact.ID) => Effect.Effect<Artifact.Metadata, ReadError>
  readonly content: (artifactID: Artifact.ID) => Stream.Stream<Uint8Array, ContentError>
  readonly abandon: (runID: SandboxProtocol.RunID) => Effect.Effect<void, AbandonmentError>
}

export class Service extends Context.Service<Service, Interface>()("@koala-ai/core/ArtifactStore") {}
