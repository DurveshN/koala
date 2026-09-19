export * as SandboxProtocol from "./protocol"

import { Schema } from "effect"

export const ProtocolVersion = Schema.Literal(1)
export type ProtocolVersion = typeof ProtocolVersion.Type

export const RunID = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/)).pipe(
  Schema.brand("SandboxProtocol.RunID"),
)
export type RunID = typeof RunID.Type

export const AbsolutePath = Schema.String.check(
  Schema.makeFilter((value) => {
    if (value.includes("\0")) return "Paths cannot contain null bytes"

    const normalized = value.replaceAll("\\", "/")
    if (!normalized.startsWith("/") && !/^[a-zA-Z]:\//.test(normalized)) return "Expected an absolute path"
    return normalized.split("/").some((segment) => segment === "." || segment === "..")
      ? "Paths cannot contain dot segments"
      : undefined
  }),
).pipe(Schema.brand("SandboxProtocol.AbsolutePath"))
export type AbsolutePath = typeof AbsolutePath.Type

export const Command = Schema.String.check(
  Schema.makeFilter((value) =>
    value.trim().length > 0 && !value.includes("\0") ? undefined : "Expected a non-empty command without null bytes",
  ),
)
export type Command = typeof Command.Type

const EnvironmentKeys = ["HOME", "LANG", "LC_ALL", "PATH", "TMPDIR"] as const
const environmentKeys = new Set<string>(EnvironmentKeys)

export const EnvironmentKey = Schema.Literals(EnvironmentKeys)
export type EnvironmentKey = typeof EnvironmentKey.Type

const EnvironmentValue = Schema.String.check(
  Schema.makeFilter((value) => (value.includes("\0") ? "Environment values cannot contain null bytes" : undefined)),
)

export const Environment = Schema.Record(Schema.String, EnvironmentValue).check(
  Schema.makeFilter((environment) =>
    Object.keys(environment).every((key) => environmentKeys.has(key))
      ? undefined
      : `Environment keys must be one of: ${EnvironmentKeys.join(", ")}`,
  ),
)
export type Environment = typeof Environment.Type

const PositiveFiniteInt = Schema.Int.check(Schema.isFinite(), Schema.isGreaterThan(0))

export interface ExecutionRequest extends Schema.Schema.Type<typeof ExecutionRequest> {}
export const ExecutionRequest = Schema.Struct({
  command: Command,
  cwd: AbsolutePath,
  readRoots: Schema.Array(AbsolutePath),
  writeRoots: Schema.Array(AbsolutePath),
  env: Environment,
  network: Schema.Tuple([]),
  timeoutMs: PositiveFiniteInt,
  maxOutputBytes: PositiveFiniteInt,
}).annotate({ identifier: "SandboxProtocol.ExecutionRequest" })

export const AvailabilityRequest = Schema.Struct({
  protocolVersion: ProtocolVersion,
  type: Schema.Literal("availability"),
})

export const ExecuteRequest = Schema.Struct({
  protocolVersion: ProtocolVersion,
  type: Schema.Literal("execute"),
  runID: RunID,
  request: ExecutionRequest,
})

export const CancelRequest = Schema.Struct({
  protocolVersion: ProtocolVersion,
  type: Schema.Literal("cancel"),
  runID: RunID,
})

export const WorkerRequest = Schema.Union([AvailabilityRequest, ExecuteRequest, CancelRequest]).annotate({
  discriminator: "type",
  identifier: "SandboxProtocol.WorkerRequest",
})
export type WorkerRequest = typeof WorkerRequest.Type

export const UnavailabilityReason = Schema.Literals([
  "unsupported-platform",
  "sandbox-unavailable",
  "initialization-failed",
])
export type UnavailabilityReason = typeof UnavailabilityReason.Type

export const AvailabilityStatus = Schema.Union([
  Schema.Struct({ status: Schema.Literal("available") }),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    reason: UnavailabilityReason,
  }),
]).annotate({ discriminator: "status", identifier: "SandboxProtocol.AvailabilityStatus" })
export type AvailabilityStatus = typeof AvailabilityStatus.Type

export const ViolationKind = Schema.Literals(["filesystem-read", "filesystem-write", "network", "process"])
export type ViolationKind = typeof ViolationKind.Type

export interface Violation extends Schema.Schema.Type<typeof Violation> {}
export const Violation = Schema.Struct({
  kind: ViolationKind,
  operation: Schema.String,
  target: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "SandboxProtocol.Violation" })

export interface ExecutionResult extends Schema.Schema.Type<typeof ExecutionResult> {}
export const ExecutionResult = Schema.Struct({
  exitCode: Schema.NullOr(Schema.Int),
  stdout: Schema.String,
  stderr: Schema.String,
  timedOut: Schema.Boolean,
  cancelled: Schema.Boolean,
  outputTruncated: Schema.Boolean,
  violations: Schema.Array(Violation),
}).annotate({ identifier: "SandboxProtocol.ExecutionResult" })

export const FailureCode = Schema.Literals([
  "invalid-request",
  "protocol-mismatch",
  "sandbox-unavailable",
  "execution-failed",
  "worker-failed",
])
export type FailureCode = typeof FailureCode.Type

export const AvailabilityResponse = Schema.Struct({
  protocolVersion: ProtocolVersion,
  type: Schema.Literal("availability"),
  availability: AvailabilityStatus,
})

export const ResultResponse = Schema.Struct({
  protocolVersion: ProtocolVersion,
  type: Schema.Literal("result"),
  runID: RunID,
  result: ExecutionResult,
})

export const FailureResponse = Schema.Struct({
  protocolVersion: ProtocolVersion,
  type: Schema.Literal("failure"),
  runID: Schema.NullOr(RunID),
  code: FailureCode,
})

export const WorkerResponse = Schema.Union([AvailabilityResponse, ResultResponse, FailureResponse]).annotate({
  discriminator: "type",
  identifier: "SandboxProtocol.WorkerResponse",
})
export type WorkerResponse = typeof WorkerResponse.Type
