import { describe, expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { Artifact } from "@koala-ai/core/artifact/artifact"
import { ArtifactStore } from "@koala-ai/core/artifact/store"
import { IndustrialResult } from "@koala-ai/core/industrial/result"
import { SandboxProtocol } from "@koala-ai/core/sandbox/protocol"
import { SandboxTool } from "@koala-ai/core/sandbox/tool"
import { ArtifactTable } from "@opencode-ai/core/artifact/sql"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { ProjectV2 } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { ToolAuditTable } from "@opencode-ai/core/tool-audit/sql"
import { count, sql } from "drizzle-orm"
import { Context, Effect, Layer, Result, Schema } from "effect"
import { Agent } from "@/agent/agent"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ArtifactStoreLive } from "@/koala/artifact-store"
import { IndustrialAuditLive } from "@/koala/industrial-audit"
import { IndustrialExecution } from "@/koala/industrial-execution"
import { SandboxRuntime } from "@/sandbox/runtime"
import { MessageID, SessionID } from "@/session/schema"
import { SandboxExecuteTool } from "@/tool/sandbox-execute"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { provideInstance, testInstanceStoreLayer, tmpdir } from "../fixture/fixture"
import { it } from "../lib/effect"

const outputPath = Schema.decodeUnknownSync(Artifact.OutputPath)
const decodeResponse = Schema.decodeUnknownSync(SandboxProtocol.WorkerResponse)
const agent: Agent.Info = { name: "build", mode: "primary", permission: [], options: {} }

type SandboxDefinition = Omit<Tool.InferDef<typeof SandboxExecuteTool>, "id">
type Fixture = {
  readonly data: string
  readonly sessionID: SessionID
  readonly messageID: MessageID
  readonly tool: SandboxDefinition
  readonly store: ArtifactStore.Interface
  readonly db: Context.Service.Shape<typeof Database.Service>["db"]
}

