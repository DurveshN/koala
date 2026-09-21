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

const FilesystemIdentityComponent = Schema.String.check(
  Schema.isPattern(/^(?:0|[1-9][0-9]{0,19})$/),
  Schema.makeFilter((value) => (BigInt(value) <= 18_446_744_073_709_551_615n ? undefined : "Identity exceeds uint64")),
)
export const FilesystemIdentity = Schema.Struct({
  dev: FilesystemIdentityComponent,
  ino: FilesystemIdentityComponent,
})
export type FilesystemIdentity = typeof FilesystemIdentity.Type
export const ReceiptNonce = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)).pipe(
  Schema.brand("DocumentSandboxProtocol.ReceiptNonce"),
)
export type ReceiptNonce = typeof ReceiptNonce.Type

export const LaunchRequest = Schema.Struct({
  protocolVersion: ProtocolVersion,
  type: Schema.Literal("launch"),
  jobID: DocumentRuntimeProtocol.JobID,
  target: DocumentRuntimeTarget.Target,
  runtimeRoot: AbsolutePath,
  manifestSha256: DocumentRuntimeManifest.Digest,
  parentRoot: AbsolutePath,
  parentIdentity: FilesystemIdentity,
  parentMode: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(0o777))),
  jobRoot: AbsolutePath,
  jobRootIdentity: FilesystemIdentity,
  pendingRoot: AbsolutePath,
  pendingRootIdentity: FilesystemIdentity,
  receiptNonce: ReceiptNonce,
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
  Schema.makeFilter((request) =>
    siblingRoots(request.parentRoot, request.jobRoot, request.pendingRoot)
      ? undefined
      : "Job and pending roots must be distinct direct siblings",
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
  innerProcessID: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(4_294_967_295)),
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
  "output-handoff-failed",
  "root-identity-failed",
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

const teardownFields = {
  treeContained: Schema.Boolean,
  managerInitialized: Schema.Boolean,
  cleanupCalls: Schema.Literals([0, 1]),
  cleanupCompleted: Schema.Boolean,
  resetCalls: Schema.Literals([0, 1]),
  resetCompleted: Schema.Boolean,
} as const

export const TeardownReceiptPayload = Schema.Struct({
  protocolVersion: ProtocolVersion,
  type: Schema.Literal("teardown-receipt"),
  jobID: DocumentRuntimeProtocol.JobID,
  receiptNonce: ReceiptNonce,
  terminalCategory: Schema.Literals(["completed", "cancelled", "failure"]),
  ...teardownFields,
})
export type TeardownReceiptPayload = typeof TeardownReceiptPayload.Type

export const TeardownReceipt = Schema.Struct({
  ...TeardownReceiptPayload.fields,
  receiptSha256: DocumentRuntimeManifest.Digest,
})
export type TeardownReceipt = typeof TeardownReceipt.Type

export const ClosedEvent = Schema.Struct({
  protocolVersion: ProtocolVersion,
  type: Schema.Literal("closed"),
  jobID: Schema.NullOr(DocumentRuntimeProtocol.JobID),
  receiptNonce: Schema.NullOr(ReceiptNonce),
  receiptSha256: Schema.NullOr(DocumentRuntimeManifest.Digest),
  terminalCategory: Schema.NullOr(Schema.Literals(["completed", "cancelled", "failure"])),
  ...teardownFields,
}).check(
  Schema.makeFilter((event) =>
    event.jobID === null
      ? event.receiptNonce === null && event.receiptSha256 === null && event.terminalCategory === null
        ? undefined
        : "Undecodable launches cannot publish a teardown receipt"
      : event.receiptNonce !== null && event.receiptSha256 !== null && event.terminalCategory !== null
        ? undefined
        : "Decoded launches require a teardown receipt",
  ),
  Schema.makeFilter((event) =>
    event.managerInitialized && event.treeContained
      ? event.cleanupCalls === 1 && event.resetCalls === 1
        ? undefined
        : "Initialized sandbox closure requires exactly one cleanup and reset call"
      : event.cleanupCalls === 0 &&
          event.resetCalls === 0 &&
          !event.cleanupCompleted &&
          !event.resetCompleted
        ? undefined
        : "Closure without safe manager teardown requires zero cleanup and reset calls",
  ),
  Schema.makeFilter((event) =>
    (!event.cleanupCompleted || event.cleanupCalls === 1) && (!event.resetCompleted || event.resetCalls === 1)
      ? undefined
      : "Completed teardown requires a matching call",
  ),
)

export function teardownCompleted(event: typeof ClosedEvent.Type) {
  return (
    event.treeContained &&
    event.managerInitialized &&
    event.cleanupCalls === 1 &&
    event.cleanupCompleted &&
    event.resetCalls === 1 &&
    event.resetCompleted
  )
}

export function teardownReceiptPayload(input: TeardownReceiptPayload) {
  return `${JSON.stringify({
    protocolVersion: input.protocolVersion,
    type: input.type,
    jobID: input.jobID,
    receiptNonce: input.receiptNonce,
    terminalCategory: input.terminalCategory,
    treeContained: input.treeContained,
    managerInitialized: input.managerInitialized,
    cleanupCalls: input.cleanupCalls,
    cleanupCompleted: input.cleanupCompleted,
    resetCalls: input.resetCalls,
    resetCompleted: input.resetCompleted,
  })}\n`
}

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
  readonly terminalCategory?: "completed" | "cancelled" | "failure"
  readonly receiptNonce?: ReceiptNonce
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
      receiptNonce: message.receiptNonce,
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
        ? {
            ...state,
            phase: "terminal",
            order: next.state,
            terminalJobID: state.jobID,
            terminalCategory: message.event.type === "completed" ? "completed" : message.event.type === "cancelled" ? "cancelled" : "failure",
          }
        : { ...state, order: next.state },
    )
  }

  if (message.type === "failure") {
    if (state.phase !== "awaiting-accepted" && state.phase !== "active") {
      return { ok: false, code: "invalid-order" }
    }
    if (state.phase === "active" && message.jobID === null) return { ok: false, code: "job-mismatch" }
    return lifecycleSuccess({ ...state, phase: "terminal", terminalJobID: message.jobID, terminalCategory: "failure" })
  }

  if (state.phase !== "terminal") return { ok: false, code: "invalid-order" }
  if (message.jobID !== state.terminalJobID) return { ok: false, code: "job-mismatch" }
  if (
    (state.terminalJobID === null
      ? message.receiptNonce !== null || message.receiptSha256 !== null
      : message.receiptNonce !== state.receiptNonce || message.receiptSha256 === null) ||
    (state.terminalJobID !== null && message.terminalCategory !== state.terminalCategory)
  ) {
    return { ok: false, code: "invalid-order" }
  }
  return lifecycleSuccess({ ...state, phase: "closed" })
}

function lifecycleSuccess(state: LifecycleState): LifecycleResult {
  return { ok: true, state }
}

function siblingRoots(parent: string, left: string, right: string) {
  const normalize = (value: string) => value.replaceAll("\\", "/").replace(/\/+$/, "")
  const leftPath = normalize(left)
  const rightPath = normalize(right)
  if (leftPath.toLowerCase() === rightPath.toLowerCase()) return false
  const expected = normalize(parent).toLowerCase()
  return (
    leftPath.slice(0, leftPath.lastIndexOf("/")).toLowerCase() === expected &&
    rightPath.slice(0, rightPath.lastIndexOf("/")).toLowerCase() === expected
  )
}
