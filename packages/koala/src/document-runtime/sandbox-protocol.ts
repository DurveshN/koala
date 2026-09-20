export * as DocumentSandboxProtocol from "./sandbox-protocol"

import { Schema } from "effect"
import { DocumentRuntimeManifest } from "./manifest"
import { DocumentRuntimeProtocol } from "./protocol"
import { DocumentRuntimeTarget } from "./target"

export const ProtocolVersion = Schema.Literal(1)
export type ProtocolVersion = typeof ProtocolVersion.Type

export const AbsolutePath = Schema.String.check(
  Schema.makeFilter((value) => {
    if (value.includes("\0")) return "Paths cannot contain null bytes"

    const normalized = value.replaceAll("\\", "/")
    if (!normalized.startsWith("/") && !/^[a-zA-Z]:\//.test(normalized)) return "Expected an absolute path"
    return normalized.split("/").some((segment) => segment === "." || segment === "..")
      ? "Paths cannot contain dot segments"
      : undefined
  }),
).pipe(Schema.brand("DocumentSandboxProtocol.AbsolutePath"))
export type AbsolutePath = typeof AbsolutePath.Type

export const LaunchRequest = Schema.Struct({
  protocolVersion: ProtocolVersion,
  type: Schema.Literal("launch"),
  jobID: DocumentRuntimeProtocol.JobID,
  target: DocumentRuntimeTarget.Target,
  runtimeRoot: AbsolutePath,
  manifestSha256: DocumentRuntimeManifest.Digest,
  jobRoot: AbsolutePath,
  start: DocumentRuntimeProtocol.InitialRequest,
}).check(
  Schema.makeFilter((request) =>
    request.jobID === request.start.jobID ? undefined : "Start request job ID must match the launch job ID",
  ),
  Schema.makeFilter((request) =>
    request.start.type !== "probe" || request.target === request.start.target
      ? undefined
      : "Probe target must match the launch target",
  ),
  Schema.makeFilter((request) =>
    request.start.type !== "probe" || request.manifestSha256 === request.start.manifestSha256
      ? undefined
      : "Probe manifest digest must match the launch digest",
  ),
)

export const CommandRequest = Schema.Struct({
  protocolVersion: ProtocolVersion,
  type: Schema.Literal("command"),
  jobID: DocumentRuntimeProtocol.JobID,
  command: DocumentRuntimeProtocol.ContinuationRequest,
}).check(
  Schema.makeFilter((request) =>
    request.jobID === request.command.jobID ? undefined : "Command job ID must match the outer job ID",
  ),
)

export const CancelRequest = Schema.Struct({
  protocolVersion: ProtocolVersion,
  type: Schema.Literal("cancel"),
  jobID: DocumentRuntimeProtocol.JobID,
})

export const ParentRequest = Schema.Union([LaunchRequest, CommandRequest, CancelRequest]).annotate({
  discriminator: "type",
  identifier: "DocumentSandboxProtocol.ParentRequest",
})
export type ParentRequest = typeof ParentRequest.Type

export const AcceptedEvent = Schema.Struct({
  protocolVersion: ProtocolVersion,
  type: Schema.Literal("accepted"),
  jobID: DocumentRuntimeProtocol.JobID,
})

export const WorkerEvent = Schema.Struct({
  protocolVersion: ProtocolVersion,
  type: Schema.Literal("event"),
  jobID: DocumentRuntimeProtocol.JobID,
  event: DocumentRuntimeProtocol.WorkerEvent,
}).check(
  Schema.makeFilter((message) =>
    message.jobID === message.event.jobID ? undefined : "Worker event job ID must match the outer job ID",
  ),
)

export const FailureCode = Schema.Literals([
  "invalid-launch",
  "protocol-mismatch",
  "sandbox-unavailable",
  "dependency-failed",
  "spawn-failed",
  "transport-overflow",
  "worker-crashed",
  "termination-failed",
  "command-cleanup-failed",
  "reset-failed",
])
export type FailureCode = typeof FailureCode.Type

export const FailureStage = Schema.Literals([
  "launch",
  "sandbox",
  "dependency",
  "spawn",
  "transport",
  "worker",
  "termination",
  "command-cleanup",
  "reset",
])
export type FailureStage = typeof FailureStage.Type

export const FailureEvent = Schema.Struct({
  protocolVersion: ProtocolVersion,
  type: Schema.Literal("failure"),
  jobID: Schema.NullOr(DocumentRuntimeProtocol.JobID),
  code: FailureCode,
  stage: FailureStage,
  retryable: Schema.Boolean,
})

export const ClosedEvent = Schema.Struct({
  protocolVersion: ProtocolVersion,
  type: Schema.Literal("closed"),
  jobID: Schema.NullOr(DocumentRuntimeProtocol.JobID),
})

export const ProxyEvent = Schema.Union([AcceptedEvent, WorkerEvent, FailureEvent, ClosedEvent]).annotate({
  discriminator: "type",
  identifier: "DocumentSandboxProtocol.ProxyEvent",
})
export type ProxyEvent = typeof ProxyEvent.Type

const strictDecodeOptions = { onExcessProperty: "error" } as const
const decodeParent = Schema.decodeUnknownSync(ParentRequest, strictDecodeOptions)
const decodeProxy = Schema.decodeUnknownSync(ProxyEvent, strictDecodeOptions)

export const decodeParentRequest = (input: unknown) => decodeParent(input)
export const decodeProxyEvent = (input: unknown) => decodeProxy(input)

export type LifecyclePhase = "awaiting-launch" | "awaiting-accepted" | "active" | "terminal" | "closed"

export interface LifecycleState {
  readonly phase: LifecyclePhase
  readonly jobID?: DocumentRuntimeProtocol.JobID
  readonly order?: DocumentRuntimeProtocol.OrderState
  readonly terminalJobID?: DocumentRuntimeProtocol.JobID | null
  readonly cancelSent: boolean
}

export type LifecycleResult =
  | { readonly ok: true; readonly state: LifecycleState }
  | { readonly ok: false; readonly code: "job-mismatch" | "invalid-order" | "limit-exceeded" }

export function beginLifecycle(): LifecycleState {
  return { phase: "awaiting-launch", cancelSent: false }
}

export function advanceLifecycle(state: LifecycleState, message: ParentRequest | ProxyEvent): LifecycleResult {
  if (state.phase === "awaiting-launch") {
    if (message.type !== "launch") return { ok: false, code: "invalid-order" }
    return lifecycleSuccess({
      phase: "awaiting-accepted",
      jobID: message.jobID,
      order: DocumentRuntimeProtocol.beginOrder(message.start),
      cancelSent: false,
    })
  }
  if (state.phase === "closed" || message.type === "launch") return { ok: false, code: "invalid-order" }
  if (state.jobID === undefined || state.order === undefined) return { ok: false, code: "invalid-order" }
  if (message.jobID !== null && message.jobID !== state.jobID) return { ok: false, code: "job-mismatch" }

  if (message.type === "accepted") {
    if (state.phase !== "awaiting-accepted") return { ok: false, code: "invalid-order" }
    return lifecycleSuccess({ ...state, phase: "active" })
  }

  if (message.type === "command") {
    if (state.phase !== "active") return { ok: false, code: "invalid-order" }
    if (message.command.jobID !== state.jobID) return { ok: false, code: "job-mismatch" }
    const next = DocumentRuntimeProtocol.advanceOrder(state.order, message.command)
    return next.ok ? lifecycleSuccess({ ...state, order: next.state }) : next
  }

  if (message.type === "cancel") {
    if ((state.phase !== "awaiting-accepted" && state.phase !== "active") || state.cancelSent) {
      return { ok: false, code: "invalid-order" }
    }
    const next = DocumentRuntimeProtocol.advanceOrder(state.order, {
      protocolVersion: 1,
      type: "cancel",
      jobID: state.jobID,
    })
    return next.ok ? lifecycleSuccess({ ...state, order: next.state, cancelSent: true }) : next
  }

  if (message.type === "event") {
    if (state.phase !== "active") return { ok: false, code: "invalid-order" }
    if (message.event.jobID !== state.jobID) return { ok: false, code: "job-mismatch" }
    const next = DocumentRuntimeProtocol.advanceOrder(state.order, message.event)
    if (!next.ok) return next
    return lifecycleSuccess(
      next.state.phase === "terminal"
        ? { ...state, phase: "terminal", order: next.state, terminalJobID: state.jobID }
        : { ...state, order: next.state },
    )
  }

  if (message.type === "failure") {
    if (state.phase !== "awaiting-accepted" && state.phase !== "active") {
      return { ok: false, code: "invalid-order" }
    }
    if (state.phase === "active" && message.jobID === null) return { ok: false, code: "job-mismatch" }
    return lifecycleSuccess({ ...state, phase: "terminal", terminalJobID: message.jobID })
  }

  if (state.phase !== "terminal") return { ok: false, code: "invalid-order" }
  if (message.jobID !== state.terminalJobID) return { ok: false, code: "job-mismatch" }
  return lifecycleSuccess({ ...state, phase: "closed" })
}

function lifecycleSuccess(state: LifecycleState): LifecycleResult {
  return { ok: true, state }
}
