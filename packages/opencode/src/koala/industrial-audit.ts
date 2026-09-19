import { randomUUID } from "node:crypto"
import { IndustrialAudit } from "@koala-ai/core/industrial/audit"
import { Database } from "@opencode-ai/core/database/database"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { ToolAuditTable } from "@opencode-ai/core/tool-audit/sql"
import { and, eq } from "drizzle-orm"
import { Effect, Layer, Schema } from "effect"

const layer = Layer.effect(
  IndustrialAudit.Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const decodeBegin = Schema.decodeUnknownEffect(IndustrialAudit.BeginInput)
    const decodeComplete = Schema.decodeUnknownEffect(IndustrialAudit.CompleteInput)
    const decodeRunning = Schema.decodeUnknownEffect(IndustrialAudit.Running)
    const decodeCompleted = Schema.decodeUnknownEffect(IndustrialAudit.Completed)

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
      if (updated) return completed

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

    return IndustrialAudit.Service.of({ begin, complete })
  }),
)

export const node = makeGlobalNode({ service: IndustrialAudit.Service, layer, deps: [Database.node] })

export * as IndustrialAuditLive from "./industrial-audit"
