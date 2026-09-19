export * as IndustrialResult from "./result"

import { Schema } from "effect"
import { Artifact } from "../artifact/artifact"
import { IndustrialCitation } from "./citation"
import { IndustrialInput } from "./input"
import { IndustrialTool } from "./tool"
import { SandboxProtocol } from "../sandbox/protocol"

export const GeneralErrorCode = Schema.Literals([
  "invalid-input",
  "permission-denied",
  "source-not-found",
  "source-access-denied",
  "source-not-owned",
  "source-changed",
  "source-invalid",
  "unsupported-format",
  "input-too-large",
  "limit-exceeded",
  "engine-unavailable",
  "engine-failed",
  "protocol-error",
  "sandbox-nonzero-exit",
  "validation-failed",
  "sandbox-violation",
  "output-truncated",
  "artifact-storage-failed",
  "audit-unavailable",
  "internal-error",
])
export type GeneralErrorCode = typeof GeneralErrorCode.Type

export const ErrorCode = Schema.Union([
  GeneralErrorCode,
  Schema.Literals(["cancelled", "deadline-exceeded"]),
]).annotate({ identifier: "IndustrialResult.ErrorCode" })
export type ErrorCode = typeof ErrorCode.Type

export const Error = Schema.Union([
  Schema.Struct({ code: GeneralErrorCode, retryable: Schema.Boolean }),
  Schema.Struct({ code: Schema.Literal("cancelled"), retryable: Schema.Literal(true) }),
  Schema.Struct({ code: Schema.Literal("deadline-exceeded"), retryable: Schema.Literal(true) }),
]).annotate({ identifier: "IndustrialResult.Error" })
export type Error = typeof Error.Type

export const RouteDecisionID = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
).pipe(Schema.brand("IndustrialResult.RouteDecisionID"))
export type RouteDecisionID = typeof RouteDecisionID.Type

const References = Schema.Array(Artifact.Reference).check(
  Schema.isMaxLength(IndustrialInput.MaxSources),
  Schema.makeFilter((references) =>
    new Set(references.map((reference) => reference.id)).size === references.length
      ? undefined
      : "Source artifact references must be unique",
  ),
)
const Outputs = Schema.Array(Artifact.Reference).check(
  Schema.isMaxLength(Artifact.MaxOutputsPerRun),
  Schema.makeFilter((references) =>
    new Set(references.map((reference) => reference.id)).size === references.length
      ? undefined
      : "Output artifact references must be unique",
  ),
)

const CommonFields = {
  contractVersion: IndustrialTool.ContractVersion,
  engine: IndustrialTool.Engine,
  sources: References,
  outputs: Outputs,
  citations: IndustrialCitation.Citations,
  producerTruncated: Schema.Boolean,
  routeDecisionID: Schema.optionalKey(RouteDecisionID),
  sandboxRunID: Schema.optionalKey(SandboxProtocol.RunID),
  summary: Schema.String.check(Schema.isMaxLength(16 * 1024)),
}

export interface Common {
  readonly tool: IndustrialTool.Name
  readonly contractVersion: IndustrialTool.ContractVersion
  readonly engine: IndustrialTool.Engine
  readonly sources: ReadonlyArray<Artifact.Reference>
  readonly outputs: ReadonlyArray<Artifact.Reference>
  readonly citations: IndustrialCitation.Citations
  readonly producerTruncated: boolean
  readonly routeDecisionID?: RouteDecisionID
  readonly sandboxRunID?: SandboxProtocol.RunID
  readonly summary: string
}

export interface Success<A> extends Common {
  readonly status: "success"
  readonly cancelled: false
  readonly timedOut: false
  readonly data: A
}

export interface Failure extends Common {
  readonly status: "error"
  readonly cancelled: false
  readonly timedOut: false
  readonly error: Error
}

export interface Cancelled extends Common {
  readonly status: "error"
  readonly cancelled: true
  readonly timedOut: false
  readonly error: { readonly code: "cancelled"; readonly retryable: true }
}

export interface TimedOut extends Common {
  readonly status: "error"
  readonly cancelled: false
  readonly timedOut: true
  readonly error: { readonly code: "deadline-exceeded"; readonly retryable: true }
}

export type Checked<A> = Success<A> | Failure | Cancelled | TimedOut

export function make<const Name extends IndustrialTool.Name, Data extends Schema.Top>(name: Name, data: Data) {
  const ToolField = { tool: Schema.Literal(name) }
  return Schema.Union([
    Schema.Struct({
      ...ToolField,
      ...CommonFields,
      status: Schema.Literal("success"),
      cancelled: Schema.Literal(false),
      timedOut: Schema.Literal(false),
      data,
      error: Schema.optionalKey(Schema.Never),
    }),
    Schema.Struct({
      ...ToolField,
      ...CommonFields,
      status: Schema.Literal("error"),
      cancelled: Schema.Literal(false),
      timedOut: Schema.Literal(false),
      data: Schema.optionalKey(Schema.Never),
      error: Schema.Struct({ code: GeneralErrorCode, retryable: Schema.Boolean }),
    }),
    Schema.Struct({
      ...ToolField,
      ...CommonFields,
      status: Schema.Literal("error"),
      cancelled: Schema.Literal(true),
      timedOut: Schema.Literal(false),
      data: Schema.optionalKey(Schema.Never),
      error: Schema.Struct({ code: Schema.Literal("cancelled"), retryable: Schema.Literal(true) }),
    }),
    Schema.Struct({
      ...ToolField,
      ...CommonFields,
      status: Schema.Literal("error"),
      cancelled: Schema.Literal(false),
      timedOut: Schema.Literal(true),
      data: Schema.optionalKey(Schema.Never),
      error: Schema.Struct({ code: Schema.Literal("deadline-exceeded"), retryable: Schema.Literal(true) }),
    }),
  ]).annotate({ discriminator: "status", identifier: `IndustrialResult.${name}` })
}
