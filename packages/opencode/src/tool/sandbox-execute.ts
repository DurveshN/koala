import { randomUUID } from "node:crypto"
import path from "node:path"
import { Artifact } from "@koala-ai/core/artifact/artifact"
import { ArtifactStore } from "@koala-ai/core/artifact/store"
import { IndustrialProjection } from "@koala-ai/core/industrial/projection"
import { IndustrialResult } from "@koala-ai/core/industrial/result"
import { SandboxPolicy } from "@koala-ai/core/sandbox/policy"
import { SandboxProtocol } from "@koala-ai/core/sandbox/protocol"
import { SandboxTool } from "@koala-ai/core/sandbox/tool"
import { Cause, Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { IndustrialExecution } from "@/koala/industrial-execution"
import { SandboxRuntime } from "@/sandbox/runtime"
import { Tool } from "./tool"

type Metadata = {
  readonly result: SandboxTool.Result
  readonly projection: IndustrialProjection.Output
  readonly truncated: boolean
}

type EngineError = ArtifactStore.StagingError | ArtifactStore.PromoteError

export const Parameters = SandboxTool.Input

export const SandboxExecuteTool = Tool.define<
  typeof SandboxTool.Input,
  Metadata,
  RuntimeFlags.Service | ArtifactStore.Service | SandboxRuntime.Service | IndustrialExecution.Service
>(
  "sandbox_execute",
  Effect.gen(function* () {
    const flags = yield* RuntimeFlags.Service
    const artifacts = yield* ArtifactStore.Service
    const runtime = yield* SandboxRuntime.Service
    const execution = yield* IndustrialExecution.Service

    return {
      description:
        "Run a command in a temporary native OS sandbox. Network access is disabled, the active project is read-only, and writes are limited to work/ and artifacts/. Declare files beneath artifacts/ in outputs to publish them.",
      parameters: SandboxTool.Input,
      execute: (params, ctx) => {
        const runID = Schema.decodeUnknownSync(SandboxProtocol.RunID)(randomUUID())
        const makeError = (
          code: IndustrialResult.ErrorCode,
          summary = errorSummary(code),
          producerTruncated = false,
        ): SandboxTool.Result => {
          const common = {
            tool: "sandbox_execute" as const,
            contractVersion: 1 as const,
            engine: SandboxTool.Engine,
            status: "error" as const,
            sources: [],
            outputs: [],
            citations: [],
            producerTruncated,
            sandboxRunID: runID,
            summary,
          }
          if (code === "cancelled") {
            return {
              ...common,
              cancelled: true,
              timedOut: false,
              error: { code, retryable: true },
            }
          }
          if (code === "deadline-exceeded") {
            return {
              ...common,
              cancelled: false,
              timedOut: true,
              error: { code, retryable: true },
            }
          }
          return {
            ...common,
            cancelled: false,
            timedOut: false,
            error: { code, retryable: retryable(code) },
          }
        }

        return execution
          .execute({
            tool: "sandbox_execute",
            permission: "sandbox_execute",
            engine: SandboxTool.Engine,
            input: params,
            inputSchema: SandboxTool.Input,
            inputSummary: SandboxTool.summarize(params),
            sourceArtifactIDs: [],
            resultSchema: SandboxTool.Result,
            context: ctx,
            permissionRequest: {
              patterns: [params.command],
              always: [params.command],
              metadata: { command: params.command },
            },
            sandboxRunID: runID,
            operation: (signal, commit) => {
              if (flags.agentExecution !== "sandbox" && flags.agentExecution !== "both") {
                return Effect.succeed(makeError("engine-unavailable"))
              }
              return executeSandbox(artifacts, runtime, params, ctx, runID, signal, commit, makeError)
            },
            mapError: mapEngineError,
            makeError,
          })
          .pipe(
            Effect.map((output) => ({
              title: "Sandbox execution",
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

function executeSandbox(
  artifacts: ArtifactStore.Interface,
  runtime: SandboxRuntime.Interface,
  params: SandboxTool.Input,
  ctx: Tool.Context,
  runID: SandboxProtocol.RunID,
  signal: AbortSignal,
  commit: IndustrialExecution.CommitBoundary,
  makeError: (code: IndustrialResult.ErrorCode, summary?: string, producerTruncated?: boolean) => SandboxTool.Result,
): Effect.Effect<SandboxTool.Result, EngineError> {
  return Effect.gen(function* () {
    const instance = yield* InstanceState.context
    const staging = yield* artifacts.stage(runID)
    return yield* Effect.gen(function* () {
      const request = SandboxPolicy.buildRequest(
        {
          cwd: staging.root,
          readRoots: [instance.directory, staging.root],
          writeRoots: [staging.work, staging.artifacts],
        },
        params.command,
        { timeoutMs: params.timeout },
      )
      const response = yield* runtime.execute(runID, request, { signal })
      if (response.type === "failure") return makeError(mapWorkerFailure(response.code))
      if (response.type !== "result") return makeError("protocol-error")

      const captured = capture(response.result, staging)
      const terminal = terminalCode(response.result, captured.producerTruncated)
      if (terminal) {
        const summary = summarize(captured, terminal)
        return makeError(terminal, summary.text, captured.producerTruncated || summary.truncated)
      }
      if (signal.aborted) return makeError(signal.reason === "deadline-exceeded" ? "deadline-exceeded" : "cancelled")

      const summary = summarize(captured)
      const success = (metadata: ReadonlyArray<Artifact.Metadata>) =>
        Schema.decodeUnknownSync(SandboxTool.Result)({
          tool: "sandbox_execute" as const,
          contractVersion: 1 as const,
          engine: SandboxTool.Engine,
          status: "success",
          cancelled: false,
          timedOut: false,
          sources: [],
          outputs: metadata.map(reference),
          citations: [],
          producerTruncated: summary.truncated,
          sandboxRunID: runID,
          summary: summary.text,
          data: {
            exitCode: response.result.exitCode,
            stdout: captured.stdout,
            stderr: captured.stderr,
            violations: captured.violations,
          },
        })
      if ((params.outputs?.length ?? 0) === 0) return success([])

      let committedResult: SandboxTool.Result | undefined
      const promoted = yield* artifacts.promoteBatch(
        (params.outputs ?? []).map((outputPath) => ({
          runID,
          outputPath,
          provenance: {
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            toolName: "sandbox_execute",
            toolCallID: ctx.callID,
            sandboxRunID: runID,
          },
        })),
        {
          signal,
          commit: {
            boundary: commit,
            result: (metadata) => {
              committedResult = success(metadata)
              return committedResult
            },
          },
        },
      )
      return committedResult ?? success(promoted)
    }).pipe(
      Effect.ensuring(
        artifacts
          .abandon(runID)
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("artifact staging cleanup failed", { runID, cause: Cause.pretty(cause) }),
            ),
          ),
      ),
    )
  })
}

function capture(result: SandboxProtocol.ExecutionResult, staging: ArtifactStore.Staging) {
  const stdout = redactArtifactPaths(result.stdout, staging)
  const stderr = redactArtifactPaths(result.stderr, staging)
  const stdoutBytes = new TextEncoder().encode(stdout)
  const keptStdout = truncateUtf8(stdout, SandboxTool.MaxCapturedOutputBytes)
  const stderrLimit = Math.max(0, SandboxTool.MaxCapturedOutputBytes - new TextEncoder().encode(keptStdout).byteLength)
  const keptStderr = truncateUtf8(stderr, stderrLimit)
  const violations = result.violations.slice(0, SandboxTool.MaxViolations).map((violation) => ({
    ...violation,
    ...(violation.target ? { target: redactArtifactPaths(violation.target, staging) } : {}),
  }))
  return {
    stdout: keptStdout,
    stderr: keptStderr,
    violations,
    producerTruncated:
      result.outputTruncated ||
      stdoutBytes.byteLength + new TextEncoder().encode(stderr).byteLength > SandboxTool.MaxCapturedOutputBytes ||
      violations.length !== result.violations.length,
  }
}

function terminalCode(result: SandboxProtocol.ExecutionResult, producerTruncated: boolean) {
  if (result.cancelled) return "cancelled" as const
  if (result.timedOut) return "deadline-exceeded" as const
  if (result.violations.length > 0) return "sandbox-violation" as const
  if (producerTruncated) return "output-truncated" as const
  if (result.exitCode !== 0) return "sandbox-nonzero-exit" as const
}

function mapWorkerFailure(code: SandboxProtocol.FailureCode): IndustrialResult.GeneralErrorCode {
  if (code === "invalid-request") return "invalid-input"
  if (code === "protocol-mismatch") return "protocol-error"
  if (code === "sandbox-unavailable") return "engine-unavailable"
  return "engine-failed"
}

function mapEngineError(error: EngineError): IndustrialResult.GeneralErrorCode {
  if (error instanceof ArtifactStore.LimitError) return "limit-exceeded"
  if (error instanceof ArtifactStore.ValidationError || error instanceof ArtifactStore.InvalidOutputPathError) {
    return "validation-failed"
  }
  return "artifact-storage-failed"
}

function retryable(code: IndustrialResult.ErrorCode) {
  return ["cancelled", "deadline-exceeded", "engine-unavailable", "engine-failed", "artifact-storage-failed"].includes(
    code,
  )
}

function errorSummary(code: IndustrialResult.ErrorCode) {
  return `Sandbox execution failed: ${code}`
}

function summarize(captured: ReturnType<typeof capture>, code?: IndustrialResult.ErrorCode) {
  const sections = [
    code ? errorSummary(code) : "Sandbox execution completed.",
    captured.stdout ? `stdout:\n${captured.stdout}` : "",
    captured.stderr ? `stderr:\n${captured.stderr}` : "",
    captured.violations.length
      ? `violations:\n${captured.violations.map((violation) => JSON.stringify(violation)).join("\n")}`
      : "",
  ].filter(Boolean)
  const summary = sections.join("\n\n") || "(no output)"
  if (new TextEncoder().encode(summary).byteLength <= SandboxTool.MaxSummaryBytes) {
    return { text: summary, truncated: false }
  }
  const suffix = `\n${SandboxTool.SummaryTruncationMarker}`
  return {
    text: `${truncateUtf8(summary, SandboxTool.MaxSummaryBytes - new TextEncoder().encode(suffix).byteLength)}${suffix}`,
    truncated: true,
  }
}

function reference(metadata: Artifact.Metadata): Artifact.Reference {
  return {
    id: metadata.id,
    name: metadata.name,
    mime: metadata.mime,
    size: metadata.size,
    digest: metadata.digest,
  }
}

function truncateUtf8(value: string, maximum: number) {
  const bytes = new TextEncoder().encode(value)
  if (bytes.byteLength <= maximum) return value
  let end = maximum
  while (end > 0 && end < bytes.byteLength && (bytes[end] ?? 0) >> 6 === 2) end--
  return new TextDecoder().decode(bytes.subarray(0, end))
}

function redactArtifactPaths(value: string, staging: ArtifactStore.Staging) {
  const artifactRoot = path.dirname(path.dirname(staging.root))
  const replacements = [
    [staging.root, "[artifact-staging]"],
    [artifactRoot, "[artifact-store]"],
  ] as const
  return replacements.reduce((output, [absolute, replacement]) => {
    const forms = new Set([absolute, absolute.replaceAll("\\", "/"), absolute.replaceAll("/", "\\")])
    return Array.from(forms).reduce(
      (redacted, form) =>
        redacted.replace(new RegExp(escapeRegExp(form), process.platform === "win32" ? "gi" : "g"), replacement),
      output,
    )
  }, value)
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
