export * as CalculateEvaluator from "./evaluator"

import { Decimal } from "decimal.js"
import { Effect } from "effect"
import { CalculateParser, type Node } from "./parser"
import { CalculateTool } from "./tool"

type Dimension = readonly [length: number, mass: number, time: number, data: number, angle: number]

interface Quantity {
  readonly value: Decimal
  readonly dimension: Dimension
  readonly display?: Unit
}

interface UnitDefinition {
  readonly symbol: string
  readonly factor: string | "degrees"
  readonly dimension: Dimension
}

interface Unit extends UnitDefinition {
  readonly value: Decimal
}

const Scalar: Dimension = [0, 0, 0, 0, 0]
const Units = {
  m: { symbol: "m", factor: "1", dimension: [1, 0, 0, 0, 0] },
  km: { symbol: "km", factor: "1000", dimension: [1, 0, 0, 0, 0] },
  cm: { symbol: "cm", factor: "0.01", dimension: [1, 0, 0, 0, 0] },
  mm: { symbol: "mm", factor: "0.001", dimension: [1, 0, 0, 0, 0] },
  in: { symbol: "in", factor: "0.0254", dimension: [1, 0, 0, 0, 0] },
  ft: { symbol: "ft", factor: "0.3048", dimension: [1, 0, 0, 0, 0] },
  yd: { symbol: "yd", factor: "0.9144", dimension: [1, 0, 0, 0, 0] },
  mi: { symbol: "mi", factor: "1609.344", dimension: [1, 0, 0, 0, 0] },
  kg: { symbol: "kg", factor: "1", dimension: [0, 1, 0, 0, 0] },
  g: { symbol: "g", factor: "0.001", dimension: [0, 1, 0, 0, 0] },
  mg: { symbol: "mg", factor: "0.000001", dimension: [0, 1, 0, 0, 0] },
  lb: { symbol: "lb", factor: "0.45359237", dimension: [0, 1, 0, 0, 0] },
  oz: { symbol: "oz", factor: "0.028349523125", dimension: [0, 1, 0, 0, 0] },
  s: { symbol: "s", factor: "1", dimension: [0, 0, 1, 0, 0] },
  ms: { symbol: "ms", factor: "0.001", dimension: [0, 0, 1, 0, 0] },
  min: { symbol: "min", factor: "60", dimension: [0, 0, 1, 0, 0] },
  h: { symbol: "h", factor: "3600", dimension: [0, 0, 1, 0, 0] },
  day: { symbol: "day", factor: "86400", dimension: [0, 0, 1, 0, 0] },
  B: { symbol: "B", factor: "1", dimension: [0, 0, 0, 1, 0] },
  KB: { symbol: "KB", factor: "1000", dimension: [0, 0, 0, 1, 0] },
  MB: { symbol: "MB", factor: "1000000", dimension: [0, 0, 0, 1, 0] },
  GB: { symbol: "GB", factor: "1000000000", dimension: [0, 0, 0, 1, 0] },
  KiB: { symbol: "KiB", factor: "1024", dimension: [0, 0, 0, 1, 0] },
  MiB: { symbol: "MiB", factor: "1048576", dimension: [0, 0, 0, 1, 0] },
  GiB: { symbol: "GiB", factor: "1073741824", dimension: [0, 0, 0, 1, 0] },
  rad: { symbol: "rad", factor: "1", dimension: [0, 0, 0, 0, 1] },
  deg: { symbol: "deg", factor: "degrees", dimension: [0, 0, 0, 0, 1] },
} satisfies Readonly<Record<string, UnitDefinition>>

const FunctionArity = {
  abs: [1, 1],
  min: [1, CalculateTool.MaxFunctionArguments],
  max: [1, CalculateTool.MaxFunctionArguments],
  sum: [1, CalculateTool.MaxFunctionArguments],
  avg: [1, CalculateTool.MaxFunctionArguments],
  floor: [1, 1],
  ceil: [1, 1],
  trunc: [1, 1],
  round: [1, 1],
  sqrt: [1, 1],
  cbrt: [1, 1],
  pow: [2, 2],
  mod: [2, 2],
} as const

type FunctionName = keyof typeof FunctionArity
type UnitName = keyof typeof Units

