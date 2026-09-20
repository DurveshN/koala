import { afterAll, describe, expect, test } from "bun:test"
import { DocumentRuntimeLimits } from "@koala-ai/core/document-runtime/limits"
import { DocumentRuntimeManifest } from "@koala-ai/core/document-runtime/manifest"
import { DocumentRuntimeTarget } from "@koala-ai/core/document-runtime/target"
import { Deferred, Effect, Fiber, Ref, Schema } from "effect"
import { createHash } from "node:crypto"
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { DocumentRuntime } from "@/document/runtime"

const roots: string[] = []
const target = DocumentRuntimeTarget.fromHost(
  Schema.decodeUnknownSync(DocumentRuntimeTarget.HostPlatform)(process.platform),
  Schema.decodeUnknownSync(DocumentRuntimeTarget.HostArchitecture)(process.arch),
)
const proxyPath = fileURLToPath(new URL("./fixture-proxy.js", import.meta.url))
const proxyAssetsRoot = import.meta.dir
const runtime = await makeRuntime("success", true)

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

describe("document runtime proxy coordinator", () => {
  test("requires one complete runtime, digest, proxy, and assets configuration", () => {
    expect(
      DocumentRuntime.configFromEnvironment({
        KOALA_DOCUMENT_RUNTIME_PATH: runtime.config.runtimePath,
        KOALA_DOCUMENT_RUNTIME_MANIFEST_SHA256: runtime.config.manifestSha256,
        KOALA_DOCUMENT_RUNTIME_PROXY_PATH: proxyPath,
        KOALA_DOCUMENT_RUNTIME_PROXY_ASSETS_ROOT: proxyAssetsRoot,
        KOALA_DOCUMENT_RUNTIME_REQUIRE_RELEASE_READY: "true",
      }),
    ).toEqual(runtime.config)
    for (const key of [
      "KOALA_DOCUMENT_RUNTIME_PATH",
      "KOALA_DOCUMENT_RUNTIME_MANIFEST_SHA256",
      "KOALA_DOCUMENT_RUNTIME_PROXY_PATH",
      "KOALA_DOCUMENT_RUNTIME_PROXY_ASSETS_ROOT",
    ]) {
      const environment = {
        KOALA_DOCUMENT_RUNTIME_PATH: runtime.config.runtimePath,
        KOALA_DOCUMENT_RUNTIME_MANIFEST_SHA256: runtime.config.manifestSha256,
        KOALA_DOCUMENT_RUNTIME_PROXY_PATH: proxyPath,
        KOALA_DOCUMENT_RUNTIME_PROXY_ASSETS_ROOT: proxyAssetsRoot,
      }
      delete environment[key as keyof typeof environment]
      expect(DocumentRuntime.configFromEnvironment(environment)).toBeUndefined()
    }
    expect(DocumentRuntime.configFromEnvironment({ PATH: runtime.config.runtimePath })).toBeUndefined()
  })

  test("probes through the configured proxy and removes the private child and parent", async () => {
    const before = new Set(await Array.fromAsync(new Bun.Glob("opencode-document-*").scan(os.tmpdir())))
    const available = await run(
      runtime.config,
      Effect.gen(function* () {
        return yield* (yield* DocumentRuntime.Service).probe()
      }),
    )
    const after = new Set(await Array.fromAsync(new Bun.Glob("opencode-document-*").scan(os.tmpdir())))
    expect(available).toEqual({ status: "available", target, runtimeVersion: "0.1.0-test", releaseReady: true })
    expect(after).toEqual(before)
  })

  test("fails closed for absent, partial, relative, hash-mismatched, and incomplete configuration", async () => {
    const incomplete = await makeRuntime("success", false, false)
    const configs: Array<DocumentRuntime.Config | undefined> = [
      undefined,
      { ...runtime.config, runtimePath: "relative" },
      { ...runtime.config, proxyPath: "relative" },
      { ...runtime.config, proxyAssetsRoot: "relative" },
      { ...runtime.config, manifestSha256: "0".repeat(64) },
      { ...incomplete.config, requireReleaseReady: true },
    ]
    for (const config of configs) {
      expect(
        await run(
          config,
          Effect.gen(function* () {
            return yield* (yield* DocumentRuntime.Service).availability()
          }),
        ),
      ).toEqual({ status: "unavailable", code: "runtime-unavailable" })
    }
  })

  test("returns image OCR bytes only after the proxy closes and the job tree is deleted", async () => {
    const image = await temporaryFile("source.png", png(12, 8))
    const result = await run(
      runtime.config,
      Effect.gen(function* () {
        return yield* (yield* DocumentRuntime.Service).ocr({ inputPath: image })
      }),
    )
    expect(result.page).toBe(1)
    expect(result.dimensions).toEqual({ width: 12, height: 8 })
    expect(new TextDecoder().decode(result.tsv)).toContain("fixture")
    expect(Object.keys(result).sort()).toEqual(["dimensions", "page", "tsv", "tsvBytes"])
  })

  test("preserves inner and outer continuation order while scoping each rendered page", async () => {
    const pdf = await temporaryFile("source.pdf", Buffer.from("fixture-pdf"))
    const paths: string[] = []
    const result = await run(
      runtime.config,
      Effect.gen(function* () {
        return yield* (yield* DocumentRuntime.Service).renderAndOcr(
          { inputPath: pdf, startPage: 2, pageCount: 2 },
          (page) =>
            Effect.tryPromise(async () => {
              if (paths.length > 0) {
                expect(await Bun.file(paths[paths.length - 2]).exists()).toBe(false)
                expect(await Bun.file(paths[paths.length - 1]).exists()).toBe(false)
              }
              expect(await Bun.file(page.pagePath).exists()).toBe(true)
              expect(await Bun.file(page.tsvPath).text()).toContain(`\t${page.page}\n`)
              expect(path.basename(path.dirname(page.pagePath))).toStartWith("pending-")
              expect(path.basename(path.dirname(page.tsvPath))).toStartWith("pending-")
              expect(page.pagePath).not.toContain(`${path.sep}pages${path.sep}`)
              expect(page.tsvPath).not.toContain(`${path.sep}ocr${path.sep}`)
              paths.push(page.pagePath, page.tsvPath)
            }),
        )
      }),
    )
    expect(result).toEqual({ pagesProcessed: 2 })
    expect(await Promise.all(paths.map((file) => Bun.file(file).exists()))).toEqual([false, false, false, false])
  })

  test("retains the process-global two-job concurrency limit across layers", async () => {
    const pdf = await temporaryFile("concurrency.pdf", Buffer.from("fixture-pdf"))
    await run(
      runtime.config,
      Effect.gen(function* () {
        const service = yield* DocumentRuntime.Service
        const gate = yield* Deferred.make<void>()
        const twoEntered = yield* Deferred.make<void>()
        const active = yield* Ref.make(0)
        const maximum = yield* Ref.make(0)
        const calls = yield* Ref.make(0)
        const callback = () =>
          Effect.gen(function* () {
            const current = yield* Ref.updateAndGet(active, (value) => value + 1)
            yield* Ref.update(maximum, (value) => Math.max(value, current))
            const count = yield* Ref.updateAndGet(calls, (value) => value + 1)
            if (count === 2) yield* Deferred.succeed(twoEntered, undefined)
            yield* Deferred.await(gate)
            yield* Ref.update(active, (value) => value - 1)
          })
        const running = yield* Effect.all(
          Array.from({ length: 3 }, () =>
            service.renderAndOcr({ inputPath: pdf, startPage: 1, pageCount: 1 }, callback),
          ),
          { concurrency: "unbounded" },
        ).pipe(Effect.forkChild)
        yield* Deferred.await(twoEntered).pipe(Effect.timeout("5 seconds"))
        expect(yield* Ref.get(active)).toBe(2)
        expect(yield* Ref.get(maximum)).toBe(2)
        yield* Deferred.succeed(gate, undefined)
        yield* Fiber.join(running)
        expect(yield* Ref.get(calls)).toBe(3)
        expect(yield* Ref.get(maximum)).toBe(2)
      }),
    )
  })

  test.each([
    ["invalid-outer", "protocol-mismatch"],
    ["wrong-order", "invalid-order"],
    ["wrong-job", "protocol-mismatch"],
  ])("rejects hostile outer lifecycle mode %s without leaking diagnostics", async (mode, code) => {
    const broken = await makeRuntime(mode, true)
    const error = await run(
      broken.config,
      Effect.gen(function* () {
        return yield* (yield* DocumentRuntime.Service).probe()
      }).pipe(Effect.flip),
    )
    expect(error).toEqual(expect.objectContaining({ _tag: "DocumentRuntimeError", code }))
    expect(JSON.stringify(error)).not.toContain("canary")
    expect(error).not.toHaveProperty("cause")
  })

  test("does not poison later jobs after an ordinary parser failure with confirmed closure", async () => {
    const parserFailure = await makeRuntime("parser-failure", true)
    const error = await run(
      parserFailure.config,
      Effect.gen(function* () {
        return yield* (yield* DocumentRuntime.Service).probe()
      }).pipe(Effect.flip),
    )
    expect(error).toEqual(expect.objectContaining({ code: "render-failed", stage: "render" }))
    expect(
      await run(
        runtime.config,
        Effect.gen(function* () {
          return yield* (yield* DocumentRuntime.Service).availability()
        }),
      ),
    ).toEqual(expect.objectContaining({ status: "available" }))
  })

  test("rejects an oversized worker output without exposing its writable path", async () => {
    const oversized = await makeRuntime("oversize-output", true)
    const image = await temporaryFile("oversized.png", png(12, 8))
    const error = await run(
      oversized.config,
      Effect.gen(function* () {
        return yield* (yield* DocumentRuntime.Service).ocr({ inputPath: image })
      }).pipe(Effect.flip),
    )
    expect(error).toEqual(expect.objectContaining({ code: "worker-failed" }))
    expect(
      await run(
        runtime.config,
        Effect.gen(function* () {
          return yield* (yield* DocumentRuntime.Service).availability()
        }),
      ),
    ).toEqual(expect.objectContaining({ status: "available" }))
  })

  test.each(["duplicate-output-id", "wrong-output-extension"])(
    "rejects parent output correlation mode %s",
    async (mode) => {
      const broken = await makeRuntime(mode, true)
      const pdf = await temporaryFile(`${mode}.pdf`, Buffer.from("fixture-pdf"))
      const error = await run(
        broken.config,
        Effect.gen(function* () {
          return yield* (yield* DocumentRuntime.Service).renderAndOcr(
            { inputPath: pdf, startPage: 1, pageCount: 1 },
            () => Effect.void,
          )
        }).pipe(Effect.flip),
      )
      expect(error).toEqual(expect.objectContaining({ code: "invalid-order", stage: "worker" }))
    },
  )

  test("wraps deadline and caller interruption in one outer cancel and verifies cleanup", async () => {
    const hanging = await makeRuntime("hang", true)
    const image = await temporaryFile("deadline.png", png(12, 8))
    const error = await run(
      hanging.config,
      Effect.gen(function* () {
        return yield* (yield* DocumentRuntime.Service).ocr({
          inputPath: image,
          limits: { ...DocumentRuntimeLimits.requestedHard, jobDeadlineMs: 25 },
        })
      }).pipe(Effect.flip),
    )
    expect(error).toEqual(expect.objectContaining({ code: "job-deadline-exceeded", retryable: true }))

    const pdf = await temporaryFile("cancel.pdf", Buffer.from("fixture-pdf"))
    const page = await run(
      runtime.config,
      Effect.gen(function* () {
        const service = yield* DocumentRuntime.Service
        const entered = yield* Deferred.make<DocumentRuntime.ScopedPage>()
        const fiber = yield* service
          .renderAndOcr({ inputPath: pdf, startPage: 1, pageCount: 1 }, (value) =>
            Deferred.succeed(entered, value).pipe(Effect.andThen(Effect.never)),
          )
          .pipe(Effect.forkChild)
        const value = yield* Deferred.await(entered).pipe(Effect.timeout("5 seconds"))
        yield* Fiber.interrupt(fiber)
        return value
      }),
    )
    expect(await Bun.file(page.pagePath).exists()).toBe(false)
    expect(await Bun.file(page.tsvPath).exists()).toBe(false)
  })

  test("latches the process unhealthy after pending-root identity failure", async () => {
    const identityFailure = await makeRuntime("root-identity-failure", true)
    const error = await run(
      identityFailure.config,
      Effect.gen(function* () {
        return yield* (yield* DocumentRuntime.Service).probe()
      }).pipe(Effect.flip),
    )
    expect(error).toEqual(expect.objectContaining({ code: "worker-failed" }))
    expect(
      await run(
        runtime.config,
        Effect.gen(function* () {
          return yield* (yield* DocumentRuntime.Service).availability()
        }),
      ),
    ).toEqual({ status: "unavailable", code: "runtime-unavailable" })
  })
})

