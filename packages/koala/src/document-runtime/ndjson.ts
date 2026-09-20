export * as DocumentRuntimeNdjson from "./ndjson"

import { DocumentRuntimeLimits } from "./limits"

export type ErrorCode =
  | "line-overflow"
  | "buffer-overflow"
  | "frame-overflow"
  | "aggregate-overflow"
  | "malformed-utf8"
  | "malformed-json"
  | "blank-line"
  | "unterminated-eof"
  | "closed"

export class NdjsonError extends Error {
  override readonly name = "NdjsonError"

  constructor(readonly code: ErrorCode) {
    super(code)
  }
}

export interface Decoder {
  readonly frames: number
  readonly bytes: number
  readonly bufferedBytes: number
  readonly push: (chunk: Uint8Array) => ReadonlyArray<unknown>
  readonly end: () => void
}

export interface Encoder {
  readonly frames: number
  readonly bytes: number
  readonly encode: (value: unknown) => Uint8Array
}

export function makeDecoder(): Decoder {
  let buffered = new Uint8Array()
  let frames = 0
  let bytes = 0
  let failure: NdjsonError | undefined
  let ended = false

  const fail = (code: ErrorCode): never => {
    failure ??= new NdjsonError(code)
    throw failure
  }

  return {
    get frames() {
      return frames
    },
    get bytes() {
      return bytes
    },
    get bufferedBytes() {
      return buffered.byteLength
    },
    push(chunk) {
      if (failure) throw failure
      if (ended) return fail("closed")
      if (bytes + chunk.byteLength > DocumentRuntimeLimits.MaxNdjsonBytesPerDirection) {
        return fail("aggregate-overflow")
      }
      bytes += chunk.byteLength

      const input = concatenate(buffered, chunk)
      const values: unknown[] = []
      let start = 0
      for (let index = 0; index < input.byteLength; index++) {
        if (input[index] !== 0x0a) continue
        const lineBytes = index - start + 1
        if (lineBytes > DocumentRuntimeLimits.MaxNdjsonLineBytes) return fail("line-overflow")
        if (lineBytes === 1) return fail("blank-line")
        if (frames === DocumentRuntimeLimits.MaxNdjsonFramesPerDirection) return fail("frame-overflow")

        let text: string
        try {
          text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(input.subarray(start, index))
        } catch {
          return fail("malformed-utf8")
        }
        try {
          values.push(JSON.parse(text))
        } catch {
          return fail("malformed-json")
        }
        frames++
        start = index + 1
      }

      buffered = input.slice(start)
      if (buffered.byteLength > DocumentRuntimeLimits.MaxNdjsonUnterminatedBytes) {
        return fail("buffer-overflow")
      }
      return values
    },
    end() {
      if (failure) throw failure
      if (ended) return
      ended = true
      if (buffered.byteLength > 0) fail("unterminated-eof")
    },
  }
}

export function makeEncoder(): Encoder {
  const encoder = new TextEncoder()
  let frames = 0
  let bytes = 0
  let failure: NdjsonError | undefined

  const fail = (code: ErrorCode): never => {
    failure ??= new NdjsonError(code)
    throw failure
  }

  return {
    get frames() {
      return frames
    },
    get bytes() {
      return bytes
    },
    encode(value) {
      if (failure) throw failure
      if (frames === DocumentRuntimeLimits.MaxNdjsonFramesPerDirection) return fail("frame-overflow")

      let json: string | undefined
      try {
        json = JSON.stringify(value)
      } catch {
        return fail("malformed-json")
      }
      if (json === undefined) return fail("malformed-json")
      const frame = encoder.encode(`${json}\n`)
      if (frame.byteLength > DocumentRuntimeLimits.MaxNdjsonLineBytes) return fail("line-overflow")
      if (bytes + frame.byteLength > DocumentRuntimeLimits.MaxNdjsonBytesPerDirection) {
        return fail("aggregate-overflow")
      }
      frames++
      bytes += frame.byteLength
      return frame
    },
  }
}

function concatenate(left: Uint8Array, right: Uint8Array) {
  if (left.byteLength === 0) return right.slice()
  if (right.byteLength === 0) return left
  const combined = new Uint8Array(left.byteLength + right.byteLength)
  combined.set(left)
  combined.set(right, left.byteLength)
  return combined
}
