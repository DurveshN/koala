import { DocumentRuntimeLimits } from "@koala-ai/core/document-runtime/limits"
import { DocumentSandboxProtocol } from "@koala-ai/core/document-runtime/sandbox-protocol"

export interface Port {
  readonly connected: boolean
  readonly send: (value: DocumentSandboxProtocol.ParentRequest, callback: (error: Error | null) => void) => boolean
}

export interface Channel {
  state: DocumentSandboxProtocol.LifecycleState
  tail: Promise<void>
  pending: number
}

export class ChannelError extends Error {
  override readonly name = "DocumentOuterChannelError"

  constructor(readonly code: string) {
    super(code)
  }
}

export function make(): Channel {
  return {
    state: DocumentSandboxProtocol.beginLifecycle(),
    tail: Promise.resolve(),
    pending: 0,
  }
}

export function send(
  channel: Channel,
  port: Port,
  input: unknown,
  timeoutMs = DocumentRuntimeLimits.MaxCancellationGraceMs,
) {
  const message = DocumentSandboxProtocol.decodeParentRequest(serialized(input))
  if (channel.pending >= DocumentRuntimeLimits.MaxOuterPendingMessages) throw new ChannelError("queue-overflow")
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new ChannelError("send-timeout")
  const next = DocumentSandboxProtocol.advanceLifecycle(channel.state, message)
  if (!next.ok) throw new ChannelError(next.code)

  // Reserve the transition before an interrupt can enqueue a later cancel.
  channel.state = next.state
  channel.pending++
  const result = channel.tail.then(
    () =>
      new Promise<void>((resolve, reject) => {
        if (!port.connected) return reject(new ChannelError("disconnected"))
        let settled = false
        const finish = (error?: ChannelError) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (error) reject(error)
          else resolve()
        }
        const timer = setTimeout(() => finish(new ChannelError("send-timeout")), timeoutMs)
        try {
          port.send(message, (error) => finish(error ? new ChannelError("send-failed") : undefined))
        } catch {
          finish(new ChannelError("send-failed"))
        }
      }),
  )
  channel.tail = result.catch(() => undefined)
  return result.finally(() => {
    channel.pending--
  })
}

export function receive(channel: Channel, input: unknown) {
  const message = DocumentSandboxProtocol.decodeProxyEvent(serialized(input))
  const next = DocumentSandboxProtocol.advanceLifecycle(channel.state, message)
  if (!next.ok) throw new ChannelError(next.code)
  channel.state = next.state
  return message
}

function serialized(input: unknown) {
  const encoded = JSON.stringify(input)
  if (encoded === undefined || Buffer.byteLength(encoded) > DocumentRuntimeLimits.MaxOuterIpcMessageBytes) {
    throw new ChannelError("message-overflow")
  }
  return JSON.parse(encoded)
}

export * as DocumentOuterChannel from "./outer-channel"
