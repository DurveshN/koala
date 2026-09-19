import { SandboxPolicy } from "@koala-ai/core/sandbox/policy"
import { SandboxProtocol } from "@koala-ai/core/sandbox/protocol"
import { PositiveInt } from "@opencode-ai/core/schema"
import { Effect, Schema } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
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
})

type Metadata = {
  exit: number | null
  timedOut: boolean
  cancelled: boolean
  truncated: boolean
  violations: ReadonlyArray<SandboxProtocol.Violation>
}

export const SandboxExecuteTool = Tool.define<typeof Parameters, Metadata, RuntimeFlags.Service>(
  "sandbox_execute",
  Effect.gen(function* () {
    const flags = yield* RuntimeFlags.Service

    return {
      description:
        "Run a command in a temporary native OS sandbox. Network access is disabled, the active project is read-only, and writes are limited to the temporary working directory.",
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
            const directory = yield* Effect.acquireRelease(
              Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "koala-sandbox-"))),
              (temporary) => Effect.promise(() => fs.rm(temporary, { recursive: true, force: true })),
            )
            const runID = Schema.decodeUnknownSync(SandboxProtocol.RunID)(randomUUID())
            const request = SandboxPolicy.buildRequest(
              {
                cwd: directory,
                readRoots: [instance.directory, directory],
                writeRoots: [directory],
              },
              params.command,
              { timeoutMs: params.timeout },
            )
            const response = yield* Effect.promise(() => SandboxRuntime.execute(runID, request, { signal: ctx.abort }))
            if (response.type === "failure") throw new Error(`Sandbox execution unavailable (${response.code})`)
            if (response.type !== "result") throw new Error("Sandbox worker returned an invalid response")

            const sections = [
              response.result.stdout ? `stdout:\n${response.result.stdout}` : "",
              response.result.stderr ? `stderr:\n${response.result.stderr}` : "",
            ].filter(Boolean)
            const output = sections.join("\n\n") || "(no output)"
            return {
              title: params.command,
              output,
              metadata: {
                exit: response.result.exitCode,
                timedOut: response.result.timedOut,
                cancelled: response.result.cancelled,
                truncated: response.result.outputTruncated,
                violations: response.result.violations,
              },
            }
          }),
        ),
    }
  }),
)