export function calculate(input: CalculateTool.Input, signal?: AbortSignal): CalculateTool.Data {
  const evaluation = calculateSteps(input, signal)
  let step = evaluation.next()
  while (!step.done) step = evaluation.next()
  return step.value
}

export function calculateEffect(
  input: CalculateTool.Input,
  signal?: AbortSignal,
  onEvaluationStart?: () => void,
): Effect.Effect<CalculateTool.Data, CalculateTool.CalculationError> {
  return Effect.suspend(() => {
    const evaluation = calculateSteps(input, signal)
    const state = { started: false }
    const advance = (): Effect.Effect<CalculateTool.Data, CalculateTool.CalculationError> =>
      Effect.try({
        try: () => evaluation.next(),
        catch: (error) => {
          if (error instanceof CalculateTool.CalculationError) return error
          throw error
        },
      }).pipe(
        Effect.flatMap((step) => {
          if (step.done) return Effect.succeed(step.value)
          if (!state.started) {
            state.started = true
            onEvaluationStart?.()
          }
          return Effect.yieldNow.pipe(Effect.andThen(advance))
        }),
      )
    return advance()
  })
}

function* calculateSteps(input: CalculateTool.Input, signal?: AbortSignal): Generator<void, CalculateTool.Data, void> {
  const precision = input.precision ?? CalculateTool.DefaultPrecision
  if (new TextEncoder().encode(input.expression).byteLength > CalculateTool.MaxExpressionBytes) {
    fail("expression-limit", { start: 0, end: input.expression.length })
  }
  if (
    !Number.isInteger(precision) ||
    precision < CalculateTool.MinPrecision ||
    precision > CalculateTool.MaxPrecision
  ) {
    fail("precision-out-of-range", { start: 0, end: 0 })
  }
  const DecimalForCall = Decimal.clone({
    defaults: true,
    precision,
    rounding: Decimal.ROUND_HALF_EVEN,
    minE: -CalculateTool.MaxExponent,
    maxE: CalculateTool.MaxExponent,
    modulo: Decimal.ROUND_DOWN,
  })
  const parsed = CalculateParser.parse(input.expression, signal)
  let operationCount = 0

  const operation = function* (span: CalculateTool.Span): Generator<void, void, void> {
    if (signal?.aborted) fail("cancelled", span)
    operationCount++
    if (operationCount > CalculateTool.MaxNodes) fail("node-limit", span)
    yield
  }

  const unit = (name: string, span: CalculateTool.Span): Unit => {
    if (!isUnitName(name)) fail("unknown-identifier", span)
    const definition = Units[name]
    const value =
      definition.factor === "degrees"
        ? DecimalForCall.acos(-1).div(new DecimalForCall(180))
        : new DecimalForCall(definition.factor)
    return { ...definition, value }
  }

  const evaluate = function* (node: Node): Generator<void, Quantity, void> {
    if (signal?.aborted) fail("cancelled", node.span)
    if (node.type === "literal") return quantity(checked(new DecimalForCall(node.value), node.span), Scalar)
    yield* operation(node.span)

    if (node.type === "unary") {
      const operand = yield* evaluate(node.operand)
      return quantity(node.operator === "-" ? operand.value.neg() : operand.value, operand.dimension)
    }
    if (node.type === "percent") {
      const operand = yield* evaluate(node.operand)
      return quantity(checked(operand.value.div(100), node.span, !operand.value.isZero()), operand.dimension)
    }
    if (node.type === "unit") {
      const operand = yield* evaluate(node.operand)
      if (!sameDimension(operand.dimension, Scalar)) fail("unit-not-allowed", node.unit.span)
      const selected = unit(node.unit.unit, node.unit.identifierSpan)
      return quantity(
        checked(operand.value.mul(selected.value.pow(node.unit.power)), node.span, !operand.value.isZero()),
        selected.dimension.map((power) =>
          boundedUnitPower(power * node.unit.power, node.unit.exponentSpan ?? node.unit.identifierSpan),
        ) as unknown as Dimension,
      )
    }
    if (node.type === "conversion") {
      const operand = yield* evaluate(node.operand)
      const converted = node.units.reduce<Unit>(
        (result, term) => {
          const next = unit(term.unit, term.identifierSpan)
          return {
            symbol: "",
            factor: "1",
            value: checked(result.value.mul(next.value.pow(term.power)), node.unitSpan),
            dimension: combineDimension(
              result.dimension,
              next.dimension.map((power) => boundedUnitPower(power * term.power, term.span)) as unknown as Dimension,
              1,
              term.span,
            ),
          }
        },
        { symbol: "", factor: "1", value: new DecimalForCall(1), dimension: Scalar },
      )
      const selected = { ...converted, symbol: formatRequestedUnits(node.units) }
      if (sameDimension(operand.dimension, Scalar)) fail("unit-required", node.span)
      if (!sameDimension(operand.dimension, selected.dimension)) fail("dimension-mismatch", node.span)
      checked(operand.value.div(selected.value), node.span, !operand.value.isZero())
      return { ...operand, display: selected }
    }
    if (node.type === "binary") return binary(node, yield* evaluate(node.left), yield* evaluate(node.right))
    return yield* call(node)
  }

  const binary = (node: Extract<Node, { type: "binary" }>, left: Quantity, right: Quantity): Quantity => {
    if (node.operator === "+" || node.operator === "-") {
      requireSameDimension(left, right, node.span)
      return quantity(
        checked(node.operator === "+" ? left.value.add(right.value) : left.value.sub(right.value), node.span),
        left.dimension,
      )
    }
    if (node.operator === "*") {
      return quantity(
        checked(left.value.mul(right.value), node.span, !left.value.isZero() && !right.value.isZero()),
        combineDimension(left.dimension, right.dimension, 1, node.span),
      )
    }
    if (node.operator === "/") {
      if (right.value.isZero()) fail("division-by-zero", node.right.span)
      return quantity(
        checked(left.value.div(right.value), node.span, !left.value.isZero()),
        combineDimension(left.dimension, right.dimension, -1, node.span),
      )
    }
    return power(left, right, node.span, node.right.span)
  }

  const power = (
    base: Quantity,
    exponent: Quantity,
    span: CalculateTool.Span,
    exponentSpan: CalculateTool.Span,
  ): Quantity => {
    if (!sameDimension(exponent.dimension, Scalar)) fail("dimension-mismatch", exponentSpan)
    if (exponent.value.abs().gt(CalculateTool.MaxExponent)) fail("power-exponent-limit", exponentSpan)
    if (!sameDimension(base.dimension, Scalar) && !exponent.value.isInteger()) {
      fail("dimensional-power-not-integer", exponentSpan)
    }
    const value = checked(base.value.pow(exponent.value), span, !base.value.isZero())
    if (sameDimension(base.dimension, Scalar)) return quantity(value, Scalar)
    const exponentNumber = exponent.value.toNumber()
    return quantity(
      value,
      base.dimension.map((item) => boundedUnitPower(item * exponentNumber, span)) as unknown as Dimension,
    )
  }

  const call = function* (node: Extract<Node, { type: "function" }>): Generator<void, Quantity, void> {
    if (!isFunctionName(node.name)) {
      fail("unknown-identifier", { start: node.span.start, end: node.span.start + node.name.length })
    }
    const name = node.name
    const arity = FunctionArity[name]
    if (node.arguments.length < arity[0] || node.arguments.length > arity[1]) fail("invalid-arity", node.span)
    const args: Quantity[] = []
    for (const argument of node.arguments) args.push(yield* evaluate(argument))
    const first = args[0]
    if (!first) fail("invalid-arity", node.span)

    switch (name) {
      case "pow":
        return power(first, args[1], node.span, node.arguments[1].span)
      case "mod":
        requireSameDimension(first, args[1], node.span)
        if (args[1].value.isZero()) fail("division-by-zero", node.arguments[1].span)
        return quantity(checked(first.value.mod(args[1].value), node.span), first.dimension)
      case "min":
      case "max":
      case "sum":
      case "avg": {
        args.slice(1).forEach((item) => requireSameDimension(first, item, node.span))
        const values = args.map((item) => item.value)
        const value =
          name === "min"
            ? DecimalForCall.min(...values)
            : name === "max"
              ? DecimalForCall.max(...values)
              : DecimalForCall.sum(...values)
        return quantity(
          checked(name === "avg" ? value.div(args.length) : value, node.span, name === "avg" && !value.isZero()),
          first.dimension,
        )
      }
      case "sqrt":
      case "cbrt": {
        const root = name === "sqrt" ? 2 : 3
        if (first.dimension.some((item) => item % root !== 0)) fail("dimensional-power-not-integer", node.span)
        const value = name === "sqrt" ? first.value.sqrt() : first.value.cbrt()
        return quantity(checked(value, node.span), first.dimension.map((item) => item / root) as unknown as Dimension)
      }
      case "abs":
        return quantity(checked(first.value.abs(), node.span), first.dimension)
      case "floor":
        return quantity(checked(first.value.floor(), node.span), first.dimension)
      case "ceil":
        return quantity(checked(first.value.ceil(), node.span), first.dimension)
      case "trunc":
        return quantity(checked(first.value.trunc(), node.span), first.dimension)
      case "round":
        return quantity(checked(first.value.round(), node.span), first.dimension)
    }
  }

  try {
    const result = yield* evaluate(parsed.root)
    const displayed = result.display ? result.value.div(result.display.value) : result.value
    const value = checked(displayed.toSignificantDigits(precision), parsed.root.span).toString()
    return {
      value: value === "-0" ? "0" : value,
      ...(result.display
        ? { unit: result.display.symbol }
        : sameDimension(result.dimension, Scalar)
          ? {}
          : { unit: formatDimension(result.dimension) }),
      precision,
      operationCount,
    }
  } catch (error) {
    if (error instanceof CalculateTool.CalculationError) throw error
    fail("domain-error", parsed.root.span)
  }
}

