import { createHash } from "node:crypto"
import { Artifact } from "@koala-ai/core/artifact/artifact"
import { ArtifactStore } from "@koala-ai/core/artifact/store"
import { IndustrialAudit } from "@koala-ai/core/industrial/audit"
import { IndustrialInput } from "@koala-ai/core/industrial/input"
import { IndustrialProjection } from "@koala-ai/core/industrial/projection"
import { IndustrialResult } from "@koala-ai/core/industrial/result"
import { IndustrialTool } from "@koala-ai/core/industrial/tool"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Cause, Context, Effect, Exit, Fiber, Layer, Result, Schema } from "effect"
import type { Tool } from "@/tool/tool"
import { ArtifactStoreLive } from "./artifact-store"
import { IndustrialAuditLive } from "./industrial-audit"

const DefaultCancellationGraceMs = 10_000

type PermissionRequest = Parameters<Tool.Context["ask"]>[0]

export interface Request<Input, Checked extends IndustrialResult.Checked<unknown>, Error, Requirements> {
  readonly tool: IndustrialTool.Name
  readonly permission: IndustrialTool.Permission
  readonly engine: IndustrialTool.Engine
  readonly input: Input
  readonly inputSchema: Schema.Decoder<Input>
  readonly inputSummary: IndustrialInput.Summary
  readonly sourceArtifactIDs: IndustrialAudit.BeginInput["sourceArtifactIDs"]
  readonly resultSchema: Schema.Decoder<Checked>
  readonly context: Tool.Context
  readonly permissionRequest: Omit<PermissionRequest, "permission">
  readonly deadlineMs?: number
  readonly cancellationGraceMs?: number
  readonly sandboxRunID?: IndustrialResult.Common["sandboxRunID"]
  readonly routeDecisionID?: IndustrialResult.Common["routeDecisionID"]
  readonly operation: (signal: AbortSignal, commit: CommitBoundary) => Effect.Effect<unknown, Error, Requirements>
  readonly mapError: (error: Error) => IndustrialResult.GeneralErrorCode
  readonly makeError: (code: IndustrialResult.ErrorCode) => Checked
}

export interface CommitBoundary {
  readonly begin: (result: unknown) => boolean
  readonly complete: () => void
  readonly rollback: () => void
}

export interface Output<Checked extends IndustrialResult.Checked<unknown>> {
  readonly result: Checked
  readonly projection: IndustrialProjection.Output
}

export class BoundaryError extends Schema.TaggedErrorClass<BoundaryError>()("IndustrialExecutionBoundaryError", {
  code: Schema.Literals(["missing-call-id", "invalid-call-id", "invalid-input"]),
}) {
  override get message() {
    return `Industrial execution boundary failed: ${this.code}`
  }
}

export interface Interface {
  readonly execute: <Input, Checked extends IndustrialResult.Checked<unknown>, Error, Requirements>(
    request: Request<Input, Checked, Error, Requirements>,
  ) => Effect.Effect<Output<Checked>, BoundaryError | IndustrialAudit.WriteError, Requirements>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/IndustrialExecution") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const audit = yield* IndustrialAudit.Service
    const artifacts = yield* ArtifactStore.Service

    const execute: Interface["execute"] = Effect.fn("IndustrialExecution.execute")(function* (request) {
      if (request.context.callID === undefined) return yield* new BoundaryError({ code: "missing-call-id" })
      if (
        (request.deadlineMs !== undefined &&
          (!Number.isSafeInteger(request.deadlineMs) || request.deadlineMs <= 0 || request.deadlineMs > 2_147_483_647)) ||
        (request.cancellationGraceMs !== undefined &&
          (!Number.isSafeInteger(request.cancellationGraceMs) || request.cancellationGraceMs < 0))
      ) {
        return yield* new BoundaryError({ code: "invalid-input" })
      }
      const toolCallID = yield* Schema.decodeUnknownEffect(IndustrialAudit.ToolCallID)(request.context.callID).pipe(
        Effect.mapError(() => new BoundaryError({ code: "invalid-call-id" })),
      )
      const input = yield* Schema.decodeUnknownEffect(request.inputSchema)(request.input).pipe(
        Effect.mapError(() => new BoundaryError({ code: "invalid-input" })),
      )
      const inputDigest = yield* digest(input)
      const startedAt = Date.now()

      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const running = yield* audit.begin({
            tool: request.tool,
            permission: request.permission,
            sessionID: request.context.sessionID,
            messageID: request.context.messageID,
            toolCallID,
            startedAt,
            engine: request.engine,
            contractVersion: 1,
            inputDigest,
            inputSummary: request.inputSummary,
            sourceArtifactIDs: request.sourceArtifactIDs,
          })
          const handoff = makeCommitHandoff()
          const exit = yield* restore(run(artifacts, request, handoff)).pipe(Effect.exit)
          const finishedAt = Math.max(startedAt, Date.now())
          const committed = handoff.committed()
          if (committed !== undefined) {
            const recovered = project(yield* validateResult(artifacts, request, committed))
            yield* audit.complete(completion(running.id, recovered, finishedAt, startedAt))
            return recovered
          }
          if (Exit.isSuccess(exit)) {
            yield* audit.complete(completion(running.id, exit.value, finishedAt, startedAt))
            return exit.value
          }

          yield* audit.complete(
            causeCompletion(
              running.id,
              exit.cause,
              finishedAt,
              startedAt,
              request.sourceArtifactIDs,
              request.sandboxRunID,
              request.routeDecisionID,
            ),
          )
          return yield* Effect.failCause(exit.cause)
        }),
      )
    })

    return Service.of({ execute })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [ArtifactStoreLive.node, IndustrialAuditLive.node] })

