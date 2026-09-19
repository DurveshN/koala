import { describe, expect } from "bun:test"
import path from "node:path"
import { IndustrialAudit } from "@koala-ai/core/industrial/audit"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ToolAuditTable } from "@opencode-ai/core/tool-audit/sql"
import { sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { IndustrialAuditLive } from "../../src/koala/industrial-audit"
import { tmpdir } from "../fixture/fixture"
import { it } from "../lib/effect"

const digest = "a".repeat(64)
const sourceArtifactID = "art_123e4567-e89b-42d3-a456-426614174000"
const outputArtifactID = "art_123e4567-e89b-42d3-a456-426614174001"
const decodeBeginInput = Schema.decodeUnknownSync(IndustrialAudit.BeginInput)
const decodeCompleteInput = Schema.decodeUnknownSync(IndustrialAudit.CompleteInput)
const decodeAuditID = Schema.decodeUnknownSync(IndustrialAudit.ID)

const canaries = {
  command: "command-canary --credential secret-canary",
  expression: "expression-canary + 1",
  ocrText: "ocr-text-canary",
  url: "https://url-canary.example/private",
  credentials: "credentials-canary",
  stderr: "stderr-canary",
  hostPath: "C:\\host-path-canary\\private.txt",
}

const beginInput = (startedAt = 1_758_236_400_000) =>
  decodeBeginInput({
    tool: "sandbox_execute",
    permission: "sandbox_execute",
    sessionID: "session-123",
    messageID: "message-123",
    toolCallID: "call-123",
    startedAt,
    engine: { name: "sandbox", version: "1.0.0" },
    contractVersion: 1,
    inputDigest: digest,
    inputSummary: { sourceCount: 1, artifactCount: 1, pathCount: 0, declaredOutputCount: 1 },
    sourceArtifactIDs: [sourceArtifactID],
  })

const completeInput = (auditID: IndustrialAudit.ID, outcome: "success" | "error" | "cancelled" | "timeout") =>
  decodeCompleteInput({
    auditID,
    finishedAt: 1_758_236_401_000,
    durationMs: 1_000,
    producerTruncated: outcome === "error",
    projectionTruncated: outcome === "timeout",
    sourceArtifactIDs: outcome === "success" ? [sourceArtifactID, outputArtifactID] : [sourceArtifactID],
    outputArtifactIDs: outcome === "success" ? [outputArtifactID] : [],
    sandboxRunID: "sandbox-run-123",
    routeDecisionID: "route-decision-123",
    ...(outcome === "success"
      ? { outcome, cancelled: false, timedOut: false }
      : outcome === "error"
        ? { outcome, cancelled: false, timedOut: false, errorCode: "engine-failed" }
        : outcome === "cancelled"
          ? { outcome, cancelled: true, timedOut: false, errorCode: "cancelled" }
          : { outcome, cancelled: false, timedOut: true, errorCode: "deadline-exceeded" }),
  })

const withAudit = <A, E>(body: () => Effect.Effect<A, E, IndustrialAudit.Service | Database.Service>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) =>
      body().pipe(
        Effect.provide(
          LayerNode.compile(LayerNode.group([IndustrialAuditLive.node, Database.node]), [
            [Database.node, Database.layerFromPath(path.join(tmp.path, "industrial-audit.db"))],
          ]),
        ),
      ),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

describe("IndustrialAudit", () => {
  it.live("decodes begin input, generates a strict ID, and persists only redacted declared fields", () =>
    withAudit(() =>
      Effect.gen(function* () {
        const audit = yield* IndustrialAudit.Service
        const unsafe = {
          ...beginInput(),
          ...canaries,
          engine: { ...beginInput().engine, command: canaries.command, credentials: canaries.credentials },
          inputSummary: { ...beginInput().inputSummary, ocrText: canaries.ocrText, hostPath: canaries.hostPath },
        }

        const running = yield* audit.begin(unsafe as unknown as IndustrialAudit.BeginInput)
        expect(running.id).toMatch(/^aud_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
        expect(running).toEqual({ ...beginInput(), id: running.id, state: "running" })

        const { db } = yield* Database.Service
        const rows = yield* db.select().from(ToolAuditTable).all()
        expect(rows).toHaveLength(1)
        expect(rows[0]).toEqual({
          id: running.id,
          state: "running",
          tool_name: "sandbox_execute",
          permission_class: "sandbox_execute",
          session_id: "session-123",
          message_id: "message-123",
          tool_call_id: "call-123",
          time_started: 1_758_236_400_000,
          time_finished: null,
          duration_ms: null,
          outcome_code: null,
          cancelled: false,
          timed_out: false,
          producer_truncated: false,
          projection_truncated: false,
          truncated: false,
          engine_name: "sandbox",
          engine_version: "1.0.0",
          contract_version: 1,
          input_sha256: digest,
          input_summary: beginInput().inputSummary,
          source_artifact_ids: [sourceArtifactID],
          output_artifact_ids: [],
          sandbox_run_id: null,
          route_decision_id: null,
          error_code: null,
        })
        const persisted = JSON.stringify(rows)
        for (const canary of Object.values(canaries)) expect(persisted).not.toContain(canary)
      }),
    ),
  )

  it.live("completes success, error, cancellation, and timeout records", () =>
    withAudit(() =>
      Effect.gen(function* () {
        const audit = yield* IndustrialAudit.Service
        const outcomes = ["success", "error", "cancelled", "timeout"] as const

        for (const [index, outcome] of outcomes.entries()) {
          const running = yield* audit.begin({
            ...beginInput(),
            toolCallID: Schema.decodeUnknownSync(IndustrialAudit.ToolCallID)(`call-${outcome}`),
            startedAt: beginInput().startedAt + index * 10_000,
          })
          const input = {
            ...completeInput(running.id, outcome),
            finishedAt: running.startedAt + 1_000,
            ...canaries,
          }
          const completed = yield* audit.complete(input as unknown as IndustrialAudit.CompleteInput)

          expect(completed).toMatchObject({
            ...beginInput(running.startedAt),
            id: running.id,
            toolCallID: `call-${outcome}`,
            state: "completed",
            outcome,
            finishedAt: running.startedAt + 1_000,
            sourceArtifactIDs: input.sourceArtifactIDs,
          })
        }

        const { db } = yield* Database.Service
        const rows = yield* db.select().from(ToolAuditTable).all()
        expect(rows.map((row) => row.outcome_code).sort()).toEqual(["cancelled", "error", "success", "timeout"])
        expect(rows.find((row) => row.outcome_code === "success")).toMatchObject({
          cancelled: false,
          timed_out: false,
          truncated: false,
          producer_truncated: false,
          projection_truncated: false,
          error_code: null,
          output_artifact_ids: [outputArtifactID],
          source_artifact_ids: [sourceArtifactID, outputArtifactID],
        })
        expect(rows.find((row) => row.outcome_code === "error")).toMatchObject({
          cancelled: false,
          timed_out: false,
          truncated: true,
          producer_truncated: true,
          projection_truncated: false,
          error_code: "engine-failed",
        })
        expect(rows.find((row) => row.outcome_code === "cancelled")).toMatchObject({
          cancelled: true,
          timed_out: false,
          error_code: "cancelled",
        })
        expect(rows.find((row) => row.outcome_code === "timeout")).toMatchObject({
          cancelled: false,
          timed_out: true,
          truncated: true,
          producer_truncated: false,
          projection_truncated: true,
          error_code: "deadline-exceeded",
        })
        const persisted = JSON.stringify(rows)
        for (const canary of Object.values(canaries)) expect(persisted).not.toContain(canary)
      }),
    ),
  )

  it.live("allows exactly one concurrent transition", () =>
    withAudit(() =>
      Effect.gen(function* () {
        const audit = yield* IndustrialAudit.Service
        const running = yield* audit.begin(beginInput())
        const outcomes = yield* Effect.all(
          [
            audit.complete(completeInput(running.id, "success")),
            audit.complete(completeInput(running.id, "success")),
          ].map((effect) =>
            effect.pipe(
              Effect.as("completed" as const),
              Effect.catch((error) => Effect.succeed(error.code)),
            ),
          ),
          { concurrency: "unbounded" },
        )

        expect(outcomes.toSorted()).toEqual(["already-completed", "completed"])
      }),
    ),
  )

  it.live("returns typed invalid-transition errors for invalid input and missing audits", () =>
    withAudit(() =>
      Effect.gen(function* () {
        const audit = yield* IndustrialAudit.Service
        const invalidBegin = yield* audit
          .begin({ ...beginInput(), permission: "document_read" } as unknown as IndustrialAudit.BeginInput)
          .pipe(Effect.flip)
        expect(invalidBegin).toEqual(new IndustrialAudit.WriteError({ operation: "begin", code: "invalid-transition" }))

        const invalidCall = yield* audit
          .begin({ ...beginInput(), toolCallID: "provider\ncall" } as unknown as IndustrialAudit.BeginInput)
          .pipe(Effect.flip)
        expect(invalidCall).toEqual(
          new IndustrialAudit.WriteError({ operation: "begin", code: "invalid-transition" }),
        )

        const missing = yield* audit
          .complete(completeInput(decodeAuditID("aud_123e4567-e89b-42d3-a456-426614174999"), "success"))
          .pipe(Effect.flip)
        expect(missing).toEqual(new IndustrialAudit.WriteError({ operation: "complete", code: "invalid-transition" }))

        const running = yield* audit.begin(beginInput())
        const invalidComplete = yield* audit
          .complete({
            ...completeInput(running.id, "success"),
            durationMs: 999,
          } as unknown as IndustrialAudit.CompleteInput)
          .pipe(Effect.flip)
        expect(invalidComplete).toEqual(
          new IndustrialAudit.WriteError({ operation: "complete", code: "invalid-transition" }),
        )
      }),
    ),
  )

  it.live("returns typed already-completed errors without changing the terminal row", () =>
    withAudit(() =>
      Effect.gen(function* () {
        const audit = yield* IndustrialAudit.Service
        const running = yield* audit.begin(beginInput())
        const first = yield* audit.complete(completeInput(running.id, "success"))
        const error = yield* audit.complete(completeInput(running.id, "error")).pipe(Effect.flip)

        expect(error).toEqual(new IndustrialAudit.WriteError({ operation: "complete", code: "already-completed" }))
        const { db } = yield* Database.Service
        expect((yield* db.select().from(ToolAuditTable).get())?.outcome_code).toBe(first.outcome)
      }),
    ),
  )

  it.live("maps begin database failures to a cause-free unavailable error", () =>
    withAudit(() =>
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db.run(sql`DROP TABLE koala_tool_audit`)
        const audit = yield* IndustrialAudit.Service
        const error = yield* audit.begin(beginInput()).pipe(Effect.flip)

        expect(error).toEqual(new IndustrialAudit.WriteError({ operation: "begin", code: "unavailable" }))
        expect("cause" in error).toBe(false)
      }),
    ),
  )

  it.live("maps complete database failures to a cause-free unavailable error", () =>
    withAudit(() =>
      Effect.gen(function* () {
        const audit = yield* IndustrialAudit.Service
        const running = yield* audit.begin(beginInput())
        const { db } = yield* Database.Service
        yield* db.run(sql`DROP TABLE koala_tool_audit`)
        const error = yield* audit.complete(completeInput(running.id, "success")).pipe(Effect.flip)

        expect(error).toEqual(new IndustrialAudit.WriteError({ operation: "complete", code: "unavailable" }))
        expect("cause" in error).toBe(false)
      }),
    ),
  )
})
