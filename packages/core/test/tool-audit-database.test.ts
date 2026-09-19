import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import auditFlagsMigration from "@opencode-ai/core/database/migration/20260919173052_koala_industrial_audit_flags"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { Effect, Exit } from "effect"
import { sql } from "drizzle-orm"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"

const run = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

const makeDb = EffectDrizzleSqlite.makeWithDefaults()

const tools = [
  "document_extract",
  "ocr_extract",
  "vision_analyze",
  "knowledge_ingest",
  "knowledge_search",
  "knowledge_open",
  "docx_read",
  "docx_create",
  "docx_update",
  "pptx_read",
  "pptx_create",
  "pptx_update",
  "spreadsheet_read",
  "spreadsheet_write",
  "spreadsheet_update",
  "pdf_read",
  "pdf_create",
  "pdf_update",
  "calculate",
  "sandbox_execute",
  "sandbox_test",
  "artifact_validate",
] as const

const permissions = [
  "document_read",
  "document_write",
  "vision_analyze",
  "knowledge_read",
  "knowledge_write",
  "calculate",
  "sandbox_execute",
] as const

const permissionByTool: Record<(typeof tools)[number], (typeof permissions)[number]> = {
  document_extract: "document_read",
  ocr_extract: "document_read",
  vision_analyze: "vision_analyze",
  knowledge_ingest: "knowledge_write",
  knowledge_search: "knowledge_read",
  knowledge_open: "knowledge_read",
  docx_read: "document_read",
  docx_create: "document_write",
  docx_update: "document_write",
  pptx_read: "document_read",
  pptx_create: "document_write",
  pptx_update: "document_write",
  spreadsheet_read: "document_read",
  spreadsheet_write: "document_write",
  spreadsheet_update: "document_write",
  pdf_read: "document_read",
  pdf_create: "document_write",
  pdf_update: "document_write",
  calculate: "calculate",
  sandbox_execute: "sandbox_execute",
  sandbox_test: "sandbox_execute",
  artifact_validate: "document_read",
}

