export * as SandboxTestTool from "./test-tool"

import { Schema } from "effect"
import { IndustrialInput } from "../industrial/input"
import { IndustrialResult } from "../industrial/result"
import { Engine } from "./tool"

export { Engine }

export const Input = Schema.Record(Schema.String, Schema.Never).annotate({ identifier: "SandboxTestTool.Input" })
export type Input = typeof Input.Type

export const FailureReason = Schema.Literals([
  "not-run",
  "unsupported-platform",
  "sandbox-unavailable",
  "initialization-failed",
  "worker-failed",
  "protocol-error",
  "staging-failed",
  "setup-failed",
  "probe-execution-failed",
  "probe-result-invalid",
  "staging-read-failed",
  "staging-write-failed",
  "project-read-allowed",
  "project-write-allowed",
  "external-read-allowed",
  "external-write-allowed",
  "loopback-tcp-allowed",
  "readiness-timeout",
  "cancellation-not-observed",
  "cancellation-timed-out",
  "cleanup-failed",
])
export type FailureReason = typeof FailureReason.Type

export const Outcome = Schema.Union([
  Schema.Struct({ passed: Schema.Literal(true), reason: Schema.Literal("passed") }),
  Schema.Struct({ passed: Schema.Literal(false), reason: FailureReason }),
]).annotate({ identifier: "SandboxTestTool.Outcome" })
export type Outcome = typeof Outcome.Type

export const ProbeNames = [
  "runtimeAvailability",
  "stagingRead",
  "stagingWrite",
  "projectReadDenied",
  "projectWriteDenied",
  "externalReadDenied",
  "externalWriteDenied",
  "loopbackTcpDenied",
  "cancellation",
  "cleanup",
] as const
export const ProbeName = Schema.Literals(ProbeNames)
export type ProbeName = typeof ProbeName.Type

export interface Probes extends Schema.Schema.Type<typeof Probes> {}
export const Probes = Schema.Struct({
  runtimeAvailability: Outcome,
  stagingRead: Outcome,
  stagingWrite: Outcome,
  projectReadDenied: Outcome,
  projectWriteDenied: Outcome,
  externalReadDenied: Outcome,
  externalWriteDenied: Outcome,
  loopbackTcpDenied: Outcome,
  cancellation: Outcome,
  cleanup: Outcome,
}).annotate({ identifier: "SandboxTestTool.Probes" })

export interface Data extends Schema.Schema.Type<typeof Data> {}
export const Data = Schema.Struct({
  healthy: Schema.Boolean,
  probes: Probes,
})
  .check(
    Schema.makeFilter((data) =>
      data.healthy === ProbeNames.every((name) => data.probes[name].passed)
        ? undefined
        : "Healthy must match all required probe outcomes",
    ),
  )
  .annotate({ identifier: "SandboxTestTool.Data" })

export const Result = IndustrialResult.make("sandbox_test", Data)
export type Result = typeof Result.Type

export function summarize(): IndustrialInput.Summary {
  return IndustrialInput.summarize([])
}

export function safeSummary(data: Data) {
  return [
    `Sandbox diagnostics ${data.healthy ? "passed" : "failed"}.`,
    ...ProbeNames.map((name) => `${name}=${data.probes[name].reason}`),
  ].join("\n")
}
