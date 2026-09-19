import { describe, expect } from "bun:test"
import { createHash } from "node:crypto"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { Artifact } from "@koala-ai/core/artifact/artifact"
import { ArtifactStore } from "@koala-ai/core/artifact/store"
import { IndustrialAudit } from "@koala-ai/core/industrial/audit"
import { IndustrialResult } from "@koala-ai/core/industrial/result"
import { IndustrialTool } from "@koala-ai/core/industrial/tool"
import { SandboxProtocol } from "@koala-ai/core/sandbox/protocol"
import { ArtifactTable } from "@opencode-ai/core/artifact/sql"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { ToolAuditTable } from "@opencode-ai/core/tool-audit/sql"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { count, eq, sql } from "drizzle-orm"
import { Context, Effect, Exit, Fiber, Layer, Schema } from "effect"
import { ArtifactStoreLive } from "@/koala/artifact-store"
import { IndustrialAuditLive } from "@/koala/industrial-audit"
import { IndustrialExecution } from "@/koala/industrial-execution"
import { MessageID, SessionID } from "@/session/schema"
import { Tool } from "@/tool/tool"
import { tmpdir } from "../fixture/fixture"
import { it } from "../lib/effect"

const Input = Schema.Struct({
  command: Schema.String,
  nested: Schema.Struct({ b: Schema.Number, a: Schema.Number }),
  list: Schema.Array(Schema.Struct({ z: Schema.Number, y: Schema.Number })),
  payload: Schema.optionalKey(Schema.Unknown),
})
const ResultSchema = IndustrialResult.make("sandbox_execute", Schema.Struct({ value: Schema.String }))
const Engine = Schema.decodeUnknownSync(IndustrialTool.Engine)({ name: "test-engine", version: "1.0.0" })
const summary = { sourceCount: 0, artifactCount: 0, pathCount: 0, declaredOutputCount: 0 } as const
const artifactID = Schema.decodeUnknownSync(Artifact.ID)("art_123e4567-e89b-42d3-a456-426614174000")
const reference = Schema.decodeUnknownSync(Artifact.Reference)({
  id: artifactID,
  name: "source.txt",
  mime: "text/plain",
  size: 1,
  digest: "a".repeat(64),
})
const storedReference = (
  overrides: Partial<Artifact.Metadata["provenance"]> = {},
  referenceOverride: Partial<Artifact.Reference> = {},
) =>
  Schema.decodeUnknownSync(Artifact.Metadata)({
    ...reference,
    ...referenceOverride,
    validation: {
      state: "accepted",
      validator: Artifact.ValidatorName,
      validatorVersion: Artifact.ValidatorVersion,
      findings: [],
    },
    provenance: {
      sessionID: "ses-industrial-execution",
      messageID: "msg-industrial-execution",
      toolName: "sandbox_execute",
      ...overrides,
    },
    lineage: [],
    timeCreated: 1,
  })

const success = (
  citations: IndustrialResult.Checked<unknown>["citations"] = [],
  resultSummary = "completed",
  options: {
    readonly sources?: ReadonlyArray<typeof reference>
    readonly outputs?: ReadonlyArray<typeof reference>
    readonly sandboxRunID?: string
    readonly routeDecisionID?: string
    readonly engine?: IndustrialTool.Engine
  } = {},
) =>
  Schema.decodeUnknownSync(ResultSchema)({
    tool: "sandbox_execute",
    contractVersion: 1,
    engine: options.engine ?? Engine,
    status: "success",
    cancelled: false,
    timedOut: false,
    sources: options.sources ?? [],
    outputs: options.outputs ?? [],
    citations,
    producerTruncated: false,
    summary: resultSummary,
    data: { value: "ok" },
    ...(options.sandboxRunID === undefined ? {} : { sandboxRunID: options.sandboxRunID }),
    ...(options.routeDecisionID === undefined ? {} : { routeDecisionID: options.routeDecisionID }),
  })

