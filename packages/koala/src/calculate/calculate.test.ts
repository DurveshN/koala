import { describe, expect, test } from "bun:test"
import { Effect, Result, Schema } from "effect"
import { calculate, calculateEffect } from "./evaluator"
import { CalculateParser } from "./parser"
import { CalculateTool } from "./tool"
import { tokenize } from "./tokenizer"

const value = (expression: string, precision?: number) => calculate({ expression, ...(precision ? { precision } : {}) })

describe("CalculateTool contracts", () => {
  test("accepts bounded inputs and defines a checked industrial result", () => {
    expect(Schema.decodeUnknownSync(CalculateTool.Input)({ expression: "1 + 2" })).toEqual({ expression: "1 + 2" })
    expect(
      Result.isSuccess(
        Schema.decodeUnknownResult(CalculateTool.Result)({
          tool: "calculate",
          contractVersion: 1,
          engine: CalculateTool.Engine,
          status: "success",
          cancelled: false,
          timedOut: false,
          sources: [],
          outputs: [],
          citations: [],
          producerTruncated: false,
          summary: "Calculation completed.",
          data: value("1 + 2"),
        }),
      ),
    ).toBe(true)
    expect(CalculateTool.summarize()).toEqual({
      sourceCount: 0,
      artifactCount: 0,
      pathCount: 0,
      declaredOutputCount: 0,
    })
  })

  test.each([0, 101, 1.5])("rejects precision %p", (precision) => {
    expect(Result.isFailure(Schema.decodeUnknownResult(CalculateTool.Input)({ expression: "1", precision }))).toBe(true)
    expectError(() => calculate({ expression: "1", precision } as CalculateTool.Input), "precision-out-of-range", 0, 0)
  })

  test.each([CalculateTool.MinPrecision, CalculateTool.MaxPrecision])("accepts precision boundary %p", (precision) => {
    expect(value("1", precision).precision).toBe(precision)
  })

  test("bounds expression bytes without including it in summaries", () => {
    const expression = "1".repeat(CalculateTool.MaxExpressionBytes + 1)
    expect(Result.isFailure(Schema.decodeUnknownResult(CalculateTool.Input)({ expression }))).toBe(true)
    expectError(
      () => calculate({ expression } as CalculateTool.Input),
      "expression-limit",
      0,
      CalculateTool.MaxExpressionBytes + 1,
    )
    const error = new CalculateTool.CalculationError({ code: "division-by-zero", span: { start: 4, end: 5 } })
    expect(CalculateTool.safeSummary(error)).toBe("Calculation failed: division-by-zero at 4-5")
    expect(CalculateTool.safeSummary(error)).not.toContain("credential-canary")
  })
})

describe("calculator grammar and decimal arithmetic", () => {
  test.each([
    [".5 + 1.25", "1.75"],
    ["1.2e3 + 4E-2", "1200.04"],
    ["2^3^2", "512"],
    ["-2^2", "-4"],
    ["(-2)^2", "4"],
    ["2^-2", "0.25"],
    ["200 * 10%", "20"],
    ["round(2.5)", "2"],
    ["round(3.5)", "4"],
    ["abs(-3) + floor(2.9) + ceil(2.1) + trunc(-2.9)", "6"],
    ["min(4, 2, 8) + max(4, 2, 8)", "10"],
    ["sum(1, 2, 3) + avg(2, 4, 6)", "10"],
    ["sqrt(81) + cbrt(27)", "12"],
    ["pow(2, 8) + mod(17, 5)", "258"],
  ])("evaluates %s", (expression, expected) => {
    expect(value(expression).value).toBe(expected)
  })

  test("clones decimal configuration per call and uses half-even rounding", () => {
    expect(value("2 / 3", 5)).toEqual({ value: "0.66667", precision: 5, operationCount: 1 })
    expect(value("2 / 3").value).toBe("0.6666666666666666666666666666666667")
    expect(value("1.245 + 0", 3).value).toBe("1.24")
    expect(value("1.255 + 0", 3).value).toBe("1.26")
  })

  test("reports deterministic operation counts", () => {
    expect(value("-(2 + 3) * 4%").operationCount).toBe(4)
    expect(value("42").operationCount).toBe(0)
  })
})

