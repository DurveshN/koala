import { SandboxManager, SandboxRuntimeConfigSchema, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime"
import { SandboxProtocol } from "@koala-ai/core/sandbox/protocol"
import { Schema } from "effect"
import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const decodeRequest = Schema.decodeUnknownSync(SandboxProtocol.WorkerRequest)
const decodeResponse = Schema.decodeUnknownSync(SandboxProtocol.WorkerResponse)
const encodeResponse = Schema.encodeSync(SandboxProtocol.WorkerResponse)
const decodeResult = Schema.decodeUnknownSync(SandboxProtocol.ExecutionResult)

const securityEnvironmentKeys = new Set([
  "ALL_PROXY",
  "CLAUDE_CODE_HOST_HTTP_PROXY_PORT",
  "CLAUDE_CODE_HOST_SOCKS_PROXY_PORT",
  "CURL_CA_BUNDLE",
  "GIT_CONFIG_COUNT",
  "GIT_SSL_CAINFO",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "JAVA_TOOL_OPTIONS",
  "NODE_EXTRA_CA_CERTS",
  "NO_PROXY",
  "SSL_CERT_FILE",
  "TMPDIR",
  "all_proxy",
  "https_proxy",
  "http_proxy",
  "no_proxy",
])

export interface SandboxAssets {
  readonly javaAgentJarPath?: string
  readonly seccompApplyPath?: string
  readonly srtWinPath?: string
}

export interface WrappedCommand {
  readonly argv: string[]
  readonly env: NodeJS.ProcessEnv
}

export interface WorkerSandboxManager {
  readonly isSupportedPlatform: () => boolean
  readonly checkDependenciesAsync: () => Promise<{
    readonly errors: ReadonlyArray<string>
    readonly warnings?: ReadonlyArray<string>
  }>
  readonly initialize: (
    config: SandboxRuntimeConfig,
    ask?: (input: { readonly host: string; readonly port: number | undefined }) => Promise<boolean>,
    enableLogMonitor?: boolean,
  ) => Promise<void>
  readonly wrapWithSandboxArgv: (
    command: string,
    binShell?: string,
    customConfig?: Partial<SandboxRuntimeConfig>,
    abortSignal?: AbortSignal,
    cwd?: string,
    options?: { readonly commandId?: string; readonly commandText?: string },
  ) => Promise<WrappedCommand>
  readonly getSandboxViolationStore: () => {
    readonly getViolationsForCommand: (command: string) => ReadonlyArray<{ readonly line: string }>
  }
  readonly cleanupAfterCommand: () => void
  readonly reset: () => Promise<void>
}

export interface WorkerDependencies {
  readonly manager: WorkerSandboxManager
  readonly platform: NodeJS.Platform
  readonly assets: SandboxAssets
  readonly spawnCommand: typeof spawn
  readonly terminateProcessTree: typeof terminateProcessTree
}

const defaultDependencies = (): WorkerDependencies => ({
  manager: SandboxManager,
  platform: process.platform,
  assets: resolveSandboxAssets(import.meta.url, process.platform, process.arch),
  spawnCommand: spawn,
  terminateProcessTree,
})

export function strictConfig(
  request: SandboxProtocol.ExecutionRequest,
  platform: NodeJS.Platform,
  assets: SandboxAssets,
): SandboxRuntimeConfig {
  return SandboxRuntimeConfigSchema.parse({
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
      denyRead: broadReadRoots(platform),
      allowRead: [...new Set([...runtimeReadRoots(platform), ...request.readRoots])],
      allowWrite: [...request.writeRoots],
      denyWrite: compatibilityWritePaths(platform),
      allowGitConfig: false,
    },
    enableWeakerNestedSandbox: false,
    enableWeakerNetworkIsolation: false,
    allowAppleEvents: false,
    allowPty: false,
    ...(assets.javaAgentJarPath ? { javaAgentJarPath: assets.javaAgentJarPath } : {}),
    ...(platform === "linux" && assets.seccompApplyPath ? { seccomp: { applyPath: assets.seccompApplyPath } } : {}),
    ...(platform === "win32" && assets.srtWinPath ? { windows: { srtWin: { path: assets.srtWinPath } } } : {}),
  })
}