function isUnitName(name: string): name is UnitName {
  return Object.hasOwn(Units, name)
}

function isFunctionName(name: string): name is FunctionName {
  return Object.hasOwn(FunctionArity, name)
}

function quantity(value: Decimal, dimension: Dimension): Quantity {
  return { value, dimension }
}

function checked(value: Decimal, span: CalculateTool.Span, underflow = false) {
  if (value.isNaN()) fail("domain-error", span)
  if (!value.isFinite() || Math.abs(value.e) > CalculateTool.MaxExponent || (underflow && value.isZero())) {
    fail("result-out-of-range", span)
  }
  return value
}

function sameDimension(left: Dimension, right: Dimension) {
  return left.every((value, index) => value === right[index])
}

function requireSameDimension(left: Quantity, right: Quantity, span: CalculateTool.Span) {
  if (!sameDimension(left.dimension, right.dimension)) fail("dimension-mismatch", span)
}

function combineDimension(left: Dimension, right: Dimension, sign: 1 | -1, span: CalculateTool.Span): Dimension {
  return left.map((value, index) => boundedUnitPower(value + sign * right[index], span)) as unknown as Dimension
}

function boundedUnitPower(value: number, span: CalculateTool.Span) {
  if (!Number.isSafeInteger(value) || Math.abs(value) > CalculateTool.MaxExponent) fail("power-exponent-limit", span)
  return value
}

