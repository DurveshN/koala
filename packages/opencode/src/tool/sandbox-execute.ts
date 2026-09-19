import { Artifact } from "@koala-ai/core/artifact/artifact"
import { ArtifactStore } from "@koala-ai/core/artifact/store"
import { SandboxPolicy } from "@koala-ai/core/sandbox/policy"
import { SandboxProtocol } from "@koala-ai/core/sandbox/protocol"
import { PositiveInt } from "@opencode-ai/core/schema"
import { Cause, Effect, Schema } from "effect"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { SandboxRuntime } from "@/sandbox/runtime"
import { Tool } from "./tool"

const MAX_TIMEOUT_MS = 120_000

export const Parameters = Schema.Struct({
  command: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty()).annotate({
    description: "The command to run inside the native sandbox",
  }),
  timeout: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_TIMEOUT_MS))).annotate({
    description: `Optional timeout in milliseconds, up to ${MAX_TIMEOUT_MS}`,
  }),
  outputs: Schema.optional(Artifact.OutputPaths).annotate({
    description: `Optional unique paths beneath artifacts/ to publish, up to ${Artifact.MaxOutputsPerRun}`,
  }),
})

type Metadata = {
  exit: number | null
  timedOut: boolean
  cancelled: boolean
  truncated: boolean
  violations: ReadonlyArray<SandboxProtocol.Violation>
  artifacts: ReadonlyArray<Artifact.Reference>
}

export const SandboxExecuteTool = Tool.define<
  typeof Parameters,
  Metadata,
  RuntimeFlags.Service | ArtifactStore.Service | SandboxRuntime.Service
>(
  "sandbox_execute",
  Effect.gen(function* () {
    const flags = yield* RuntimeFlags.Service
    const artifacts = yield* ArtifactStore.Service
    const runtime = yield* SandboxRuntime.Service

    return {
      description:
        "Run a command in a temporary native OS sandbox. Network access is disabled, the active project is read-only, and writes are limited to work/ and artifacts/. Declare files beneath artifacts/ in outputs to publish them.",
      parameters: Parameters,
      execute: (params, ctx) =>
        Effect.scoped(
          Effect.gen(function* () {
            if (flags.agentExecution !== "sandbox" && flags.agentExecution !== "both") {
              throw new Error("Sandbox execution is disabled")
            }
            yield* ctx.ask({
              permission: "sandbox_execute",
              patterns: [params.command],
              always: [params.command],
              metadata: { command: params.command },
            })

            const instance = yield* InstanceState.context
            const runID = Schema.decodeUnknownSync(SandboxProtocol.RunID)(randomUUID())
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
              const response = yield* runtime.execute(runID, request, { signal: ctx.abort })
              if (response.type === "failure") throw new Error(`Sandbox execution unavailable (${response.code})`)
              if (response.type !== "result") throw new Error("Sandbox worker returned an invalid response")

              const clean =
                response.result.exitCode === 0 &&
                !response.result.timedOut &&
                !response.result.cancelled &&
                !response.result.outputTruncated &&
                response.result.violations.length === 0
              const promoted = clean
                ? yield* Effect.forEach(
                    params.outputs ?? [],
                    Effect.fnUntraced(function* (outputPath) {
                      const metadata = yield* artifacts.promote({
                        runID,
                        outputPath,
                        provenance: {
                          sessionID: ctx.sessionID,
                          messageID: ctx.messageID,
                          toolName: "sandbox_execute",
                          ...(ctx.callID ? { toolCallID: ctx.callID } : {}),
                          sandboxRunID: runID,
                        },
                      })
                      return {
                        id: metadata.id,
                        name: metadata.name,
                        mime: metadata.mime,
                        size: metadata.size,
                        digest: metadata.digest,
                      } satisfies Artifact.Reference
                    }),
                    { concurrency: 1 },
                  )
                : []
              const stdout = redactArtifactPaths(response.result.stdout, staging)
              const stderr = redactArtifactPaths(response.result.stderr, staging)
              const violations = response.result.violations.map((violation) => ({
                ...violation,
                ...(violation.target ? { target: redactArtifactPaths(violation.target, staging) } : {}),
              }))
              const sections = [
                stdout ? `stdout:\n${stdout}` : "",
                stderr ? `stderr:\n${stderr}` : "",
                promoted.length
                  ? `artifacts:\n${promoted.map((reference) => `- ${JSON.stringify(reference)}`).join("\n")}`
                  : "",
              ].filter(Boolean)
              return {
                title: params.command,
                output: sections.join("\n\n") || "(no output)",
                metadata: {
                  exit: response.result.exitCode,
                  timedOut: response.result.timedOut,
                  cancelled: response.result.cancelled,
                  truncated: response.result.outputTruncated,
                  violations,
                  artifacts: promoted,
                },
              }
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
          }),
        ).pipe(Effect.orDie),
    }
  }),
)

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