export function runtimeReadRoots(platform: NodeJS.Platform, environment: NodeJS.ProcessEnv = process.env) {
  if (platform === "win32") {
    return [
      process.execPath,
      environment.SYSTEMROOT,
      environment.WINDIR,
      ...(environment.PATH?.split(path.delimiter) ?? []),
    ]
      .filter((value): value is string => Boolean(value))
      .map((value) => path.resolve(value))
  }
  return [
    process.execPath,
    "/bin",
    "/usr",
    "/lib",
    "/lib64",
    "/System",
    "/Library",
    "/dev/null",
    "/etc/ld.so.cache",
  ].filter(fs.existsSync)
}

export function compatibilityWritePaths(platform: NodeJS.Platform, environment: NodeJS.ProcessEnv = process.env) {
  if (platform === "win32") return []
  const home = environment.HOME
  return [
    "/tmp/claude",
    "/private/tmp/claude",
    home ? path.join(home, ".npm/_logs") : undefined,
    home ? path.join(home, ".claude/debug") : undefined,
  ].filter((value): value is string => Boolean(value))
}

export function broadReadRoots(platform: NodeJS.Platform) {
  if (platform === "win32") return []
  return ["/"]
}

export function applyRequestEnvironment(
  wrapped: WrappedCommand,
  request: SandboxProtocol.Environment,
  platform: NodeJS.Platform,
): WrappedCommand {
  const entries = Object.entries(request).filter(([key]) => !securityEnvironmentKeys.has(key))
  if (platform !== "win32") return { argv: [...wrapped.argv], env: { ...wrapped.env, ...Object.fromEntries(entries) } }
  if (entries.length === 0) return { argv: [...wrapped.argv], env: { ...wrapped.env } }

  const separator = wrapped.argv.lastIndexOf("--")
  if (separator < 0) throw new Error("Invalid Windows sandbox descriptor")
  const provided = new Set(
    wrapped.argv.flatMap((value, index) => {
      const entry = wrapped.argv[index + 1]
      if (value !== "--env" || index + 1 >= separator || !entry) return []
      return [entry.split("=", 1)[0] ?? ""]
    }),
  )
  const additions = entries
    .filter(([key]) => !provided.has(key))
    .flatMap(([key, value]) => ["--env", `${key}=${value}`])
  return {
    argv: [...wrapped.argv.slice(0, separator), ...additions, ...wrapped.argv.slice(separator)],
    env: { ...wrapped.env },
  }
}

export function resolveSandboxAssets(moduleURL: string, platform: NodeJS.Platform, arch: string): SandboxAssets {
  const adjacent = fileURLToPath(new URL("./vendor/", moduleURL))
  const vendor = fs.existsSync(adjacent)
    ? adjacent
    : path.resolve(path.dirname(fileURLToPath(import.meta.resolve("@anthropic-ai/sandbox-runtime"))), "../vendor")
  const architecture = arch === "arm64" || arch === "x64" ? arch : undefined
  return {
    javaAgentJarPath: path.join(vendor, "java-proxy-agent", "srt-proxy-agent.jar"),
    ...(platform === "linux" && architecture
      ? { seccompApplyPath: path.join(vendor, "seccomp", architecture, "apply-seccomp") }
      : {}),
    ...(platform === "win32" && architecture
      ? { srtWinPath: path.join(vendor, "srt-win", architecture, "srt-win.exe") }
      : {}),
  }
}