function formatDimension(dimension: Dimension) {
  const symbols = ["m", "kg", "s", "B", "rad"]
  const numerator = dimension.flatMap((power, index) => (power > 0 ? [formatUnit(symbols[index], power)] : []))
  const denominator = dimension.flatMap((power, index) => (power < 0 ? [formatUnit(symbols[index], -power)] : []))
  if (denominator.length === 0) return numerator.join("*")
  return `${numerator.join("*") || "1"}/${denominator.join("*")}`
}

function formatUnit(symbol: string, power: number) {
  return power === 1 ? symbol : `${symbol}^${power}`
}

function formatRequestedUnits(terms: ReadonlyArray<CalculateParser.UnitTerm>) {
  const powers = terms.reduce<Map<string, number>>((result, term) => {
    result.set(term.unit, (result.get(term.unit) ?? 0) + term.power)
    return result
  }, new Map())
  const ordered = Object.keys(Units).flatMap((symbol) =>
    powers.get(symbol) ? [{ symbol, power: powers.get(symbol) ?? 0 }] : [],
  )
  const numerator = ordered.flatMap((term) => (term.power > 0 ? [formatUnit(term.symbol, term.power)] : []))
  const denominator = ordered.flatMap((term) => (term.power < 0 ? [formatUnit(term.symbol, -term.power)] : []))
  if (denominator.length === 0) return numerator.join("*")
  return `${numerator.join("*") || "1"}/${denominator.join("*")}`
}

function fail(code: CalculateTool.ErrorCode, span: CalculateTool.Span): never {
  throw new CalculateTool.CalculationError({ code, span })
}
