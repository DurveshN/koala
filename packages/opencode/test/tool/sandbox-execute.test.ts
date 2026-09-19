import { describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { Artifact } from "@koala-ai/core/artifact/artifact"
import { ArtifactStore } from "@koala-ai/core/artifact/store"
import { SandboxProtocol } from "@koala-ai/core/sandbox/protocol"
import { ArtifactTable } from "@opencode-ai/core/artifact/sql"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { ProjectV2 } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { count, sql } from "drizzle-orm"
import { Context, Effect, Exit, Layer, Result, Schema } from "effect"
import { Agent } from "@/agent/agent"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ArtifactStoreLive } from "@/koala/artifact-store"
import { SandboxRuntime } from "@/sandbox/runtime"
import { MessageID, SessionID } from "@/session/schema"
import { Parameters, SandboxExecuteTool } from "@/tool/sandbox-execute"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { provideInstance, testInstanceStoreLayer, tmpdir } from "../fixture/fixture"
import { it } from "../lib/effect"

const outputPath = Schema.decodeUnknownSync(Artifact.OutputPath)
const decodeResponse = Schema.decodeUnknownSync(SandboxProtocol.WorkerResponse)
const agent: Agent.Info = { name: "build", mode: "primary", permission: [], options: {} }

type SandboxTool = Omit<Tool.InferDef<typeof SandboxExecuteTool>, "id">
type Fixture = {
  readonly data: string
  readonly sessionID: SessionID
  readonly messageID: MessageID
  readonly tool: SandboxTool
  readonly store: ArtifactStore.Interface
  readonly db: Context.Service.Shape<typeof Database.Service>["db"]
}

