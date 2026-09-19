import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:net"
import os from "node:os"
import path from "node:path"
import { ArtifactStore } from "@koala-ai/core/artifact/store"
import { IndustrialProjection } from "@koala-ai/core/industrial/projection"
import { IndustrialResult } from "@koala-ai/core/industrial/result"
import { SandboxPolicy } from "@koala-ai/core/sandbox/policy"
import { SandboxProtocol } from "@koala-ai/core/sandbox/protocol"
import {
  Data,
  Engine,
  type FailureReason,
  Input,
  type Outcome,
  type Probes,
  Result,
  safeSummary,
  summarize,
} from "@koala-ai/core/sandbox/test-tool"
import { Effect, Exit, Fiber, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { IndustrialExecution } from "@/koala/industrial-execution"
import { SandboxRuntime } from "@/sandbox/runtime"
import { Tool } from "./tool"

const PolicyTimeoutMs = 10_000
const CancellationTimeoutMs = 15_000
const ReadinessTimeoutMs = 5_000
const PollIntervalMs = 10
const MaxOutputBytes = 4 * 1024
const MaxReportBytes = 4 * 1024

const PolicyReport = Schema.Struct({
  stagingRead: Schema.Boolean,
  stagingWrite: Schema.Boolean,
  projectRead: Schema.Boolean,
  projectWrite: Schema.Boolean,
  externalRead: Schema.Boolean,
  externalWrite: Schema.Boolean,
  loopbackTcp: Schema.Boolean,
})

type Metadata = {
  readonly result: Result
  readonly projection: IndustrialProjection.Output
  readonly truncated: boolean
}

type ResourceState = {
  staging?: ArtifactStore.Staging
  externalRoot?: string
  projectRoot?: string
  listener?: { server: Server; connected: boolean }
  controllers: AbortController[]
}

export type PreparationBoundary = "staging" | "project" | "external" | "listener"

export interface SandboxTestOptions {
  readonly cancellationGraceMs?: number
  readonly onPreparationBoundary?: (event: {
    readonly boundary: PreparationBoundary
    readonly path?: string
    readonly port?: number
  }) => Promise<void>
}

type ProbeSetup = {
  readonly nonce: string
  readonly policyReport: string
  readonly readiness: string
  readonly stagingRead: string
  readonly projectRead: string
  readonly projectWrite: string
  readonly externalRead: string
  readonly externalWrite: string
  readonly policyCommand: DiagnosticCommand
  readonly cancellationCommand: DiagnosticCommand
}

export interface DiagnosticCommand {
  readonly command: string
  readonly env: SandboxProtocol.Environment
}

export const Parameters = Input

export function makeSandboxTestTool(options: SandboxTestOptions = {}) {
  return Tool.define<
    typeof Input,
    Metadata,
    RuntimeFlags.Service | ArtifactStore.Service | SandboxRuntime.Service | IndustrialExecution.Service
  >(
    "sandbox_test",
    Effect.gen(function* () {
      const flags = yield* RuntimeFlags.Service
      const artifacts = yield* ArtifactStore.Service
      const runtime = yield* SandboxRuntime.Service
      const execution = yield* IndustrialExecution.Service

      return {
        description:
          "Run fixed host-defined diagnostics for native sandbox availability, filesystem isolation, loopback network denial, cancellation, and cleanup. This tool accepts no options and publishes no artifacts.",
        parameters: Input,
        execute: (params, context) => {
          const runID = Schema.decodeUnknownSync(SandboxProtocol.RunID)(randomUUID())
          const makeError = (code: IndustrialResult.ErrorCode): Result => {
            const common = {
              tool: "sandbox_test" as const,
              contractVersion: 1 as const,
              engine: Engine,
              status: "error" as const,
              sources: [],
              outputs: [],
              citations: [],
              producerTruncated: false,
              sandboxRunID: runID,
              summary: `Sandbox diagnostics failed: ${code}`,
            }
            if (code === "cancelled") {
              return { ...common, cancelled: true, timedOut: false, error: { code, retryable: true } }
            }
            if (code === "deadline-exceeded") {
              return { ...common, cancelled: false, timedOut: true, error: { code, retryable: true } }
            }
            return { ...common, cancelled: false, timedOut: false, error: { code, retryable: retryable(code) } }
          }

          return execution
            .execute({
              tool: "sandbox_test",
              permission: "sandbox_execute",
              engine: Engine,
              input: params,
              inputSchema: Input,
              inputSummary: summarize(),
              sourceArtifactIDs: [],
              resultSchema: Result,
              context,
              permissionRequest: {
                patterns: ["sandbox_test"],
                always: ["sandbox_test"],
                metadata: { token: "sandbox_test" },
              },
              cancellationGraceMs: options.cancellationGraceMs,
              sandboxRunID: runID,
              operation: (signal) => {
                if (flags.agentExecution !== "sandbox" && flags.agentExecution !== "both") {
                  return Effect.succeed(makeError("engine-unavailable"))
                }
                return runDiagnostics(artifacts, runtime, runID, signal, options)
              },
              mapError: () => "internal-error",
              makeError,
            })
            .pipe(
              Effect.map((output) => ({
                title: "Sandbox diagnostics",
                output: output.projection.text,
                metadata: {
                  result: output.result,
                  projection: output.projection,
                  truncated: output.result.producerTruncated || output.projection.truncated,
                },
              })),
              Effect.scoped,
              Effect.orDie,
            )
        },
      }
    }),
  )
}

export const SandboxTestTool = makeSandboxTestTool()

function runDiagnostics(
  artifacts: ArtifactStore.Interface,
  runtime: SandboxRuntime.Interface,
  runID: SandboxProtocol.RunID,
  signal: AbortSignal,
  options: SandboxTestOptions,
) {
  return Effect.gen(function* () {
    const availability = availabilityOutcome(yield* runtime.availability({ signal }))
    if (!availability.passed) return success(runID, unavailableProbes(availability))

    const state: ResourceState = { controllers: [] }
    const staged = yield* Effect.acquireRelease(
      artifacts.stage(runID),
      () => artifacts.abandon(runID).pipe(Effect.ignore),
    ).pipe(
      Effect.map((staging) => ({ ok: true as const, staging })),
      Effect.catch(() => Effect.succeed({ ok: false as const })),
    )
    if (!staged.ok) return success(runID, unavailableProbes(availability, "staging-failed"))

    state.staging = staged.staging
    yield* preparationBoundary(options, { boundary: "staging", path: staged.staging.root })
    yield* Effect.addFinalizer(() =>
      cleanup(artifacts, runID, state).pipe(
        Effect.tap((clean) => (clean ? Effect.void : Effect.logWarning("sandbox_test finalizer cleanup failed"))),
        Effect.ignore,
      ),
    )
    if (signal.aborted) {
      const clean = yield* cleanup(artifacts, runID, state)
      return success(runID, unavailableProbes(availability, clean ? "setup-failed" : "cleanup-failed", clean))
    }

    const instance = yield* InstanceState.context
    const setup = yield* prepare(state, staged.staging, instance.directory, options, signal)
    if (!setup) {
      const clean = yield* cleanup(artifacts, runID, state)
      return success(runID, unavailableProbes(availability, clean ? "setup-failed" : "cleanup-failed", clean))
    }

    const policy = yield* runPolicy(runtime, staged.staging, setup, state, signal)
    const cancellation = yield* runCancellation(runtime, staged.staging, setup, signal, state)
    const clean = yield* cleanup(artifacts, runID, state)
    return success(runID, {
      runtimeAvailability: availability,
      ...policy,
      cancellation,
      cleanup: clean ? passed() : failed("cleanup-failed"),
    })
  })
}

function prepare(
  state: ResourceState,
  staging: ArtifactStore.Staging,
  project: string,
  options: SandboxTestOptions,
  signal: AbortSignal,
) {
  return Effect.gen(function* () {
    const nonce = randomUUID()
    const projectRoot = yield* acquireDirectory(path.join(project, `.koala-sandbox-test-${randomUUID()}`))
    state.projectRoot = projectRoot
    yield* preparationBoundary(options, { boundary: "project", path: projectRoot })
    if (signal.aborted) return undefined

    const externalRoot = yield* Effect.acquireRelease(
      Effect.tryPromise(() => mkdtemp(path.join(os.tmpdir(), "koala-sandbox-test-"))),
      removeOwnedDirectory,
    )
    state.externalRoot = externalRoot
    yield* preparationBoundary(options, { boundary: "external", path: externalRoot })
    if (signal.aborted) return undefined

    const listener = yield* Effect.acquireRelease(Effect.promise(openListener), (owned) =>
      closeListener(owned.server).pipe(Effect.ignore),
    )
    state.listener = listener
    const address = listener.server.address()
    if (typeof address !== "object" || address === null) return undefined
    yield* preparationBoundary(options, { boundary: "listener", port: address.port })
    if (signal.aborted) return undefined

    const scripts = yield* acquireDirectory(path.join(staging.work, "sandbox-test"))
    const policyScript = path.join(scripts, "policy.mjs")
    const cancellationScript = path.join(scripts, "cancellation.mjs")
    const policyConfig = path.join(scripts, "policy.json")
    const cancellationConfig = path.join(scripts, "cancellation.json")
    const policyReport = path.join(staging.work, "policy-report.json")
    const readiness = path.join(staging.work, "cancellation-ready")
    const stagingRead = path.join(staging.work, "staging-read-canary")
    const stagingWrite = path.join(staging.work, "staging-write-canary")
    const projectRead = path.join(projectRoot, "read-canary")
    const projectWrite = path.join(projectRoot, "write-canary")
    const externalRead = path.join(externalRoot, "read-canary")
    const externalWrite = path.join(externalRoot, "write-canary")
    yield* acquireFile(projectRead, nonce)
    yield* acquireFile(externalRead, nonce)
    yield* acquireFile(stagingRead, nonce)
    yield* acquireFile(policyScript, policyScriptSource)
    yield* acquireFile(cancellationScript, cancellationScriptSource)
    yield* acquireFile(
      policyConfig,
      JSON.stringify({
        nonce,
        stagingRead,
        stagingWrite,
        projectRead,
        projectWrite,
        externalRead,
        externalWrite,
        report: policyReport,
        host: "127.0.0.1",
        port: address.port,
      }),
    )
    yield* acquireFile(cancellationConfig, JSON.stringify({ nonce, readiness }))

    return {
      nonce,
      policyReport,
      readiness,
      stagingRead,
      projectRead,
      projectWrite,
      externalRead,
      externalWrite,
      policyCommand: encodeDiagnosticCommand(process.platform, process.execPath, policyScript, [policyConfig]),
      cancellationCommand: encodeDiagnosticCommand(process.platform, process.execPath, cancellationScript, [
        cancellationConfig,
      ]),
    } satisfies ProbeSetup
  }).pipe(Effect.catch(() => Effect.succeed(undefined)))
}

function runPolicy(
  runtime: SandboxRuntime.Interface,
  staging: ArtifactStore.Staging,
  setup: ProbeSetup,
  state: ResourceState,
  signal: AbortSignal,
) {
  return Effect.gen(function* () {
    const response = yield* runtime.execute(
      staging.runID,
      SandboxPolicy.buildRequest(
        { cwd: staging.root, readRoots: [staging.root], writeRoots: [staging.work] },
        setup.policyCommand.command,
        { timeoutMs: PolicyTimeoutMs, maxOutputBytes: MaxOutputBytes, env: setup.policyCommand.env },
      ),
      { signal },
    )
    const failure = executionFailure(response)
    if (failure) return failedPolicy(failure)

    const report = yield* readReport(setup.policyReport)
    if (!report) return failedPolicy("probe-result-invalid")
    const verified = yield* verifyPolicy(setup, state)
    return {
      stagingRead: report.stagingRead && verified.stagingRead ? passed() : failed("staging-read-failed"),
      stagingWrite: report.stagingWrite && verified.stagingWrite ? passed() : failed("staging-write-failed"),
      projectReadDenied: !report.projectRead && verified.projectRead ? passed() : failed("project-read-allowed"),
      projectWriteDenied:
        !report.projectWrite && verified.projectWrite ? passed() : failed("project-write-allowed"),
      externalReadDenied: !report.externalRead && verified.externalRead ? passed() : failed("external-read-allowed"),
      externalWriteDenied:
        !report.externalWrite && verified.externalWrite ? passed() : failed("external-write-allowed"),
      loopbackTcpDenied:
        !report.loopbackTcp && state.listener !== undefined && !state.listener.connected
          ? passed()
          : failed("loopback-tcp-allowed"),
    }
  })
}

function runCancellation(
  runtime: SandboxRuntime.Interface,
  staging: ArtifactStore.Staging,
  setup: ProbeSetup,
  signal: AbortSignal,
  state: ResourceState,
) {
  return Effect.gen(function* () {
    const local = new AbortController()
    state.controllers.push(local)
    const running = yield* runtime
      .execute(
        staging.runID,
        SandboxPolicy.buildRequest(
          { cwd: staging.root, readRoots: [staging.root], writeRoots: [staging.work] },
          setup.cancellationCommand.command,
          {
            timeoutMs: CancellationTimeoutMs,
            maxOutputBytes: MaxOutputBytes,
            env: setup.cancellationCommand.env,
          },
        ),
        { signal: AbortSignal.any([signal, local.signal]) },
      )
      .pipe(Effect.forkChild)
    const first = yield* Effect.raceFirst(
      pollReadiness(setup.readiness, setup.nonce, signal).pipe(
        Effect.map((ready) => ({ type: "readiness" as const, ready })),
      ),
      Fiber.await(running).pipe(Effect.map((exit) => ({ type: "response" as const, exit }))),
    )
    if (first.type === "response") {
      if (Exit.isFailure(first.exit)) return failed("cancellation-not-observed")
      return cancellationOutcome(first.exit.value, false)
    }
    local.abort("sandbox_test")
    const response = yield* Fiber.join(running)
    if (!first.ready) return failed("readiness-timeout")
    return cancellationOutcome(response, true)
  })
}

function availabilityOutcome(response: SandboxProtocol.WorkerResponse): Outcome {
  if (response.type === "availability") {
    if (response.availability.status === "available") return passed()
    return failed(response.availability.reason)
  }
  if (response.type === "failure") {
    if (response.code === "sandbox-unavailable") return failed("sandbox-unavailable")
    if (response.code === "protocol-mismatch" || response.code === "invalid-request") return failed("protocol-error")
    return failed("worker-failed")
  }
  return failed("protocol-error")
}

function executionFailure(response: SandboxProtocol.WorkerResponse): FailureReason | undefined {
  if (response.type === "failure") {
    if (response.code === "sandbox-unavailable") return "sandbox-unavailable"
    if (response.code === "protocol-mismatch" || response.code === "invalid-request") return "protocol-error"
    if (response.code === "worker-failed") return "worker-failed"
    return "probe-execution-failed"
  }
  if (response.type !== "result") return "protocol-error"
  if (
    response.result.exitCode !== 0 ||
    response.result.cancelled ||
    response.result.timedOut ||
    response.result.outputTruncated
  ) {
    return "probe-execution-failed"
  }
}

function cancellationOutcome(response: SandboxProtocol.WorkerResponse, requested: boolean): Outcome {
  if (response.type === "failure") {
    if (response.code === "sandbox-unavailable") return failed("sandbox-unavailable")
    if (response.code === "protocol-mismatch" || response.code === "invalid-request") return failed("protocol-error")
    if (response.code === "worker-failed") return failed("worker-failed")
    return failed("probe-execution-failed")
  }
  if (response.type !== "result") return failed("protocol-error")
  if (response.result.timedOut) return failed("cancellation-timed-out")
  return requested && response.result.cancelled ? passed() : failed("cancellation-not-observed")
}

function readReport(filepath: string) {
  return Effect.tryPromise(async () => {
    const info = await stat(filepath)
    if (!info.isFile() || info.size > MaxReportBytes) return undefined
    return Schema.decodeUnknownSync(PolicyReport)(JSON.parse(await readFile(filepath, "utf8")))
  }).pipe(Effect.catch(() => Effect.succeed(undefined)))
}

function verifyPolicy(setup: ProbeSetup, state: ResourceState) {
  return Effect.promise(async () => ({
    stagingRead: await hasExactContent(setup.stagingRead, setup.nonce).then(() => true, () => false),
    stagingWrite: await hasExactContent(path.join(state.staging?.work ?? "", "staging-write-canary"), setup.nonce).then(
      () => true,
      () => false,
    ),
    projectRead: await hasExactContent(setup.projectRead, setup.nonce).then(() => true, () => false),
    projectWrite: await absent(setup.projectWrite),
    externalRead: await hasExactContent(setup.externalRead, setup.nonce).then(() => true, () => false),
    externalWrite: await absent(setup.externalWrite),
  }))
}

function pollReadiness(filepath: string, nonce: string, signal: AbortSignal) {
  return Effect.promise(async () => {
    const deadline = Date.now() + ReadinessTimeoutMs
    while (!signal.aborted && Date.now() < deadline) {
      if (await hasExactContent(filepath, nonce).then(() => true, () => false)) return true
      await new Promise((resolve) => setTimeout(resolve, PollIntervalMs))
    }
    return false
  })
}

function cleanup(artifacts: ArtifactStore.Interface, runID: SandboxProtocol.RunID, state: ResourceState) {
  return Effect.gen(function* () {
    state.controllers.forEach((controller) => controller.abort("sandbox_test_cleanup"))
    const closed = yield* closeListener(state.listener?.server)
    const removed = yield* Effect.tryPromise(async () => {
      await Promise.all([
        ...(state.projectRoot ? [rm(state.projectRoot, { recursive: true, force: true })] : []),
        ...(state.externalRoot ? [rm(state.externalRoot, { recursive: true, force: true })] : []),
      ])
      return true
    }).pipe(Effect.catch(() => Effect.succeed(false)))
    const abandoned = state.staging
      ? yield* artifacts.abandon(runID).pipe(
          Effect.as(true),
          Effect.catch(() => Effect.succeed(false)),
        )
      : true
    const verified = yield* Effect.promise(async () => {
      const paths = [state.staging?.root, state.projectRoot, state.externalRoot].filter(
        (value): value is string => value !== undefined,
      )
      return (await Promise.all(paths.map(absent))).every(Boolean) && !state.listener?.server.listening
    })
    return closed && removed && abandoned && verified
  })
}

function acquireDirectory(directory: string) {
  return Effect.acquireRelease(
    Effect.tryPromise(async () => {
      await mkdir(directory, { mode: 0o700 })
      return directory
    }),
    removeOwnedDirectory,
  )
}

function acquireFile(filepath: string, content: string) {
  return Effect.acquireRelease(
    Effect.tryPromise(async () => {
      await writeFile(filepath, content, { flag: "wx", mode: 0o600 })
      return filepath
    }),
    (owned) => Effect.promise(() => rm(owned, { force: true })).pipe(Effect.ignore),
  )
}

function removeOwnedDirectory(directory: string) {
  return Effect.promise(() => rm(directory, { recursive: true, force: true })).pipe(Effect.ignore)
}

function preparationBoundary(
  options: SandboxTestOptions,
  event: { readonly boundary: PreparationBoundary; readonly path?: string; readonly port?: number },
) {
  const callback = options.onPreparationBoundary
  return callback ? Effect.promise(() => callback(event)) : Effect.void
}

function openListener() {
  return new Promise<{ server: Server; connected: boolean }>((resolve, reject) => {
    const listener = {
      server: createServer((socket) => {
        listener.connected = true
        socket.destroy()
      }),
      connected: false,
    }
    const fail = (error: Error) => {
      listener.server.close()
      reject(error)
    }
    listener.server.once("error", fail)
    listener.server.listen(0, "127.0.0.1", () => {
      listener.server.removeListener("error", fail)
      resolve(listener)
    })
  })
}

function closeListener(server?: Server) {
  if (!server?.listening) return Effect.succeed(true)
  return Effect.promise(
    () =>
      new Promise<boolean>((resolve) => {
        server.close((error) => resolve(error === undefined))
      }),
  )
}

async function hasExactContent(filepath: string, nonce: string) {
  if ((await stat(filepath)).size > 256) throw new Error("Unexpected canary size")
  if ((await readFile(filepath, "utf8")) !== nonce) throw new Error("Unexpected canary content")
}

async function absent(filepath: string) {
  return await stat(filepath).then(
    () => false,
    (error: unknown) => hasCode(error, "ENOENT"),
  )
}

function hasCode(error: unknown, code: string) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code
}

