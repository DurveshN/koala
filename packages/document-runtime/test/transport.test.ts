import { describe, expect, test } from "bun:test"
import { DocumentRuntimeLimits } from "@koala-ai/core/document-runtime/limits"
import { PassThrough, Readable, Writable } from "node:stream"
import { createNodeStreamTransport } from "../src/transport"

describe("document runtime Node stream transport", () => {
  test("decodes split and combined frames and rejects unterminated EOF permanently", async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    output.resume()
    const transport = createNodeStreamTransport(input, output)
    const messages: unknown[] = []
    const disconnected = Promise.withResolvers<void>()
    transport.onMessage((message) => messages.push(message))
    transport.onDisconnect(() => disconnected.resolve())

    input.write(Buffer.from('{"value":"koala-'))
    input.write(Buffer.from('ü"}\n[1,2]\n'))
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(messages).toEqual([{ value: "koala-ü" }, [1, 2]])
    input.end("{}")
    await disconnected.promise
    await expect(transport.send({ late: true })).rejects.toThrow("input-failed")
  })

  test("reports a fully framed EOF as a clean disconnect", async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    output.resume()
    const transport = createNodeStreamTransport(input, output)
    const disconnected = Promise.withResolvers<Error | undefined>()
    transport.onMessage(() => undefined)
    transport.onDisconnect((error) => disconnected.resolve(error))

    input.end("{}\n")
    expect(await disconnected.promise).toBeUndefined()
    await expect(transport.send({ late: true })).rejects.toEqual(expect.objectContaining({ code: "closed" }))
  })

  test("fails once on malformed UTF-8 and stream errors", async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    output.resume()
    const transport = createNodeStreamTransport(input, output)
    let disconnects = 0
    transport.onMessage(() => undefined)
    transport.onDisconnect(() => disconnects++)
    input.write(Buffer.from([0xc3, 0x28, 0x0a]))
    input.write(Buffer.from("{}\n"))
    expect(disconnects).toBe(1)
    await expect(transport.send({ late: true })).rejects.toEqual(expect.objectContaining({ code: "input-failed" }))
  })

  test("delivers already accepted frames and stops after a later malformed frame", async () => {
    const queuedInput = new PassThrough()
    const queuedOutput = new PassThrough()
    queuedOutput.resume()
    const queued = createNodeStreamTransport(queuedInput, queuedOutput)
    queuedInput.write(Buffer.from('{"queued":1}\n{"queued":2}\n'))
    queuedInput.write(Buffer.from([0xc3, 0x28, 0x0a]))
    const messages: unknown[] = []
    queued.onMessage((message) => messages.push(message))
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(messages).toEqual([{ queued: 1 }, { queued: 2 }])
    expect(queuedInput.destroyed).toBe(true)
    expect(queuedOutput.destroyed).toBe(true)

    messages.length = 0
    const input = new PassThrough()
    const output = new PassThrough()
    output.resume()
    const transport = createNodeStreamTransport(input, output)
    transport.onDisconnect(() => undefined)
    transport.onMessage((message) => {
      messages.push(message)
      output.emit("error", new Error("stop delivery"))
    })
    input.write(Buffer.from('{"delivered":1}\n{"blocked":2}\n'))
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(messages).toEqual([{ delivered: 1 }])
  })

  test("serializes writes and waits for backpressure drain", async () => {
    const callbacks: Array<(error?: Error | null) => void> = []
    const written: string[] = []
    const output = new Writable({
      highWaterMark: 1,
      write(chunk, _encoding, callback) {
        written.push(chunk.toString())
        callbacks.push(callback)
      },
    })
    const input = new PassThrough()
    const transport = createNodeStreamTransport(input, output)
    transport.onMessage(() => undefined)
    transport.onDisconnect(() => undefined)

    const first = transport.send({ frame: 1 })
    const second = transport.send({ frame: 2 })
    expect(written).toEqual(['{"frame":1}\n'])
    callbacks.shift()?.()
    await new Promise((resolve) => setImmediate(resolve))
    expect(written).toEqual(['{"frame":1}\n', '{"frame":2}\n'])
    callbacks.shift()?.()
    await Promise.all([first, second])
    transport.close()
  })

  test("detaches every stream listener after graceful terminal close", async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    output.resume()
    const inputClosed = Promise.withResolvers<void>()
    const outputClosed = Promise.withResolvers<void>()
    input.once("close", () => inputClosed.resolve())
    output.once("close", () => outputClosed.resolve())
    const transport = createNodeStreamTransport(input, output)
    transport.onMessage(() => undefined)
    transport.onDisconnect(() => undefined)

    await transport.send({ terminal: true })
    transport.close()
    await Promise.all([inputClosed.promise, outputClosed.promise])
    expect(listenerCounts(input)).toEqual(emptyListenerCounts())
    expect(listenerCounts(output)).toEqual(emptyListenerCounts())
  })

  test("accepts exactly 32 pending writes and makes overflow terminal", async () => {
    const output = new Writable({
      highWaterMark: 1,
      write() {},
    })
    const input = new PassThrough()
    const transport = createNodeStreamTransport(input, output)
    transport.onMessage(() => undefined)
    transport.onDisconnect(() => undefined)
    const pending = Array.from({ length: DocumentRuntimeLimits.MaxNdjsonPendingWrites }, (_, frame) =>
      transport.send({ frame }).catch((error) => error),
    )

    await expect(transport.send({ overflow: true })).rejects.toEqual(
      expect.objectContaining({ code: "queue-overflow" }),
    )
    expect(await Promise.all(pending)).toEqual(
      Array.from({ length: DocumentRuntimeLimits.MaxNdjsonPendingWrites }, () =>
        expect.objectContaining({ code: "queue-overflow" }),
      ),
    )
    await expect(transport.send({ late: true })).rejects.toEqual(expect.objectContaining({ code: "queue-overflow" }))
  })

  test("settles active and queued writes and destroys both streams", async () => {
    const callbacks: Array<(error?: Error | null) => void> = []
    const output = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback) {
        callbacks.push(callback)
      },
    })
    const input = new PassThrough()
    const transport = createNodeStreamTransport(input, output)
    let disconnects = 0
    transport.onMessage(() => undefined)
    transport.onDisconnect(() => disconnects++)
    const writes = [transport.send({ frame: 1 }), transport.send({ frame: 2 }), transport.send({ frame: 3 })]

    output.emit("error", new Error("fail active write"))
    const settled = await Promise.allSettled(writes)
    expect(settled).toEqual(
      Array.from({ length: 3 }, () => ({
        status: "rejected",
        reason: expect.objectContaining({ code: "output-failed" }),
      })),
    )
    expect(disconnects).toBe(1)
    expect(input.destroyed).toBe(true)
    expect(output.destroyed).toBe(true)
    callbacks.shift()?.()
  })

  test("handles pre-close errors and detaches every listener when failed streams close", async () => {
    const input = new PassThrough({ emitClose: false })
    const output = new PassThrough({ emitClose: false })
    output.resume()
    const transport = createNodeStreamTransport(input, output)
    transport.onMessage(() => undefined)
    transport.onDisconnect(() => undefined)

    input.write(Buffer.from([0xc3, 0x28, 0x0a]))
    expect(listenerCounts(input)).toEqual({ data: 0, end: 0, close: 1, error: 1, drain: 0 })
    expect(listenerCounts(output)).toEqual({ data: 0, end: 0, close: 1, error: 1, drain: 0 })
    expect(() => input.emit("error", new Error("late input error"))).not.toThrow()
    expect(() => output.emit("error", new Error("late output error"))).not.toThrow()

    input.emit("close")
    output.emit("close")
    expect(listenerCounts(input)).toEqual(emptyListenerCounts())
    expect(listenerCounts(output)).toEqual(emptyListenerCounts())
  })

  test("rejects readable string decoding and output stream failure", async () => {
    const encodedInput = Readable.from(["{}\n"])
    const output = new PassThrough()
    output.resume()
    const invalidInput = createNodeStreamTransport(encodedInput, output)
    const inputDisconnected = Promise.withResolvers<void>()
    invalidInput.onMessage(() => undefined)
    invalidInput.onDisconnect(() => inputDisconnected.resolve())
    await inputDisconnected.promise
    await expect(invalidInput.send({ value: 1 })).rejects.toEqual(expect.objectContaining({ code: "input-failed" }))

    const input = new PassThrough()
    const failedOutput = new PassThrough()
    failedOutput.resume()
    const transport = createNodeStreamTransport(input, failedOutput)
    transport.onMessage(() => undefined)
    transport.onDisconnect(() => undefined)
    failedOutput.emit("error", new Error("private output error"))
    await expect(transport.send({ value: 1 })).rejects.toEqual(expect.objectContaining({ code: "output-failed" }))
  })
})

function listenerCounts(stream: PassThrough | Writable) {
  return {
    data: stream.listenerCount("data"),
    end: stream.listenerCount("end"),
    close: stream.listenerCount("close"),
    error: stream.listenerCount("error"),
    drain: stream.listenerCount("drain"),
  }
}

function emptyListenerCounts() {
  return { data: 0, end: 0, close: 0, error: 0, drain: 0 }
}