export async function availability(
  dependencies: WorkerDependencies = defaultDependencies(),
): Promise<SandboxProtocol.WorkerResponse> {
  if (!dependencies.manager.isSupportedPlatform()) {
    return response({
      protocolVersion: 1,
      type: "availability",
      availability: { status: "unavailable", reason: "unsupported-platform" },
    })
  }
  if (!assetsAvailable(dependencies)) {
    return response({
      protocolVersion: 1,
      type: "availability",
      availability: { status: "unavailable", reason: "sandbox-unavailable" },
    })
  }

  let initialized = false
  let status: SandboxProtocol.AvailabilityStatus = { status: "unavailable", reason: "initialization-failed" }
  try {
    const cwd = Schema.decodeUnknownSync(SandboxProtocol.AbsolutePath)(process.cwd())
    await dependencies.manager.initialize(
      strictConfig(
        {
          command: "availability-check",
          cwd,
          readRoots: [],
          writeRoots: [],
          env: {},
          network: [],
          timeoutMs: 1,
          maxOutputBytes: 1,
        },
        dependencies.platform,
        dependencies.assets,
      ),
      undefined,
      false,
    )
    initialized = true
    status = (await dependenciesStrict(dependencies.manager, dependencies.platform))
      ? { status: "available" }
      : { status: "unavailable", reason: "sandbox-unavailable" }
  } catch {
    status = { status: "unavailable", reason: "initialization-failed" }
  } finally {
    if (initialized) {
      try {
        dependencies.manager.cleanupAfterCommand()
        await dependencies.manager.reset()
      } catch {
        status = { status: "unavailable", reason: "initialization-failed" }
      }
    }
  }
  return response({
    protocolVersion: 1,
    type: "availability",
    availability: status,
  })
}

export async function execute(
  request: Extract<SandboxProtocol.WorkerRequest, { readonly type: "execute" }>,
  abort: AbortSignal,
  dependencies: WorkerDependencies = defaultDependencies(),
): Promise<SandboxProtocol.WorkerResponse> {
  if (!dependencies.manager.isSupportedPlatform()) return failure(request.runID, "sandbox-unavailable")
  if (!assetsAvailable(dependencies)) return failure(request.runID, "sandbox-unavailable")

  let initialized = false
  let cleanupFailed = false
  let executing = false
  let result: SandboxProtocol.WorkerResponse
  try {
    await dependencies.manager.initialize(
      strictConfig(request.request, dependencies.platform, dependencies.assets),
      undefined,
      true,
    )
    initialized = true
    if (!(await dependenciesStrict(dependencies.manager, dependencies.platform))) {
      result = failure(request.runID, "sandbox-unavailable")
    } else if (abort.aborted) {
      result = response({
        protocolVersion: 1,
        type: "result",
        runID: request.runID,
        result: emptyResult({ cancelled: true }),
      })
    } else {
      executing = true
      const wrapped = await dependencies.manager.wrapWithSandboxArgv(
        request.request.command,
        undefined,
        undefined,
        abort,
        request.request.cwd,
        { commandId: request.runID, commandText: request.request.command },
      )
      const execution = await runWrappedCommand(
        applyRequestEnvironment(wrapped, request.request.env, dependencies.platform),
        request.request,
        abort,
        dependencies,
      )
      result = response({
        protocolVersion: 1,
        type: "result",
        runID: request.runID,
        result: {
          ...execution,
          violations: dependencies.manager
            .getSandboxViolationStore()
            .getViolationsForCommand(request.runID)
            .map((violation) => parseViolation(violation.line)),
        },
      })
    }
  } catch {
    result = abort.aborted
      ? response({
          protocolVersion: 1,
          type: "result",
          runID: request.runID,
          result: emptyResult({ cancelled: true }),
        })
      : failure(request.runID, executing ? "execution-failed" : "sandbox-unavailable")
  } finally {
    if (initialized) {
      try {
        dependencies.manager.cleanupAfterCommand()
      } catch {
        cleanupFailed = true
      }
      try {
        await dependencies.manager.reset()
      } catch {
        cleanupFailed = true
      }
    }
  }
  return cleanupFailed ? failure(request.runID, "execution-failed") : result
}

