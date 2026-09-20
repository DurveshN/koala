import { DocumentRuntimeLimits } from "@koala-ai/core/document-runtime/limits"
import { DocumentRuntimeNdjson } from "@koala-ai/core/document-runtime/ndjson"
import type { Readable, Writable } from "node:stream"

export type TransportErrorCode = "input-failed" | "output-failed" | "queue-overflow" | "closed"

export class TransportError extends Error {
  override readonly name = "TransportError"

  constructor(readonly code: TransportErrorCode) {
    super(code)
  }
}

export interface NodeStreamTransport {
  readonly onMessage: (listener: (input: unknown) => unknown | Promise<unknown>) => void
  readonly onDisconnect: (listener: (error?: TransportError) => void) => void
  readonly send: (value: unknown) => Promise<void>
  readonly close: () => void
}

type PendingWrite = {
  readonly bytes: Uint8Array
  readonly resolve: () => void
  readonly reject: (error: TransportError) => void
}

export function createNodeStreamTransport(input: Readable, output: Writable): NodeStreamTransport {
  const decoder = DocumentRuntimeNdjson.makeDecoder()
  const encoder = DocumentRuntimeNdjson.makeEncoder()
  const pendingMessages: unknown[] = []
  const writes: PendingWrite[] = []
  let messageListener: ((input: unknown) => unknown | Promise<unknown>) | undefined
  let disconnectListener: ((error?: TransportError) => void) | undefined
  let failure: TransportError | undefined
  let disconnected = false
  let writing = false
  let closing = false
  let drainListener: (() => void) | undefined
  let processingInput = false
  let inputEnded = false

  const disconnect = () => {
    if (disconnected) return
    disconnected = true
    try {
      disconnectListener?.(failure)
    } catch {
      // The transport is already terminal; caller exceptions cannot restart it.
    }
  }
  const stopInput = () => {
    input.off("data", onData)
    input.off("end", onEnd)
  }
  const detachInput = () => {
    stopInput()
    input.off("error", onInputError)
    input.off("close", onInputClose)
  }
  const stopOutput = () => {
    if (drainListener) output.off("drain", drainListener)
    drainListener = undefined
  }
  const detachOutput = () => {
    stopOutput()
    output.off("error", onOutputError)
    output.off("close", onOutputClose)
  }
  const destroy = (stream: Readable | Writable) => {
    if (stream.destroyed) return
    try {
      stream.destroy()
    } catch {
      // Error listeners remain installed until close and the transport is already terminal.
    }
  }
  const fail = (code: TransportErrorCode) => {
    if (failure) return failure
    failure = new TransportError(code)
    pendingMessages.length = 0
    messageListener = undefined
    stopInput()
    stopOutput()
    for (const write of writes.splice(0)) write.reject(failure)
    writing = false
    disconnect()
    destroy(input)
    destroy(output)
    return failure
  }
  const enqueue = (value: unknown) => {
    if (failure || closing) return
    if (pendingMessages.length === DocumentRuntimeLimits.MaxNdjsonPendingWrites) throw fail("queue-overflow")
    pendingMessages.push(value)
  }
  const finishInput = () => {
    if (!inputEnded || processingInput || pendingMessages.length > 0 || failure || closing) return
    closing = true
    messageListener = undefined
    stopInput()
    disconnect()
    drainWrites()
  }
  const drainMessages = () => {
    if (processingInput || failure || closing || !messageListener) return
    const value = pendingMessages.shift()
    if (value === undefined) {
      finishInput()
      if (!inputEnded) input.resume()
      return
    }
    processingInput = true
    void Promise.resolve()
      .then(() => messageListener?.(value))
      .then(
        () => {
          processingInput = false
          drainMessages()
        },
        () => fail("input-failed"),
      )
  }
  function onData(chunk: unknown) {
    if (failure || closing) return
    if (!(chunk instanceof Uint8Array)) return void fail("input-failed")
    input.pause()
    try {
      for (const value of decoder.push(chunk)) {
        if (failure || closing) break
        enqueue(value)
      }
      drainMessages()
    } catch {
      fail("input-failed")
    }
  }
  function onEnd() {
    if (failure || closing) return
    try {
      decoder.end()
    } catch {
      fail("input-failed")
      return
    }
    inputEnded = true
    stopInput()
    drainMessages()
    finishInput()
  }
  function onInputError() {
    fail("input-failed")
  }
  function onInputClose() {
    const unexpected = !inputEnded && !closing && !disconnected
    detachInput()
    if (unexpected) fail("input-failed")
  }
  function onOutputError() {
    if (!failure) fail("output-failed")
  }
  function onOutputClose() {
    const unexpected = !failure && (!closing || writes.length > 0)
    detachOutput()
    if (unexpected) fail("output-failed")
  }
  const drainWrites = () => {
    if (writing || failure) return
    const current = writes[0]
    if (!current) {
      if (closing) {
        try {
          output.end()
        } catch {
          fail("output-failed")
        }
      }
      return
    }
    writing = true
    let callbackComplete = false
    let drained = true
    const complete = (error?: Error | null) => {
      if (failure) return
      if (error) return void fail("output-failed")
      callbackComplete = true
      if (!drained) return
      writes.shift()
      writing = false
      current.resolve()
      drainWrites()
    }
    let accepted: boolean
    try {
      accepted = output.write(current.bytes, complete)
    } catch {
      fail("output-failed")
      return
    }
    if (accepted) return
    drained = false
    drainListener = () => {
      drainListener = undefined
      drained = true
      if (callbackComplete) complete()
    }
    output.once("drain", drainListener)
  }

  input.on("data", onData)
  input.once("end", onEnd)
  input.on("error", onInputError)
  input.once("close", onInputClose)
  output.on("error", onOutputError)
  output.once("close", onOutputClose)

  return {
    onMessage(listener) {
      if (messageListener) throw new TransportError("closed")
      if (failure || closing) {
        pendingMessages.length = 0
        return
      }
      messageListener = listener
      input.pause()
      drainMessages()
    },
    onDisconnect(listener) {
      if (disconnectListener) throw new TransportError("closed")
      disconnectListener = listener
      if (disconnected) queueMicrotask(listener)
    },
    send(value) {
      if (failure) return Promise.reject(failure)
      if (closing) return Promise.reject(new TransportError("closed"))
      if (writes.length === DocumentRuntimeLimits.MaxNdjsonPendingWrites) {
        return Promise.reject(fail("queue-overflow"))
      }
      let bytes: Uint8Array
      try {
        bytes = encoder.encode(value)
      } catch {
        return Promise.reject(fail("output-failed"))
      }
      return new Promise<void>((resolve, reject) => {
        writes.push({ bytes, resolve, reject })
        drainWrites()
      })
    },
    close() {
      if (closing || failure) return
      closing = true
      pendingMessages.length = 0
      messageListener = undefined
      stopInput()
      destroy(input)
      disconnect()
      drainWrites()
    },
  }
}
