import { afterEach, describe, expect, test } from "bun:test"
import type { DocumentRuntimeTarget } from "@koala-ai/core/document-runtime/target"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { verifyProductionTargetBinaries } from "../src/production-profile"
import { runtimeNativeBinary, runtimeNativePackage } from "../src/runtime"

const roots: string[] = []
const targets: DocumentRuntimeTarget.Target[] = [
  "x86_64-apple-darwin",
  "aarch64-apple-darwin",
  "x86_64-pc-windows-msvc",
  "aarch64-pc-windows-msvc",
  "x86_64-unknown-linux-gnu",
  "aarch64-unknown-linux-gnu",
]

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("production target binaries", () => {
  test.each(targets)("accepts matching %s architecture and rejects the opposite architecture", async (target) => {
    const root = await temporary()
    await writeBinaries(root, target, binaryHeader(target))
    expect(await verifyProductionTargetBinaries(root, target)).toBe(true)

    await writeBinaries(root, target, binaryHeader(oppositeArchitecture(target)))
    expect(await verifyProductionTargetBinaries(root, target)).toBe(false)
  })

  test.each([
    ["x86_64-apple-darwin", "little"],
    ["x86_64-apple-darwin", "big"],
    ["aarch64-apple-darwin", "little"],
    ["aarch64-apple-darwin", "big"],
  ] as const)("accepts matching %s Mach-O %s-endian headers", async (target, endian) => {
    const root = await temporary()
    await writeBinaries(root, target, binaryHeader(target, endian))
    expect(await verifyProductionTargetBinaries(root, target)).toBe(true)
  })

  test("rejects unsupported big-endian ELF headers", async () => {
    const root = await temporary()
    await writeBinaries(root, "x86_64-unknown-linux-gnu", binaryHeader("x86_64-unknown-linux-gnu", "big"))
    expect(await verifyProductionTargetBinaries(root, "x86_64-unknown-linux-gnu")).toBe(false)
  })
})

async function temporary() {
  const root = await mkdtemp(path.join(os.tmpdir(), "document-target-"))
  roots.push(root)
  return root
}

async function writeBinaries(root: string, target: DocumentRuntimeTarget.Target, bytes: Buffer) {
  const files = [
    path.join(root, "bin", target.includes("windows") ? "tesseract.exe" : "tesseract"),
    path.join(root, "node_modules", ...runtimeNativePackage(target).split("/"), runtimeNativeBinary(target)),
  ]
  await Promise.all(
    files.map(async (file) => {
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, bytes)
    }),
  )
}

function binaryHeader(target: DocumentRuntimeTarget.Target, endian: "little" | "big" = "little") {
  const bytes = Buffer.alloc(256)
  const arm = target.startsWith("aarch64-")
  if (target.includes("windows")) {
    bytes.write("MZ", 0, "ascii")
    bytes.writeUInt32LE(128, 0x3c)
    bytes.write("PE\0\0", 128, "binary")
    bytes.writeUInt16LE(arm ? 0xaa64 : 0x8664, 132)
    return bytes
  }
  if (target.includes("linux")) {
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, endian === "little" ? 1 : 2]).copy(bytes)
    if (endian === "little") bytes.writeUInt16LE(arm ? 183 : 62, 18)
    else bytes.writeUInt16BE(arm ? 183 : 62, 18)
    return bytes
  }
  Buffer.from(endian === "little" ? [0xcf, 0xfa, 0xed, 0xfe] : [0xfe, 0xed, 0xfa, 0xcf]).copy(bytes)
  if (endian === "little") bytes.writeUInt32LE(arm ? 0x0100000c : 0x01000007, 4)
  else bytes.writeUInt32BE(arm ? 0x0100000c : 0x01000007, 4)
  return bytes
}

function oppositeArchitecture(target: DocumentRuntimeTarget.Target): DocumentRuntimeTarget.Target {
  if (target === "x86_64-pc-windows-msvc") return "aarch64-pc-windows-msvc"
  if (target === "aarch64-pc-windows-msvc") return "x86_64-pc-windows-msvc"
  if (target === "x86_64-unknown-linux-gnu") return "aarch64-unknown-linux-gnu"
  if (target === "aarch64-unknown-linux-gnu") return "x86_64-unknown-linux-gnu"
  if (target === "x86_64-apple-darwin") return "aarch64-apple-darwin"
  return "x86_64-apple-darwin"
}