export async function runWrappedCommand(
  wrapped: WrappedCommand,
  request: SandboxProtocol.ExecutionRequest,
  abort: AbortSignal,
  dependencies: Pick<WorkerDependencies, "platform" | "spawnCommand" | "terminateProcessTree">,
): Promise<Omit<SandboxProtocol.ExecutionResult, "violations">> {
  const executable = wrapped.argv[0]
  if (!executable) throw new Error("Missing wrapped command")
  const child = dependencies.spawnCommand(executable, wrapped.argv.slice(1), {
    cwd: request.cwd,
    env: wrapped.env,
    shell: false,
    detached: dependencies.platform !== "win32",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  })
  if (!child.stdout || !child.stderr) throw new Error("Missing command output streams")

  return await new Promise((resolve, reject) => {
    const output = { stdout: [] as Buffer[], stderr: [] as Buffer[], bytes: 0, truncated: false }
    let terminal: "cancelled" | "output" | "timeout" | undefined
    let settled = false
    let terminating = false

    const terminate = (reason: "cancelled" | "output" | "timeout") => {
      if (terminating) return
      terminating = true
      terminal = reason
      void dependencies.terminateProcessTree(child, dependencies.platform)
    }
    const append = (stream: "stdout" | "stderr", chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      const available = request.maxOutputBytes - output.bytes
      if (value.byteLength <= available) {
        output[stream].push(value)
        output.bytes += value.byteLength
        return
      }
      if (available > 0) output[stream].push(value.subarray(0, available))
      output.bytes = request.maxOutputBytes
      output.truncated = true
      terminate("output")
    }
    const cancel = () => {
      terminate("cancelled")
    }
    const timer = setTimeout(() => {
      terminate("timeout")
    }, request.timeoutMs)

    child.stdout.on("data", (chunk: Buffer | string) => append("stdout", chunk))
    child.stderr.on("data", (chunk: Buffer | string) => append("stderr", chunk))
    child.once("error", (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      abort.removeEventListener("abort", cancel)
      reject(error)
    })
    child.once("close", (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      abort.removeEventListener("abort", cancel)
      void dependencies.terminateProcessTree(child, dependencies.platform).then(() =>
        resolve({
          exitCode: code,
          stdout: decodeBounded(Buffer.concat(output.stdout)),
          stderr: decodeBounded(Buffer.concat(output.stderr)),
          timedOut: terminal === "timeout",
          cancelled: terminal === "cancelled",
          outputTruncated: output.truncated,
        }),
      )
    })
    abort.addEventListener("abort", cancel, { once: true })
    if (abort.aborted) cancel()
  })
}

function decodeBounded(value: Buffer) {
  const decoded = value.toString("utf8")
  if (Buffer.byteLength(decoded) <= value.byteLength) return decoded
  let bytes = 0
  return Array.from(decoded)
    .filter((character) => {
      const size = Buffer.byteLength(character)
      if (bytes + size > value.byteLength) return false
      bytes += size
      return true
    })
    .join("")
}

export async function terminateProcessTree(child: ChildProcess, platform: NodeJS.Platform) {
  if (!child.pid) return
  if (platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGKILL")
    } catch {
      child.kill("SIGKILL")
    }
    return
  }

  if (child.exitCode !== null || child.signalCode !== null) return

  await new Promise<void>((resolve) => {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      env: workerEnvironment(process.env),
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    })
    killer.once("close", (code) => {
      if (code !== 0) child.kill("SIGKILL")
      resolve()
    })
    killer.once("error", () => {
      child.kill("SIGKILL")
      resolve()
    })
  })
}

