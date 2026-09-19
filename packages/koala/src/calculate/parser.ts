export * as CalculateParser from "./parser"

import { CalculateTool } from "./tool"
import { tokenize, type Token } from "./tokenizer"

interface Located {
  readonly span: CalculateTool.Span
}

export interface LiteralNode extends Located {
  readonly type: "literal"
  readonly value: string
}

export interface UnaryNode extends Located {
  readonly type: "unary"
  readonly operator: "+" | "-"
  readonly operand: Node
}

export interface BinaryNode extends Located {
  readonly type: "binary"
  readonly operator: "+" | "-" | "*" | "/" | "^"
  readonly left: Node
  readonly right: Node
}

export interface PercentNode extends Located {
  readonly type: "percent"
  readonly operand: Node
}

export interface FunctionNode extends Located {
  readonly type: "function"
  readonly name: string
  readonly arguments: ReadonlyArray<Node>
}

export interface UnitNode extends Located {
  readonly type: "unit"
  readonly operand: Node
  readonly unit: UnitTerm
}

export interface ConversionNode extends Located {
  readonly type: "conversion"
  readonly operand: Node
  readonly units: ReadonlyArray<UnitTerm>
  readonly unitSpan: CalculateTool.Span
}

export interface UnitTerm {
  readonly unit: string
  readonly power: number
  readonly span: CalculateTool.Span
  readonly identifierSpan: CalculateTool.Span
  readonly exponentSpan?: CalculateTool.Span
}

export type Node = LiteralNode | UnaryNode | BinaryNode | PercentNode | FunctionNode | UnitNode | ConversionNode

export interface Parsed {
  readonly root: Node
  readonly nodeCount: number
}

export function parse(expression: string, signal?: AbortSignal): Parsed {
  const tokens = tokenize(expression, signal)
  let index = 0
  let nodeCount = 0

  const current = () => tokens[index]
  const advance = () => tokens[index++]
  const node = <A extends Node>(value: A): A => {
    nodeCount++
    if (nodeCount > CalculateTool.MaxNodes) fail("node-limit", value.span)
    return value
  }

  const unitTerm = (sign: 1 | -1): UnitTerm => {
    const name = advance()
    if (name.kind !== "identifier" || name.text === "to") fail("expected-token", tokenSpan(name))
    if (current().kind !== "operator" || current().text !== "^") {
      return { unit: name.text, power: sign, span: tokenSpan(name), identifierSpan: tokenSpan(name) }
    }
    advance()
    const prefix =
      current().kind === "operator" && (current().text === "+" || current().text === "-") ? advance() : undefined
    const exponent = advance()
    const start = prefix?.start ?? exponent.start
    if (exponent.kind !== "number" || !/^\d+$/.test(exponent.text)) {
      fail("dimensional-power-not-integer", { start, end: exponent.end })
    }
    const power = Number(`${prefix?.text ?? ""}${exponent.text}`)
    if (Math.abs(power) > CalculateTool.MaxExponent) {
      fail("power-exponent-limit", { start, end: exponent.end })
    }
    return {
      unit: name.text,
      power: sign * power,
      span: { start: name.start, end: exponent.end },
      identifierSpan: tokenSpan(name),
      exponentSpan: { start, end: exponent.end },
    }
  }

  const expressionAt = (minimumBindingPower: number, depth: number): Node => {
    if (signal?.aborted) fail("cancelled", tokenSpan(current()))
    if (depth > CalculateTool.MaxDepth) fail("nesting-limit", tokenSpan(current()))
    const first = advance()
    let left: Node

    if (first.kind === "number") {
      left = node({ type: "literal", value: first.text, span: tokenSpan(first) })
    } else if (first.kind === "operator" && (first.text === "+" || first.text === "-")) {
      const operand = expressionAt(30, depth + 1)
      left = node({
        type: "unary",
        operator: first.text,
        operand,
        span: { start: first.start, end: operand.span.end },
      })
    } else if (first.kind === "left-paren") {
      left = expressionAt(0, depth + 1)
      const closing = advance()
      if (closing.kind !== "right-paren") fail("expected-token", tokenSpan(closing))
      left = { ...left, span: { start: first.start, end: closing.end } }
    } else if (first.kind === "identifier") {
      const opening = advance()
      if (opening.kind !== "left-paren") fail("unknown-identifier", tokenSpan(first))
      const args: Node[] = []
      if (current().kind !== "right-paren") {
        while (true) {
          if (args.length >= CalculateTool.MaxFunctionArguments) fail("argument-limit", tokenSpan(current()))
          args.push(expressionAt(0, depth + 1))
          if (current().kind !== "comma") break
          advance()
        }
      }
      const closing = advance()
      if (closing.kind !== "right-paren") fail("expected-token", tokenSpan(closing))
      left = node({
        type: "function",
        name: first.text,
        arguments: args,
        span: { start: first.start, end: closing.end },
      })
    } else {
      fail("expected-expression", tokenSpan(first))
    }

    while (true) {
      if (signal?.aborted) fail("cancelled", tokenSpan(current()))
      const next = current()
      if (next.kind === "operator" && next.text === "%") {
        if (50 < minimumBindingPower) break
        advance()
        left = node({ type: "percent", operand: left, span: { start: left.span.start, end: next.end } })
        continue
      }
      if (next.kind === "identifier" && next.text !== "to") {
        if (35 < minimumBindingPower) break
        const unit = unitTerm(1)
        left = node({
          type: "unit",
          operand: left,
          unit,
          span: { start: left.span.start, end: unit.span.end },
        })
        continue
      }
      if (next.kind === "identifier" && next.text === "to") {
        if (5 < minimumBindingPower) break
        advance()
        const start = current().start
        const units = [unitTerm(1)]
        while (current().kind === "operator" && (current().text === "*" || current().text === "/")) {
          const operator = advance()
          units.push(unitTerm(operator.text === "*" ? 1 : -1))
        }
        left = node({
          type: "conversion",
          operand: left,
          units,
          unitSpan: { start, end: units[units.length - 1].span.end },
          span: { start: left.span.start, end: units[units.length - 1].span.end },
        })
        break
      }
      if (next.kind !== "operator" || !isBinary(next.text)) break
      const binding = binaryBinding(next.text)
      if (binding.left < minimumBindingPower) break
      advance()
      const right = expressionAt(binding.right, depth + 1)
      left = node({
        type: "binary",
        operator: next.text,
        left,
        right,
        span: { start: left.span.start, end: right.span.end },
      })
    }
    return left
  }

  const root = expressionAt(0, 0)
  if (current().kind !== "eof") fail("unexpected-token", tokenSpan(current()))
  return { root, nodeCount }
}

function binaryBinding(operator: BinaryNode["operator"]) {
  if (operator === "+" || operator === "-") return { left: 10, right: 11 }
  if (operator === "*" || operator === "/") return { left: 20, right: 21 }
  return { left: 40, right: 40 }
}

function isBinary(value: string): value is BinaryNode["operator"] {
  return value === "+" || value === "-" || value === "*" || value === "/" || value === "^"
}

function tokenSpan(token: Token): CalculateTool.Span {
  return { start: token.start, end: token.end }
}

function fail(code: CalculateTool.ErrorCode, span: CalculateTool.Span): never {
  throw new CalculateTool.CalculationError({ code, span })
}
