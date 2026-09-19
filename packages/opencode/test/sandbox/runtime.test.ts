import { describe, expect, test } from "bun:test"
import { SandboxProtocol } from "@koala-ai/core/sandbox/protocol"
import { Schema } from "effect"
import path from "node:path"
import { SandboxRuntime } from "@/sandbox/runtime"

const runID = Schema.decodeUnknownSync(SandboxProtocol.RunID)("run-ipc")
const request = Schema.decodeUnknownSync(SandboxProtocol.ExecutionRequest)({
  command: "echo ok",
  cwd: process.cwd(),
  readRoots: [process.cwd()],
  writeRoots: [process.cwd()],
  env: {},
  network: [],
  timeoutMs: 2_000,
  maxOutputBytes: 1_024,
})

const fixture = (name: string) => path.join(import.meta.dir, name)

describe("sandbox runtime adapter", () => {
  test("passes only an explicit environment allowlist to the worker", () => {
    expect(
      SandboxRuntime.workerEnvironment({
        PATH: "/bin",
        SYSTEMROOT: "C:\\Windows",
        HTTP_PROXY: "credential-canary",
        AWS_SECRET_ACCESS_KEY: "credential-canary",
      }),
    ).toEqual({ ELECTRON_RUN_AS_NODE: "1", PATH: "/bin", SYSTEMROOT: "C:\\Windows" })
  })

  test("uses schema-validated child-process IPC", async () => {
    const result = await SandboxRuntime.availability({ workerPath: fixture("ipc-worker.ts") })
    expect(result).toEqual({
      protocolVersion: 1,
      type: "availability",
      availability: { status: "available" },
    })
  })

  test("forwards one matching cancellation", async () => {
    const abort = new AbortController()
    const pending = SandboxRuntime.execute(runID, request, {
      workerPath: fixture("ipc-worker.ts"),
      signal: abort.signal,
    })
    abort.abort()

    expect(await pending).toMatchObject({
      type: "result",
      runID: "run-ipc",
      result: { cancelled: true },
    })
  })

  test("fails closed when the configured worker is absent", async () => {
    const result = await SandboxRuntime.availability({ workerPath: fixture("missing-worker.mjs") })
    expect(result).toEqual({ protocolVersion: 1, type: "failure", runID: null, code: "worker-failed" })
  })

  test("fails closed when the worker crashes", async () => {
    const result = await SandboxRuntime.availability({ workerPath: fixture("ipc-crash-worker.ts") })
    expect(result).toEqual({ protocolVersion: 1, type: "failure", runID: null, code: "worker-failed" })
  })

  test("fails closed when the worker crashes after a valid response", async () => {
    const result = await SandboxRuntime.availability({ workerPath: fixture("ipc-response-crash-worker.ts") })
    expect(result).toEqual({ protocolVersion: 1, type: "failure", runID: null, code: "worker-failed" })
  })

  test("fails closed without exposing protocol-invalid worker output", async () => {
    const result = await SandboxRuntime.availability({ workerPath: fixture("ipc-invalid-worker.ts") })
    expect(result).toEqual({ protocolVersion: 1, type: "failure", runID: null, code: "worker-failed" })
    expect(JSON.stringify(result)).not.toContain("canary")
  })

  test("honors KOALA_SANDBOX_WORKER_PATH without fallback", () => {
    const checked: string[] = []
    const result = SandboxRuntime.resolveWorkerPath({ KOALA_SANDBOX_WORKER_PATH: "missing-worker.mjs" }, (value) => {
      checked.push(value)
      return false
    })

    expect(result).toBeUndefined()
    expect(checked).toEqual(["missing-worker.mjs"])
  })
})
