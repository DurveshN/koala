export * as IndustrialAudit from "./audit"

import { Context, Effect, Schema } from "effect"
import { Artifact } from "../artifact/artifact"
import { SandboxProtocol } from "../sandbox/protocol"
import { IndustrialInput } from "./input"
import { IndustrialResult } from "./result"
import { IndustrialTool } from "./tool"

const Identifier = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/))
export const MaxToolCallIDLength = 512
export const ToolCallID = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(MaxToolCallIDLength),
  Schema.makeFilter((value) =>
    /[\u0000-\u001f\u007f]/.test(value) ? "Tool call IDs cannot contain control characters" : undefined,
  ),
).pipe(Schema.brand("IndustrialAudit.ToolCallID"))
export type ToolCallID = typeof ToolCallID.Type
const Timestamp = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const ArtifactIDs = Schema.Array(Artifact.ID).check(
  Schema.isMaxLength(IndustrialInput.MaxSources),
  Schema.makeFilter((ids) => (new Set(ids).size === ids.length ? undefined : "Artifact IDs must be unique")),
)
const OutputArtifactIDs = Schema.Array(Artifact.ID).check(
  Schema.isMaxLength(Artifact.MaxOutputsPerRun),
  Schema.makeFilter((ids) => (new Set(ids).size === ids.length ? undefined : "Output artifact IDs must be unique")),
)

