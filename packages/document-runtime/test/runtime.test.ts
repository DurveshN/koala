import { describe, expect, test } from "bun:test"
import { DocumentRuntimeManifest } from "@koala-ai/core/document-runtime/manifest"
import { DocumentRuntimeTarget } from "@koala-ai/core/document-runtime/target"
import { Schema } from "effect"
import path from "node:path"
import { runtimePaths, sanitizeNativeLoaderEnvironment } from "../src/runtime"
import { workerConfigFromEnvironment } from "../src/worker"

describe("verified runtime configuration", () => {
  test("derives target-specific paths and ignores executable path environment", () => {
    const root = path.resolve("runtime")
    const jobRoot = path.resolve("jobs", "one")
    const target = DocumentRuntimeTarget.fromHost(
      process.platform as DocumentRuntimeTarget.HostPlatform,
      process.arch as DocumentRuntimeTarget.HostArchitecture,
    )
    const config = workerConfigFromEnvironment({
      DOCUMENT_RUNTIME_ROOT: root,
      DOCUMENT_JOB_ROOT: jobRoot,
      DOCUMENT_RUNTIME_TARGET: target,
      DOCUMENT_RUNTIME_MANIFEST_SHA256: "0".repeat(64),
      DOCUMENT_RUNTIME_TESSERACT_EXECUTABLE: path.resolve("untrusted", "tesseract"),
      DOCUMENT_RUNTIME_TESSDATA: path.resolve("untrusted", "tessdata"),
    })
    expect(config).not.toHaveProperty("tesseractExecutable")
    expect(config).not.toHaveProperty("tessdataPath")
    expect(runtimePaths(config.runtimeRoot, config.target)).toEqual(
      expect.objectContaining({
        worker: path.join(root, "worker", "worker.js"),
        tesseract: path.join(root, "bin", process.platform === "win32" ? "tesseract.exe" : "tesseract"),
        tessdata: path.join(root, "tessdata"),
        pdfRoot: path.join(root, "node_modules", "pdfjs-dist"),
        canvasEntry: path.join(root, "node_modules", "@napi-rs", "canvas", "index.js"),
      }),
    )
  })

  test("requires a trusted manifest digest", () => {
    expect(() =>
      workerConfigFromEnvironment({
        DOCUMENT_RUNTIME_ROOT: path.resolve("runtime"),
        DOCUMENT_JOB_ROOT: path.resolve("jobs", "one"),
        DOCUMENT_RUNTIME_TARGET: DocumentRuntimeTarget.fromHost(
          process.platform as DocumentRuntimeTarget.HostPlatform,
          process.arch as DocumentRuntimeTarget.HostArchitecture,
        ),
      }),
    ).toThrow()
  })

  test("sanitizes native loader variables and disables system font loading", () => {
    const environment: NodeJS.ProcessEnv = {
      NAPI_RS_NATIVE_LIBRARY_PATH: "untrusted",
      NODE_OPTIONS: "--require=untrusted",
      LD_LIBRARY_PATH: "untrusted",
      LD_PRELOAD: "untrusted",
      DYLD_INSERT_LIBRARIES: "untrusted",
      DYLD_LIBRARY_PATH: "untrusted",
    }
    sanitizeNativeLoaderEnvironment(environment)
    expect(environment).toEqual({ DISABLE_SYSTEM_FONTS_LOAD: "1" })
  })

  test("does not attribute the unresolved Koala license to the OpenCode root license", async () => {
    const target = DocumentRuntimeTarget.fromHost(
      process.platform as DocumentRuntimeTarget.HostPlatform,
      process.arch as DocumentRuntimeTarget.HostArchitecture,
    )
    const root = path.resolve(import.meta.dir, "..", "dist", target)
    const manifest = Schema.decodeUnknownSync(DocumentRuntimeManifest.Manifest)(
      await Bun.file(path.join(root, "manifest.json")).json(),
    )
    expect(manifest.components.find((component) => component.name === "document-runtime")?.licenseFiles).toEqual([])
    expect(await Bun.file(path.join(root, "licenses", "koala", "LICENSE")).exists()).toBe(false)
    expect(await Bun.file(path.join(root, "licenses", "THIRD_PARTY_NOTICES.md")).exists()).toBe(true)
    expect(manifest.releaseReady).toBe(false)
  })
})