function run<Input, Checked extends IndustrialResult.Checked<unknown>, Error, Requirements>(
  artifacts: ArtifactStore.Interface,
  request: Request<Input, Checked, Error, Requirements>,
  handoff: ReturnType<typeof makeCommitHandoff>,
) {
  return Effect.gen(function* () {
    if (request.context.abort.aborted) return yield* errorOutput(request, "cancelled")

    const permission = yield* Effect.raceFirst(
      request.context.ask({ permission: request.permission, ...request.permissionRequest }).pipe(
        Effect.exit,
        Effect.map((exit) => ({ type: "permission" as const, exit })),
      ),
      waitForAbort(request.context.abort).pipe(Effect.as({ type: "cancelled" as const })),
    )
    if (permission.type === "cancelled") return yield* errorOutput(request, "cancelled")
    if (Exit.isFailure(permission.exit)) {
      if (isPermissionFailure(permission.exit.cause)) return yield* errorOutput(request, "permission-denied")
      return yield* Effect.failCause(permission.exit.cause)
    }

    return yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        const cancel = () => handoff.abort("cancelled")
        request.context.abort.addEventListener("abort", cancel, { once: true })
        const timer =
          request.deadlineMs === undefined
            ? undefined
            : setTimeout(() => handoff.abort("deadline-exceeded"), request.deadlineMs)
        if (request.context.abort.aborted) cancel()
        return { timer, cancel }
      }),
      () =>
        Effect.gen(function* () {
          const operation = yield* request.operation(handoff.signal, handoff.boundary).pipe(
            Effect.catch((error) => validatedError(request, request.mapError(error))),
            Effect.flatMap((value) => validateResult(artifacts, request, value)),
            Effect.forkChild,
          )
          const cancelled = waitForAbort(handoff.signal).pipe(
            Effect.andThen(Effect.sleep(request.cancellationGraceMs ?? DefaultCancellationGraceMs)),
            Effect.andThen(Effect.suspend(() => validatedError(request, handoff.terminal() ?? "cancelled"))),
            Effect.map((result) => ({ type: "cancelled" as const, result })),
          )
          const outcome = yield* Effect.raceFirst(
            Fiber.await(operation).pipe(Effect.map((exit) => ({ type: "operation" as const, exit }))),
            cancelled,
          )
          if (outcome.type === "cancelled") {
            yield* Fiber.interrupt(operation)
            return project(outcome.result)
          }
          const committed = handoff.committed()
          if (committed !== undefined) return project(yield* validateResult(artifacts, request, committed))
          const terminalCode = handoff.terminal()
          if (terminalCode !== undefined) return project(yield* validatedError(request, terminalCode))
          if (Exit.isFailure(outcome.exit)) return yield* Effect.failCause(outcome.exit.cause)
          return project(outcome.exit.value)
        }),
      ({ timer, cancel }) =>
        Effect.sync(() => {
          if (timer !== undefined) clearTimeout(timer)
          request.context.abort.removeEventListener("abort", cancel)
        }),
    )
  })
}

