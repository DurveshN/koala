import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { SandboxPolicy } from "./policy"
import { SandboxProtocol } from "./protocol"

describe("SandboxPolicy", () => {
  test("provides deeply immutable strict defaults", () => {
    expect(SandboxPolicy.defaults).toEqual({
      env: {},
      network: [],
      timeoutMs: 30_000,
      maxOutputBytes: 1_048_576,
    })
    expect(Object.isFrozen(SandboxPolicy.defaults)).toBe(true)
    expect(Object.isFrozen(SandboxPolicy.defaults.env)).toBe(true)
    expect(Object.isFrozen(SandboxPolicy.defaults.network)).toBe(true)
  })

  test("builds a validated request with no ambient environment or network", () => {
    const built = SandboxPolicy.buildRequest(
      {
        cwd: "/sandbox/work",
        readRoots: ["/runtime", "/sandbox/input"],
        writeRoots: ["/sandbox/work", "/sandbox/artifacts"],
      },
      "python3 script.py",
    )
    const encoded = Schema.encodeSync(SandboxProtocol.ExecutionRequest)(built)

    expect(encoded).toEqual({
      command: "python3 script.py",
      cwd: "/sandbox/work",
      readRoots: ["/runtime", "/sandbox/input"],
      writeRoots: ["/sandbox/work", "/sandbox/artifacts"],
      env: {},
      network: [],
      timeoutMs: 30_000,
      maxOutputBytes: 1_048_576,
    })
    expect(
      Schema.encodeSync(SandboxProtocol.ExecutionRequest)(
        Schema.decodeUnknownSync(SandboxProtocol.ExecutionRequest)(built),
      ),
    ).toEqual(encoded)
  })

  test("defensively copies and freezes commands and host roots", () => {
    const command = "python3 script.py"
    const readRoots = ["/runtime", "/sandbox/input"]
    const writeRoots = ["/sandbox/work"]
    const roots = { cwd: "/sandbox/work", readRoots, writeRoots }
    const first = SandboxPolicy.buildRequest(roots, command)
    const second = SandboxPolicy.buildRequest(roots, command)

    readRoots[0] = "/private"
    writeRoots[0] = "/"

    expect(first.command).toBe("python3 script.py")
    expect(first.readRoots.map(String)).toEqual(["/runtime", "/sandbox/input"])
    expect(first.writeRoots.map(String)).toEqual(["/sandbox/work"])
    expect(first).not.toBe(second)
    expect(first.readRoots).not.toBe(second.readRoots)
    expect(first.writeRoots).not.toBe(second.writeRoots)
    expect(first.env).not.toBe(second.env)
    expect(first.network).not.toBe(second.network)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.readRoots)).toBe(true)
    expect(Object.isFrozen(first.writeRoots)).toBe(true)
    expect(Object.isFrozen(first.env)).toBe(true)
    expect(Object.isFrozen(first.network)).toBe(true)
  })

  test("rejects invalid model commands and host paths", () => {
    const roots = { cwd: "/sandbox/work", readRoots: ["/runtime"], writeRoots: ["/sandbox/work"] }

    expect(() => SandboxPolicy.buildRequest(roots, "")).toThrow("Expected a non-empty command")
    expect(() => SandboxPolicy.buildRequest(roots, "echo\0secret")).toThrow("Expected a non-empty command")
    expect(() => SandboxPolicy.buildRequest({ ...roots, readRoots: ["relative/input"] }, "echo ok")).toThrow(
      "Expected an absolute path",
    )
  })

  test("accepts validated host-controlled limits", () => {
    const built = SandboxPolicy.buildRequest(
      { cwd: "/sandbox/work", readRoots: ["/runtime"], writeRoots: ["/sandbox/work"] },
      "echo ok",
      { timeoutMs: 1_000, maxOutputBytes: 4_096 },
    )

    expect(built.timeoutMs).toBe(1_000)
    expect(built.maxOutputBytes).toBe(4_096)
  })
})