describe("calculator dimensions and units", () => {
  test.each([
    ["1 km + 250 m to m", { value: "1250", unit: "m" }],
    ["12 in to cm", { value: "30.48", unit: "cm" }],
    ["1 lb to g", { value: "453.59237", unit: "g" }],
    ["2 day to h", { value: "48", unit: "h" }],
    ["1 GiB to MB", { value: "1073.741824", unit: "MB" }],
    ["180 deg to rad", { value: "3.141592653589793238462643383279503", unit: "rad" }],
    ["10 m / 2 s", { value: "5", unit: "m/s" }],
    ["100 km / 2 h to m/s", { value: "13.88888888888888888888888888888889", unit: "m/s" }],
    ["2 kg * 3 m / 2 s", { value: "3", unit: "m*kg/s" }],
    ["2^2 m", { value: "4", unit: "m" }],
    ["-2^2 m", { value: "-4", unit: "m" }],
    ["2 m^2", { value: "2", unit: "m^2" }],
    ["2 m^+2", { value: "2", unit: "m^2" }],
    ["2 m^-2", { value: "2", unit: "1/m^2" }],
    ["2 m^2 to cm^2", { value: "20000", unit: "cm^2" }],
    ["(3 m)^2", { value: "9", unit: "m^2" }],
    ["(2 m)^2", { value: "4", unit: "m^2" }],
    ["sqrt((3 m)^2)", { value: "3", unit: "m" }],
  ])("normalizes %s", (expression, expected) => {
    expect(value(expression)).toMatchObject(expected)
  })

  test.each([
    ["100 cm to m", "1"],
    ["1000 mm to m", "1"],
    ["1 ft to in", "12"],
    ["1 yd to ft", "3"],
    ["1 mi to ft", "5280"],
    ["1000000 mg to kg", "1"],
    ["16 oz to lb", "1"],
    ["1000 ms to s", "1"],
    ["60 min to h", "1"],
    ["24 h to day", "1"],
    ["1000 B to KB", "1"],
    ["1000 KB to MB", "1"],
    ["1000 MB to GB", "1"],
    ["1024 B to KiB", "1"],
    ["1024 KiB to MiB", "1"],
    ["1024 MiB to GiB", "1"],
  ])("covers the closed conversion registry: %s", (expression, expected) => {
    expect(value(expression).value).toBe(expected)
  })

  test.each([
    ["1 m + 1 s", "dimension-mismatch"],
    ["1 m to kg", "dimension-mismatch"],
    ["1 to m", "unit-required"],
    ["1 m cm", "unit-not-allowed"],
    ["(2 m)^0.5", "dimensional-power-not-integer"],
    ["sqrt(2 m)", "dimensional-power-not-integer"],
    ["1 parsec", "unknown-identifier"],
    ["1 constructor", "unknown-identifier"],
  ])("rejects invalid dimensional expression %s", (expression, code) => {
    expectError(() => value(expression), code as CalculateTool.ErrorCode)
  })

  test("tracks source-unit identifier and signed exponent spans separately", () => {
    expect(CalculateParser.parse("2 meter^-12").root).toMatchObject({
      type: "unit",
      unit: {
        unit: "meter",
        power: -12,
        span: { start: 2, end: 11 },
        identifierSpan: { start: 2, end: 7 },
        exponentSpan: { start: 8, end: 11 },
      },
    })
    expectError(() => value("1 constructor^2"), "unknown-identifier", 2, 13)
    expectError(() => value("1 m^1.5"), "dimensional-power-not-integer", 4, 7)
    expectError(() => value("1 m^+10001"), "power-exponent-limit", 4, 10)
    expectError(() => value("1 m^-10001"), "power-exponent-limit", 4, 10)
  })

  test("treats a zero unit power as scalar", () => {
    expect(value("2 m^0")).toEqual({ value: "2", precision: 34, operationCount: 1 })
  })
})

