import { describe, expect } from "bun:test"
import { Engine, MaxLiteralDigits } from "@koala-ai/core/calculate/tool"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { ToolAuditTable } from "@opencode-ai/core/tool-audit/sql"
import { Context, Deferred, Effect, Fiber, Layer } from "effect"
import { sql } from "drizzle-orm"
import path from "node:path"
import { Agent } from "@/agent/agent"
import { IndustrialAuditLive } from "@/koala/industrial-audit"
import { IndustrialExecution } from "@/koala/industrial-execution"
import { MessageID, SessionID } from "@/session/schema"
import { CalculateTool, DeadlineMs, makeCalculateTool } from "@/tool/calculate"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { testInstanceStoreLayer, tmpdir } from "../fixture/fixture"
import { it } from "../lib/effect"

const agent: Agent.Info = { name: "build", mode: "primary", permission: [], options: {} }

type Definition = Omit<Tool.InferDef<typeof CalculateTool>, "id">
type Fixture = {
  readonly tool: Definition
  readonly db: Context.Service.Shape<typeof Database.Service>["db"]
  readonly sessionID: SessionID
  readonly messageID: MessageID
}

const withTool = <A, E>(body: (fixture: Fixture) => Effect.Effect<A, E>, definition = CalculateTool) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => {
      const services = LayerNode.compile(
        LayerNode.group([IndustrialAuditLive.node, IndustrialExecution.node, Database.node]),
        [[Database.node, Database.layerFromPath(path.join(tmp.path, "calculate.db"))]],
      )
      const layer = Layer.mergeAll(
        services,
        Layer.mock(Agent.Service, { get: () => Effect.succeed(agent) }),
        Layer.mock(Truncate.Service, {
          output: (text) => Effect.succeed({ content: text, truncated: false as const }),
        }),
        testInstanceStoreLayer,
      )
      return Effect.gen(function* () {
        const { db } = yield* Database.Service
        const sessionID = SessionID.make("ses_calculate")
        const messageID = MessageID.make("msg_calculate")
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
            id: sessionID,
            project_id: ProjectV2.ID.global,
            slug: sessionID,
            directory: AbsolutePath.make(tmp.path),
            title: "calculate test",
            version: "test",
            time_created: now,
            time_updated: now,
          })
          .run()
        yield* db.run(sql`
          INSERT INTO message (id, session_id, time_created, time_updated, data)
          VALUES (
            ${messageID}, ${sessionID}, ${now}, ${now},
            ${JSON.stringify({
              role: "user",
              time: { created: now },
              agent: "test",
              model: { providerID: "test", modelID: "test" },
            })}
          )
        `)
        const info = yield* definition
        return yield* body({ tool: yield* info.init(), db, sessionID, messageID })
      }).pipe(Effect.provide(layer))
    },
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

const context = (
  fixture: Fixture,
  callID: string,
  ask: Tool.Context["ask"] = () => Effect.void,
  abort = AbortSignal.any([]),
): Tool.Context => ({
  sessionID: fixture.sessionID,
  messageID: fixture.messageID,
  callID,
  agent: agent.name,
  abort,
  messages: [],
  metadata: () => Effect.void,
  ask,
})

const expensiveExpression = Array.from({ length: 250 }, () => "1^1").join("+")