const failure = (code: IndustrialResult.ErrorCode) =>
  Schema.decodeUnknownSync(ResultSchema)(
    code === "cancelled"
      ? {
          tool: "sandbox_execute",
          contractVersion: 1,
          engine: Engine,
          status: "error",
          cancelled: true,
          timedOut: false,
          sources: [],
          outputs: [],
          citations: [],
          producerTruncated: false,
          summary: code,
          error: { code, retryable: true },
        }
      : code === "deadline-exceeded"
        ? {
            tool: "sandbox_execute",
            contractVersion: 1,
            engine: Engine,
            status: "error",
            cancelled: false,
            timedOut: true,
            sources: [],
            outputs: [],
            citations: [],
            producerTruncated: false,
            summary: code,
            error: { code, retryable: true },
          }
        : {
            tool: "sandbox_execute",
            contractVersion: 1,
            engine: Engine,
            status: "error",
            cancelled: false,
            timedOut: false,
            sources: [],
            outputs: [],
            citations: [],
            producerTruncated: false,
            summary: code,
            error: { code, retryable: false },
          },
  )

const context = (
  callID: string,
  ask: Tool.Context["ask"] = () => Effect.void,
  abort: AbortSignal = AbortSignal.any([]),
): Tool.Context => ({
  sessionID: SessionID.make("ses-industrial-execution"),
  messageID: MessageID.make("msg-industrial-execution"),
  callID,
  agent: "test",
  abort,
  messages: [],
  metadata: () => Effect.void,
  ask,
})

const request = (
  callID: string,
  operation: (
    signal: AbortSignal,
    commit: IndustrialExecution.CommitBoundary,
  ) => Effect.Effect<unknown, string>,
  options: {
    readonly input?: typeof Input.Type
    readonly ask?: Tool.Context["ask"]
    readonly abort?: AbortSignal
    readonly deadlineMs?: number
    readonly cancellationGraceMs?: number
    readonly sourceArtifactIDs?: ReadonlyArray<Artifact.ID>
    readonly sandboxRunID?: IndustrialResult.Common["sandboxRunID"]
    readonly routeDecisionID?: IndustrialResult.Common["routeDecisionID"]
  } = {},
): IndustrialExecution.Request<typeof Input.Type, typeof ResultSchema.Type, string, never> => ({
  tool: "sandbox_execute",
  permission: "sandbox_execute",
  engine: Engine,
  input: options.input ?? { command: "canary-secret", nested: { a: 1, b: 2 }, list: [{ y: 2, z: 1 }] },
  inputSchema: Input,
  inputSummary: summary,
  sourceArtifactIDs: options.sourceArtifactIDs ?? [],
  resultSchema: ResultSchema,
  context: context(callID, options.ask, options.abort),
  permissionRequest: { patterns: ["canary-secret"], always: ["canary-secret"], metadata: {} },
  deadlineMs: options.deadlineMs ?? 1_000,
  cancellationGraceMs: options.cancellationGraceMs ?? 5,
  ...(options.sandboxRunID === undefined ? {} : { sandboxRunID: options.sandboxRunID }),
  ...(options.routeDecisionID === undefined ? {} : { routeDecisionID: options.routeDecisionID }),
  operation,
  mapError: () => "engine-failed",
  makeError: failure,
})

const withExecution = <A, E>(
  body: () => Effect.Effect<A, E, IndustrialExecution.Service | Database.Service>,
  metadata: Artifact.Metadata = storedReference(),
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) =>
      body().pipe(
        Effect.provide(
          LayerNode.compile(LayerNode.group([IndustrialAuditLive.node, IndustrialExecution.node, Database.node]), [
            [Database.node, Database.layerFromPath(path.join(tmp.path, "industrial-execution.db"))],
            [
              ArtifactStoreLive.node,
              Layer.mock(ArtifactStore.Service, {
                metadata: (id) =>
                  id === metadata.id
                    ? Effect.succeed(metadata)
                    : Effect.fail(new ArtifactStore.ArtifactNotFoundError({ artifactID: id })),
              }),
            ],
          ]),
        ),
      ),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

