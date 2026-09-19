import { describe, expect, test } from "bun:test"
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { spawn } from "node:child_process"
import { createConnection } from "node:net"
import path from "node:path"
import { ArtifactStore } from "@koala-ai/core/artifact/store"
import { SandboxProtocol } from "@koala-ai/core/sandbox/protocol"
import { Engine, Input } from "@koala-ai/core/sandbox/test-tool"
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
import {
  encodeDiagnosticCommand,
  makeSandboxTestTool,
  type PreparationBoundary,
  SandboxTestTool,
} from "@/tool/sandbox-test"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { provideInstance, testInstanceStoreLayer, tmpdir } from "../fixture/fixture"
import { it } from "../lib/effect"

const decodeResponse = Schema.decodeUnknownSync(SandboxProtocol.WorkerResponse)
const Config = Schema.Struct({
  nonce: Schema.String,
  stagingRead: Schema.String,
  stagingWrite: Schema.String,
  projectRead: Schema.String,
  projectWrite: Schema.String,
  externalRead: Schema.String,
  externalWrite: Schema.String,
  report: Schema.String,
  host: Schema.String,
  port: Schema.Int,
})
const CancellationConfig = Schema.Struct({ nonce: Schema.String, readiness: Schema.String })
const agent: Agent.Info = { name: "build", mode: "primary", permission: [], options: {} }

type Definition = Omit<Tool.InferDef<typeof SandboxTestTool>, "id">
type Fixture = {
  readonly data: string
  readonly sessionID: SessionID
  readonly messageID: MessageID
  readonly tool: Definition
  readonly db: Context.Service.Shape<typeof Database.Service>["db"]
}

const available = decodeResponse({
  protocolVersion: 1,
  type: "availability",
  availability: { status: "available" },
})

const unavailable = (reason: SandboxProtocol.UnavailabilityReason) =>
  decodeResponse({ protocolVersion: 1, type: "availability", availability: { status: "unavailable", reason } })

const workerResult = (runID: SandboxProtocol.RunID, result: Partial<SandboxProtocol.ExecutionResult> = {}) =>
  decodeResponse({
    protocolVersion: 1,
    type: "result",
    runID,
    result: {
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
      cancelled: false,
      outputTruncated: false,
      violations: [],
      ...result,
    },
  })

const runtimeLayer = (runtime: SandboxRuntime.Interface) =>
  Layer.succeed(SandboxRuntime.Service, SandboxRuntime.Service.of(runtime))

