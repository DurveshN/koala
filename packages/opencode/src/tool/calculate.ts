import { calculateEffect } from "@koala-ai/core/calculate/evaluator"
import { CalculationError, Engine, Input, Result, safeSummary, summarize } from "@koala-ai/core/calculate/tool"
import { IndustrialProjection } from "@koala-ai/core/industrial/projection"
import { IndustrialResult } from "@koala-ai/core/industrial/result"
import { Effect } from "effect"
import { IndustrialExecution } from "@/koala/industrial-execution"
import { Tool } from "./tool"

export const DeadlineMs = 5_000

type Metadata = {
  readonly result: typeof Result.Type
  readonly projection: IndustrialProjection.Output
  readonly truncated: boolean
}

export function makeCalculateTool(deadlineMs = DeadlineMs, onEvaluationStart?: () => void) {
  return Tool.define<typeof Input, Metadata, IndustrialExecution.Service>(
    "calculate",
    Effect.gen(function* () {
      const execution = yield* IndustrialExecution.Service

      return {
        description:
          "Evaluate bounded deterministic decimal arithmetic, functions, percentages, dimensional units, and unit conversions. Use `to` for conversion, for example `1 km + 250 m to m`.",
        parameters: Input,
        execute: (params, context) => {
          const makeError = (
            code: IndustrialResult.ErrorCode,
            summary = `Calculation failed: ${code}`,
          ): typeof Result.Type => {
            const common = {
              tool: "calculate" as const,
              contractVersion: 1 as const,
              engine: Engine,
              status: "error" as const,
              sources: [],
              outputs: [],
              citations: [],
              producerTruncated: false,
              summary,
            }
            if (code === "cancelled") {
              return { ...common, cancelled: true, timedOut: false, error: { code, retryable: true } }
            }
            if (code === "deadline-exceeded") {
              return { ...common, cancelled: false, timedOut: true, error: { code, retryable: true } }
            }
            return { ...common, cancelled: false, timedOut: false, error: { code, retryable: false } }
          }

          return execution
            .execute({
              tool: "calculate",
              permission: "calculate",
              engine: Engine,
              input: params,
              inputSchema: Input,
              inputSummary: summarize(),
              sourceArtifactIDs: [],
              resultSchema: Result,
              context,
              permissionRequest: { patterns: ["*"], always: ["*"], metadata: {} },
              deadlineMs,
              operation: (signal) =>
                calculateEffect(params, signal, onEvaluationStart).pipe(
                  Effect.map((data) => ({
                    tool: "calculate" as const,
                    contractVersion: 1 as const,
                    engine: Engine,
                    status: "success" as const,
                    cancelled: false as const,
                    timedOut: false as const,
                    sources: [],
                    outputs: [],
                    citations: [],
                    producerTruncated: false,
                    summary: `Calculation completed: ${data.value}${data.unit ? ` ${data.unit}` : ""}; precision=${data.precision}; operations=${data.operationCount}`,
                    data,
                  })),
                  Effect.catch((error) =>
                    Effect.succeed(
                      error.code === "cancelled" && !context.abort.aborted
                        ? makeError("deadline-exceeded")
                        : makeError(mapCalculationError(error), safeSummary(error)),
                    ),
                  ),
                ),
              mapError: () => "internal-error",
              makeError,
            })
            .pipe(
              Effect.map((output) => ({
                title: "Calculation",
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
}

export const CalculateTool = makeCalculateTool()

function mapCalculationError(error: CalculationError): IndustrialResult.ErrorCode {
  if (error.code === "cancelled") return "cancelled"
  if (
    error.code === "expression-limit" ||
    error.code === "token-limit" ||
    error.code === "literal-digit-limit" ||
    error.code === "literal-exponent-limit" ||
    error.code === "nesting-limit" ||
    error.code === "node-limit" ||
    error.code === "argument-limit" ||
    error.code === "power-exponent-limit" ||
    error.code === "result-out-of-range"
  ) {
    return "limit-exceeded"
  }
  return "invalid-input"
}
