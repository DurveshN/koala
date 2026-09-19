import type { DocumentRuntimeLimits } from "@koala-ai/core/document-runtime/limits"
import { open } from "node:fs/promises"
import { RuntimeFailure } from "./error"
import { validateInputFile } from "./path"

const MaxHeaderBytes = 1024 * 1024

export type ImageDimensions = {
  readonly width: number
  readonly height: number
}

export async function readImageDimensions(root: string, file: string, declaredBytes: number) {
  await validateInputFile(root, file, declaredBytes)
  const handle = await open(file, "r")
  try {
    const header = Buffer.allocUnsafe(Math.min(declaredBytes, MaxHeaderBytes))
    const { bytesRead } = await handle.read(header, 0, header.byteLength, 0)
    return dimensions(header.subarray(0, bytesRead))
  } finally {
    await handle.close()
  }
}

export async function validateOcrImage(
  root: string,
  file: string,
  declaredBytes: number,
  declaredDimensions: ImageDimensions,
  limits: DocumentRuntimeLimits.Requested,
) {
  const actual = await readImageDimensions(root, file, declaredBytes)
  if (actual.width !== declaredDimensions.width || actual.height !== declaredDimensions.height) {
    throw new RuntimeFailure("invalid-request", "input")
  }
  if (
    actual.width > limits.rasterSidePixels ||
    actual.height > limits.rasterSidePixels ||
    actual.width * actual.height > limits.rasterAreaPixels
  ) {
    throw new RuntimeFailure("raster-limit-exceeded", "input")
  }
  return actual
}

function dimensions(bytes: Buffer): ImageDimensions {
  const result = png(bytes) ?? jpeg(bytes) ?? gif(bytes) ?? webp(bytes)
  if (!result || result.width < 1 || result.height < 1) throw new RuntimeFailure("invalid-request", "input")
  return result
}

function png(bytes: Buffer) {
  if (bytes.byteLength < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return
  if (bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR") return
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

function gif(bytes: Buffer) {
  if (
    bytes.byteLength < 10 ||
    (bytes.toString("ascii", 0, 6) !== "GIF87a" && bytes.toString("ascii", 0, 6) !== "GIF89a")
  ) {
    return
  }
  return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) }
}

function jpeg(bytes: Buffer) {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return
  let offset = 2
  while (offset + 3 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) return
    while (bytes[offset] === 0xff) offset++
    const marker = bytes[offset++]
    if (marker === undefined || marker === 0xd9 || marker === 0xda) return
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > bytes.byteLength) return
    const length = bytes.readUInt16BE(offset)
    if (length < 2 || offset + length > bytes.byteLength) return
    if (isStartOfFrame(marker) && length >= 7) {
      return { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) }
    }
    offset += length
  }
}

function isStartOfFrame(marker: number) {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
}

function webp(bytes: Buffer) {
  if (bytes.byteLength < 30 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP") {
    return
  }
  const kind = bytes.toString("ascii", 12, 16)
  if (kind === "VP8X") {
    return { width: readUInt24LE(bytes, 24) + 1, height: readUInt24LE(bytes, 27) + 1 }
  }
  if (kind === "VP8 " && bytes.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))) {
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff }
  }
  if (kind === "VP8L" && bytes[20] === 0x2f) {
    const packed = bytes.readUInt32LE(21)
    return { width: (packed & 0x3fff) + 1, height: ((packed >>> 14) & 0x3fff) + 1 }
  }
}

function readUInt24LE(bytes: Buffer, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)
}
