import { randomUUID } from "node:crypto"
import { IndustrialAudit } from "@koala-ai/core/industrial/audit"
import { Database } from "@opencode-ai/core/database/database"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { ToolAuditTable } from "@opencode-ai/core/tool-audit/sql"
import { KoalaAudit } from "@opencode-ai/schema/koala-audit"
import { and, desc, eq, lt } from "drizzle-orm"
import { Effect, Layer, Schema } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"

const layer = Layer.effect(
  IndustrialAudit.Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2Bridge.Service
    const decodeBegin = Schema.decodeUnknownEffect(IndustrialAudit.BeginInput)
    const decodeComplete = Schema.decodeUnknownEffect(IndustrialAudit.CompleteInput)
    const decodeRunning = Schema.decodeUnknownEffect(IndustrialAudit.Running)
    const decodeCompleted = Schema.decodeUnknownEffect(IndustrialAudit.Completed)
    const decodeRecord = Schema.decodeUnknownEffect(IndustrialAudit.Record)

    const begin = Effect.fn("IndustrialAudit.begin")(function* (unsafeInput: IndustrialAudit.BeginInput) {
      const input = yield* decodeBegin(unsafeInput).pipe(
        Effect.mapError(() => new IndustrialAudit.WriteError({ operation: "begin", code: "invalid-transition" })),
      )
      const running = yield* decodeRunning({
        id: `aud_${randomUUID()}`,
        state: "running",
        tool: input.tool,
        permission: input.permission,
        sessionID: input.sessionID,
        messageID: input.messageID,
        toolCallID: input.toolCallID,
        startedAt: input.startedAt,
        engine: input.engine,
        contractVersion: input.contractVersion,
        inputDigest: input.inputDigest,
        inputSummary: input.inputSummary,
        sourceArtifactIDs: input.sourceArtifactIDs,
      }).pipe(Effect.mapError(() => new IndustrialAudit.WriteError({ operation: "begin", code: "invalid-transition" })))

      yield* db
        .insert(ToolAuditTable)
        .values({
          id: running.id,
          state: running.state,
          tool_name: running.tool,
          permission_class: running.permission,
          session_id: running.sessionID,
          message_id: running.messageID,
          tool_call_id: running.toolCallID,
          time_started: running.startedAt,
          engine_name: running.engine.name,
          engine_version: running.engine.version,
          contract_version: running.contractVersion,
          input_sha256: running.inputDigest,
          input_summary: {
            sourceCount: running.inputSummary.sourceCount,
            artifactCount: running.inputSummary.artifactCount,
            pathCount: running.inputSummary.pathCount,
            declaredOutputCount: running.inputSummary.declaredOutputCount,
          },
          source_artifact_ids: [...running.sourceArtifactIDs],
          output_artifact_ids: [],
        })
        .run()
        .pipe(
          Effect.mapError(() => new IndustrialAudit.WriteError({ operation: "begin", code: "unavailable" })),
          Effect.catchDefect(() =>
            Effect.fail(new IndustrialAudit.WriteError({ operation: "begin", code: "unavailable" })),
          ),
        )

      yield* events
        .publish(KoalaAudit.Event.ToolRecorded, {
          id: running.id,
          sessionID: running.sessionID,
          messageID: running.messageID,
          toolCallID: running.toolCallID,
          tool: running.tool,
          permission: running.permission,
          state: "running",
          timeStarted: running.startedAt,
        })
        .pipe(Effect.ignore)

      return running
    })

    const complete = Effect.fn("IndustrialAudit.complete")(function* (unsafeInput: IndustrialAudit.CompleteInput) {
      const input = yield* decodeComplete(unsafeInput).pipe(
        Effect.mapError(() => new IndustrialAudit.WriteError({ operation: "complete", code: "invalid-transition" })),
      )
      const row = yield* db
        .select({
          id: ToolAuditTable.id,
          state: ToolAuditTable.state,
          tool: ToolAuditTable.tool_name,
          permission: ToolAuditTable.permission_class,
          sessionID: ToolAuditTable.session_id,
          messageID: ToolAuditTable.message_id,
          toolCallID: ToolAuditTable.tool_call_id,
          startedAt: ToolAuditTable.time_started,
          engineName: ToolAuditTable.engine_name,
          engineVersion: ToolAuditTable.engine_version,
          contractVersion: ToolAuditTable.contract_version,
          inputDigest: ToolAuditTable.input_sha256,
          inputSummary: ToolAuditTable.input_summary,
          sourceArtifactIDs: ToolAuditTable.source_artifact_ids,
        })
        .from(ToolAuditTable)
        .where(eq(ToolAuditTable.id, input.auditID))
        .get()
        .pipe(
          Effect.mapError(() => new IndustrialAudit.WriteError({ operation: "complete", code: "unavailable" })),
          Effect.catchDefect(() =>
            Effect.fail(new IndustrialAudit.WriteError({ operation: "complete", code: "unavailable" })),
          ),
        )
      if (!row) {
        return yield* new IndustrialAudit.WriteError({ operation: "complete", code: "invalid-transition" })
      }
      if (row.state === "completed") {
        return yield* new IndustrialAudit.WriteError({ operation: "complete", code: "already-completed" })
      }
      if (row.state !== "running") {
        return yield* new IndustrialAudit.WriteError({ operation: "complete", code: "invalid-transition" })
      }

      const running = yield* decodeRunning({
        id: row.id,
        state: row.state,
        tool: row.tool,
        permission: row.permission,
        sessionID: row.sessionID,
        messageID: row.messageID,
        toolCallID: row.toolCallID,
        startedAt: row.startedAt,
        engine: { name: row.engineName, version: row.engineVersion },
        contractVersion: row.contractVersion,
        inputDigest: row.inputDigest,
        inputSummary: row.inputSummary,
        sourceArtifactIDs: row.sourceArtifactIDs,
      }).pipe(
        Effect.mapError(() => new IndustrialAudit.WriteError({ operation: "complete", code: "invalid-transition" })),
      )
      const completed = yield* decodeCompleted({ ...running, ...input, state: "completed" }).pipe(
        Effect.mapError(() => new IndustrialAudit.WriteError({ operation: "complete", code: "invalid-transition" })),
      )
      const updated = yield* db
        .update(ToolAuditTable)
        .set({
          state: completed.state,
          time_finished: completed.finishedAt,
          duration_ms: completed.durationMs,
          outcome_code: completed.outcome,
          cancelled: completed.cancelled,
          timed_out: completed.timedOut,
          producer_truncated: completed.producerTruncated,
          projection_truncated: completed.projectionTruncated,
          truncated: completed.producerTruncated || completed.projectionTruncated,
          source_artifact_ids: [...completed.sourceArtifactIDs],
          output_artifact_ids: [...completed.outputArtifactIDs],
          sandbox_run_id: completed.sandboxRunID ?? null,
          route_decision_id: completed.routeDecisionID ?? null,
          error_code: completed.outcome === "success" ? null : completed.errorCode,
        })
        .where(and(eq(ToolAuditTable.id, completed.id), eq(ToolAuditTable.state, "running")))
        .returning({ id: ToolAuditTable.id })
        .get()
        .pipe(
          Effect.mapError(() => new IndustrialAudit.WriteError({ operation: "complete", code: "unavailable" })),
          Effect.catchDefect(() =>
            Effect.fail(new IndustrialAudit.WriteError({ operation: "complete", code: "unavailable" })),
          ),
        )
      if (updated) {
        yield* events
          .publish(KoalaAudit.Event.ToolRecorded, {
            id: completed.id,
            sessionID: completed.sessionID,
            messageID: completed.messageID,
            toolCallID: completed.toolCallID,
            tool: completed.tool,
            permission: completed.permission,
            state: "completed",
            outcome: completed.outcome,
            timeStarted: completed.startedAt,
          })
          .pipe(Effect.ignore)
        return completed
      }

      const current = yield* db
        .select({ state: ToolAuditTable.state })
        .from(ToolAuditTable)
        .where(eq(ToolAuditTable.id, completed.id))
        .get()
        .pipe(
          Effect.mapError(() => new IndustrialAudit.WriteError({ operation: "complete", code: "unavailable" })),
          Effect.catchDefect(() =>
            Effect.fail(new IndustrialAudit.WriteError({ operation: "complete", code: "unavailable" })),
          ),
        )
      if (current?.state === "completed") {
        return yield* new IndustrialAudit.WriteError({ operation: "complete", code: "already-completed" })
      }
      return yield* new IndustrialAudit.WriteError({ operation: "complete", code: "invalid-transition" })
    })

    const list = Effect.fn("IndustrialAudit.list")(function* (query: IndustrialAudit.ListQuery) {
      const limit = query.limit ?? IndustrialAudit.DefaultListLimit
      const conditions = [
        query.cursor !== undefined ? lt(ToolAuditTable.time_started, query.cursor) : undefined,
        query.sessionID !== undefined ? eq(ToolAuditTable.session_id, query.sessionID) : undefined,
      ].filter((condition) => condition !== undefined)

      const rows = yield* db
        .select()
        .from(ToolAuditTable)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(ToolAuditTable.time_started), desc(ToolAuditTable.id))
        .limit(limit + 1)
        .all()
        .pipe(
          Effect.mapError(() => new IndustrialAudit.ReadError({ code: "unavailable" })),
          Effect.catchDefect(() => Effect.fail(new IndustrialAudit.ReadError({ code: "unavailable" }))),
        )

      const page = rows.length > limit ? rows.slice(0, limit) : rows
      const records = yield* Effect.forEach(page, (row) =>
        decodeRecord(rowToRecord(row)).pipe(
          Effect.mapError(() => new IndustrialAudit.ReadError({ code: "unavailable" })),
        ),
      )

      return rows.length > limit && page.length > 0
        ? { records, nextCursor: page[page.length - 1].time_started }
        : { records }
    })

    return IndustrialAudit.Service.of({ begin, complete, list })
  }),
)