export function encodeDiagnosticCommand(
  platform: NodeJS.Platform,
  executable: string,
  script: string,
  args: ReadonlyArray<string>,
): DiagnosticCommand {
  const environment = Schema.decodeUnknownSync(SandboxProtocol.Environment)({
    ELECTRON_RUN_AS_NODE: "1",
    KOALA_SANDBOX_TEST_ARGUMENTS: Buffer.from(JSON.stringify(args), "utf8").toString("base64"),
  })
  if (platform !== "win32") {
    return { command: [executable, script].map(quotePosix).join(" "), env: environment }
  }

  const encodedExecutable = Buffer.from(executable, "utf8").toString("base64")
  const encodedScript = Buffer.from(script, "utf8").toString("base64")
  const powershell = [
    `$executable=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedExecutable}'))`,
    `$script=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedScript}'))`,
    "& $executable $script",
    "if ($null -eq $LASTEXITCODE) { exit 0 }",
    "exit $LASTEXITCODE",
  ].join(";")
  return {
    command: `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(powershell, "utf16le").toString("base64")}`,
    env: environment,
  }
}

function quotePosix(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function unavailableProbes(
  runtimeAvailability: Outcome,
  reason: FailureReason = "not-run",
  cleanupPassed = false,
): Probes {
  const outcome = failed(reason)
  return {
    runtimeAvailability,
    stagingRead: outcome,
    stagingWrite: outcome,
    projectReadDenied: outcome,
    projectWriteDenied: outcome,
    externalReadDenied: outcome,
    externalWriteDenied: outcome,
    loopbackTcpDenied: outcome,
    cancellation: outcome,
    cleanup: cleanupPassed ? passed() : outcome,
  }
}

function failedPolicy(reason: FailureReason) {
  const outcome = failed(reason)
  return {
    stagingRead: outcome,
    stagingWrite: outcome,
    projectReadDenied: outcome,
    projectWriteDenied: outcome,
    externalReadDenied: outcome,
    externalWriteDenied: outcome,
    loopbackTcpDenied: outcome,
  }
}

function success(runID: SandboxProtocol.RunID, probes: Probes): Result {
  const data = Schema.decodeUnknownSync(Data)({
    healthy: allPassed(probes),
    probes,
  })
  return Schema.decodeUnknownSync(Result)({
    tool: "sandbox_test",
    contractVersion: 1,
    engine: Engine,
    status: "success",
    cancelled: false,
    timedOut: false,
    sources: [],
    outputs: [],
    citations: [],
    producerTruncated: false,
    sandboxRunID: runID,
    summary: safeSummary(data),
    data,
  })
}

function allPassed(probes: Probes) {
  return (
    probes.runtimeAvailability.passed &&
    probes.stagingRead.passed &&
    probes.stagingWrite.passed &&
    probes.projectReadDenied.passed &&
    probes.projectWriteDenied.passed &&
    probes.externalReadDenied.passed &&
    probes.externalWriteDenied.passed &&
    probes.loopbackTcpDenied.passed &&
    probes.cancellation.passed &&
    probes.cleanup.passed
  )
}

function passed(): Outcome {
  return { passed: true, reason: "passed" }
}

function failed(reason: FailureReason): Outcome {
  return { passed: false, reason }
}

function retryable(code: IndustrialResult.ErrorCode) {
  return ["cancelled", "deadline-exceeded", "engine-unavailable", "engine-failed", "artifact-storage-failed"].includes(
    code,
  )
}

const policyScriptSource = `import { readFile, writeFile } from "node:fs/promises"
import { createConnection } from "node:net"

const [configPath] = JSON.parse(Buffer.from(process.env.KOALA_SANDBOX_TEST_ARGUMENTS ?? "", "base64").toString("utf8"))
const config = JSON.parse(await readFile(configPath, "utf8"))
const canRead = async (target) => {
  try {
    return (await readFile(target, "utf8")) === config.nonce
  } catch {
    return false
  }
}
const canWrite = async (target) => {
  try {
    await writeFile(target, config.nonce, { flag: "wx" })
    return true
  } catch {
    return false
  }
}
const canConnect = () => new Promise((resolve) => {
  const socket = createConnection({ host: config.host, port: config.port })
  let settled = false
  const finish = (value) => {
    if (settled) return
    settled = true
    socket.destroy()
    resolve(value)
  }
  socket.setTimeout(1_000, () => finish(false))
  socket.once("connect", () => finish(true))
  socket.once("error", () => finish(false))
})

await writeFile(config.report, JSON.stringify({
  stagingRead: await canRead(config.stagingRead),
  stagingWrite: await canWrite(config.stagingWrite),
  projectRead: await canRead(config.projectRead),
  projectWrite: await canWrite(config.projectWrite),
  externalRead: await canRead(config.externalRead),
  externalWrite: await canWrite(config.externalWrite),
  loopbackTcp: await canConnect(),
}), { flag: "wx" })
`

const cancellationScriptSource = `import { readFile, writeFile } from "node:fs/promises"

const [configPath] = JSON.parse(Buffer.from(process.env.KOALA_SANDBOX_TEST_ARGUMENTS ?? "", "base64").toString("utf8"))
const config = JSON.parse(await readFile(configPath, "utf8"))
await writeFile(config.readiness, config.nonce, { flag: "wx" })
setInterval(() => {}, 1_000)
`
