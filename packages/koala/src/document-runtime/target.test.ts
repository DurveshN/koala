import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { DocumentRuntimeTarget } from "./target.ts"

describe("DocumentRuntimeTarget", () => {
  test("contains exactly the six supported targets", () => {
    expect(DocumentRuntimeTarget.Targets).toEqual([
      "x86_64-apple-darwin",
      "aarch64-apple-darwin",
      "x86_64-pc-windows-msvc",
      "aarch64-pc-windows-msvc",
      "x86_64-unknown-linux-gnu",
      "aarch64-unknown-linux-gnu",
    ])
    expect(DocumentRuntimeTarget.Targets).toHaveLength(6)
  })

  test.each([
    ["darwin", "x64", "x86_64-apple-darwin"],
    ["darwin", "arm64", "aarch64-apple-darwin"],
    ["win32", "x64", "x86_64-pc-windows-msvc"],
    ["win32", "arm64", "aarch64-pc-windows-msvc"],
    ["linux", "x64", "x86_64-unknown-linux-gnu"],
    ["linux", "arm64", "aarch64-unknown-linux-gnu"],
  ] as const)("maps %s/%s to %s", (platform, architecture, target) => {
    expect(DocumentRuntimeTarget.fromHost(platform, architecture)).toBe(target)
    expect(DocumentRuntimeTarget.architecture(target)).toBe(architecture === "x64" ? "x86_64" : "aarch64")
  })

  test.each(["x64-unknown-linux-gnu", "aarch64-unknown-linux-musl", "x86_64-pc-windows-gnu", "linux-x64"])(
    "rejects unsupported target %s",
    (target) => {
      expect(() => Schema.decodeUnknownSync(DocumentRuntimeTarget.Target)(target)).toThrow()
    },
  )
})
