import { describe, expect, test } from "bun:test"
import { SandboxProtocol } from "@koala-ai/core/sandbox/protocol"
import { Schema } from "effect"
import { spawn } from "node:child_process"
import path from "node:path"
import {
  applyRequestEnvironment,
  availability,
  execute,
  parseViolation,
  runWrappedCommand,
  strictConfig,
  terminateProcessTree,
  workerEnvironment,
  type WorkerDependencies,
  type WorkerSandboxManager,
} from "@/sandbox/worker"

const decodeExecution = Schema.decodeUnknownSync(SandboxProtocol.ExecutionRequest)
const decodeRunID = Schema.decodeUnknownSync(SandboxProtocol.RunID)
const assets = {
  javaAgentJarPath: process.execPath,
  seccompApplyPath: process.execPath,
  srtWinPath: process.execPath,
}

function execution(overrides: Record<string, unknown> = {}) {
  return decodeExecution({
    command: `${JSON.stringify(process.execPath)} -e "process.stdout.write('ok')"`,
    cwd: process.cwd(),
    readRoots: [process.cwd()],
    writeRoots: [process.cwd()],
    env: {},
    network: [],
    timeoutMs: 2_000,
    maxOutputBytes: 1_024,
    ...overrides,
  })
}

describe("sandbox worker policy", () => {
  test("builds the strict SRT policy", () => {
    const request = execution({ readRoots: [process.cwd()], writeRoots: [path.join(process.cwd(), "tmp")] })
    const config = strictConfig(request, "linux", {
      javaAgentJarPath: "/runtime/srt-proxy-agent.jar",
      seccompApplyPath: "/runtime/apply-seccomp",
    })

    expect(config).toMatchObject({
      network: {
        allowedDomains: [],
        deniedDomains: [],
        strictAllowlist: true,
        allowUnixSockets: [],
        allowAllUnixSockets: false,
        allowLocalBinding: false,
        allowMachLookup: [],
      },
      filesystem: {
        denyRead: ["/"],
        allowWrite: [path.join(process.cwd(), "tmp")],
        denyWrite: expect.arrayContaining(["/tmp/claude", "/private/tmp/claude"]),
        allowGitConfig: false,
      },
      enableWeakerNestedSandbox: false,
      enableWeakerNetworkIsolation: false,
      allowAppleEvents: false,
      allowPty: false,
      seccomp: { applyPath: "/runtime/apply-seccomp" },
    })
    expect(config.filesystem.allowRead).toContain(process.cwd())
    expect(config.filesystem.allowRead).toContain(process.execPath)
  })

  test("does not apply broad read-deny ACLs on Windows", () => {
    expect(strictConfig(execution(), "win32", assets).filesystem.denyRead).toEqual([])
  })

  test("keeps only the explicit worker environment allowlist", () => {
    expect(
      workerEnvironment({
        PATH: "/bin",
        HOME: "/home/test",
        HTTP_PROXY: "credential-canary",
        AWS_SECRET_ACCESS_KEY: "credential-canary",
      }),
    ).toEqual({ HOME: "/home/test", PATH: "/bin" })
  })

  test("does not let request values replace SRT-owned environment", () => {
    expect(
      applyRequestEnvironment(
        { argv: ["srt-win.exe", "exec", "--env", "PATH=secure", "--", "cmd.exe"], env: {} },
        { PATH: "requested", HOME: "requested-home" },
        "win32",
      ).argv,
    ).toEqual(["srt-win.exe", "exec", "--env", "PATH=secure", "--env", "HOME=requested-home", "--", "cmd.exe"])

    expect(
      applyRequestEnvironment(
        { argv: ["/bin/bash", "-c", "wrapped"], env: { TMPDIR: "/secure" } },
        { PATH: "/requested", TMPDIR: "/requested-tmp" },
        "linux",
      ).env,
    ).toEqual({ PATH: "/requested", TMPDIR: "/secure" })
  })

  test("projects violation lines into bounded protocol values", () => {
    expect(parseViolation("deny network-outbound example.com:443 (host is not on the allow list)")).toEqual({
      kind: "network",
      operation: "network-outbound",
      target: "example.com:443",
    })
    expect(parseViolation("deny file-read-data /private/key")).toEqual({
      kind: "filesystem-read",
      operation: "file-read-data",
      target: "/private/key",
    })
  })
})

