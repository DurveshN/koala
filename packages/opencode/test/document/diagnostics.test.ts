import { describe, expect, test } from "bun:test"
import { PassThrough } from "node:stream"
import { DocumentDiagnostics } from "@/document/diagnostics"

describe("document proxy diagnostic drainage", () => {
  test("counts late bytes and requires end plus close on both streams", async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    let bytes = 0
    const tracker = DocumentDiagnostics.track(stdout, stderr, (chunk) => {
      if (chunk instanceof Uint8Array) bytes += chunk.byteLength
    })

    stdout.write(Buffer.alloc(17))
    stderr.write(Buffer.alloc(19))
    stdout.end()
    stderr.end()
    expect(await tracker.drain).toBe(true)
    expect(bytes).toBe(36)
    tracker.cleanup()
    expect(stdout.listenerCount("data") + stdout.listenerCount("error")).toBe(0)
    expect(stderr.listenerCount("data") + stderr.listenerCount("error")).toBe(0)
  })

  test("marks a late stream error unclean and retains handlers until cleanup", async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const tracker = DocumentDiagnostics.track(stdout, stderr, () => undefined)
    stdout.emit("error", new Error("late diagnostic error"))

    expect(await tracker.drain).toBe(false)
    expect(stderr.listenerCount("error")).toBe(1)
    tracker.cleanup()
    expect(stdout.listenerCount("error")).toBe(0)
    expect(stderr.listenerCount("error")).toBe(0)
  })
})