describe("tool audit database", () => {
  test("creates the independent audit table and lookup indexes", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`PRAGMA foreign_keys = ON`)
        yield* DatabaseMigration.apply(db)

        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'koala_tool_audit'`),
        ).toEqual({ name: "koala_tool_audit" })
        expect(
          yield* db.all<{ name: string }>(sql`
            SELECT name
            FROM sqlite_master
            WHERE type = 'index' AND name LIKE 'koala_tool_audit_%_idx'
            ORDER BY name
          `),
        ).toEqual([
          { name: "koala_tool_audit_message_idx" },
          { name: "koala_tool_audit_route_decision_idx" },
          { name: "koala_tool_audit_sandbox_run_idx" },
          { name: "koala_tool_audit_session_started_idx" },
          { name: "koala_tool_audit_state_started_idx" },
          { name: "koala_tool_audit_tool_call_idx" },
        ])
        expect(yield* db.all(sql`PRAGMA foreign_key_list('koala_tool_audit')`)).toEqual([])
      }),
    )
  })

  test("transitions once from running to completed and survives source deletion", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`PRAGMA foreign_keys = ON`)
        yield* DatabaseMigration.apply(db)
        const artifactID = "art_00000000-0000-4000-8000-000000000001"
        const digest = "a".repeat(64)

        yield* db.run(
          sql`INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('project', '/project', 1, 1, '[]')`,
        )
        yield* db.run(
          sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES ('session', 'project', 'session', '/project', 'Session', 'test', 1, 1)`,
        )
        yield* db.run(
          sql`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('message', 'session', 1, 1, '{}')`,
        )
        yield* db.run(sql`INSERT INTO koala_artifact_blob (digest, size, time_created) VALUES (${digest}, 1, 1)`)
        yield* db.run(sql`
          INSERT INTO koala_artifact (
            id, digest, name, mime, validation_state, validator, validator_version,
            validation, owner_session_id, owner_message_id, tool_name, time_created
          ) VALUES (
            ${artifactID}, ${digest}, 'source.txt', 'text/plain', 'accepted', 'basic', '1',
            '{"state":"accepted","validator":"basic","validatorVersion":"1"}',
            'session', 'message', 'document_extract', 1
          )
        `)
        yield* insertAudit(db, "audit", {
          sourceArtifactIDs: JSON.stringify([artifactID]),
          sandboxRunID: "sandbox-run",
          routeDecisionID: "route-decision",
        })
        yield* db.run(sql`
          UPDATE koala_tool_audit
          SET state = 'completed', time_finished = 175, duration_ms = 75,
              outcome_code = 'success', output_artifact_ids = ${JSON.stringify([artifactID])}
          WHERE id = ${auditID("audit")} AND state = 'running'
        `)

        expect(
          yield* db.get(
            sql`SELECT state, time_started, time_finished, duration_ms, outcome_code FROM koala_tool_audit WHERE id = ${auditID("audit")}`,
          ),
        ).toEqual({
          state: "completed",
          time_started: 100,
          time_finished: 175,
          duration_ms: 75,
          outcome_code: "success",
        })
        yield* db.run(sql`DELETE FROM session WHERE id = 'session'`)
        expect(yield* db.get(sql`SELECT count(*) AS count FROM koala_artifact`)).toEqual({ count: 0 })
        expect(yield* db.get(sql`SELECT id FROM koala_tool_audit`)).toEqual({ id: auditID("audit") })
      }),
    )
  })

  test("enforces closed inventories and safe lifecycle payloads", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)

        yield* Effect.forEach(tools, (tool, index) =>
          insertAudit(db, `tool-${index}`, { tool, permission: permissionByTool[tool] }),
        )
        yield* insertAudit(db, "opaque-call", { toolCallID: "provider call/id:{opaque}=v1" })

        const validArtifactID = "art_00000000-0000-4000-8000-000000000001"
        const invalid = [
          insertAudit(db, "bad-state", { state: "pending" }),
          insertAudit(db, "bad-tool", { tool: "shell" }),
          insertAudit(db, "bad-permission", { permission: "network" }),
          insertAudit(db, "bad-tool-permission-pair", { tool: "sandbox_execute", permission: "document_read" }),
          insertAudit(db, "bad-running-finish", { timeFinished: 101, durationMs: 1, outcomeCode: "success" }),
          insertAudit(db, "bad-completed-finish", { state: "completed", outcomeCode: "success" }),
          insertAudit(db, "bad-duration", {
            state: "completed",
            timeFinished: 110,
            durationMs: 9,
            outcomeCode: "success",
          }),
          insertAudit(db, "bad-flag", { cancelled: 2 }),
          insertAudit(db, "bad-producer-truncated", { producerTruncated: 2 }),
          insertAudit(db, "bad-projection-truncated", { projectionTruncated: 2 }),
          insertAudit(db, "bad-digest", { inputSHA256: "A".repeat(64) }),
          insertAudit(db, "bad-summary-json", { inputSummary: "not-json" }),
          insertAudit(db, "bad-summary-root", { inputSummary: "[]" }),
          insertAudit(db, "bad-source-root", { sourceArtifactIDs: "{}" }),
          insertAudit(db, "bad-source-count", {
            sourceArtifactIDs: JSON.stringify(Array.from({ length: 101 }, () => "art")),
          }),
          insertAudit(db, "bad-output-root", { outputArtifactIDs: "{}" }),
          insertAudit(db, "bad-output-count", {
            outputArtifactIDs: JSON.stringify(Array.from({ length: 11 }, () => "art")),
          }),
          insertAudit(db, "bad-source-id", { sourceArtifactIDs: JSON.stringify(["art_invalid"]) }),
          insertAudit(db, "duplicate-source-id", {
            sourceArtifactIDs: JSON.stringify([validArtifactID, validArtifactID]),
          }),
          insertAudit(db, "duplicate-output-id", {
            outputArtifactIDs: JSON.stringify([validArtifactID, validArtifactID]),
          }),
          insertAudit(db, "bad-call-control", { toolCallID: "provider\ncall" }),
          insertAudit(db, "bad-call-length", { toolCallID: "x".repeat(513) }),
          insertAudit(db, "bad-reference", { sandboxRunID: " " }),
          insertAudit(db, "bad-outcome", {
            state: "completed",
            timeFinished: 101,
            durationMs: 1,
            outcomeCode: "Not Safe",
          }),
          insertAudit(db, "bad-error", {
            state: "completed",
            timeFinished: 101,
            durationMs: 1,
            outcomeCode: "error",
            errorCode: "raw error",
          }),
          insertAudit(db, "uncurated-error", {
            state: "completed",
            timeFinished: 101,
            durationMs: 1,
            outcomeCode: "error",
            errorCode: "future-code",
          }),
          insertAudit(db, "inconsistent-truncation", { producerTruncated: 1, truncated: 0 }),
        ]
        expect((yield* Effect.forEach(invalid, (effect) => Effect.exit(effect))).every(Exit.isFailure)).toBe(true)
      }),
    )
  })

  test("migrates legacy combined truncation and unknown safe errors conservatively", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`
          CREATE TABLE koala_tool_audit (
            id text PRIMARY KEY, state text NOT NULL, tool_name text NOT NULL, permission_class text NOT NULL,
            session_id text NOT NULL, message_id text NOT NULL, tool_call_id text NOT NULL,
            time_started integer NOT NULL, time_finished integer, duration_ms integer, outcome_code text,
            cancelled integer NOT NULL, timed_out integer NOT NULL, truncated integer NOT NULL,
            engine_name text NOT NULL, engine_version text NOT NULL, contract_version integer NOT NULL,
            input_sha256 text NOT NULL, input_summary text NOT NULL, source_artifact_ids text NOT NULL,
            output_artifact_ids text NOT NULL, sandbox_run_id text, route_decision_id text, error_code text
          )
        `)
        yield* db.run(sql`
          INSERT INTO koala_tool_audit VALUES (
            ${auditID("legacy")}, 'completed', 'sandbox_execute', 'sandbox_execute', 'session', 'message',
            'call-legacy', 100, 101, 1, 'error', 0, 0, 1, 'engine', '1', 1,
             ${"a".repeat(64)}, '{}', '[]', '[]', NULL, NULL, 'future-code'
          )
        `)

        yield* DatabaseMigration.applyOnly(db, [auditFlagsMigration])

        expect(
          yield* db.get(sql`
            SELECT producer_truncated, projection_truncated, truncated, error_code
            FROM koala_tool_audit
          `),
        ).toEqual({ producer_truncated: 1, projection_truncated: 0, truncated: 1, error_code: "internal-error" })
      }),
    )
  })
})

