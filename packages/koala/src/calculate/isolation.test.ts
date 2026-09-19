import { expect, test } from "bun:test"
import { calculate } from "./evaluator"

const implementation = ["tool.ts", "tokenizer.ts", "parser.ts", "evaluator.ts"]

test("calculator implementation has no dynamic-code or execution-runtime dependency", async () => {
  const source = (await Promise.all(implementation.map((file) => Bun.file(`${import.meta.dir}/${file}`).text()))).join(
    "\n",
  )
  const dynamicCall = new RegExp(`\\b${["ev", "al"].join("")}\\s*\\(`)
  const constructorCall = new RegExp(`\\b${["Fun", "ction"].join("")}\\s*\\(`)
  expect(source).not.toMatch(dynamicCall)
  expect(source).not.toMatch(constructorCall)
  expect(source).not.toContain(["code", "mode"].join("-"))
  expect(source).not.toContain(["child", "_process"].join(""))
  expect(source).not.toContain(["sand", "box"].join(""))
})

test("calculator runs when dynamic JavaScript entry points reject calls", () => {
  const host = globalThis as typeof globalThis & Record<string, unknown>
  const names = [["ev", "al"].join(""), ["Fun", "ction"].join("")] as const
  const descriptors = names.map((name) => Object.getOwnPropertyDescriptor(host, name))
  const reject = () => {
    throw new Error("dynamic code must not run")
  }
  try {
    names.forEach((name) => Object.defineProperty(host, name, { configurable: true, value: reject }))
    expect(calculate({ expression: "sqrt(81) m + 1 km to m" })).toMatchObject({ value: "1009", unit: "m" })
  } finally {
    names.forEach((name, index) => {
      const descriptor = descriptors[index]
      if (descriptor) Object.defineProperty(host, name, descriptor)
    })
  }
})
