import { afterEach, describe, expect, test } from "bun:test"
import { DocumentRuntimeLimits } from "@koala-ai/core/document-runtime/limits"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { readImageDimensions, validateOcrImage } from "../src/image"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("direct OCR image validation", () => {
  test.each([
    ["PNG", png(640, 480)],
    ["JPEG", jpeg(640, 480)],
    ["GIF", gif(640, 480)],
    ["WebP VP8X", webpExtended(640, 480)],
    ["WebP VP8", webpLossy(640, 480)],
    ["WebP VP8L", webpLossless(640, 480)],
  ])("reads bounded %s dimensions", async (_format, bytes) => {
    const fixture = await image(bytes)
    expect(await readImageDimensions(fixture.root, fixture.file, bytes.byteLength)).toEqual({ width: 640, height: 480 })
  })

  test("rejects unsupported input and declared-dimension substitution", async () => {
    const unsupported = await image(Buffer.from("not-an-image"))
    await expect(readImageDimensions(unsupported.root, unsupported.file, 12)).rejects.toEqual(
      expect.objectContaining({ code: "invalid-request", stage: "input" }),
    )

    const fixture = await image(png(640, 480))
    await expect(
      validateOcrImage(fixture.root, fixture.file, 24, { width: 1, height: 1 }, DocumentRuntimeLimits.requestedHard),
    ).rejects.toEqual(expect.objectContaining({ code: "invalid-request", stage: "input" }))
  })

  test("enforces requested limits using parsed dimensions", async () => {
    const bytes = png(640, 480)
    const fixture = await image(bytes)
    await expect(
      validateOcrImage(
        fixture.root,
        fixture.file,
        bytes.byteLength,
        { width: 640, height: 480 },
        { ...DocumentRuntimeLimits.requestedHard, rasterSidePixels: 500 },
      ),
    ).rejects.toEqual(expect.objectContaining({ code: "raster-limit-exceeded", stage: "input" }))
  })
})

async function image(bytes: Buffer) {
  const root = await mkdtemp(path.join(os.tmpdir(), "document-image-"))
  roots.push(root)
  const file = path.join(root, "input.bin")
  await writeFile(file, bytes)
  return { root, file }
}

function png(width: number, height: number) {
  const bytes = Buffer.alloc(24)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
  bytes.writeUInt32BE(13, 8)
  bytes.write("IHDR", 12, "ascii")
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}

function jpeg(width: number, height: number) {
  const bytes = Buffer.alloc(23)
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08]).copy(bytes)
  bytes.writeUInt16BE(height, 13)
  bytes.writeUInt16BE(width, 15)
  return bytes
}

function gif(width: number, height: number) {
  const bytes = Buffer.alloc(10)
  bytes.write("GIF89a", 0, "ascii")
  bytes.writeUInt16LE(width, 6)
  bytes.writeUInt16LE(height, 8)
  return bytes
}

function webpExtended(width: number, height: number) {
  const bytes = Buffer.alloc(30)
  bytes.write("RIFF", 0, "ascii")
  bytes.writeUInt32LE(22, 4)
  bytes.write("WEBPVP8X", 8, "ascii")
  writeUInt24LE(bytes, width - 1, 24)
  writeUInt24LE(bytes, height - 1, 27)
  return bytes
}

function webpLossy(width: number, height: number) {
  const bytes = Buffer.alloc(30)
  bytes.write("RIFF", 0, "ascii")
  bytes.writeUInt32LE(22, 4)
  bytes.write("WEBPVP8 ", 8, "ascii")
  Buffer.from([0x9d, 0x01, 0x2a]).copy(bytes, 23)
  bytes.writeUInt16LE(width, 26)
  bytes.writeUInt16LE(height, 28)
  return bytes
}

function webpLossless(width: number, height: number) {
  const bytes = Buffer.alloc(30)
  bytes.write("RIFF", 0, "ascii")
  bytes.writeUInt32LE(22, 4)
  bytes.write("WEBPVP8L", 8, "ascii")
  bytes[20] = 0x2f
  bytes.writeUInt32LE((width - 1) | ((height - 1) << 14), 21)
  return bytes
}

function writeUInt24LE(bytes: Buffer, value: number, offset: number) {
  bytes[offset] = value & 0xff
  bytes[offset + 1] = (value >>> 8) & 0xff
  bytes[offset + 2] = (value >>> 16) & 0xff
}