describe("calculator limits and curated errors", () => {
  test.each([
    ["1 / 0", "division-by-zero"],
    ["sqrt(-1)", "domain-error"],
    ["pow(2, 10001)", "power-exponent-limit"],
    ["1e10001", "literal-exponent-limit"],
    ["unknown(1)", "unknown-identifier"],
    ["toString(1)", "unknown-identifier"],
    ["constructor(1)", "unknown-identifier"],
    ["abs(1, 2)", "invalid-arity"],
    ["1 +", "expected-expression"],
    ["(1 + 2", "expected-token"],
    ["1 $ 2", "unexpected-token"],
  ])("returns %s as %s", (expression, code) => {
    expectError(() => value(expression), code as CalculateTool.ErrorCode)
  })

  test("reports precise source spans", () => {
    expectError(() => value("12 + 1 / 0"), "division-by-zero", 9, 10)
    expectError(() => value("1 parsec"), "unknown-identifier", 2, 8)
  })

  test("bounds total literal digits, tokens, nesting, and function arguments", () => {
    expectError(() => value("9".repeat(CalculateTool.MaxLiteralDigits + 1)), "literal-digit-limit")
    expectError(() => tokenize(`${"1+".repeat(CalculateTool.MaxTokens / 2)}1`), "token-limit")
    expectError(
      () => value(`${"(".repeat(CalculateTool.MaxDepth + 1)}1${")".repeat(CalculateTool.MaxDepth + 1)}`),
      "nesting-limit",
    )
    expectError(
      () => value(`sum(${Array.from({ length: CalculateTool.MaxFunctionArguments + 1 }, () => "1").join(",")})`),
      "argument-limit",
    )
  })

  test("accepts exact parser and arithmetic limits", () => {
    const maxTokenExpression = `+${"1+".repeat(CalculateTool.MaxTokens / 2 - 1)}1`
    expect(value(`${" ".repeat(CalculateTool.MaxExpressionBytes - 1)}1`).value).toBe("1")
    expect(value("9".repeat(CalculateTool.MaxLiteralDigits)).value).toBe("1e+1000")
    expect(tokenize(maxTokenExpression)).toHaveLength(CalculateTool.MaxTokens + 1)
    expect(value(maxTokenExpression).value).toBe(String(CalculateTool.MaxTokens / 2))
    expect(value(`${"(".repeat(CalculateTool.MaxDepth)}1${")".repeat(CalculateTool.MaxDepth)}`).value).toBe("1")
    expect(value(`sum(${Array.from({ length: CalculateTool.MaxFunctionArguments }, () => "1").join(",")})`).value).toBe(
      String(CalculateTool.MaxFunctionArguments),
    )
    expect(value(`1e${CalculateTool.MaxExponent}`).value).toBe(`1e+${CalculateTool.MaxExponent}`)
    expect(value(`1e-${CalculateTool.MaxExponent}`).value).toBe(`1e-${CalculateTool.MaxExponent}`)
    expect(value(`1 m^${CalculateTool.MaxExponent}`).unit).toBe(`m^${CalculateTool.MaxExponent}`)
    expect(value(`1 m^-${CalculateTool.MaxExponent}`).unit).toBe(`1/m^${CalculateTool.MaxExponent}`)
  })

  test("bounds result exponents and supports cancellation", () => {
    expectError(() => value("1e10000 * 10"), "result-out-of-range")
    expectError(() => value("1e-10000 / 10"), "result-out-of-range")
    const abort = new AbortController()
    abort.abort()
    expectError(() => calculate({ expression: "1 + 2" }, abort.signal), "cancelled", 0, 0)
  })

  test("cancels cooperatively after evaluation has started", async () => {
    const abort = new AbortController()
    const error = await Effect.runPromise(
      calculateEffect({ expression: Array.from({ length: 250 }, () => "1^1").join("+") }, abort.signal, () =>
        abort.abort(),
      ).pipe(Effect.flip),
    )

    expect(error).toBeInstanceOf(CalculateTool.CalculationError)
    expect(error.code).toBe("cancelled")
  })
})

function expectError(operation: () => unknown, code: CalculateTool.ErrorCode, start?: number, end?: number) {
  try {
    operation()
    throw new Error(`Expected ${code}`)
  } catch (error) {
    expect(error).toBeInstanceOf(CalculateTool.CalculationError)
    if (!(error instanceof CalculateTool.CalculationError)) throw error
    expect(error.code).toBe(code)
    if (start !== undefined) expect(error.span.start).toBe(start)
    if (end !== undefined) expect(error.span.end).toBe(end)
  }
}