async function run<A, E>(
  config: DocumentRuntime.Config | undefined,
  effect: Effect.Effect<A, E, DocumentRuntime.Service>,
) {
  return Effect.runPromise(effect.pipe(Effect.provide(DocumentRuntime.layer(config))))
}

async function temporaryFile(name: string, body: Uint8Array) {
  const root = await mkdtemp(path.join(os.tmpdir(), "document-adapter-input-"))
  roots.push(root)
  const file = path.join(root, name)
  await writeFile(file, body)
  return file
}

async function makeRuntime(mode: string, releaseReady: boolean, complete = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), "document-adapter-runtime-"))
  roots.push(root)
  const nativePackage = {
    "x86_64-apple-darwin": "@napi-rs/canvas-darwin-x64",
    "aarch64-apple-darwin": "@napi-rs/canvas-darwin-arm64",
    "x86_64-pc-windows-msvc": "@napi-rs/canvas-win32-x64-msvc",
    "aarch64-pc-windows-msvc": "@napi-rs/canvas-win32-arm64-msvc",
    "x86_64-unknown-linux-gnu": "@napi-rs/canvas-linux-x64-gnu",
    "aarch64-unknown-linux-gnu": "@napi-rs/canvas-linux-arm64-gnu",
  }[target]
  const executable = target.includes("windows") ? "bin/tesseract.exe" : "bin/tesseract"
  const files = [
    "package.json",
    "worker/bootstrap.js",
    "worker/worker.js",
    executable,
    "tessdata/eng.traineddata",
    "tessdata/osd.traineddata",
    "node_modules/pdfjs-dist/legacy/build/pdf.mjs",
    "node_modules/pdfjs-dist/cmaps/fixture.bcmap",
    "node_modules/pdfjs-dist/iccs/fixture.icc",
    "node_modules/pdfjs-dist/standard_fonts/fixture.pfb",
    "node_modules/pdfjs-dist/wasm/fixture.wasm",
    "node_modules/@napi-rs/canvas/index.js",
    `node_modules/${nativePackage}/native.node`,
    "LICENSE",
  ]
  for (const file of files) await mkdir(path.dirname(path.join(root, ...file.split("/"))), { recursive: true })
  await copyFile(proxyPath, path.join(root, "worker", "worker.js"))
  await Promise.all(
    files
      .filter((file) => file !== "worker/worker.js")
      .map((file) => writeFile(path.join(root, ...file.split("/")), file === executable ? "fixture" : file)),
  )
  if (!target.includes("windows")) await chmod(path.join(root, executable), 0o755)

  const manifestFiles = await Promise.all(
    files.map(async (file) => {
      const body = await readFile(path.join(root, ...file.split("/")))
      return {
        path: DocumentRuntimeManifest.RelativePath.make(file),
        component: "fixture",
        sha256: DocumentRuntimeManifest.Digest.make(createHash("sha256").update(body).digest("hex")),
        bytes: body.byteLength,
        mode: (file === executable ? 0o755 : 0o644) as DocumentRuntimeManifest.FileMode,
      }
    }),
  )
  const manifest = Schema.decodeUnknownSync(DocumentRuntimeManifest.Manifest)({
    manifestVersion: 1,
    protocolVersion: 1,
    releaseReady,
    runtimeVersion: "0.1.0-test",
    target,
    architecture: DocumentRuntimeTarget.architecture(target),
    components: [
      {
        name: "fixture",
        version: "0.1.0",
        sourceRevision: mode,
        sourceSha256: DocumentRuntimeManifest.Digest.make("1".repeat(64)),
        licenseFiles: ["LICENSE"],
      },
    ],
    files: complete ? manifestFiles : manifestFiles.filter((file) => file.path !== "worker/bootstrap.js"),
    dependencies: [],
  })
  const manifestBody = `${JSON.stringify(manifest)}\n`
  await writeFile(path.join(root, "manifest.json"), manifestBody)
  return {
    root,
    config: {
      runtimePath: root,
      manifestSha256: createHash("sha256").update(manifestBody).digest("hex"),
      proxyPath,
      proxyAssetsRoot,
      requireReleaseReady: releaseReady,
    } satisfies DocumentRuntime.Config,
  }
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