describe("sandbox worker execution", () => {
  test("checks availability without mutating filesystem policy", async () => {
    const calls: string[] = []
    const manager = {
      isSupportedPlatform: () => true,
      checkDependenciesAsync: async () => ({ errors: [] }),
      initialize: async () => {
        calls.push("initialize")
      },
      wrapWithSandboxArgv: async () => ({ argv: [], env: {} }),
      getSandboxViolationStore: () => ({ getViolationsForCommand: () => [] }),
      cleanupAfterCommand: () => {
        calls.push("cleanup")
      },
      reset: async () => {
        calls.push("reset")
      },
    } satisfies WorkerSandboxManager
    const result = await availability({
      manager,
      platform: process.platform,
      assets,
      spawnCommand: spawn,
      terminateProcessTree,
    })

    expect(result).toMatchObject({ type: "availability", availability: { status: "available" } })
    expect(calls).toEqual(["initialize", "cleanup", "reset"])
  })

  test("rejects Linux availability when seccomp is degraded", async () => {
    const manager = {
      isSupportedPlatform: () => true,
      checkDependenciesAsync: async () => ({ errors: [], warnings: ["seccomp not available"] }),
      initialize: async () => undefined,
      wrapWithSandboxArgv: async () => ({ argv: [], env: {} }),
      getSandboxViolationStore: () => ({ getViolationsForCommand: () => [] }),
      cleanupAfterCommand: () => undefined,
      reset: async () => undefined,
    } satisfies WorkerSandboxManager

    expect(
      await availability({ manager, platform: "linux", assets, spawnCommand: spawn, terminateProcessTree }),
    ).toMatchObject({ type: "availability", availability: { status: "unavailable", reason: "sandbox-unavailable" } })
  })

  test("enforces one combined stdout and stderr byte limit", async () => {
    const request = execution({
      timeoutMs: 5_000,
      maxOutputBytes: 12,
    })
    const result = await runWrappedCommand(
      {
        argv: [
          process.execPath,
          "-e",
          'process.stdout.write("abcdefghij");process.stderr.write("klmnopqrst");setInterval(()=>{},1000)',
        ],
        env: workerEnvironment(process.env),
      },
      request,
      new AbortController().signal,
      {
        platform: process.platform,
        spawnCommand: spawn,
        terminateProcessTree,
      },
    )

    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBe(12)
    expect(result.outputTruncated).toBe(true)
    expect(result.timedOut).toBe(false)
    expect(result.cancelled).toBe(false)
  })

  test("terminates on timeout", async () => {
    const result = await runWrappedCommand(
      {
        argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
        env: workerEnvironment(process.env),
      },
      execution({ timeoutMs: 25 }),
      new AbortController().signal,
      { platform: process.platform, spawnCommand: spawn, terminateProcessTree },
    )

    expect(result).toMatchObject({ timedOut: true, cancelled: false })
  })

  test("terminates on cancellation", async () => {
    const abort = new AbortController()
    const pending = runWrappedCommand(
      {
        argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
        env: workerEnvironment(process.env),
      },
      execution(),
      abort.signal,
      { platform: process.platform, spawnCommand: spawn, terminateProcessTree },
    )
    abort.abort()

    expect(await pending).toMatchObject({ timedOut: false, cancelled: true })
  })

  test("cleans up and resets after initialized execution", async () => {
    const calls: string[] = []
    const request = execution()
    const manager = {
      isSupportedPlatform: () => true,
      checkDependenciesAsync: async () => ({ errors: [], warnings: [] }),
      initialize: async () => {
        calls.push("initialize")
      },
      wrapWithSandboxArgv: async () => ({
        argv: [process.execPath, "-e", 'process.stdout.write("ok")'],
        env: workerEnvironment(process.env),
      }),
      getSandboxViolationStore: () =>
        ({ getViolationsForCommand: () => [] }) satisfies ReturnType<WorkerSandboxManager["getSandboxViolationStore"]>,
      cleanupAfterCommand: () => {
        calls.push("cleanup")
      },
      reset: async () => {
        calls.push("reset")
      },
    } satisfies WorkerSandboxManager
    const dependencies = {
      manager,
      platform: process.platform,
      assets,
      spawnCommand: (await import("node:child_process")).spawn,
      terminateProcessTree: async (child) => {
        child.kill("SIGKILL")
      },
    } satisfies WorkerDependencies
    const result = await execute(
      { protocolVersion: 1, type: "execute", runID: decodeRunID("run-cleanup"), request },
      new AbortController().signal,
      dependencies,
    )

    expect(result).toMatchObject({ type: "result", result: { stdout: "ok", exitCode: 0 } })
    expect(calls).toEqual(["initialize", "cleanup", "reset"])
  })

  test("cleans up and resets when wrapping fails", async () => {
    const calls: string[] = []
    const manager = {
      isSupportedPlatform: () => true,
      checkDependenciesAsync: async () => ({ errors: [], warnings: [] }),
      initialize: async () => {
        calls.push("initialize")
      },
      wrapWithSandboxArgv: async () => {
        throw new Error("private-stack-canary")
      },
      getSandboxViolationStore: () =>
        ({ getViolationsForCommand: () => [] }) satisfies ReturnType<WorkerSandboxManager["getSandboxViolationStore"]>,
      cleanupAfterCommand: () => {
        calls.push("cleanup")
      },
      reset: async () => {
        calls.push("reset")
      },
    } satisfies WorkerSandboxManager
    const result = await execute(
      { protocolVersion: 1, type: "execute", runID: decodeRunID("run-failure"), request: execution() },
      new AbortController().signal,
      {
        manager,
        platform: process.platform,
        assets,
        spawnCommand: (await import("node:child_process")).spawn,
        terminateProcessTree: async () => undefined,
      },
    )

    expect(result).toMatchObject({ type: "failure", code: "execution-failed" })
    expect(JSON.stringify(result)).not.toContain("canary")
    expect(calls).toEqual(["initialize", "cleanup", "reset"])
  })
})