const withLiveExecution = <A, E>(
  body: (
    store: ArtifactStore.Interface,
    db: Context.Service.Shape<typeof Database.Service>["db"],
  ) => Effect.Effect<A, E, IndustrialExecution.Service>,
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => {
      const services = LayerNode.compile(
        LayerNode.group([ArtifactStoreLive.node, IndustrialAuditLive.node, IndustrialExecution.node, Database.node]),
        [
          [Global.node, Global.layerWith({ data: tmp.path, state: tmp.path })],
          [Database.node, Database.layerFromPath(path.join(tmp.path, "industrial-commit.db"))],
        ],
      )
      return Effect.gen(function* () {
        const { db } = yield* Database.Service
        const now = Date.now()
        yield* db
          .insert(ProjectTable)
          .values({
            id: ProjectV2.ID.global,
            worktree: AbsolutePath.make(tmp.path),
            time_created: now,
            time_updated: now,
            sandboxes: [],
          })
          .run()
        yield* db
          .insert(SessionTable)
          .values({
            id: context("call").sessionID,
            project_id: ProjectV2.ID.global,
            slug: "industrial-commit",
            directory: AbsolutePath.make(tmp.path),
            title: "industrial commit test",
            version: "test",
            time_created: now,
            time_updated: now,
          })
          .run()
        yield* db.run(sql`
          INSERT INTO message (id, session_id, time_created, time_updated, data)
          VALUES (${context("call").messageID}, ${context("call").sessionID}, ${now}, ${now}, '{}')
        `)
        return yield* body(yield* ArtifactStore.Service, db)
      }).pipe(Effect.provide(services))
    },
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

describe("IndustrialExecution", () => {
  it.live("uses a recursive-key-sorted digest and begins the redacted audit before permission and engine work", () =>
    withExecution(() =>
      Effect.gen(function* () {
        const execution = yield* IndustrialExecution.Service
        const { db } = yield* Database.Service
        const order: string[] = []
        const ask: Tool.Context["ask"] = (permission) =>
          Effect.gen(function* () {
            const rows = yield* db.select().from(ToolAuditTable).all()
            expect(rows).toHaveLength(1)
            expect(rows[0]?.state).toBe("running")
            expect(permission.permission).toBe("sandbox_execute")
            order.push("permission")
          }).pipe(Effect.orDie)
        const input = { list: [{ z: 1, y: 2 }], nested: { b: 2, a: 1 }, command: "canary-secret" }

        yield* execution.execute(
          request(
            "call-digest-a",
            () => Effect.sync(() => order.push("engine")).pipe(Effect.as(success([], "output-canary"))),
            { input, ask },
          ),
        )
        yield* execution.execute(request("call-digest-b", () => Effect.succeed(success())))

        const rows = yield* db.select().from(ToolAuditTable).all()
        const expected = createHash("sha256")
          .update('{"command":"canary-secret","list":[{"y":2,"z":1}],"nested":{"a":1,"b":2}}')
          .digest("hex")
        expect(rows.map((row) => row.input_sha256)).toEqual([expected, expected])
        expect(order).toEqual(["permission", "engine"])
        expect(JSON.stringify(rows)).not.toContain("canary-secret")
        expect(JSON.stringify(rows)).not.toContain("output-canary")
        expect(rows.every((row) => row.state === "completed" && row.outcome_code === "success")).toBe(true)
      }),
    ),
  )

  it.live("requires a tool call ID before starting an audit or permission request", () =>
    withExecution(() =>
      Effect.gen(function* () {
        const execution = yield* IndustrialExecution.Service
        const { db } = yield* Database.Service
        let asked = false
        const input = request("unused", () => Effect.succeed(success()), {
          ask: () => Effect.sync(() => (asked = true)),
        })
        const error = yield* execution
          .execute({ ...input, context: { ...input.context, callID: undefined } })
          .pipe(Effect.flip)

        expect(error).toEqual(new IndustrialExecution.BoundaryError({ code: "missing-call-id" }))
        expect(asked).toBe(false)
        expect(yield* db.select().from(ToolAuditTable).all()).toEqual([])
      }),
    ),
  )

  it.live("classifies permission rejection without invoking the engine", () =>
    withExecution(() =>
      Effect.gen(function* () {
        const execution = yield* IndustrialExecution.Service
        const { db } = yield* Database.Service
        let invoked = false
        const output = yield* execution.execute(
          request("call-permission", () => Effect.sync(() => (invoked = true)).pipe(Effect.as(success())), {
            ask: () => Effect.die(new PermissionV1.DeniedError({ ruleset: [] })),
          }),
        )

        expect(invoked).toBe(false)
        expect(output.result).toMatchObject({ status: "error", error: { code: "permission-denied" } })
        expect(yield* db.select().from(ToolAuditTable).get()).toMatchObject({
          state: "completed",
          outcome_code: "error",
          error_code: "permission-denied",
        })
      }),
    ),
  )

  it.live("latches cancellation before delayed operation success and classifies deadline expiry", () =>
    withExecution(() =>
      Effect.gen(function* () {
        const execution = yield* IndustrialExecution.Service
        const { db } = yield* Database.Service
        const caller = new AbortController()
        let composed: AbortSignal | undefined
        const cancelled = yield* execution.execute(
          request(
            "call-cancelled",
            (signal) =>
              Effect.sync(() => {
                composed = signal
                caller.abort()
                return undefined
              }).pipe(Effect.andThen(Effect.sleep(1)), Effect.as(success())),
            { abort: caller.signal },
          ),
        )
        const timedOut = yield* execution.execute(request("call-timeout", () => Effect.never, { deadlineMs: 5 }))

        expect(cancelled.result).toMatchObject({ cancelled: true, error: { code: "cancelled" } })
        expect(composed?.aborted).toBe(true)
        expect(timedOut.result).toMatchObject({ timedOut: true, error: { code: "deadline-exceeded" } })
        expect((yield* db.select().from(ToolAuditTable).all()).map((row) => row.outcome_code).sort()).toEqual([
          "cancelled",
          "timeout",
        ])
      }),
    ),
  )

  it.live("preserves the first abort source while cleanup grace is running", () =>
    withExecution(() =>
      Effect.gen(function* () {
        const execution = yield* IndustrialExecution.Service
        const callerAfterDeadline = new AbortController()
        setTimeout(() => callerAfterDeadline.abort(), 10)
        const timedOut = yield* execution.execute(
          request("call-deadline-source", () => Effect.never, {
            abort: callerAfterDeadline.signal,
            deadlineMs: 5,
            cancellationGraceMs: 20,
          }),
        )

        const callerBeforeDeadline = new AbortController()
        setTimeout(() => callerBeforeDeadline.abort(), 5)
        const cancelled = yield* execution.execute(
          request("call-cancel-source", () => Effect.never, {
            abort: callerBeforeDeadline.signal,
            deadlineMs: 20,
            cancellationGraceMs: 20,
          }),
        )

        expect(timedOut.result).toMatchObject({ timedOut: true, error: { code: "deadline-exceeded" } })
        expect(cancelled.result).toMatchObject({ cancelled: true, error: { code: "cancelled" } })
      }),
    ),
  )

  it.live("uses commit completion as the cancellation linearization point", () =>
    withExecution(() =>
      Effect.gen(function* () {
        const execution = yield* IndustrialExecution.Service
        const before = new AbortController()
        const beforeCommit = yield* execution.execute(
          request(
            "call-before-commit",
            (_signal, commit) =>
              Effect.sync(() => {
                before.abort()
                expect(commit.begin(success())).toBe(false)
                return success()
              }),
            { abort: before.signal },
          ),
        )

        const rolledBack = new AbortController()
        const duringRollback = yield* execution.execute(
          request(
            "call-mid-commit-rollback",
            (signal, commit) =>
              Effect.sync(() => {
                expect(commit.begin(success())).toBe(true)
                rolledBack.abort()
                expect(signal.aborted).toBe(false)
                commit.rollback()
                expect(signal.aborted).toBe(true)
                return success()
              }),
            { abort: rolledBack.signal },
          ),
        )

        const committed = new AbortController()
        const duringCommit = yield* execution.execute(
          request(
            "call-mid-commit-success",
            (signal, commit) =>
              Effect.sync(() => {
                expect(commit.begin(success())).toBe(true)
                committed.abort()
                expect(signal.aborted).toBe(false)
                commit.complete()
                return success()
              }),
            { abort: committed.signal },
          ),
        )

        const after = new AbortController()
        const afterCommit = yield* execution.execute(
          request(
            "call-after-commit",
            (_signal, commit) =>
              Effect.sync(() => {
                expect(commit.begin(success())).toBe(true)
                commit.complete()
                after.abort()
                return success()
              }),
            { abort: after.signal },
          ),
        )

        expect(beforeCommit.result).toMatchObject({ cancelled: true, error: { code: "cancelled" } })
        expect(duringRollback.result).toMatchObject({ cancelled: true, error: { code: "cancelled" } })
        expect(duringCommit.result.status).toBe("success")
        expect(afterCommit.result.status).toBe("success")
        const { db } = yield* Database.Service
        expect(
          (yield* db.select().from(ToolAuditTable).all()).map((row) => [row.tool_call_id, row.outcome_code]),
        ).toEqual([
          ["call-before-commit", "cancelled"],
          ["call-mid-commit-rollback", "cancelled"],
          ["call-mid-commit-success", "success"],
          ["call-after-commit", "success"],
        ])
      }),
    ),
  )

  it.live("recovers the exact committed artifact result after Fiber interruption", () =>
    withLiveExecution((store, db) =>
      Effect.gen(function* () {
        const execution = yield* IndustrialExecution.Service
        const runID = Schema.decodeUnknownSync(SandboxProtocol.RunID)("fiber-commit-race")
        const staging = yield* store.stage(runID)
        yield* Effect.promise(() => writeFile(path.join(staging.artifacts, "committed.txt"), "committed result"))
        let signalPrepared: () => void = () => {}
        const prepared = new Promise<void>((resolve) => {
          signalPrepared = resolve
        })

        const output = yield* execution.execute(
          request(
            "call-fiber-commit",
            (signal, commit) =>
              Effect.gen(function* () {
                const publication = yield* store
                  .promoteBatch(
                    [
                      {
                        runID,
                        outputPath: Schema.decodeUnknownSync(Artifact.OutputPath)("committed.txt"),
                        provenance: Schema.decodeUnknownSync(Artifact.Provenance)({
                          sessionID: context("call").sessionID,
                          messageID: context("call").messageID,
                          toolName: "sandbox_execute",
                          toolCallID: "call-fiber-commit",
                          sandboxRunID: runID,
                        }),
                      },
                    ],
                    {
                      signal,
                      commit: {
                        boundary: commit,
                        result: (metadata) => {
                          const result = success([], "committed", {
                            outputs: metadata.map((item) =>
                              Schema.decodeUnknownSync(Artifact.Reference)({
                                id: item.id,
                                name: item.name,
                                mime: item.mime,
                                size: item.size,
                                digest: item.digest,
                              }),
                            ),
                            sandboxRunID: runID,
                          })
                          signalPrepared()
                          return result
                        },
                      },
                    },
                  )
                  .pipe(Effect.forkChild)
                yield* Effect.promise(() => prepared)
                yield* Fiber.interrupt(publication)
                return yield* Fiber.join(publication)
              }).pipe(Effect.mapError(() => "promotion-failed" as const)),
            { sandboxRunID: runID },
          ),
        )

        expect(output.result.status).toBe("success")
        expect(output.result.outputs).toHaveLength(1)
        const outputID = output.result.outputs[0]?.id
        expect((yield* db.select({ value: count() }).from(ArtifactTable).get())?.value).toBe(1)
        expect(yield* db.select().from(ToolAuditTable).get()).toMatchObject({
          outcome_code: "success",
          output_artifact_ids: [outputID],
        })
      }),
    ),
  )

  it.live("keeps pre-commit Fiber interruption classified as cancellation", () =>
    withLiveExecution((_store, db) =>
      Effect.gen(function* () {
        const execution = yield* IndustrialExecution.Service
        let signalStarted: () => void = () => {}
        const started = new Promise<void>((resolve) => {
          signalStarted = resolve
        })
        const fiber = yield* execution
          .execute(
            request("call-fiber-pre-commit", () =>
              Effect.sync(signalStarted).pipe(Effect.andThen(Effect.never)),
            ),
          )
          .pipe(Effect.forkChild)

        yield* Effect.promise(() => started)
        yield* Fiber.interrupt(fiber)
        const exit = yield* Fiber.await(fiber)
        expect(Exit.hasInterrupts(exit)).toBe(true)
        expect((yield* db.select({ value: count() }).from(ArtifactTable).get())?.value).toBe(0)
        expect(yield* db.select().from(ToolAuditTable).get()).toMatchObject({
          outcome_code: "cancelled",
          output_artifact_ids: [],
        })
      }),
    ),
  )

  it.live("preserves defects and interruptions after classifying each audit once", () =>
    withExecution(() =>
      Effect.gen(function* () {
        const execution = yield* IndustrialExecution.Service
        const { db } = yield* Database.Service
        const defect = yield* execution
          .execute(request("call-defect", () => Effect.die("engine-defect")))
          .pipe(Effect.exit)
        const interrupted = yield* execution
          .execute(request("call-interrupt", () => Effect.interrupt))
          .pipe(Effect.exit)

        expect(Exit.hasDies(defect)).toBe(true)
        expect(Exit.hasInterrupts(interrupted)).toBe(true)
        expect(
          (yield* db.select().from(ToolAuditTable).all()).map((row) => [row.tool_call_id, row.error_code]),
        ).toEqual([
          ["call-defect", "internal-error"],
          ["call-interrupt", "cancelled"],
        ])
      }),
    ),
  )

  it.live("records projection truncation independently from producer truncation", () =>
    withExecution(() =>
      Effect.gen(function* () {
        const execution = yield* IndustrialExecution.Service
        const { db } = yield* Database.Service
        const citations = Array.from({ length: 200 }, () => ({
          type: "docx" as const,
          artifactID,
          part: "document" as const,
          path: Array.from({ length: 32 }, (_, index) => ({ node: "paragraph" as const, index })),
          elementID: "x".repeat(128),
        }))
        const output = yield* execution.execute(
          request("call-projection", () => Effect.succeed(success(citations, "completed", { sources: [reference] }))),
        )

        expect(output.projection.truncated).toBe(true)
        expect(output.result.producerTruncated).toBe(false)
        expect(yield* db.select().from(ToolAuditTable).get()).toMatchObject({
          producer_truncated: false,
          projection_truncated: true,
          truncated: true,
        })
      }),
    ),
  )

  it.live("races a pending permission request against caller cancellation before starting the deadline", () =>
    withExecution(() =>
      Effect.gen(function* () {
        const execution = yield* IndustrialExecution.Service
        const { db } = yield* Database.Service
        const caller = new AbortController()
        const cancelled = yield* execution.execute(
          request("call-permission-cancel", () => Effect.die("operation must not run"), {
            abort: caller.signal,
            ask: () =>
              Effect.callback(() => {
                caller.abort()
                return Effect.void
              }),
          }),
        )
        const afterSlowPermission = yield* execution.execute(
          request("call-permission-deadline", () => Effect.succeed(success()), {
            ask: () => Effect.sleep(20),
            deadlineMs: 5,
          }),
        )

        expect(cancelled.result).toMatchObject({ cancelled: true, error: { code: "cancelled" } })
        expect(afterSlowPermission.result.status).toBe("success")
        expect((yield* db.select().from(ToolAuditTable).all()).map((row) => row.outcome_code)).toEqual([
          "cancelled",
          "success",
        ])
      }),
    ),
  )

  it.live("rejects non-JSON-like canonical inputs before beginning an audit", () =>
    withExecution(() =>
      Effect.gen(function* () {
        const execution = yield* IndustrialExecution.Service
        const { db } = yield* Database.Service
        const cyclic: { self?: unknown } = {}
        cyclic.self = cyclic
        const payloads = [Number.NaN, Number.POSITIVE_INFINITY, 1n, cyclic, new Date(0)]

        const exits = yield* Effect.forEach(payloads, (payload, index) =>
          execution
            .execute(
              request(`call-invalid-${index}`, () => Effect.succeed(success()), {
                input: { command: "input", nested: { a: 1, b: 2 }, list: [], payload },
              }),
            )
            .pipe(Effect.exit),
        )

        expect(exits.every(Exit.isFailure)).toBe(true)
        expect(yield* db.select().from(ToolAuditTable).all()).toEqual([])
      }),
    ),
  )

  it.live("accepts opaque call IDs and rejects unsafe call IDs with typed boundary errors", () =>
    withExecution(() =>
      Effect.gen(function* () {
        const execution = yield* IndustrialExecution.Service
        const opaque = yield* execution.execute(request("provider call/id:{opaque}=v1", () => Effect.succeed(success())))
        const invalid = yield* execution
          .execute(request("provider\ncall", () => Effect.succeed(success())))
          .pipe(Effect.flip)

        expect(opaque.result.status).toBe("success")
        expect(invalid).toEqual(new IndustrialExecution.BoundaryError({ code: "invalid-call-id" }))
      }),
    ),
  )

  it.live("validates result identity, references, and final audit sources", () =>
    withExecution(() =>
      Effect.gen(function* () {
        const execution = yield* IndustrialExecution.Service
        const { db } = yield* Database.Service
        const runID = Schema.decodeUnknownSync(SandboxProtocol.RunID)("sandbox-run")
        const routeID = Schema.decodeUnknownSync(IndustrialResult.RouteDecisionID)("route-requested")
        const otherID = Schema.decodeUnknownSync(Artifact.ID)("art_123e4567-e89b-42d3-a456-426614174001")
        const cases = [
          { ...success(), tool: "calculate" },
          { ...success(), contractVersion: 2 },
          {
            ...success([], "completed", {
              engine: Schema.decodeUnknownSync(IndustrialTool.Engine)({ name: "other", version: "1.0.0" }),
            }),
          },
          { ...success(), sandboxRunID: "other-run" },
          { ...success(), routeDecisionID: "other-route" },
          success(),
          success([{ type: "artifact", artifactID: otherID }], "completed", { sources: [reference] }),
        ]
        for (const [index, value] of cases.entries()) {
          const options =
            index === 3
              ? { sandboxRunID: runID }
              : index === 4
                ? { routeDecisionID: routeID }
                : index === 5
                  ? { sourceArtifactIDs: [artifactID] }
                  : {}
          const output = yield* execution.execute(
            request(`call-correlation-${index}`, () => Effect.succeed(value), options),
          )
          expect(output.result).toMatchObject({ status: "error", error: { code: "protocol-error" } })
        }

        const valid = yield* execution.execute(
          request("call-final-sources", () => Effect.succeed(success([], "completed", { sources: [reference] })), {
            sourceArtifactIDs: [artifactID],
          }),
        )
        expect(valid.result.status).toBe("success")
        expect(
          (yield* db.select().from(ToolAuditTable).where(eq(ToolAuditTable.tool_call_id, "call-final-sources")).get())
            ?.source_artifact_ids,
        ).toEqual([artifactID])
      }),
    ),
  )

  it.live("authenticates returned references and output provenance against ArtifactStore", () => {
    const outputMetadata = storedReference({ toolCallID: "call-auth-output" })
    return withExecution(
      () =>
        Effect.gen(function* () {
          const execution = yield* IndustrialExecution.Service
          const valid = yield* execution.execute(
            request("call-auth-output", () => Effect.succeed(success([], "completed", { outputs: [reference] }))),
          )
          expect(valid.result.status).toBe("success")
        }),
      outputMetadata,
    )
  })

  it.live("rejects forged reference metadata and cross-session provenance", () => {
    const forged = [
      storedReference({}, { digest: Schema.decodeUnknownSync(Artifact.Digest)("b".repeat(64)) }),
      storedReference({ sessionID: "ses-other" }),
      storedReference({ toolCallID: "call-other" }),
    ]
    return Effect.forEach(forged, (metadata, index) =>
      withExecution(
        () =>
          Effect.gen(function* () {
            const execution = yield* IndustrialExecution.Service
            const output = yield* execution.execute(
              request(`call-forged-${index}`, () =>
                Effect.succeed(success([], "completed", { outputs: [reference] })),
              ),
            )
            expect(output.result).toMatchObject({ status: "error", error: { code: "protocol-error" } })
          }),
        metadata,
      ),
      { concurrency: 1 },
    )
  })
})
