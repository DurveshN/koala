export * as CalculateTool from "./tool"

import { Schema } from "effect"
import { IndustrialInput } from "../industrial/input"
import { IndustrialResult } from "../industrial/result"
import { IndustrialTool } from "../industrial/tool"

export const DefaultPrecision = 34
export const MinPrecision = 1
export const MaxPrecision = 100
export const MaxExpressionBytes = 4 * 1024
export const MaxTokens = 1_024
export const MaxNodes = 2_048
export const MaxDepth = 64
export const MaxLiteralDigits = 1_000
export const MaxExponent = 10_000
export const MaxFunctionArguments = 256

export const Engine = Schema.decodeUnknownSync(IndustrialTool.Engine)({
  name: "koala-decimal-calculator",
  version: "1",
})

export const Expression = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.makeFilter((value) =>
    new TextEncoder().encode(value).byteLength <= MaxExpressionBytes
      ? undefined
      : `Expression exceeds ${MaxExpressionBytes} UTF-8 bytes`,
  ),
)

export interface Input extends Schema.Schema.Type<typeof Input> {}
export const Input = Schema.Struct({
  expression: Expression,
  precision: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(MinPrecision), Schema.isLessThanOrEqualTo(MaxPrecision)),
  ),
}).annotate({ identifier: "CalculateTool.Input" })

export interface Span extends Schema.Schema.Type<typeof Span> {}
export const Span = Schema.Struct({
  start: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  end: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})
  .check(Schema.makeFilter((span) => (span.end >= span.start ? undefined : "Span end must not precede start")))
  .annotate({ identifier: "CalculateTool.Span" })

export const ErrorCode = Schema.Literals([
  "cancelled",
  "expression-limit",
  "precision-out-of-range",
  "token-limit",
  "literal-digit-limit",
  "literal-exponent-limit",
  "unexpected-token",
  "expected-expression",
  "expected-token",
  "unknown-identifier",
  "nesting-limit",
  "node-limit",
  "argument-limit",
  "invalid-arity",
  "division-by-zero",
  "domain-error",
  "dimension-mismatch",
  "unit-required",
  "unit-not-allowed",
  "power-exponent-limit",
  "dimensional-power-not-integer",
  "result-out-of-range",
])
export type ErrorCode = typeof ErrorCode.Type

export class CalculationError extends Schema.TaggedErrorClass<CalculationError>()("CalculateError", {
  code: ErrorCode,
  span: Span,
}) {
  override get message() {
    return `Calculation failed: ${this.code} at ${this.span.start}-${this.span.end}`
  }
}

export interface Data extends Schema.Schema.Type<typeof Data> {}
export const Data = Schema.Struct({
  value: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(16 * 1024)),
  unit: Schema.optionalKey(Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256))),
  precision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(MinPrecision), Schema.isLessThanOrEqualTo(MaxPrecision)),
  operationCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(MaxNodes)),
}).annotate({ identifier: "CalculateTool.Data" })

export const Result = IndustrialResult.make("calculate", Data)
export type Result = typeof Result.Type

export function summarize(): IndustrialInput.Summary {
  return IndustrialInput.summarize([])
}

export function safeSummary(error?: CalculationError) {
  return error ? error.message : "Calculation completed."
}
