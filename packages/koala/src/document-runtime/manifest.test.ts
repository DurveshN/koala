import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { DocumentRuntimeManifest } from "./manifest.ts"

const hash = "0123456789abcdef".repeat(4)
const licensePath = "licenses/tesseract-LICENSE.txt"

const manifest = () => ({
  manifestVersion: 1 as const,
  protocolVersion: 1 as const,
  releaseReady: false,
  runtimeVersion: "1.0.0",
  target: "x86_64-pc-windows-msvc" as const,
  architecture: "x86_64" as const,
  components: [
    {
      name: "tesseract",
      version: "5.5.3",
      sourceRevision: "v5.5.3",
      sourceSha256: hash,
      licenseFiles: [licensePath],
    },
  ],
  files: [
    { path: "bin/tesseract.exe", component: "tesseract", sha256: hash, bytes: 1024, mode: 0o755 as const },
    { path: licensePath, component: "tesseract", sha256: hash, bytes: 256, mode: 0o644 as const },
  ],
  dependencies: [
    {
      name: "leptonica",
      version: "1.87.0",
      component: "tesseract",
      linkage: "static" as const,
      licenseFiles: [licensePath],
    },
  ],
})

describe("DocumentRuntimeManifest", () => {
  const decode = Schema.decodeUnknownSync(DocumentRuntimeManifest.Manifest)
  const encode = Schema.encodeSync(DocumentRuntimeManifest.Manifest)

  test("round trips a target-specific hashed manifest", () => {
    const input = manifest()
    expect(encode(decode(input))).toEqual(input)
  })

  test("requires an explicit release-readiness declaration", () => {
    const input = manifest()
    const { releaseReady: _, ...missing } = input
    expect(() => decode(missing)).toThrow()
  })

  test.each([
    "",
    "/absolute/file",
    "C:/absolute/file",
    "../escape",
    "safe/../escape",
    "safe\\file",
    "safe//file",
    "safe/./file",
    "safe/file.",
    "safe/NUL.txt",
    "safe/file\0name",
  ])("rejects non-normalized relative path %j", (path) => {
    expect(() => Schema.decodeUnknownSync(DocumentRuntimeManifest.RelativePath)(path)).toThrow()
  })

  test("rejects target and architecture substitution", () => {
    expect(() => decode({ ...manifest(), architecture: "aarch64" })).toThrow(
      "Manifest architecture does not match its target",
    )
  })

  test("requires unique component names and file paths", () => {
    const input = manifest()
    expect(() => decode({ ...input, components: [...input.components, input.components[0]] })).toThrow()
    expect(() =>
      decode({ ...input, files: [...input.files, { ...input.files[0], path: "BIN/TESSERACT.EXE" }] }),
    ).toThrow()
  })

  test("requires component ownership and hashed license files", () => {
    const input = manifest()
    expect(() =>
      decode({ ...input, files: [{ ...input.files[0], component: "undeclared" }, input.files[1]] }),
    ).toThrow()
    expect(() =>
      decode({
        ...input,
        components: [{ ...input.components[0], licenseFiles: ["licenses/missing.txt"] }],
      }),
    ).toThrow("Every license path must reference a hashed manifest file")
  })

  test("allows incomplete notice inventories only when release readiness is false", () => {
    const input = manifest()
    const incomplete = {
      ...input,
      components: [{ ...input.components[0], licenseFiles: [] }],
      dependencies: [{ ...input.dependencies[0], licenseFiles: [] }],
    }
    expect(decode(incomplete).releaseReady).toBe(false)
    expect(() => decode({ ...incomplete, releaseReady: true })).toThrow(
      "Release-ready manifests require license files for every component and dependency",
    )
  })

  test.each(["ABCDEF".repeat(10) + "ABCD", "0".repeat(63), "0".repeat(65)])("rejects invalid hash %s", (sha256) => {
    expect(() => decode({ ...manifest(), files: [{ ...manifest().files[0], sha256 }, manifest().files[1]] })).toThrow()
  })
})