export const ID = Schema.String.check(
  Schema.isPattern(/^aud_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
).pipe(Schema.brand("IndustrialAudit.ID"))
export type ID = typeof ID.Type

const BaseFields = {
  id: ID,
  tool: IndustrialTool.Name,
  permission: IndustrialTool.Permission,
  sessionID: Identifier,
  messageID: Identifier,
  toolCallID: ToolCallID,
  startedAt: Timestamp,
  engine: IndustrialTool.Engine,
  contractVersion: IndustrialTool.ContractVersion,
  inputDigest: Artifact.Digest,
  inputSummary: IndustrialInput.Summary,
  sourceArtifactIDs: ArtifactIDs,
}

const CompletionFields = {
  finishedAt: Timestamp,
  durationMs: Timestamp,
  producerTruncated: Schema.Boolean,
  projectionTruncated: Schema.Boolean,
  sourceArtifactIDs: ArtifactIDs,
  outputArtifactIDs: OutputArtifactIDs,
  sandboxRunID: Schema.optionalKey(SandboxProtocol.RunID),
  routeDecisionID: Schema.optionalKey(IndustrialResult.RouteDecisionID),
}

export interface Running extends Schema.Schema.Type<typeof Running> {}
export const Running = Schema.Struct({
  ...BaseFields,
  state: Schema.Literal("running"),
})
  .check(
    Schema.makeFilter((record) =>
      IndustrialTool.permission(record.tool) === record.permission
        ? undefined
        : "Audit permission must match the industrial tool permission",
    ),
  )
  .annotate({ identifier: "IndustrialAudit.Running" })

const CompletedSuccess = Schema.Struct({
  ...BaseFields,
  ...CompletionFields,
  state: Schema.Literal("completed"),
  outcome: Schema.Literal("success"),
  cancelled: Schema.Literal(false),
  timedOut: Schema.Literal(false),
  errorCode: Schema.optionalKey(Schema.Never),
})

const CompletedError = Schema.Struct({
  ...BaseFields,
  ...CompletionFields,
  state: Schema.Literal("completed"),
  outcome: Schema.Literal("error"),
  cancelled: Schema.Literal(false),
  timedOut: Schema.Literal(false),
  errorCode: IndustrialResult.GeneralErrorCode,
})

const CompletedCancelled = Schema.Struct({
  ...BaseFields,
  ...CompletionFields,
  state: Schema.Literal("completed"),
  outcome: Schema.Literal("cancelled"),
  cancelled: Schema.Literal(true),
  timedOut: Schema.Literal(false),
  errorCode: Schema.Literal("cancelled"),
})

const CompletedTimedOut = Schema.Struct({
  ...BaseFields,
  ...CompletionFields,
  state: Schema.Literal("completed"),
  outcome: Schema.Literal("timeout"),
  cancelled: Schema.Literal(false),
  timedOut: Schema.Literal(true),
  errorCode: Schema.Literal("deadline-exceeded"),
})

export const Completed = Schema.Union([CompletedSuccess, CompletedError, CompletedCancelled, CompletedTimedOut])
  .check(
    Schema.makeFilter((record) =>
      IndustrialTool.permission(record.tool) === record.permission
        ? undefined
        : "Audit permission must match the industrial tool permission",
    ),
    Schema.makeFilter((record) =>
      record.finishedAt >= record.startedAt && record.durationMs === record.finishedAt - record.startedAt
        ? undefined
        : "Audit duration must match the non-negative start and finish interval",
    ),
  )
  .annotate({ identifier: "IndustrialAudit.Completed" })
export type Completed = typeof Completed.Type

export const Record = Schema.Union([Running, Completed]).annotate({
  discriminator: "state",
  identifier: "IndustrialAudit.Record",
})
export type Record = typeof Record.Type

export const BeginInput = Schema.Struct({
  tool: IndustrialTool.Name,
  permission: IndustrialTool.Permission,
  sessionID: Identifier,
  messageID: Identifier,
  toolCallID: ToolCallID,
  startedAt: Timestamp,
  engine: IndustrialTool.Engine,
  contractVersion: IndustrialTool.ContractVersion,
  inputDigest: Artifact.Digest,
  inputSummary: IndustrialInput.Summary,
  sourceArtifactIDs: ArtifactIDs,
}).check(
  Schema.makeFilter((input) =>
    IndustrialTool.permission(input.tool) === input.permission
      ? undefined
      : "Audit permission must match the industrial tool permission",
  ),
)
export type BeginInput = typeof BeginInput.Type

const CompleteIdentity = { auditID: ID }

export const CompleteInput = Schema.Union([
  Schema.Struct({
    ...CompleteIdentity,
    ...CompletionFields,
    outcome: Schema.Literal("success"),
    cancelled: Schema.Literal(false),
    timedOut: Schema.Literal(false),
    errorCode: Schema.optionalKey(Schema.Never),
  }),
  Schema.Struct({
    ...CompleteIdentity,
    ...CompletionFields,
    outcome: Schema.Literal("error"),
    cancelled: Schema.Literal(false),
    timedOut: Schema.Literal(false),
    errorCode: IndustrialResult.GeneralErrorCode,
  }),
  Schema.Struct({
    ...CompleteIdentity,
    ...CompletionFields,
    outcome: Schema.Literal("cancelled"),
    cancelled: Schema.Literal(true),
    timedOut: Schema.Literal(false),
    errorCode: Schema.Literal("cancelled"),
  }),
  Schema.Struct({
    ...CompleteIdentity,
    ...CompletionFields,
    outcome: Schema.Literal("timeout"),
    cancelled: Schema.Literal(false),
    timedOut: Schema.Literal(true),
    errorCode: Schema.Literal("deadline-exceeded"),
  }),
]).annotate({ identifier: "IndustrialAudit.CompleteInput" })
export type CompleteInput = typeof CompleteInput.Type

export class WriteError extends Schema.TaggedErrorClass<WriteError>()("IndustrialAuditWriteError", {
  operation: Schema.Literals(["begin", "complete"]),
  code: Schema.Literals(["unavailable", "already-completed", "invalid-transition"]),
}) {
  override get message() {
    return `Industrial audit ${this.operation} failed: ${this.code}`
  }
}

export interface Interface {
  readonly begin: (input: BeginInput) => Effect.Effect<Running, WriteError>
  readonly complete: (input: CompleteInput) => Effect.Effect<Completed, WriteError>
}

export class Service extends Context.Service<Service, Interface>()("@koala-ai/core/IndustrialAudit") {}