const ctx = (fixture: Fixture): Tool.Context => ({
  sessionID: fixture.sessionID,
  messageID: fixture.messageID,
  callID: "call-artifact",
  agent: agent.name,
  abort: AbortSignal.any([]),
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
      const storeLayer = LayerNode.compile(LayerNode.group([ArtifactStoreLive.node, Database.node]), [
        [Global.node, Global.layerWith({ data: tmp.path, state: tmp.path })],
        [Database.node, Database.layerFromPath(path.join(tmp.path, "sandbox-artifacts.db"))],
      ])
      const layer = Layer.mergeAll(
        storeLayer,
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
        const sessionID = SessionID.make("ses_sandbox_artifacts")
        const messageID = MessageID.make("msg_sandbox_artifacts")
        const now = Date.now()
        yield* db
          .insert(SessionTable)
          .values({
            id: sessionID,
            project_id: ProjectV2.ID.global,
            slug: sessionID,
            directory: AbsolutePath.make(tmp.path),
            title: "sandbox artifact test",
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
  test("accepts a command and bounded timeout", () => {
    const decoded = Schema.decodeUnknownSync(Parameters)({
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
    { command: "echo ok", timeout: 120_001 },
    { command: "echo ok", outputs: ["same.txt", "same.txt"] },
    { command: "echo ok", outputs: ["../outside.txt"] },
    {
      command: "echo ok",
      outputs: Array.from({ length: Artifact.MaxOutputsPerRun + 1 }, (_, index) => `${index}.txt`),
    },
  ])("rejects invalid parameters %#", (input) => {
    expect(Result.isFailure(Schema.decodeUnknownResult(Parameters)(input))).toBe(true)
  })
})

describe("tool.sandbox_execute artifact promotion", () => {
  it.live("runs from private staging and promotes declared outputs in order", () => {
    const requests: SandboxProtocol.ExecutionRequest[] = []
    return withTool(
      (runID, request) =>
        Effect.promise(async () => {
          requests.push(request)
          await writeFile(path.join(request.cwd, "artifacts", "first.txt"), "first")
          await writeFile(path.join(request.cwd, "artifacts", "second.txt"), "second output")
          return workerResult(runID)
        }),
      (fixture) =>
        Effect.gen(function* () {
          const result = yield* fixture.tool.execute(
            {
              command: "produce artifacts",
              outputs: [outputPath("first.txt"), outputPath("second.txt")],
            },
            ctx(fixture),
          )

          expect(requests).toHaveLength(1)
          const request = requests[0]
          const first = result.metadata.artifacts[0]
          const second = result.metadata.artifacts[1]
          if (!request || !first || !second) return yield* Effect.die(new Error("missing sandbox artifact result"))
          expect(
            String(request.cwd).startsWith(path.join(fixture.data, "koala", "artifacts", "staging") + path.sep),
          ).toBe(true)
          expect(request.readRoots.map(String)).toEqual([fixture.data, String(request.cwd)])
          expect(request.writeRoots.map(String)).toEqual([
            path.join(request.cwd, "work"),
            path.join(request.cwd, "artifacts"),
          ])
          expect(result.metadata.artifacts.map((reference) => String(reference.name))).toEqual([
            "first.txt",
            "second.txt",
          ])
          expect(result.output).toContain(`"id":"${first.id}"`)
          expect(result.output).toContain(`"digest":"${second.digest}"`)
          expect(result.output).not.toContain(fixture.data)
          expect(yield* fixture.store.metadata(first.id)).toMatchObject({
            name: "first.txt",
            provenance: {
              sessionID: fixture.sessionID,
              messageID: fixture.messageID,
              toolName: "sandbox_execute",
              toolCallID: "call-artifact",
            },
          })
          expect(yield* Effect.promise(() => Bun.file(request.cwd).exists())).toBe(false)
        }),
    )
  })

  it.live("does not promote outputs from any non-clean terminal result", () => {
    const roots: string[] = []
    const outcomes: Record<string, Partial<SandboxProtocol.ExecutionResult>> = {
      exit: { exitCode: 2 },
      timeout: { timedOut: true },
      cancelled: { cancelled: true },
      truncated: { outputTruncated: true },
      violation: { violations: [{ kind: "filesystem-write", operation: "open", target: "outside" }] },
    }
    return withTool(
      (runID, request) =>
        Effect.promise(async () => {
          roots.push(request.cwd)
          await writeFile(path.join(request.cwd, "artifacts", "result.txt"), request.command)
          return workerResult(runID, outcomes[request.command])
        }),
      (fixture) =>
        Effect.gen(function* () {
          const results = yield* Effect.forEach(Object.keys(outcomes), (command) =>
            fixture.tool.execute({ command, outputs: [outputPath("result.txt")] }, ctx(fixture)),
          )
          expect(results.every((result) => result.metadata.artifacts.length === 0)).toBe(true)
          expect((yield* fixture.db.select({ value: count() }).from(ArtifactTable).get())?.value).toBe(0)
          expect(yield* Effect.promise(() => Promise.all(roots.map((root) => Bun.file(root).exists())))).toEqual([
            false,
            false,
            false,
            false,
            false,
          ])
        }),
    )
  })

  it.live("redacts real artifact-store and staging paths from model-visible output", () => {
    const leaked: string[] = []
    return withTool(
      (runID, request) => {
        const artifactRoot = path.dirname(path.dirname(request.cwd))
        leaked.push(request.cwd, artifactRoot)
        return Effect.succeed(
          workerResult(runID, {
            stdout: `staging=${request.cwd}\nstore=${artifactRoot}`,
            stderr: `portable=${String(request.cwd).replaceAll("\\", "/")}`,
            violations: [{ kind: "filesystem-read", operation: "open", target: request.cwd }],
          }),
        )
      },
      (fixture) =>
        Effect.gen(function* () {
          const result = yield* fixture.tool.execute({ command: "print real paths" }, ctx(fixture))
          expect(result.output).toContain("[artifact-staging]")
          expect(result.output).toContain("[artifact-store]")
          expect(leaked.every((absolute) => !result.output.includes(absolute))).toBe(true)
          expect(JSON.stringify(result.metadata)).not.toContain(fixture.data)
          expect(result.metadata.violations[0]?.target).toBe("[artifact-staging]")
        }),
    )
  })

  it.live("abandons staging after a worker failure", () => {
    const roots: string[] = []
    return withTool(
      (runID, request) => {
        roots.push(request.cwd)
        return Effect.succeed(decodeResponse({ protocolVersion: 1, type: "failure", runID, code: "execution-failed" }))
      },
      (fixture) =>
        Effect.gen(function* () {
          const exit = yield* fixture.tool
            .execute({ command: "worker failure", outputs: [outputPath("result.txt")] }, ctx(fixture))
            .pipe(Effect.exit)
          expect(Exit.isFailure(exit)).toBe(true)
          expect(roots).toHaveLength(1)
          expect(yield* Effect.promise(() => Bun.file(roots[0]).exists())).toBe(false)
          expect((yield* fixture.db.select({ value: count() }).from(ArtifactTable).get())?.value).toBe(0)
        }),
    )
  })

  it.live("keeps a completed result when staging cleanup fails", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        const abandoned: SandboxProtocol.RunID[] = []
        const layer = Layer.mergeAll(
          Layer.mock(ArtifactStore.Service, {
            stage: (runID) =>
              Effect.promise(async () => {
                const root = path.join(tmp.path, runID)
                await mkdir(path.join(root, "work"), { recursive: true })
                await mkdir(path.join(root, "artifacts"), { recursive: true })
                return { runID, root, work: path.join(root, "work"), artifacts: path.join(root, "artifacts") }
              }),
            abandon: (runID) =>
              Effect.sync(() => abandoned.push(runID)).pipe(
                Effect.andThen(Effect.fail(new ArtifactStore.AbandonmentError({ runID }))),
              ),
          }),
          Layer.mock(SandboxRuntime.Service, { execute: (runID) => Effect.succeed(workerResult(runID)) }),
          RuntimeFlags.layer({ agentExecution: "sandbox" }),
          Layer.mock(Agent.Service, { get: () => Effect.succeed(agent) }),
          Layer.mock(Truncate.Service, {
            output: (text) => Effect.succeed({ content: text, truncated: false as const }),
          }),
          testInstanceStoreLayer,
        )
        return Effect.gen(function* () {
          const info = yield* SandboxExecuteTool
          const result = yield* (yield* info.init()).execute(
            { command: "completed despite cleanup" },
            {
              sessionID: SessionID.make("ses_cleanup"),
              messageID: MessageID.make("msg_cleanup"),
              agent: agent.name,
              abort: AbortSignal.any([]),
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )
          expect(result.output).toBe("stdout:\ncompleted")
          expect(abandoned).toHaveLength(1)
        }).pipe(provideInstance(tmp.path), Effect.provide(layer))
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