describe("tool.calculate", () => {
  it.live("returns typed decimal output and completes a redacted audit", () =>
    withTool((fixture) =>
      Effect.gen(function* () {
        const requested: unknown[] = []
        const result = yield* fixture.tool.execute(
          { expression: "1 km + 250 m to m" },
          context(fixture, "call-calculate", (request) => Effect.sync(() => requested.push(request))),
        )

        expect(requested).toEqual([{ permission: "calculate", patterns: ["*"], always: ["*"], metadata: {} }])
        expect(result.metadata.result).toMatchObject({
          status: "success",
          sources: [],
          outputs: [],
          citations: [],
          engine: Engine,
          data: { value: "1250", unit: "m", precision: 34, operationCount: 4 },
        })
        expect(result.output).toContain("Calculation completed: 1250 m")
        expect(result.metadata.truncated).toBe(false)
        const audit = yield* fixture.db.select().from(ToolAuditTable).get()
        expect(audit).toMatchObject({
          state: "completed",
          tool_name: "calculate",
          permission_class: "calculate",
          outcome_code: "success",
          engine_name: "koala-decimal-calculator",
          engine_version: "1",
          input_summary: { sourceCount: 0, artifactCount: 0, pathCount: 0, declaredOutputCount: 0 },
          source_artifact_ids: [],
          output_artifact_ids: [],
        })
        expect(JSON.stringify(audit)).not.toContain("1 km")
      }),
    ),
  )

  it.live("maps parser and limit failures to curated industrial results with spans", () =>
    withTool((fixture) =>
      Effect.gen(function* () {
        const invalid = yield* fixture.tool.execute({ expression: "12 / 0" }, context(fixture, "call-invalid"))
        const limited = yield* fixture.tool.execute(
          { expression: "9".repeat(MaxLiteralDigits + 1) },
          context(fixture, "call-limit"),
        )

        expect(invalid.metadata.result).toMatchObject({ status: "error", error: { code: "invalid-input" } })
        expect(invalid.output).toContain("Calculation failed: division-by-zero at 5-6")
        expect(limited.metadata.result).toMatchObject({ status: "error", error: { code: "limit-exceeded" } })
        expect((yield* fixture.db.select().from(ToolAuditTable).all()).map((row) => row.outcome_code)).toEqual([
          "error",
          "error",
        ])
      }),
    ),
  )

  it.live("records cancellation before invoking calculation", () =>
    withTool((fixture) =>
      Effect.gen(function* () {
        const abort = new AbortController()
        abort.abort()
        const result = yield* fixture.tool.execute(
          { expression: "1 + 2" },
          context(fixture, "call-cancel", undefined, abort.signal),
        )

        expect(result.metadata.result).toMatchObject({
          status: "error",
          cancelled: true,
          error: { code: "cancelled" },
        })
        expect(yield* fixture.db.select().from(ToolAuditTable).get()).toMatchObject({
          state: "completed",
          outcome_code: "cancelled",
          error_code: "cancelled",
        })
      }),
    ),
  )

  it.live("cancels an active calculation after evaluation starts", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const abort = new AbortController()

      yield* withTool(
        (fixture) =>
          Effect.gen(function* () {
            const running = yield* fixture.tool
              .execute(
                { expression: expensiveExpression },
                context(fixture, "call-active-cancel", undefined, abort.signal),
              )
              .pipe(Effect.forkChild)
            yield* Deferred.await(started).pipe(Effect.timeout("5 seconds"))
            abort.abort()
            const result = yield* Fiber.join(running)

            expect(result.metadata.result).toMatchObject({
              status: "error",
              cancelled: true,
              timedOut: false,
              error: { code: "cancelled" },
            })
            expect(yield* fixture.db.select().from(ToolAuditTable).get()).toMatchObject({
              state: "completed",
              outcome_code: "cancelled",
              error_code: "cancelled",
            })
          }),
        makeCalculateTool(DeadlineMs, () => Effect.runSync(Deferred.succeed(started, undefined))),
      )
    }),
  )

  it.live("classifies an active calculation deadline", () =>
    withTool(
      (fixture) =>
        Effect.gen(function* () {
          const result = yield* fixture.tool.execute(
            { expression: expensiveExpression },
            context(fixture, "call-deadline"),
          )

          expect(result.metadata.result).toMatchObject({
            status: "error",
            cancelled: false,
            timedOut: true,
            error: { code: "deadline-exceeded" },
          })
          expect(yield* fixture.db.select().from(ToolAuditTable).get()).toMatchObject({
            state: "completed",
            outcome_code: "timeout",
            error_code: "deadline-exceeded",
          })
        }),
      makeCalculateTool(1),
    ),
  )

  it.live("does not route through dynamic code or execution tools", () =>
    Effect.gen(function* () {
      const source = yield* Effect.promise(() => Bun.file(`${import.meta.dir}/../../src/tool/calculate.ts`).text())
      expect(source).not.toMatch(new RegExp(`\\b${["ev", "al"].join("")}\\s*\\(`))
      expect(source).not.toMatch(new RegExp(`\\b${["Fun", "ction"].join("")}\\s*\\(`))
      expect(source).not.toContain(["code", "mode"].join("-"))
      expect(source).not.toContain(["child", "_process"].join(""))
      expect(source).not.toContain(["sand", "box"].join(""))
    }),
  )
})
