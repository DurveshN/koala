import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { SandboxProtocol } from "./protocol"

const request = () => ({
  command: "python3 script.py",
  cwd: "/sandbox/work",
  readRoots: ["/runtime", "/sandbox/input"],
  writeRoots: ["/sandbox/work", "/sandbox/artifacts"],
  env: { LANG: "C.UTF-8", PATH: "/usr/bin:/bin" },
  network: [] as const,
  timeoutMs: 30_000,
  maxOutputBytes: 1_048_576,
})

const result = () => ({
  exitCode: 0,
  stdout: "complete\n",
  stderr: "",
  timedOut: false,
  cancelled: false,
  outputTruncated: false,
  violations: [{ kind: "filesystem-write" as const, operation: "open", target: "/outside/output" }],
})

describe("SandboxProtocol.WorkerRequest", () => {
  const decode = Schema.decodeUnknownSync(SandboxProtocol.WorkerRequest)
  const encode = Schema.encodeSync(SandboxProtocol.WorkerRequest)

  test("decodes a complete execution request", () => {
    const input = {
      protocolVersion: 1 as const,
      type: "execute" as const,
      runID: "run-123",
      request: request(),
    }

    expect(encode(decode(input))).toEqual(input)
  })

  test("decodes an availability request", () => {
    const input = { protocolVersion: 1 as const, type: "availability" as const }
    expect(encode(decode(input))).toEqual(input)
  })

  test("decodes a cancellation request", () => {
    const input = { protocolVersion: 1 as const, type: "cancel" as const, runID: "run-123" }
    expect(encode(decode(input))).toEqual(input)
  })

  test.each([0, -1, 1.5, Number.POSITIVE_INFINITY, Number.NaN])("rejects invalid limit %s", (limit) => {
    expect(() =>
      decode({
        protocolVersion: 1,
        type: "execute",
        runID: "run-123",
        request: { ...request(), timeoutMs: limit },
      }),
    ).toThrow()
    expect(() =>
      decode({
        protocolVersion: 1,
        type: "execute",
        runID: "run-123",
        request: { ...request(), maxOutputBytes: limit },
      }),
    ).toThrow()
  })

  test.each(["relative/path", "", "/sandbox/../outside", "/sandbox/\0outside"])("rejects invalid path %s", (cwd) => {
    expect(() =>
      decode({
        protocolVersion: 1,
        type: "execute",
        runID: "run-123",
        request: { ...request(), cwd },
      }),
    ).toThrow()
  })

  test.each(["AWS_SECRET_ACCESS_KEY", "BAD-KEY", "Path"])("rejects environment key %s", (key) => {
    expect(() =>
      decode({
        protocolVersion: 1,
        type: "execute",
        runID: "run-123",
        request: { ...request(), env: { [key]: "credential-canary" } },
      }),
    ).toThrow("Environment keys must be one of")
  })

  test.each([0, 2, "1", undefined])("rejects protocol version %s", (protocolVersion) => {
    expect(() =>
      decode({
        protocolVersion,
        type: "execute",
        runID: "run-123",
        request: request(),
      }),
    ).toThrow()
  })
})

describe("SandboxProtocol.WorkerResponse", () => {
  const decode = Schema.decodeUnknownSync(SandboxProtocol.WorkerResponse)
  const encode = Schema.encodeSync(SandboxProtocol.WorkerResponse)

  test.each([
    {
      protocolVersion: 1,
      type: "availability",
      availability: { status: "available" },
    },
    {
      protocolVersion: 1,
      type: "availability",
      availability: {
        status: "unavailable",
        reason: "unsupported-platform",
      },
    },
    {
      protocolVersion: 1,
      type: "result",
      runID: "run-123",
      result: result(),
    },
    {
      protocolVersion: 1,
      type: "failure",
      runID: null,
      code: "invalid-request",
    },
  ] as const)("decodes the $type response variant", (response) => {
    expect(encode(decode(response))).toEqual(response)
  })

  test("accepts nullable exit codes and terminal result flags", () => {
    const response = decode({
      protocolVersion: 1,
      type: "result",
      runID: "run-cancelled",
      result: {
        ...result(),
        exitCode: null,
        timedOut: true,
        cancelled: true,
        outputTruncated: true,
      },
    })

    expect(response).toMatchObject({
      type: "result",
      result: { exitCode: null, timedOut: true, cancelled: true, outputTruncated: true },
    })
  })

  test("strips arbitrary failure payloads from the typed response", () => {
    const response = decode({
      protocolVersion: 1,
      type: "failure",
      runID: "run-123",
      code: "worker-failed",
      cause: { token: "credential-canary" },
      stack: "private-stack-canary",
      debug: "private-debug-canary",
    })

    expect(encode(response)).toEqual({
      protocolVersion: 1,
      type: "failure",
      runID: "run-123",
      code: "worker-failed",
    })
    expect(JSON.stringify(response)).not.toContain("canary")
  })

  test("rejects unsupported versions and response discriminators", () => {
    expect(() => decode({ protocolVersion: 2, type: "availability", availability: { status: "available" } })).toThrow()
    expect(() => decode({ protocolVersion: 1, type: "debug", payload: {} })).toThrow()
  })
})