export const node = makeGlobalNode({
  service: IndustrialAudit.Service,
  layer,
  deps: [Database.node, EventV2Bridge.node],
})

type AuditRow = typeof ToolAuditTable.$inferSelect

function rowToRecord(row: AuditRow) {
  const base = {
    id: row.id,
    state: row.state,
    tool: row.tool_name,
    permission: row.permission_class,
    sessionID: row.session_id,
    messageID: row.message_id,
    toolCallID: row.tool_call_id,
    startedAt: row.time_started,
    engine: { name: row.engine_name, version: row.engine_version },
    contractVersion: row.contract_version,
    inputDigest: row.input_sha256,
    inputSummary: row.input_summary,
    sourceArtifactIDs: row.source_artifact_ids,
  }
  if (row.state !== "completed") return base
  return {
    ...base,
    finishedAt: row.time_finished,
    durationMs: row.duration_ms,
    producerTruncated: row.producer_truncated,
    projectionTruncated: row.projection_truncated,
    outputArtifactIDs: row.output_artifact_ids,
    outcome: row.outcome_code,
    cancelled: row.cancelled,
    timedOut: row.timed_out,
    ...(row.sandbox_run_id !== null && { sandboxRunID: row.sandbox_run_id }),
    ...(row.route_decision_id !== null && { routeDecisionID: row.route_decision_id }),
    ...(row.outcome_code !== "success" && row.error_code !== null && { errorCode: row.error_code }),
  }
}

export * as IndustrialAuditLive from "./industrial-audit"
