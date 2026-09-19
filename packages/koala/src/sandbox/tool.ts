export * as SandboxTool from "./tool"

import { Schema } from "effect"
import { Artifact } from "../artifact/artifact"
import { IndustrialInput } from "../industrial/input"
import { IndustrialResult } from "../industrial/result"
import { IndustrialTool } from "../industrial/tool"
import { SandboxProtocol } from "./protocol"

export const MaxTimeoutMs = 120_000
export const MaxCommandBytes = 32 * 1024
export const MaxCapturedOutputBytes = 1024 * 1024
export const MaxViolations = 100
export const MaxSummaryBytes = 16 * 1024
export const SummaryTruncationMarker = "sandbox_summary_truncated=true"

export const Engine = Schema.decodeUnknownSync(IndustrialTool.Engine)({
  name: "anthropic-sandbox-runtime",
  version: "0.0.76",
})

export const Command = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.makeFilter((value) => {
    if (value !== value.trim()) return "Expected a trimmed command"
    if (value.includes("\0")) return "Commands cannot contain null bytes"
    return byteLength(value) <= MaxCommandBytes ? undefined : `Command exceeds ${MaxCommandBytes} UTF-8 bytes`
  }),
)

export interface Input extends Schema.Schema.Type<typeof Input> {}
export const Input = Schema.Struct({
  command: Command,
  timeout: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(MaxTimeoutMs))),
  outputs: Schema.optionalKey(Artifact.OutputPaths),
}).annotate({ identifier: "SandboxTool.Input" })

export const Violations = Schema.Array(SandboxProtocol.Violation).check(Schema.isMaxLength(MaxViolations))

export interface Data extends Schema.Schema.Type<typeof Data> {}
export const Data = Schema.Struct({
  exitCode: Schema.NullOr(Schema.Int),
  stdout: Schema.String,
  stderr: Schema.String,
  violations: Violations,
}).check(
  Schema.makeFilter((result) =>
    byteLength(result.stdout) + byteLength(result.stderr) <= MaxCapturedOutputBytes
      ? undefined
      : `Captured output exceeds ${MaxCapturedOutputBytes} UTF-8 bytes`,
  ),
)

export const Result = IndustrialResult.make("sandbox_execute", Data)
export type Result = typeof Result.Type

export function summarize(input: Input): IndustrialInput.Summary {
  return IndustrialInput.summarize([], input.outputs?.length ?? 0)
}

function byteLength(value: string) {
  return new TextEncoder().encode(value).byteLength
}
