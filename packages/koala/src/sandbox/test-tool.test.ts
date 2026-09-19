import { describe, expect, test } from "bun:test"
import { Result, Schema } from "effect"
import { SandboxTestTool } from "./test-tool"
import { SandboxTool } from "./tool"

const passed = { passed: true, reason: "passed" } as const
const notRun = { passed: false, reason: "not-run" } as const

const probes = {
  runtimeAvailability: passed,
  stagingRead: passed,
  stagingWrite: passed,
  projectReadDenied: passed,
  projectWriteDenied: passed,
  externalReadDenied: passed,
  externalWriteDenied: passed,
  loopbackTcpDenied: passed,
  cancellation: passed,
  cleanup: passed,
}

describe("SandboxTestTool", () => {
  test("accepts exactly an empty object as model input", () => {
    const decode = Schema.decodeUnknownResult(SandboxTestTool.Input)
    expect(Result.isSuccess(decode({}))).toBe(true)
    expect(Result.isFailure(decode({ command: "credential-canary" }))).toBe(true)
    expect(Result.isFailure(decode([]))).toBe(true)
    expect(Result.isFailure(decode(null))).toBe(true)
  })

  test("uses the shared sandbox engine and a zero-sensitive input summary", () => {
    expect(SandboxTestTool.Engine).toBe(SandboxTool.Engine)
    expect(SandboxTestTool.summarize()).toEqual({
      sourceCount: 0,
      artifactCount: 0,
      pathCount: 0,
      declaredOutputCount: 0,
    })
  })

  test("requires every named probe and keeps healthy consistent", () => {
    const decode = Schema.decodeUnknownResult(SandboxTestTool.Data)
    expect(Result.isSuccess(decode({ healthy: true, probes }))).toBe(true)
    expect(Result.isFailure(decode({ healthy: false, probes }))).toBe(true)
    expect(
      Result.isFailure(
        decode({
          healthy: false,
          probes: { ...probes, cleanup: undefined },
        }),
      ),
    ).toBe(true)
    expect(
      Result.isSuccess(
        decode({
          healthy: false,
          probes: { ...probes, cleanup: { passed: false, reason: "cleanup-failed" } },
        }),
      ),
    ).toBe(true)
  })

  test("rejects open-ended or inconsistent diagnostic reasons", () => {
    const decode = Schema.decodeUnknownResult(SandboxTestTool.Outcome)
    expect(Result.isSuccess(decode(passed))).toBe(true)
    expect(Result.isSuccess(decode(notRun))).toBe(true)
    expect(Result.isFailure(decode({ passed: true, reason: "not-run" }))).toBe(true)
    expect(Result.isFailure(decode({ passed: false, reason: "native stderr canary" }))).toBe(true)
  })

  test("wraps diagnostics in the industrial result envelope", () => {
    const result = Schema.decodeUnknownSync(SandboxTestTool.Result)({
      tool: "sandbox_test",
      contractVersion: 1,
      engine: SandboxTestTool.Engine,
      status: "success",
      cancelled: false,
      timedOut: false,
      sources: [],
      outputs: [],
      citations: [],
      producerTruncated: false,
      sandboxRunID: "sandbox-test-contract",
      summary: SandboxTestTool.safeSummary({ healthy: true, probes }),
      data: { healthy: true, probes },
    })

    expect(result.tool).toBe("sandbox_test")
    expect(result.outputs).toEqual([])
  })

  test("renders only fixed probe labels and stable reasons", () => {
    const data = Schema.decodeUnknownSync(SandboxTestTool.Data)({
      healthy: false,
      probes: {
        ...probes,
        runtimeAvailability: { passed: false, reason: "initialization-failed" },
        stagingRead: notRun,
        stagingWrite: notRun,
        projectReadDenied: notRun,
        projectWriteDenied: notRun,
        externalReadDenied: notRun,
        externalWriteDenied: notRun,
        loopbackTcpDenied: notRun,
        cancellation: notRun,
        cleanup: notRun,
      },
    })
    const summary = SandboxTestTool.safeSummary(data)

    expect(summary).toContain("runtimeAvailability=initialization-failed")
    expect(summary).toContain("projectReadDenied=not-run")
    expect(summary).not.toContain("credential-canary")
    expect(summary).not.toMatch(/[A-Z]:[\\/]|https?:|\\\\|\/private\//)
  })

  test("does not render unknown properties from decoded diagnostic data", () => {
    const data = Schema.decodeUnknownSync(SandboxTestTool.Data)({
      healthy: true,
      probes: { ...probes, "credential-canary": { passed: true, reason: "passed" } },
    })

    expect(SandboxTestTool.safeSummary(data)).not.toContain("credential-canary")
  })
})