function insertAudit(
  db: Effect.Success<typeof makeDb>,
  id: string,
  options: {
    readonly state?: string
    readonly tool?: string
    readonly permission?: string
    readonly timeFinished?: number
    readonly durationMs?: number
    readonly outcomeCode?: string
    readonly cancelled?: number
    readonly timedOut?: number
    readonly truncated?: number
    readonly producerTruncated?: number
    readonly projectionTruncated?: number
    readonly inputSHA256?: string
    readonly inputSummary?: string
    readonly sourceArtifactIDs?: string
    readonly outputArtifactIDs?: string
    readonly sandboxRunID?: string
    readonly routeDecisionID?: string
    readonly errorCode?: string
    readonly toolCallID?: string
  } = {},
) {
  return db.run(sql`
    INSERT INTO koala_tool_audit (
      id, state, tool_name, permission_class, session_id, message_id, tool_call_id,
      time_started, time_finished, duration_ms, outcome_code, cancelled, timed_out,
      producer_truncated, projection_truncated, truncated, engine_name, engine_version, contract_version, input_sha256,
      input_summary, source_artifact_ids, output_artifact_ids, sandbox_run_id,
      route_decision_id, error_code
    ) VALUES (
      ${auditID(id)}, ${options.state ?? "running"}, ${options.tool ?? "document_extract"},
      ${options.permission ?? "document_read"}, 'session', 'message', ${options.toolCallID ?? `call-${id}`}, 100,
      ${options.timeFinished ?? null}, ${options.durationMs ?? null}, ${options.outcomeCode ?? null},
      ${options.cancelled ?? 0}, ${options.timedOut ?? 0}, ${options.producerTruncated ?? 0},
      ${options.projectionTruncated ?? 0}, ${options.truncated ?? 0},
      'engine', '1', '1', ${options.inputSHA256 ?? "a".repeat(64)},
      ${options.inputSummary ?? '{"sourceType":"artifact","sourceCount":1}'},
      ${options.sourceArtifactIDs ?? "[]"}, ${options.outputArtifactIDs ?? "[]"},
      ${options.sandboxRunID ?? null}, ${options.routeDecisionID ?? null}, ${options.errorCode ?? null}
    )
  `)
}

function auditID(value: string) {
  const hex = createHash("sha256").update(value).digest("hex")
  return `aud_${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}