function assetsAvailable(dependencies: Pick<WorkerDependencies, "assets" | "platform">) {
  if (!dependencies.assets.javaAgentJarPath || !fs.existsSync(dependencies.assets.javaAgentJarPath)) return false
  if (dependencies.platform === "win32") {
    return Boolean(dependencies.assets.srtWinPath && fs.existsSync(dependencies.assets.srtWinPath))
  }
  if (dependencies.platform !== "linux") return true
  if (!dependencies.assets.seccompApplyPath) return false
  try {
    fs.accessSync(dependencies.assets.seccompApplyPath, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

async function dependenciesStrict(manager: WorkerSandboxManager, platform: NodeJS.Platform) {
  const result = await manager.checkDependenciesAsync()
  if (result.errors.length > 0) return false
  return platform !== "linux" || !result.warnings?.some((warning) => warning.toLowerCase().includes("seccomp"))
}

export function workerEnvironment(source: NodeJS.ProcessEnv) {
  const keys = [
    "COMSPEC",
    "HOME",
    "LANG",
    "LC_ALL",
    "LOCALAPPDATA",
    "PATH",
    "PATHEXT",
    "PROGRAMDATA",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "TMPDIR",
    "USERPROFILE",
    "WINDIR",
  ] as const
  return Object.fromEntries(keys.flatMap((key) => (source[key] === undefined ? [] : [[key, source[key]]])))
}

export function parseViolation(line: string): SandboxProtocol.Violation {
  const sanitized = line.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 4096)
  const match = /^deny\s+(\S+)(?:\s+(.+?))?(?:\s+\([^)]*\))?$/.exec(sanitized)
  const operation = match?.[1] ?? "sandbox-denial"
  const target = match?.[2]?.trim()
  const kind: SandboxProtocol.ViolationKind = operation.includes("read")
    ? "filesystem-read"
    : operation.includes("write")
      ? "filesystem-write"
      : operation.includes("network") || operation.includes("connect")
        ? "network"
        : "process"
  return { kind, operation, ...(target ? { target } : {}) }
}

export function failure(runID: SandboxProtocol.RunID | null, code: SandboxProtocol.FailureCode) {
  return response({ protocolVersion: 1, type: "failure", runID, code })
}

function emptyResult(flags: Partial<SandboxProtocol.ExecutionResult> = {}) {
  return decodeResult({
    exitCode: null,
    stdout: "",
    stderr: "",
    timedOut: false,
    cancelled: false,
    outputTruncated: false,
    violations: [],
    ...flags,
  })
}

function response(value: unknown) {
  return decodeResponse(encodeResponse(decodeResponse(value)))
}

export function startWorker(dependencies: WorkerDependencies = defaultDependencies()) {
  let operation: "waiting" | "availability" | "execute" | "finished" = "waiting"
  let runID: SandboxProtocol.RunID | undefined
  let abort: AbortController | undefined
  let activeFailure: SandboxProtocol.WorkerResponse | undefined

  const send = async (value: SandboxProtocol.WorkerResponse) => {
    operation = "finished"
    const encoded = encodeResponse(value)
    await new Promise<void>((resolve) => {
      if (!process.send) return resolve()
      process.send(encoded, () => resolve())
    })
    process.disconnect?.()
  }

  process.on("disconnect", () => abort?.abort())
  process.on("message", (input: unknown) => {
    let message: SandboxProtocol.WorkerRequest
    try {
      message = decodeRequest(input)
    } catch {
      abort?.abort()
      void send(failure(null, protocolMismatch(input) ? "protocol-mismatch" : "invalid-request"))
      return
    }

    if (operation === "waiting" && message.type === "availability") {
      operation = "availability"
      void availability(dependencies).then(send, () => send(failure(null, "worker-failed")))
      return
    }
    if (operation === "waiting" && message.type === "execute") {
      operation = "execute"
      runID = message.runID
      abort = new AbortController()
      void execute(message, abort.signal, dependencies).then(
        (value) => send(activeFailure ?? value),
        () => send(failure(message.runID, "worker-failed")),
      )
      return
    }
    if (operation === "execute" && message.type === "cancel" && message.runID === runID) {
      abort?.abort()
      return
    }
    if (operation !== "finished") {
      activeFailure = failure(runID ?? null, "invalid-request")
      abort?.abort()
    }
  })
}

function protocolMismatch(input: unknown) {
  return (
    typeof input === "object" &&
    input !== null &&
    "protocolVersion" in input &&
    (input as { readonly protocolVersion?: unknown }).protocolVersion !== 1
  )
}

const entrypoint = process.argv[1]
if (entrypoint && pathToFileURL(path.resolve(entrypoint)).href === import.meta.url) startWorker()

export * as SandboxWorker from "./worker"