const withTool = <A, E>(
  runtime: SandboxRuntime.Interface,
  body: (fixture: Fixture) => Effect.Effect<A, E>,
  definition = SandboxTestTool,
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => {
      const services = LayerNode.compile(
        LayerNode.group([ArtifactStoreLive.node, IndustrialAuditLive.node, IndustrialExecution.node, Database.node]),
        [
          [Global.node, Global.layerWith({ data: tmp.path, state: tmp.path })],
          [Database.node, Database.layerFromPath(path.join(tmp.path, "sandbox-test.db"))],
        ],
      )
      const layer = Layer.mergeAll(
        services,
        runtimeLayer(runtime),
        RuntimeFlags.layer({ agentExecution: "sandbox" }),
        Layer.mock(Agent.Service, { get: () => Effect.succeed(agent) }),
        Layer.mock(Truncate.Service, {
          output: (text) => Effect.succeed({ content: text, truncated: false as const }),
        }),
        testInstanceStoreLayer,
      )
      return Effect.gen(function* () {
        const { db } = yield* Database.Service
        const sessionID = SessionID.make("ses_sandbox_test")
        const messageID = MessageID.make("msg_sandbox_test")
        const now = Date.now()
        yield* db
          .insert(SessionTable)
          .values({
            id: sessionID,
            project_id: ProjectV2.ID.global,
            slug: sessionID,
            directory: AbsolutePath.make(tmp.path),
            title: "sandbox test diagnostics",
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
        return yield* body({ data: tmp.path, sessionID, messageID, tool: yield* info.init(), db })
      }).pipe(provideInstance(tmp.path), Effect.provide(layer))
    },
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

const context = (
  fixture: Fixture,
  ask: Tool.Context["ask"] = () => Effect.void,
  abort = AbortSignal.any([]),
): Tool.Context => ({
  sessionID: fixture.sessionID,
  messageID: fixture.messageID,
  callID: "call-sandbox-test",
  agent: agent.name,
  abort,
  messages: [],
  metadata: () => Effect.void,
  ask,
})

const readConfig = async (cwd: string) =>
  Schema.decodeUnknownSync(Config)(JSON.parse(await readFile(path.join(cwd, "work", "sandbox-test", "policy.json"), "utf8")))

const readCancellationConfig = async (cwd: string) =>
  Schema.decodeUnknownSync(CancellationConfig)(
    JSON.parse(await readFile(path.join(cwd, "work", "sandbox-test", "cancellation.json"), "utf8")),
  )

const successfulRuntime = (observed: {
  requests: SandboxProtocol.ExecutionRequest[]
  configs: Array<typeof Config.Type>
}): SandboxRuntime.Interface => {
  let executions = 0
  return {
    availability: () => Effect.succeed(available),
    execute: (runID, request, options) => {
      observed.requests.push(request)
      executions++
      if (executions === 1) {
        return Effect.promise(async () => {
          const config = await readConfig(request.cwd)
          observed.configs.push(config)
          await writeFile(config.stagingWrite, config.nonce, { flag: "wx" })
          await writeFile(
            config.report,
            JSON.stringify({
              stagingRead: true,
              stagingWrite: true,
              projectRead: false,
              projectWrite: false,
              externalRead: false,
              externalWrite: false,
              loopbackTcp: false,
            }),
            { flag: "wx" },
          )
          return workerResult(runID)
        })
      }
      return Effect.promise(async () => {
        const config = await readCancellationConfig(request.cwd)
        await writeFile(config.readiness, config.nonce, { flag: "wx" })
        await new Promise<void>((resolve) => {
          if (options?.signal?.aborted) return resolve()
          options?.signal?.addEventListener("abort", () => resolve(), { once: true })
        })
        return workerResult(runID, { exitCode: null, cancelled: true })
      })
    },
  }
}

describe("tool.sandbox_test", () => {
  test("encodes diagnostic commands without exposing Windows shell metacharacters", () => {
    const values = [
      `C:\\Program Files\\%PATH% & caret^ (group)\\runner.exe`,
      `C:\\probe\\space & caret^ (group)\\script.mjs`,
      `/tmp/single' double\" percent% amp& caret^ (group) trailing\\`,
    ]
    const windows = encodeDiagnosticCommand("win32", values[0] ?? "", values[1] ?? "", values.slice(2))
    const encodedScript = windows.command.split(" ").at(-1)
    if (!encodedScript) throw new Error("missing encoded PowerShell command")
    const script = Buffer.from(encodedScript, "base64").toString("utf16le")

    expect(windows.command).toMatch(
      /^powershell\.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/,
    )
    expect(script).toContain(Buffer.from(values[0] ?? "", "utf8").toString("base64"))
    expect(script).toContain(Buffer.from(values[1] ?? "", "utf8").toString("base64"))
    expect(
      JSON.parse(Buffer.from(windows.env.KOALA_SANDBOX_TEST_ARGUMENTS ?? "", "base64").toString("utf8")),
    ).toEqual(values.slice(2))
    for (const value of values) {
      expect(windows.command).not.toContain(value)
      expect(windows.env.KOALA_SANDBOX_TEST_ARGUMENTS).not.toContain(value)
    }
    expect(encodeDiagnosticCommand("linux", values[0] ?? "", values[1] ?? "", values.slice(2))).toEqual(
      {
        command: `'${values[0]?.replaceAll("'", "'\\''")}' '${values[1]?.replaceAll("'", "'\\''")}'`,
        env: windows.env,
      },
    )
  })

  test.skipIf(process.platform !== "win32")(
    "preserves special arguments through the real Windows command parser",
    async () => {
      await using tmp = await tmpdir()
      const directory = path.join(tmp.path, "%PATH% space & caret^ (group)")
      const script = path.join(directory, "capture args.mjs")
      const output = path.join(directory, "result.json")
      const executable = path.join(directory, "runner & caret^.exe")
      const values = ["%PATH%", "space value", "amp&value", "caret^value", "(parentheses)", 'quote"value', "trailing\\"]
      await mkdir(directory)
      await copyFile(path.join(process.env.SYSTEMROOT ?? "C:\\Windows", "System32", "where.exe"), executable)
      await writeFile(
        script,
        'const [output, ...values] = JSON.parse(Buffer.from(process.env.KOALA_SANDBOX_TEST_ARGUMENTS ?? "", "base64").toString("utf8")); await Bun.write(output, JSON.stringify(values))\n',
      )

      const executableCommand = encodeDiagnosticCommand("win32", executable, "cmd.exe", [])
      const executableResult = await runCommand(
        process.env.COMSPEC ?? "cmd.exe",
        ["/d", "/s", "/c", executableCommand.command],
        { ...process.env, ...executableCommand.env },
      )
      const command = encodeDiagnosticCommand("win32", process.execPath, script, [output, ...values])
      const result = await runCommand(process.env.COMSPEC ?? "cmd.exe", ["/d", "/s", "/c", command.command], {
        ...process.env,
        ...command.env,
      })

      if (executableResult.code !== 0) throw new Error(`Encoded executable failed: ${executableResult.stderr}`)
      expect(executableResult.stdout.toLowerCase()).toContain("cmd.exe")
      if (result.code !== 0) throw new Error(`Encoded command failed: ${result.stderr}`)
      expect(result.code).toBe(0)
      expect(result.stdout).toBe("")
      expect(JSON.parse(await readFile(output, "utf8"))).toEqual(values)
    },
  )

  test("exposes a strictly empty shared parameter contract", () => {
    expect(Result.isSuccess(Schema.decodeUnknownResult(Input)({}))).toBe(true)
    expect(Result.isFailure(Schema.decodeUnknownResult(Input)({ timeout: 1 }))).toBe(true)
  })

  it.live("returns normal diagnostics without executing when the runtime is unavailable", () => {
    let executions = 0
    return withTool(
      {
        availability: () => Effect.succeed(unavailable("initialization-failed")),
        execute: () => {
          executions++
          return Effect.die(new Error("execute must not be called"))
        },
      },
      (fixture) =>
        Effect.gen(function* () {
          const requested: unknown[] = []
          const result = yield* fixture.tool.execute(
            {},
            context(fixture, (request) => Effect.sync(() => requested.push(request))),
          )

          expect(executions).toBe(0)
          expect(requested).toEqual([
            {
              permission: "sandbox_execute",
              patterns: ["sandbox_test"],
              always: ["sandbox_test"],
              metadata: { token: "sandbox_test" },
            },
          ])
          expect(result.metadata.result).toMatchObject({
            status: "success",
            data: {
              healthy: false,
              probes: {
                runtimeAvailability: { passed: false, reason: "initialization-failed" },
                stagingRead: { passed: false, reason: "not-run" },
                cancellation: { passed: false, reason: "not-run" },
                cleanup: { passed: false, reason: "not-run" },
              },
            },
          })
          expect(result.metadata.result.outputs).toEqual([])
          expect(yield* fixture.db.select().from(ToolAuditTable).get()).toMatchObject({
            state: "completed",
            outcome_code: "success",
            tool_name: "sandbox_test",
            permission_class: "sandbox_execute",
            input_summary: { sourceCount: 0, artifactCount: 0, pathCount: 0, declaredOutputCount: 0 },
          })
        }),
    )
  })

  it.live("runs fixed policy and readiness-driven cancellation probes and cleans every host resource", () => {
    const observed = { requests: [] as SandboxProtocol.ExecutionRequest[], configs: [] as Array<typeof Config.Type> }
    return withTool(successfulRuntime(observed), (fixture) =>
      Effect.gen(function* () {
        const result = yield* fixture.tool.execute({}, context(fixture))
        const config = observed.configs[0]
        if (!config) return yield* Effect.die(new Error("missing policy config"))

        expect(result.metadata.result).toMatchObject({
          status: "success",
          engine: Engine,
          sources: [],
          outputs: [],
          citations: [],
          data: { healthy: true },
        })
        if (result.metadata.result.status !== "success") return yield* Effect.die(new Error("expected diagnostics"))
        expect(Object.values(result.metadata.result.data.probes)).toEqual(
          Array.from({ length: 10 }, () => ({ passed: true, reason: "passed" })),
        )
        expect(observed.requests).toHaveLength(2)
        expect(observed.requests.every((request) => request.network.length === 0)).toBe(true)
        expect(observed.requests.every((request) => request.readRoots.length === 1)).toBe(true)
        expect(observed.requests.every((request) => request.writeRoots.length === 1)).toBe(true)
        expect(observed.requests.every((request) => request.readRoots[0] === request.cwd)).toBe(true)
        expect(observed.requests.every((request) => request.writeRoots[0] === path.join(request.cwd, "work"))).toBe(
          true,
        )
        for (const request of observed.requests) {
          expect(request.env.ELECTRON_RUN_AS_NODE).toBe("1")
          expect(Object.keys(request.env).sort()).toEqual(["ELECTRON_RUN_AS_NODE", "KOALA_SANDBOX_TEST_ARGUMENTS"])
          const args = Schema.decodeUnknownSync(Schema.Array(Schema.String))(
            JSON.parse(Buffer.from(request.env.KOALA_SANDBOX_TEST_ARGUMENTS ?? "", "base64").toString("utf8")),
          )
          expect(args).toHaveLength(1)
          expect(request.command).not.toContain(request.cwd)
          expect(request.command).not.toContain(args[0])
        }
        expect(yield* Effect.promise(() => pathAbsent(observed.requests[0]?.cwd ?? ""))).toBe(true)
        expect(path.dirname(config.projectRead)).toBe(path.dirname(config.projectWrite))
        expect(path.basename(path.dirname(config.projectRead))).toMatch(/^\.koala-sandbox-test-/)
        expect(yield* Effect.promise(() => pathAbsent(config.projectRead))).toBe(true)
        expect(yield* Effect.promise(() => pathAbsent(config.projectWrite))).toBe(true)
        expect(yield* Effect.promise(() => pathAbsent(path.dirname(config.externalRead)))).toBe(true)
        expect((yield* fixture.db.select({ value: count() }).from(ArtifactTable).get())?.value).toBe(0)

        const serialized = JSON.stringify(result)
        expect(serialized).not.toContain(config.nonce)
        expect(serialized).not.toContain(config.projectRead)
        expect(serialized).not.toContain(config.externalRead)
        expect(result.output).toContain("loopbackTcpDenied=passed")
        const audit = yield* fixture.db.select().from(ToolAuditTable).get()
        expect(audit).toMatchObject({
          state: "completed",
          outcome_code: "success",
          engine_name: "anthropic-sandbox-runtime",
          engine_version: "0.0.76",
          source_artifact_ids: [],
          output_artifact_ids: [],
        })
        expect(JSON.stringify(audit)).not.toContain(config.nonce)
        expect(JSON.stringify(audit)).not.toContain(config.projectRead)
        expect(JSON.stringify(audit)).not.toContain(config.externalRead)
      }),
    )
  })

  it.live("fails denied-access outcomes when host verification observes writes and a loopback connection", () => {
    let executions = 0
    return withTool(
      {
        availability: () => Effect.succeed(available),
        execute: (runID, request, options) => {
          executions++
          if (executions === 1) {
            return Effect.promise(async () => {
              const config = await readConfig(request.cwd)
              await writeFile(config.stagingWrite, config.nonce, { flag: "wx" })
              await writeFile(config.projectWrite, config.nonce, { flag: "wx" })
              await writeFile(config.externalWrite, config.nonce, { flag: "wx" })
              await new Promise<void>((resolve, reject) => {
                const socket = createConnection({ host: config.host, port: config.port })
                socket.once("connect", () => {
                  socket.destroy()
                  resolve()
                })
                socket.once("error", reject)
              })
              await writeFile(
                config.report,
                JSON.stringify({
                  stagingRead: true,
                  stagingWrite: true,
                  projectRead: true,
                  projectWrite: true,
                  externalRead: true,
                  externalWrite: true,
                  loopbackTcp: true,
                }),
                { flag: "wx" },
              )
              return workerResult(runID)
            })
          }
          return Effect.promise(async () => {
            const config = await readCancellationConfig(request.cwd)
            await writeFile(config.readiness, config.nonce, { flag: "wx" })
            await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve(), { once: true }))
            return workerResult(runID, { exitCode: null, cancelled: true })
          })
        },
      },
      (fixture) =>
        Effect.gen(function* () {
          const result = yield* fixture.tool.execute({}, context(fixture))
          expect(result.metadata.result).toMatchObject({
            status: "success",
            data: {
              healthy: false,
              probes: {
                projectReadDenied: { passed: false, reason: "project-read-allowed" },
                projectWriteDenied: { passed: false, reason: "project-write-allowed" },
                externalReadDenied: { passed: false, reason: "external-read-allowed" },
                externalWriteDenied: { passed: false, reason: "external-write-allowed" },
                loopbackTcpDenied: { passed: false, reason: "loopback-tcp-allowed" },
                cleanup: { passed: true, reason: "passed" },
              },
            },
          })
        }),
    )
  })

  it.live("reports a failed cancellation probe without fabricating a pass", () => {
    const observed = { requests: [] as SandboxProtocol.ExecutionRequest[], configs: [] as Array<typeof Config.Type> }
    const base = successfulRuntime(observed)
    let executions = 0
    return withTool(
      {
        availability: base.availability,
        execute: (runID, request, options) => {
          executions++
          if (executions === 1) return base.execute(runID, request, options)
          return Effect.promise(async () => {
            const config = await readCancellationConfig(request.cwd)
            await writeFile(config.readiness, config.nonce, { flag: "wx" })
            await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve(), { once: true }))
            return workerResult(runID, { exitCode: null, timedOut: true })
          })
        },
      },
      (fixture) =>
        Effect.gen(function* () {
          const result = yield* fixture.tool.execute({}, context(fixture))
          expect(result.metadata.result).toMatchObject({
            status: "success",
            data: {
              healthy: false,
              probes: { cancellation: { passed: false, reason: "cancellation-timed-out" } },
            },
          })
        }),
    )
  })

  for (const boundary of ["staging", "project", "external", "listener"] as const) {
    it.live(`cleans resources when interrupted at the ${boundary} acquisition boundary`, () => {
      const abort = new AbortController()
      const acquired: Array<{ boundary: PreparationBoundary; path?: string; port?: number }> = []
      let release: (() => void) | undefined
      let markContinued: (() => void) | undefined
      const continued = new Promise<void>((resolve) => {
        markContinued = resolve
      })
      let executions = 0
      const definition = makeSandboxTestTool({
        cancellationGraceMs: 0,
        onPreparationBoundary: (event) => {
          acquired.push(event)
          if (event.boundary !== boundary) return Promise.resolve()
          abort.abort()
          return new Promise<void>((resolve) => {
            release = resolve
          }).finally(() => markContinued?.())
        },
      })

      return withTool(
        {
          availability: () => Effect.succeed(available),
          execute: () => {
            executions++
            return Effect.die(new Error("execute must not be called during preparation"))
          },
        },
        (fixture) =>
          Effect.gen(function* () {
            const result = yield* fixture.tool.execute({}, context(fixture, undefined, abort.signal))
            expect(result.metadata.result).toMatchObject({
              status: "error",
              cancelled: true,
              timedOut: false,
              error: { code: "cancelled" },
            })
            expect(executions).toBe(0)

            const paths = acquired.flatMap((event) => (event.path ? [event.path] : []))
            expect(
              yield* Effect.promise(async () => (await Promise.all(paths.map(pathAbsent))).every(Boolean)),
            ).toBe(true)
            const listener = acquired.find((event) => event.boundary === "listener")
            if (listener?.port) {
              expect(yield* Effect.promise(() => connectionRejected(listener.port ?? 0))).toBe(true)
            }

            release?.()
            yield* Effect.promise(() => continued)
            expect(
              yield* Effect.promise(async () => (await Promise.all(paths.map(pathAbsent))).every(Boolean)),
            ).toBe(true)
          }),
        definition,
      )
    })
  }

  test.skipIf(process.env.KOALA_RUN_NATIVE_SANDBOX_TEST !== "1")(
    "passes the native sandbox diagnostic suite when explicitly capability-enabled",
    async () => {
      const runtime = SandboxRuntime.create()
      await Effect.runPromise(
        withTool(
          {
            availability: (options) => Effect.promise(() => runtime.availability(options)),
            execute: (runID, request, options) => Effect.promise(() => runtime.execute(runID, request, options)),
          },
          (fixture) =>
            Effect.gen(function* () {
              const result = yield* fixture.tool.execute({}, context(fixture))
              expect(result.metadata.result).toMatchObject({ status: "success", data: { healthy: true } })
            }),
        ),
      )
    },
    30_000,
  )
})

async function pathAbsent(filepath: string) {
  return await stat(filepath).then(
    () => false,
    (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT",
  )
}

async function connectionRejected(port: number) {
  return await new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port })
    socket.once("connect", () => {
      socket.destroy()
      resolve(false)
    })
    socket.once("error", () => resolve(true))
  })
}

async function runCommand(executable: string, args: string[], env: NodeJS.ProcessEnv) {
  return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(executable, args, { env, shell: false, windowsHide: true })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk))
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk))
    child.once("error", reject)
    child.once("close", (code) =>
      resolve({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }),
    )
  })
}
