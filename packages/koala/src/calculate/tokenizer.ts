import { CalculateTool } from "./tool"

export type TokenKind = "number" | "identifier" | "operator" | "left-paren" | "right-paren" | "comma" | "eof"

export interface Token {
  readonly kind: TokenKind
  readonly text: string
  readonly start: number
  readonly end: number
}

export function tokenize(expression: string, signal?: AbortSignal): ReadonlyArray<Token> {
  const tokens: Token[] = []
  let index = 0
  let literalDigits = 0

  const add = (kind: TokenKind, start: number, end: number) => {
    if (tokens.length >= CalculateTool.MaxTokens) fail("token-limit", start, end)
    tokens.push({ kind, text: expression.slice(start, end), start, end })
  }

  while (index < expression.length) {
    if (signal?.aborted) fail("cancelled", index, index)
    const character = expression[index]
    if (/\s/u.test(character)) {
      index++
      continue
    }

    if (isDigit(character) || (character === "." && isDigit(expression[index + 1]))) {
      const start = index
      while (isDigit(expression[index])) {
        literalDigits++
        index++
      }
      if (expression[index] === ".") {
        index++
        while (isDigit(expression[index])) {
          literalDigits++
          index++
        }
      }
      if (literalDigits > CalculateTool.MaxLiteralDigits) fail("literal-digit-limit", start, index)
      if (expression[index] === "e" || expression[index] === "E") {
        const exponentStart = index
        index++
        if (expression[index] === "+" || expression[index] === "-") index++
        const digitsStart = index
        while (isDigit(expression[index])) {
          literalDigits++
          index++
        }
        if (digitsStart === index) fail("unexpected-token", exponentStart, index)
        if (literalDigits > CalculateTool.MaxLiteralDigits) fail("literal-digit-limit", start, index)
        const exponent = Number(expression.slice(digitsStart, index))
        if (exponent > CalculateTool.MaxExponent) fail("literal-exponent-limit", exponentStart, index)
      }
      add("number", start, index)
      continue
    }

    if (isLetter(character)) {
      const start = index
      while (isLetter(expression[index])) index++
      add("identifier", start, index)
      continue
    }

    const start = index++
    if ("+-*/^%".includes(character)) {
      add("operator", start, index)
      continue
    }
    if (character === "(") {
      add("left-paren", start, index)
      continue
    }
    if (character === ")") {
      add("right-paren", start, index)
      continue
    }
    if (character === ",") {
      add("comma", start, index)
      continue
    }
    fail("unexpected-token", start, index)
  }

  tokens.push({ kind: "eof", text: "", start: expression.length, end: expression.length })
  return tokens
}

function isDigit(value: string | undefined): value is string {
  return value !== undefined && value >= "0" && value <= "9"
}

function isLetter(value: string | undefined): value is string {
  return value !== undefined && ((value >= "a" && value <= "z") || (value >= "A" && value <= "Z"))
}

function fail(code: CalculateTool.ErrorCode, start: number, end: number): never {
  throw new CalculateTool.CalculationError({ code, span: { start, end } })
}