function makeCommitHandoff() {
  const operation = new AbortController()
  let terminal: "cancelled" | "deadline-exceeded" | undefined
  let state: "open" | "committing" | "committed" = "open"
  let pendingResult: unknown
  let committedResult: unknown
  const abort = (code: "cancelled" | "deadline-exceeded") => {
    if (terminal !== undefined || state === "committed") return
    terminal = code
    if (state === "open") operation.abort(code)
  }
  const boundary: CommitBoundary = {
    begin: (result) => {
      if (terminal !== undefined || state !== "open") return false
      pendingResult = result
      state = "committing"
      return true
    },
    complete: () => {
      if (state !== "committing") return
      committedResult = pendingResult
      pendingResult = undefined
      terminal = undefined
      state = "committed"
    },
    rollback: () => {
      if (state !== "committing") return
      pendingResult = undefined
      state = "open"
      if (terminal !== undefined) operation.abort(terminal)
    },
  }
  return {
    signal: operation.signal,
    boundary,
    abort,
    terminal: () => terminal,
    committed: () => committedResult,
  }
}

function validateResult<Input, Checked extends IndustrialResult.Checked<unknown>, Error, Requirements>(
  artifacts: ArtifactStore.Interface,
  request: Request<Input, Checked, Error, Requirements>,
  value: unknown,
) {
  return Schema.decodeUnknownEffect(request.resultSchema)(value).pipe(
    Effect.flatMap((result) =>
      correlated(request, result)
        ? authenticateReferences(artifacts, request, result).pipe(
            Effect.flatMap((authenticated) =>
              authenticated ? Effect.succeed(result) : validatedError(request, "protocol-error"),
            ),
          )
        : validatedError(request, "protocol-error"),
    ),
    Effect.catch(() => validatedError(request, "protocol-error")),
  )
}

function authenticateReferences<Input, Checked extends IndustrialResult.Checked<unknown>, Error, Requirements>(
  artifacts: ArtifactStore.Interface,
  request: Request<Input, Checked, Error, Requirements>,
  result: Checked,
) {
  return Effect.forEach(
    [
      ...result.sources.map((reference) => ({ reference, output: false as const })),
      ...result.outputs.map((reference) => ({ reference, output: true as const })),
    ],
    ({ reference, output }) =>
      artifacts.metadata(reference.id).pipe(
        Effect.map((metadata) => {
          if (!sameReference(reference, metadata) || metadata.provenance.sessionID !== request.context.sessionID) {
            return false
          }
          if (!output) return true
          return (
            metadata.provenance.messageID === request.context.messageID &&
            metadata.provenance.toolName === request.tool &&
            metadata.provenance.toolCallID === request.context.callID &&
            (request.sandboxRunID === undefined || metadata.provenance.sandboxRunID === request.sandboxRunID)
          )
        }),
        Effect.catch(() => Effect.succeed(false)),
      ),
    { concurrency: 8 },
  ).pipe(Effect.map((authenticated) => authenticated.every(Boolean)))
}

function sameReference(reference: Artifact.Reference, metadata: Artifact.Metadata) {
  return (
    reference.id === metadata.id &&
    reference.name === metadata.name &&
    reference.mime === metadata.mime &&
    reference.size === metadata.size &&
    reference.digest === metadata.digest
  )
}

function correlated<Input, Checked extends IndustrialResult.Checked<unknown>, Error, Requirements>(
  request: Request<Input, Checked, Error, Requirements>,
  result: Checked,
) {
  if (
    result.tool !== request.tool ||
    result.contractVersion !== 1 ||
    result.engine.name !== request.engine.name ||
    result.engine.version !== request.engine.version ||
    result.sandboxRunID !== request.sandboxRunID ||
    result.routeDecisionID !== request.routeDecisionID
  ) {
    return false
  }
  const sources = new Set(result.sources.map((artifact) => artifact.id))
  if (!request.sourceArtifactIDs.every((artifactID) => sources.has(artifactID))) return false
  const references = new Set([...sources, ...result.outputs.map((artifact) => artifact.id)])
  return result.citations.every((citation) => references.has(citation.artifactID))
}

function validatedError<Input, Checked extends IndustrialResult.Checked<unknown>, Error, Requirements>(
  request: Request<Input, Checked, Error, Requirements>,
  code: IndustrialResult.ErrorCode,
) {
  return Schema.decodeUnknownEffect(request.resultSchema)(request.makeError(code)).pipe(Effect.orDie)
}

function errorOutput<Input, Checked extends IndustrialResult.Checked<unknown>, Error, Requirements>(
  request: Request<Input, Checked, Error, Requirements>,
  code: IndustrialResult.ErrorCode,
) {
  return validatedError(request, code).pipe(Effect.map(project))
}

function project<Checked extends IndustrialResult.Checked<unknown>>(result: Checked): Output<Checked> {
  return { result, projection: IndustrialProjection.project(result) }
}

