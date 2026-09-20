import { describe, expect, test } from "bun:test"
import { DocumentRuntimeLimits } from "./limits"
import { DocumentRuntimeNdjson } from "./ndjson"

const text = new TextEncoder()

describe("DocumentRuntimeNdjson", () => {
  test("frames split UTF-8 and combined lines without Node APIs", () => {
    const decoder = DocumentRuntimeNdjson.makeDecoder()
    const encoded = text.encode(`${JSON.stringify({ value: "koala-ü" })}\n${JSON.stringify([1, 2])}\n`)
    const split = encoded.indexOf(0xc3) + 1
    expect(decoder.push(encoded.subarray(0, split))).toEqual([])
    expect(decoder.push(encoded.subarray(split))).toEqual([{ value: "koala-ü" }, [1, 2]])
    decoder.end()
    expect({ frames: decoder.frames, bytes: decoder.bytes, buffered: decoder.bufferedBytes }).toEqual({
      frames: 2,
      bytes: encoded.byteLength,
      buffered: 0,
    })
  })

  test.each([
    [new Uint8Array([0xc3, 0x28, 0x0a]), "malformed-utf8"],
    [text.encode("{]\n"), "malformed-json"],
    [text.encode("\n"), "blank-line"],
    [new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d, 0x0a]), "malformed-json"],
  ] as const)("rejects invalid input permanently", (input, code) => {
    const decoder = DocumentRuntimeNdjson.makeDecoder()
    expect(() => decoder.push(input)).toThrow(code)
    expect(() => decoder.push(text.encode("{}\n"))).toThrow(code)
    expect(() => decoder.end()).toThrow(code)
  })

  test("accepts the exact line ceiling and rejects one byte more", () => {
    const exact = DocumentRuntimeNdjson.makeDecoder()
    const frame = text.encode(`${JSON.stringify("x".repeat(DocumentRuntimeLimits.MaxNdjsonLineBytes - 3))}\n`)
    expect(frame.byteLength).toBe(DocumentRuntimeLimits.MaxNdjsonLineBytes)
    expect(exact.push(frame)).toEqual(["x".repeat(DocumentRuntimeLimits.MaxNdjsonLineBytes - 3)])
    exact.end()

    const overflow = DocumentRuntimeNdjson.makeDecoder()
    expect(() =>
      overflow.push(text.encode(`${JSON.stringify("x".repeat(DocumentRuntimeLimits.MaxNdjsonLineBytes - 2))}\n`)),
    ).toThrow("line-overflow")
  })

  test("accepts the exact unterminated buffer ceiling and rejects one byte more", () => {
    const exact = DocumentRuntimeNdjson.makeDecoder()
    expect(exact.push(text.encode("x".repeat(DocumentRuntimeLimits.MaxNdjsonUnterminatedBytes)))).toEqual([])
    expect(exact.bufferedBytes).toBe(DocumentRuntimeLimits.MaxNdjsonUnterminatedBytes)
    expect(() => exact.end()).toThrow("unterminated-eof")

    const overflow = DocumentRuntimeNdjson.makeDecoder()
    expect(() =>
      overflow.push(text.encode("x".repeat(DocumentRuntimeLimits.MaxNdjsonUnterminatedBytes + 1))),
    ).toThrow("buffer-overflow")
  })

  test("accepts exactly 512 frames and rejects frame 513", () => {
    const encoder = DocumentRuntimeNdjson.makeEncoder()
    for (let frame = 0; frame < DocumentRuntimeLimits.MaxNdjsonFramesPerDirection; frame++) encoder.encode(frame)
    expect(encoder.frames).toBe(512)
    expect(() => encoder.encode(513)).toThrow("frame-overflow")
    expect(() => encoder.encode(514)).toThrow("frame-overflow")

    const decoder = DocumentRuntimeNdjson.makeDecoder()
    for (let frame = 0; frame < DocumentRuntimeLimits.MaxNdjsonFramesPerDirection; frame++) {
      decoder.push(text.encode(`${frame}\n`))
    }
    expect(decoder.frames).toBe(512)
    expect(() => decoder.push(text.encode("513\n"))).toThrow("frame-overflow")
  })

  test("accepts exactly one MiB aggregate and rejects one byte more", () => {
    const decoder = DocumentRuntimeNdjson.makeDecoder()
    const frame = text.encode(`${JSON.stringify("x".repeat(DocumentRuntimeLimits.MaxNdjsonLineBytes - 3))}\n`)
    for (let index = 0; index < 64; index++) expect(decoder.push(frame)).toHaveLength(1)
    expect(decoder.bytes).toBe(DocumentRuntimeLimits.MaxNdjsonBytesPerDirection)
    expect(() => decoder.push(text.encode("0\n"))).toThrow("aggregate-overflow")

    const encoder = DocumentRuntimeNdjson.makeEncoder()
    for (let index = 0; index < 64; index++) {
      expect(encoder.encode("x".repeat(DocumentRuntimeLimits.MaxNdjsonLineBytes - 3))).toHaveLength(
        DocumentRuntimeLimits.MaxNdjsonLineBytes,
      )
    }
    expect(encoder.bytes).toBe(DocumentRuntimeLimits.MaxNdjsonBytesPerDirection)
    expect(() => encoder.encode(0)).toThrow("aggregate-overflow")
  })

  test("encodes one canonical LF-delimited JSON value and applies limits permanently", () => {
    const encoder = DocumentRuntimeNdjson.makeEncoder()
    expect(new TextDecoder().decode(encoder.encode({ ok: true }))).toBe('{"ok":true}\n')

    const oversized = DocumentRuntimeNdjson.makeEncoder()
    expect(() => oversized.encode("x".repeat(DocumentRuntimeLimits.MaxNdjsonLineBytes - 2))).toThrow(
      "line-overflow",
    )
    expect(() => oversized.encode({ ok: true })).toThrow("line-overflow")
  })

  test("rejects EOF with an unterminated JSON value and closes after clean EOF", () => {
    const unterminated = DocumentRuntimeNdjson.makeDecoder()
    unterminated.push(text.encode("{}"))
    expect(() => unterminated.end()).toThrow("unterminated-eof")

    const closed = DocumentRuntimeNdjson.makeDecoder()
    closed.push(text.encode("{}\n"))
    closed.end()
    closed.end()
    expect(() => closed.push(text.encode("{}\n"))).toThrow("closed")
  })
})