const context = (fixture: Fixture, callID = "call-sandbox", abort = AbortSignal.any([])): Tool.Context => ({
  sessionID: fixture.sessionID,
  messageID: fixture.messageID,
  callID,
  agent: agent.name,
  abort,
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

const workerResult = (runID: SandboxProtocol.RunID, result: Partial<SandboxProtocol.ExecutionResult> = {}) =>
  decodeResponse({
    protocolVersion: 1,
    type: "result",
    runID,
    result: {
      exitCode: 0,
      stdout: "completed",
      stderr: "",
      timedOut: false,
      cancelled: false,
      outputTruncated: false,
      violations: [],
      ...result,
    },
  })

const withTool = <A, E>(
  execute: SandboxRuntime.Interface["execute"],
  body: (fixture: Fixture) => Effect.Effect<A, E>,
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => {
      const services = LayerNode.compile(
        LayerNode.group([ArtifactStoreLive.node, IndustrialAuditLive.node, IndustrialExecution.node, Database.node]),
        [
          [Global.node, Global.layerWith({ data: tmp.path, state: tmp.path })],
          [Database.node, Database.layerFromPath(path.join(tmp.path, "sandbox-execute.db"))],
        ],
      )
      const layer = Layer.mergeAll(
        services,
        Layer.mock(SandboxRuntime.Service, { execute }),
        RuntimeFlags.layer({ agentExecution: "sandbox" }),
        Layer.mock(Agent.Service, { get: () => Effect.succeed(agent) }),
        Layer.mock(Truncate.Service, {
          output: (text) => Effect.succeed({ content: text, truncated: false as const }),
        }),
        testInstanceStoreLayer,
      )
      return Effect.gen(function* () {
        const { db } = yield* Database.Service
        const sessionID = SessionID.make("ses_sandbox_execute")
        const messageID = MessageID.make("msg_sandbox_execute")
        const now = Date.now()
        yield* db
          .insert(SessionTable)
          .values({
            id: sessionID,
            project_id: ProjectV2.ID.global,
            slug: sessionID,
            directory: AbsolutePath.make(tmp.path),
            title: "sandbox execute test",
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
        const info = yield* SandboxExecuteTool
        return yield* body({
          data: tmp.path,
          sessionID,
          messageID,
          tool: yield* info.init(),
          store: yield* ArtifactStore.Service,
          db,
        })
      }).pipe(provideInstance(tmp.path), Effect.provide(layer))
    },
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

describe("tool.sandbox_execute parameters", () => {
  test("uses the shared sandbox input contract", () => {
    const decoded = Schema.decodeUnknownSync(SandboxTool.Input)({
      command: "node script.js",
      timeout: 30_000,
      outputs: ["report.txt", "nested/chart.png"],
    })
    expect({ ...decoded, outputs: decoded.outputs?.map(String) }).toEqual({
      command: "node script.js",
      timeout: 30_000,
      outputs: ["report.txt", "nested/chart.png"],
    })
  })

  test.each([
    { command: "" },
    { command: " echo unsafe-spacing" },
    { command: "echo ok", timeout: 0 },
    { command: "echo ok", timeout: SandboxTool.MaxTimeoutMs + 1 },
    { command: "echo ok", outputs: ["same.txt", "same.txt"] },
    { command: "echo ok", outputs: ["../outside.txt"] },
  ])("rejects invalid parameters %#", (input) => {
    expect(Result.isFailure(Schema.decodeUnknownResult(SandboxTool.Input)(input))).toBe(true)
  })
})

describe("tool.sandbox_execute industrial result", () => {
  it.live("promotes outputs only on clean exit and returns typed metadata plus projection", () => {
    const requests: SandboxProtocol.ExecutionRequest[] = []
    return withTool(
      (runID, request) =>
        Effect.promise(async () => {
          requests.push(request)
          await writeFile(path.join(request.cwd, "artifacts", "first.txt"), "first")
          await writeFile(path.join(request.cwd, "artifacts", "second.txt"), "second")
          return workerResult(runID)
        }),
      (fixture) =>
        Effect.gen(function* () {
          const result = yield* fixture.tool.execute(
            { command: "produce artifacts", outputs: [outputPath("first.txt"), outputPath("second.txt")] },
            context(fixture),
          )
          const typed = result.metadata.result
          if (typed.status !== "success") return yield* Effect.die(new Error("expected sandbox success"))
          const first = typed.outputs[0]
          const request = requests[0]
          if (!first || !request) return yield* Effect.die(new Error("missing sandbox output"))

          expect(String(typed.engine.name)).toBe("anthropic-sandbox-runtime")
          expect(String(typed.engine.version)).toBe("0.0.76")
          expect(typed.sandboxRunID).toBeDefined()
          expect(typed.outputs.map((output) => String(output.name))).toEqual(["first.txt", "second.txt"])
          expect(typed.data).toEqual({ exitCode: 0, stdout: "completed", stderr: "", violations: [] })
          expect(result.output).toBe(result.metadata.projection.text)
          expect(result.output).toContain(`output[0]=${first.id}`)
          expect(result.metadata.projection.truncated).toBe(false)
          expect(yield* fixture.store.metadata(first.id)).toMatchObject({
            provenance: {
              sessionID: fixture.sessionID,
              messageID: fixture.messageID,
              toolCallID: "call-sandbox",
              sandboxRunID: typed.sandboxRunID,
            },
          })
          expect(yield* Effect.promise(() => Bun.file(request.cwd).exists())).toBe(false)
          expect(yield* fixture.db.select().from(ToolAuditTable).get()).toMatchObject({
            state: "completed",
            outcome_code: "success",
            engine_name: "anthropic-sandbox-runtime",
            engine_version: "0.0.76",
            sandbox_run_id: typed.sandboxRunID,
            output_artifact_ids: typed.outputs.map((output) => output.id),
          })
        }),
    )
  })

  it.live("maps worker and terminal failures to curated codes without promoting outputs", () => {
    const roots: string[] = []
    const outcomes: Record<string, SandboxProtocol.WorkerResponse> = {
      "worker-invalid": decodeResponse({
        protocolVersion: 1,
        type: "failure",
        runID: null,
        code: "invalid-request",
      }),
      "worker-protocol": decodeResponse({
        protocolVersion: 1,
        type: "failure",
        runID: null,
        code: "protocol-mismatch",
      }),
      unavailable: decodeResponse({
        protocolVersion: 1,
        type: "failure",
        runID: null,
        code: "sandbox-unavailable",
      }),
      "worker-failed": decodeResponse({ protocolVersion: 1, type: "failure", runID: null, code: "worker-failed" }),
    }
    const terminal: Record<string, Partial<SandboxProtocol.ExecutionResult>> = {
      nonzero: { exitCode: 2 },
      timeout: { timedOut: true },
      cancelled: { cancelled: true },
      truncated: { outputTruncated: true },
      violation: { violations: [{ kind: "filesystem-write", operation: "open", target: "outside" }] },
    }
    const expected: Record<string, IndustrialResult.ErrorCode> = {
      "worker-invalid": "invalid-input",
      "worker-protocol": "protocol-error",
      unavailable: "engine-unavailable",
      "worker-failed": "engine-failed",
      nonzero: "sandbox-nonzero-exit",
      timeout: "deadline-exceeded",
      cancelled: "cancelled",
      truncated: "output-truncated",
      violation: "sandbox-violation",
    }

    return withTool(
      (runID, request) =>
        Effect.promise(async () => {
          roots.push(request.cwd)
          await writeFile(path.join(request.cwd, "artifacts", "result.txt"), request.command)
          return outcomes[request.command] ?? workerResult(runID, terminal[request.command])
        }),
      (fixture) =>
        Effect.gen(function* () {
          const results = yield* Effect.forEach(Object.keys(expected), (command, index) =>
            fixture.tool.execute(
              { command, outputs: [outputPath("result.txt")] },
              context(fixture, `call-terminal-${index}`),
            ),
          )
          expect(
            results.map((result) =>
              result.metadata.result.status === "error" ? result.metadata.result.error.code : "success",
            ),
          ).toEqual(Object.values(expected))
          expect(results.every((result) => result.metadata.result.outputs.length === 0)).toBe(true)
          expect((yield* fixture.db.select({ value: count() }).from(ArtifactTable).get())?.value).toBe(0)
          expect(yield* Effect.promise(() => Promise.all(roots.map((root) => Bun.file(root).exists())))).toEqual(
            roots.map(() => false),
          )
          expect(
            (yield* fixture.db.select().from(ToolAuditTable).all()).every((row) => row.state === "completed"),
          ).toBe(true)
        }),
    )
  })

  it.live("uses the worker timeout as the sandbox deadline authority", () => {
    let operationSignal: AbortSignal | undefined
    return withTool(
      (runID, _request, options) => {
        operationSignal = options?.signal
        return Effect.sleep(10).pipe(Effect.as(workerResult(runID, { timedOut: true })))
      },
      (fixture) =>
        Effect.gen(function* () {
          const result = yield* fixture.tool.execute({ command: "worker timeout", timeout: 5 }, context(fixture))

          expect(operationSignal?.aborted).toBe(false)
          expect(result.metadata.result).toMatchObject({
            status: "error",
            timedOut: true,
            error: { code: "deadline-exceeded" },
          })
          expect(yield* fixture.db.select().from(ToolAuditTable).get()).toMatchObject({
            outcome_code: "timeout",
            error_code: "deadline-exceeded",
          })
        }),
    )
  })

  it.live("does not publish a successful worker result after caller cancellation", () => {
    const caller = new AbortController()
    return withTool(
      (runID, request) =>
        Effect.promise(async () => {
          await writeFile(path.join(request.cwd, "artifacts", "late.txt"), "late output")
          caller.abort()
          await Bun.sleep(5)
          return workerResult(runID)
        }),
      (fixture) =>
        Effect.gen(function* () {
          const result = yield* fixture.tool.execute(
            { command: "cancel before publish", outputs: [outputPath("late.txt")] },
            context(fixture, "call-cancel-before-publish", caller.signal),
          )

          expect(result.metadata.result).toMatchObject({
            status: "error",
            cancelled: true,
            error: { code: "cancelled" },
          })
          expect((yield* fixture.db.select({ value: count() }).from(ArtifactTable).get())?.value).toBe(0)
          expect(yield* fixture.db.select().from(ToolAuditTable).get()).toMatchObject({ outcome_code: "cancelled" })
        }),
    )
  })

  it.live("publishes output metadata atomically when a later candidate fails", () =>
    withTool(
      (runID, request) =>
        Effect.promise(async () => {
          await writeFile(path.join(request.cwd, "artifacts", "first.txt"), "first")
          return workerResult(runID)
        }),
      (fixture) =>
        Effect.gen(function* () {
          const result = yield* fixture.tool.execute(
            { command: "partial outputs", outputs: [outputPath("first.txt"), outputPath("missing.txt")] },
            context(fixture),
          )

          expect(result.metadata.result).toMatchObject({
            status: "error",
            outputs: [],
            error: { code: "artifact-storage-failed" },
          })
          expect((yield* fixture.db.select({ value: count() }).from(ArtifactTable).get())?.value).toBe(0)
        }),
    ),
  )

  it.live("redacts typed output and tracks producer capture truncation separately", () =>
    withTool(
      (runID, request) => {
        const artifactRoot = path.dirname(path.dirname(request.cwd))
        return Effect.succeed(
          workerResult(runID, {
            stdout: `staging=${request.cwd}`,
            stderr: `store=${artifactRoot}`,
            violations:
              request.command === "redact violation"
                ? [{ kind: "filesystem-read", operation: "open", target: request.cwd }]
                : [],
          }),
        )
      },
      (fixture) =>
        Effect.gen(function* () {
          const result = yield* fixture.tool.execute({ command: "redact paths" }, context(fixture, "call-redact"))
          if (result.metadata.result.status !== "success") return yield* Effect.die(new Error("expected success"))
          expect(result.metadata.result.data.stdout).toContain("[artifact-staging]")
          expect(result.metadata.result.data.stderr).toContain("[artifact-store]")
          expect(JSON.stringify(result.metadata)).not.toContain(fixture.data)

          const violation = yield* fixture.tool.execute(
            { command: "redact violation" },
            context(fixture, "call-violation"),
          )
          expect(violation.metadata.result).toMatchObject({
            status: "error",
            error: { code: "sandbox-violation" },
          })
          expect(violation.metadata.result.summary).toContain('"target":"[artifact-staging]"')
          expect(JSON.stringify(violation.metadata)).not.toContain(fixture.data)
        }),
    ),
  )

  it.live("marks worker capture truncation without conflating projection truncation", () =>
    withTool(
      (runID) => Effect.succeed(workerResult(runID, { outputTruncated: true, stdout: "partial" })),
      (fixture) =>
        Effect.gen(function* () {
          const result = yield* fixture.tool.execute({ command: "large output" }, context(fixture))
          expect(result.metadata.result).toMatchObject({
            status: "error",
            producerTruncated: true,
            error: { code: "output-truncated" },
          })
          expect(result.metadata.projection.truncated).toBe(false)
          expect(result.metadata.truncated).toBe(true)
          expect(result.metadata.result.summary.length).toBeLessThanOrEqual(16 * 1024)
          expect(yield* fixture.db.select().from(ToolAuditTable).get()).toMatchObject({ truncated: true })
        }),
    ),
  )

  it.live("marks bounded summary truncation while preserving full typed success data", () => {
    const stdout = "x".repeat(SandboxTool.MaxSummaryBytes * 2)
    return withTool(
      (runID) => Effect.succeed(workerResult(runID, { stdout })),
      (fixture) =>
        Effect.gen(function* () {
          const result = yield* fixture.tool.execute({ command: "large summary" }, context(fixture))
          expect(result.metadata.result).toMatchObject({ status: "success", producerTruncated: true })
          if (result.metadata.result.status !== "success") return yield* Effect.die(new Error("expected success"))
          expect(result.metadata.result.data.stdout).toBe(stdout)
          expect(result.metadata.result.summary.endsWith(SandboxTool.SummaryTruncationMarker)).toBe(true)
          expect(new TextEncoder().encode(result.metadata.result.summary).byteLength).toBeLessThanOrEqual(
            SandboxTool.MaxSummaryBytes,
          )
          expect(result.metadata.truncated).toBe(true)
          expect(yield* fixture.db.select().from(ToolAuditTable).get()).toMatchObject({
            producer_truncated: true,
            projection_truncated: false,
            truncated: true,
          })
        }),
    )
  })
})
