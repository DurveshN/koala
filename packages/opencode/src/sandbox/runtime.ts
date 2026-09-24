import { SandboxProtocol } from "@koala-ai/core/sandbox/protocol"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { Context, Effect, Layer, Schema } from "effect"
import { fork, spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const decodeRequest = Schema.decodeUnknownSync(SandboxProtocol.WorkerRequest)
const encodeRequest = Schema.encodeSync(SandboxProtocol.WorkerRequest)
const decodeResponse = Schema.decodeUnknownSync(SandboxProtocol.WorkerResponse)
const encodeResponse = Schema.encodeSync(SandboxProtocol.WorkerResponse)

export interface Options {
  readonly workerPath?: string
  readonly signal?: AbortSignal
  readonly timeoutGraceMs?: number
}

export interface Runtime {
  readonly availability: (options?: Options) => Promise<SandboxProtocol.WorkerResponse>
  readonly execute: (
    runID: SandboxProtocol.RunID,
    request: SandboxProtocol.ExecutionRequest,
    options?: Options,
  ) => Promise<SandboxProtocol.WorkerResponse>
}

export interface Interface {
  readonly availability: (options?: Options) => Effect.Effect<SandboxProtocol.WorkerResponse>
  readonly execute: (
    runID: SandboxProtocol.RunID,
    request: SandboxProtocol.ExecutionRequest,
    options?: Options,
  ) => Effect.Effect<SandboxProtocol.WorkerResponse>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SandboxRuntime") {}

export function create(): Runtime {
  return {
    availability: (options) => exchange({ protocolVersion: 1, type: "availability" }, options),
    execute: (runID, request, options) => exchange({ protocolVersion: 1, type: "execute", runID, request }, options),
  }
}

export async function availability(options?: Options) {
  return await create().availability(options)
}

export async function execute(
  runID: SandboxProtocol.RunID,
  request: SandboxProtocol.ExecutionRequest,
  options?: Options,
) {
  return await create().execute(runID, request, options)
}

export const layer = Layer.succeed(
  Service,
  Service.of({
    availability: (options) => Effect.promise(() => availability(options)),
    execute: (runID, request, options) => Effect.promise(() => execute(runID, request, options)),
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [] })

export function resolveWorkerPath(
  environment: NodeJS.ProcessEnv = process.env,
  exists: (value: string) => boolean = fs.existsSync,
) {
  const configured = environment.KOALA_SANDBOX_WORKER_PATH?.trim()
  if (configured) return exists(configured) ? path.resolve(configured) : undefined

  const built = fileURLToPath(new URL("./sandbox-runtime/sandbox-worker.mjs", import.meta.url))
  if (exists(built)) return built
  const source = fileURLToPath(new URL("./worker.ts", import.meta.url))
  return exists(source) ? source : undefined
}

async function exchange(input: unknown, options: Options = {}): Promise<SandboxProtocol.WorkerResponse> {
  let request: SandboxProtocol.WorkerRequest
  try {
    request = decodeRequest(encodeRequest(decodeRequest(input)))
  } catch {
    return failure(null, protocolMismatch(input) ? "protocol-mismatch" : "invalid-request")
  }

  let workerPath: string | undefined
  try {
    workerPath = options.workerPath ?? resolveWorkerPath()
  } catch {
    return failure(request.type === "execute" ? request.runID : null, "worker-failed")
  }
  if (!workerPath || !fs.existsSync(workerPath))
    return failure(request.type === "execute" ? request.runID : null, "worker-failed")

  return await new Promise((resolve) => {
    let child: ChildProcess
    let settled = false
    let responseReceived = false
    let workerResponse: SandboxProtocol.WorkerResponse | undefined
    let cancelSent = false
    let watchdog: ReturnType<typeof setTimeout> | undefined
    const finish = (value: SandboxProtocol.WorkerResponse) => {
      if (settled) return
      settled = true
      if (watchdog) clearTimeout(watchdog)
      options.signal?.removeEventListener("abort", cancel)
      resolve(value)
    }
    const fail = () => finish(failure(request.type === "execute" ? request.runID : null, "worker-failed"))
    const cancel = () => {
      if (request.type !== "execute" || cancelSent || responseReceived || !child.connected) return
      cancelSent = true
      if (watchdog) clearTimeout(watchdog)
      watchdog = setTimeout(() => {
        void stopWorker(child).then(fail)
      }, options.timeoutGraceMs ?? 10_000)
      send(child, { protocolVersion: 1, type: "cancel", runID: request.runID }).catch(() => {
        void stopWorker(child).then(fail)
      })
    }

    try {
      child = fork(workerPath, [], {
        detached: process.platform !== "win32",
        env: workerEnvironment(process.env),
        execArgv: [],
        serialization: "json",
        silent: true,
      })
    } catch {
      return fail()
    }

    child.stdout?.resume()
    // Worker diagnostics reach the Koala desktop log through the sidecar's stderr.
    child.stderr?.on("data", (chunk: Buffer | string) => process.stderr.write(chunk))
    child.once("error", fail)
    child.once("exit", (code) => {
      if (!responseReceived || code !== 0 || !workerResponse) return fail()
      finish(workerResponse)
    })
    child.on("message", (value: unknown) => {
      if (responseReceived) {
        void stopWorker(child).then(fail)
        return
      }
      let response: SandboxProtocol.WorkerResponse
      try {
        response = decodeResponse(value)
        if (!matches(request, response)) throw new Error("Mismatched sandbox worker response")
      } catch {
        void stopWorker(child).then(fail)
        return
      }
      responseReceived = true
      workerResponse = decodeResponse(encodeResponse(response))
    })

    const watchdogMs =
      request.type === "execute"
        ? request.request.timeoutMs + (options.timeoutGraceMs ?? 10_000)
        : (options.timeoutGraceMs ?? 10_000)
    watchdog = setTimeout(() => {
      void stopWorker(child).then(fail)
    }, watchdogMs)
    options.signal?.addEventListener("abort", cancel, { once: true })
    send(child, request).catch(() => {
      void stopWorker(child).then(fail)
    })
    if (options.signal?.aborted) cancel()
  })
}

async function send(child: ChildProcess, value: SandboxProtocol.WorkerRequest) {
  const encoded = encodeRequest(decodeRequest(value))
  await new Promise<void>((resolve, reject) => {
    if (!child.connected) return reject(new Error("Sandbox worker IPC disconnected"))
    child.send(encoded, (error) => (error ? reject(error) : resolve()))
  })
}

function matches(request: SandboxProtocol.WorkerRequest, response: SandboxProtocol.WorkerResponse) {
  if (response.type === "failure") {
    return request.type === "execute"
      ? response.runID === null || response.runID === request.runID
      : response.runID === null
  }
  if (request.type === "availability") return response.type === "availability"
  return request.type === "execute" && response.type === "result" && response.runID === request.runID
}

async function stopWorker(child: ChildProcess) {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL")
    } catch {
      child.kill("SIGKILL")
    }
    return
  }
  if (child.exitCode !== null || child.signalCode !== null) return
  if (!child.pid) {
    child.kill("SIGKILL")
    return
  }
  // Sandboxed Windows descendants are owned by upstream srt-win's Job Object; this only stops the worker tree.
  await new Promise<void>((resolve) => {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      env: workerEnvironment(process.env),
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    })
    killer.once("exit", (code) => {
      if (code !== 0) child.kill("SIGKILL")
      resolve()
    })
    killer.once("error", () => {
      child.kill("SIGKILL")
      resolve()
    })
  })
}

function failure(runID: SandboxProtocol.RunID | null, code: SandboxProtocol.FailureCode) {
  return decodeResponse(encodeResponse(decodeResponse({ protocolVersion: 1, type: "failure", runID, code })))
}

function protocolMismatch(input: unknown) {
  return (
    typeof input === "object" &&
    input !== null &&
    "protocolVersion" in input &&
    (input as { readonly protocolVersion?: unknown }).protocolVersion !== 1
  )
}

export function workerEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
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
  return {
    ...Object.fromEntries(keys.flatMap((key) => (source[key] === undefined ? [] : [[key, source[key]]]))),
    ELECTRON_RUN_AS_NODE: "1",
  }
}

export * as SandboxRuntime from "./runtime"
