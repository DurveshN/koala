import { describe, expect, test } from "bun:test"
import { requestedTarget } from "../script/target"

describe("document runtime build target", () => {
  test("uses --target, then RUST_TARGET, then the native host", () => {
    expect(requestedTarget(["--target", "aarch64-unknown-linux-gnu"], {}, "win32", "x64")).toBe(
      "aarch64-unknown-linux-gnu",
    )
    expect(requestedTarget([], { RUST_TARGET: "aarch64-apple-darwin" }, "win32", "x64")).toBe("aarch64-apple-darwin")
    expect(requestedTarget([], {}, "win32", "x64")).toBe("x86_64-pc-windows-msvc")
  })

  test("requires matching explicit targets and a release target", () => {
    expect(() =>
      requestedTarget(
        ["--target", "aarch64-unknown-linux-gnu"],
        { RUST_TARGET: "x86_64-unknown-linux-gnu" },
        "linux",
        "x64",
      ),
    ).toThrow("--target must match RUST_TARGET")
    expect(() => requestedTarget([], { OPENCODE_CHANNEL: "prod" }, "linux", "x64")).toThrow(
      "Release/channel document runtime builds require RUST_TARGET",
    )
  })
})