function waitForAbort(signal: AbortSignal) {
  return Effect.callback<void>((resume) => {
    if (signal.aborted) {
      resume(Effect.void)
      return
    }
    const abort = () => resume(Effect.void)
    signal.addEventListener("abort", abort, { once: true })
    return Effect.sync(() => signal.removeEventListener("abort", abort))
  })
}

function isPermissionFailure(cause: Cause.Cause<never>) {
  const found = Cause.findDefect(cause)
  if (Result.isFailure(found)) return false
  return (
    found.success instanceof PermissionV1.DeniedError ||
    found.success instanceof PermissionV1.RejectedError ||
    found.success instanceof PermissionV1.CorrectedError
  )
}

function completion<Checked extends IndustrialResult.Checked<unknown>>(
  auditID: IndustrialAudit.ID,
  output: Output<Checked>,
  finishedAt: number,
  startedAt: number,
): IndustrialAudit.CompleteInput {
  const common = {
    auditID,
    finishedAt,
    durationMs: finishedAt - startedAt,
    producerTruncated: output.result.producerTruncated,
    projectionTruncated: output.projection.truncated,
    sourceArtifactIDs: output.result.sources.map((artifact) => artifact.id),
    outputArtifactIDs: output.result.outputs.map((artifact) => artifact.id),
    ...(output.result.sandboxRunID === undefined ? {} : { sandboxRunID: output.result.sandboxRunID }),
    ...(output.result.routeDecisionID === undefined ? {} : { routeDecisionID: output.result.routeDecisionID }),
  }
  if (output.result.status === "success") {
    return { ...common, outcome: "success", cancelled: false, timedOut: false }
  }
  if (output.result.cancelled) {
    return { ...common, outcome: "cancelled", cancelled: true, timedOut: false, errorCode: "cancelled" }
  }
  if (output.result.timedOut) {
    return { ...common, outcome: "timeout", cancelled: false, timedOut: true, errorCode: "deadline-exceeded" }
  }
  return {
    ...common,
    outcome: "error",
    cancelled: false,
    timedOut: false,
    errorCode: Schema.is(IndustrialResult.GeneralErrorCode)(output.result.error.code)
      ? output.result.error.code
      : "internal-error",
  }
}

function causeCompletion(
  auditID: IndustrialAudit.ID,
  cause: Cause.Cause<unknown>,
  finishedAt: number,
  startedAt: number,
  sourceArtifactIDs: IndustrialAudit.BeginInput["sourceArtifactIDs"],
  sandboxRunID?: IndustrialResult.Common["sandboxRunID"],
  routeDecisionID?: IndustrialResult.Common["routeDecisionID"],
): IndustrialAudit.CompleteInput {
  const common = {
    auditID,
    finishedAt,
    durationMs: finishedAt - startedAt,
    producerTruncated: false,
    projectionTruncated: false,
    sourceArtifactIDs,
    outputArtifactIDs: [],
    ...(sandboxRunID === undefined ? {} : { sandboxRunID }),
    ...(routeDecisionID === undefined ? {} : { routeDecisionID }),
  }
  if (Cause.hasInterrupts(cause) && !Cause.hasDies(cause)) {
    return { ...common, outcome: "cancelled", cancelled: true, timedOut: false, errorCode: "cancelled" }
  }
  return {
    ...common,
    outcome: "error",
    cancelled: false,
    timedOut: false,
    errorCode: "internal-error",
  }
}

function digest(input: unknown) {
  return Effect.try({
    try: () => {
      const serialized = JSON.stringify(canonical(input, new Set()))
      if (serialized === undefined) throw new TypeError("Industrial input is not JSON-like")
      return Schema.decodeUnknownSync(IndustrialAudit.BeginInput.fields.inputDigest)(
        createHash("sha256").update(serialized).digest("hex"),
      )
    },
    catch: () => new BoundaryError({ code: "invalid-input" }),
  })
}

function canonical(value: unknown, ancestors: Set<object>): unknown {
  if (typeof value === "number" && !Number.isFinite(value)) throw new TypeError("Non-finite number")
  if (typeof value === "bigint") throw new TypeError("BigInt")
  if (typeof value !== "object" || value === null) return value
  if (ancestors.has(value)) throw new TypeError("Cyclic input")
  const prototype = Object.getPrototypeOf(value)
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Non-plain object")
  }
  ancestors.add(value)
  const result = Array.isArray(value)
    ? value.map((item) => canonical(item, ancestors))
    : Object.fromEntries(
        Object.entries(value)
          .filter((entry) => entry[1] !== undefined)
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([key, item]) => [key, canonical(item, ancestors)]),
      )
  ancestors.delete(value)
  return result
}

export * as IndustrialExecution from "./industrial-execution"
