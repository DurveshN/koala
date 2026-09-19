import { describe, expect, test } from "bun:test"
import { Result, Schema } from "effect"
import { Parameters } from "@/tool/sandbox-execute"

describe("tool.sandbox_execute parameters", () => {
  test("accepts a command and bounded timeout", () => {
    expect(Schema.decodeUnknownSync(Parameters)({ command: "node script.js", timeout: 30_000 })).toEqual({
      command: "node script.js",
      timeout: 30_000,
    })
  })

  test.each([
    { command: "" },
    { command: " echo unsafe-spacing" },
    { command: "echo ok", timeout: 0 },
    { command: "echo ok", timeout: 120_001 },
  ])("rejects invalid parameters %#", (input) => {
    expect(Result.isFailure(Schema.decodeUnknownResult(Parameters)(input))).toBe(true)
  })
})
