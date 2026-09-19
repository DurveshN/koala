import { afterAll, describe, expect, test } from "bun:test"
import { DocumentRuntimeLimits } from "@koala-ai/core/document-runtime/limits"
import { DocumentRuntimeManifest } from "@koala-ai/core/document-runtime/manifest"
import { DocumentRuntimeTarget } from "@koala-ai/core/document-runtime/target"
import { terminateProcessTree } from "@koala-ai/document-runtime"
import { Deferred, Effect, Fiber, Ref, Schema } from "effect"
import { createHash } from "node:crypto"
import { fork } from "node:child_process"
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DocumentRuntime } from "@/document/runtime"

const roots: string[] = []
const target = DocumentRuntimeTarget.fromHost(
  Schema.decodeUnknownSync(DocumentRuntimeTarget.HostPlatform)(process.platform),
  Schema.decodeUnknownSync(DocumentRuntimeTarget.HostArchitecture)(process.arch),
)
const runtime = await makeRuntime("fixture-worker.js", true)

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

describe("document runtime adapter", () => {
  test("reads one immutable production configuration without fallback", () => {
    expect(
      DocumentRuntime.configFromEnvironment({
        KOALA_DOCUMENT_RUNTIME_PATH: runtime.config.runtimePath,
        KOALA_DOCUMENT_RUNTIME_MANIFEST_SHA256: runtime.config.manifestSha256,
        KOALA_DOCUMENT_RUNTIME_REQUIRE_RELEASE_READY: "true",
      }),
    ).toEqual({ ...runtime.config, requireReleaseReady: true })
    expect(DocumentRuntime.configFromEnvironment({ PATH: runtime.config.runtimePath })).toBeUndefined()
    expect(
      DocumentRuntime.configFromEnvironment({
        KOALA_DOCUMENT_RUNTIME_PATH: "relative",
        KOALA_DOCUMENT_RUNTIME_MANIFEST_SHA256: runtime.config.manifestSha256,
      }),
    ).toEqual({ runtimePath: "relative", manifestSha256: runtime.config.manifestSha256, requireReleaseReady: false })
    expect(
      DocumentRuntime.workerEnvironment(
        runtime.config.runtimePath,
        target,
        DocumentRuntimeManifest.Digest.make(runtime.config.manifestSha256),
        "C:\\private-job",
        { PATH: "credential-canary", AWS_SECRET_ACCESS_KEY: "credential-canary" },
      ),
    ).not.toHaveProperty("PATH")
  })

  test("probes a verified root with a reduced worker environment", async () => {
    process.env.AWS_SECRET_ACCESS_KEY = "credential-canary"
    try {
      const available = await run(
        runtime.config,
        Effect.gen(function* () {
          return yield* (yield* DocumentRuntime.Service).probe()
        }),
      )
      expect(available).toEqual({ status: "available", target, runtimeVersion: "0.1.0-test", releaseReady: true })
    } finally {
      delete process.env.AWS_SECRET_ACCESS_KEY
    }
  })

  test("fails closed when no native-confinement launcher is supplied", async () => {
    expect(
      await Effect.runPromise(
        Effect.gen(function* () {
          return yield* (yield* DocumentRuntime.Service).availability()
        }).pipe(Effect.provide(DocumentRuntime.layer(runtime.config))),
      ),
    ).toEqual({ status: "unavailable", code: "runtime-unavailable" })
  })

  test("fails closed for absent, relative, hash-mismatched, and incomplete runtimes", async () => {
    const incomplete = await makeRuntime("fixture-worker.js", false)
    const configs: Array<DocumentRuntime.Config | undefined> = [
      undefined,
      { ...runtime.config, runtimePath: "relative" },
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

  test("returns direct image OCR bytes without exposing a private path", async () => {
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

  test("keeps each rendered page and TSV scoped to one callback then releases it", async () => {
    const pdf = await temporaryFile("source.pdf", Buffer.from("fixture-pdf"))
    const paths: string[] = []
    const pages = await run(
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
              expect(await Bun.file(page.tsvPath).exists()).toBe(true)
              expect(await Bun.file(page.tsvPath).text()).toContain(`\t${page.page}\tfixture`)
              paths.push(page.pagePath, page.tsvPath)
            }),
        )
      }),
    )
    expect(pages).toEqual({ pagesProcessed: 2 })
    expect(paths).toHaveLength(4)
    expect(await Promise.all(paths.map((file) => Bun.file(file).exists()))).toEqual([false, false, false, false])
  })

  test("shares a process-global two-job concurrency limit across layers", async () => {
    const pdf = await temporaryFile("source.pdf", Buffer.from("fixture-pdf"))
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
            yield* Ref.update(calls, (value) => value + 1)
            if (current === 2) yield* Deferred.succeed(twoEntered, undefined)
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

  test("rejects the incomplete real built worker until bundled Tesseract is present", async () => {
    const built = path.resolve(import.meta.dir, "../../../document-runtime/dist", target, "worker", "worker.js")
    if (!(await Bun.file(built).exists())) return
    const builtRuntime = await makeRuntime(built, false)
    const error = await run(
      builtRuntime.config,
      Effect.gen(function* () {
        return yield* (yield* DocumentRuntime.Service).probe()
      }).pipe(Effect.flip),
    )
    expect(error).toEqual(expect.objectContaining({ code: "runtime-unavailable", stage: "probe" }))
  })

  test.each([
    ["fixture-invalid-worker.js", "worker-failed"],
    ["fixture-wrong-order-worker.js", "invalid-order"],
    ["fixture-wrong-job-worker.js", "job-mismatch"],
    ["fixture-crash-worker.js", "worker-failed"],
  ])("rejects invalid or crashed worker %s", async (fixture, code) => {
    const broken = await makeRuntime(fixture, true)
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

  test("enforces the whole-job deadline and accepts caller interruption", async () => {
    const hanging = await makeRuntime("fixture-hang-worker.js", true)
    const image = await temporaryFile("source.png", png(12, 8))
    const limits = { ...DocumentRuntimeLimits.requestedHard, jobDeadlineMs: 25 }
    const deadline = await run(
      hanging.config,
      Effect.gen(function* () {
        return yield* (yield* DocumentRuntime.Service).ocr({ inputPath: image, limits })
      }).pipe(Effect.flip),
    )
    expect(deadline).toEqual(
      expect.objectContaining({ code: "job-deadline-exceeded", stage: "worker", retryable: true }),
    )

    const cancelPdf = await temporaryFile("cancel.pdf", Buffer.from("fixture-pdf"))
    const scoped = await run(
      runtime.config,
      Effect.gen(function* () {
        const service = yield* DocumentRuntime.Service
        const entered = yield* Deferred.make<DocumentRuntime.ScopedPage>()
        const fiber = yield* service
          .renderAndOcr({ inputPath: cancelPdf, startPage: 1, pageCount: 1 }, (page) =>
            Deferred.succeed(entered, page).pipe(Effect.andThen(Effect.never)),
          )
          .pipe(Effect.forkChild)
        const page = yield* Deferred.await(entered).pipe(Effect.timeout("5 seconds"))
        expect(yield* Effect.promise(() => Bun.file(page.pagePath).exists())).toBe(true)
        expect(yield* Effect.promise(() => Bun.file(page.tsvPath).exists())).toBe(true)
        yield* Fiber.interrupt(fiber)
        return page
      }),
    )
    expect(await Bun.file(scoped.pagePath).exists()).toBe(false)
    expect(await Bun.file(scoped.tsvPath).exists()).toBe(false)
  })

  test("bounds a stalled confinement-launcher termination and applies the process-tree fallback", async () => {
    const hanging = await makeRuntime("fixture-ignore-cancel-worker.js", true)
    const image = await temporaryFile("bounded-reap.png", png(12, 8))
    const started = Date.now()
    const error = await run(
      hanging.config,
      Effect.gen(function* () {
        return yield* (yield* DocumentRuntime.Service).ocr({
          inputPath: image,
          limits: { ...DocumentRuntimeLimits.requestedHard, jobDeadlineMs: 25 },
        })
      }).pipe(Effect.flip),
      { ...testLauncher, terminate: () => new Promise<void>(() => undefined) },
    )
    expect(error).toEqual(expect.objectContaining({ code: "job-deadline-exceeded", stage: "worker" }))
    expect(Date.now() - started).toBeLessThan(6_000)
  })
})

const testLauncher: DocumentRuntime.NativeConfinementLauncher = {
  launch: (input) =>
    fork(input.workerPath, [], {
      cwd: input.cwd,
      detached: process.platform !== "win32",
      env: input.environment,
      execArgv: [],
      serialization: "json",
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    }),
  terminate: (child, graceMs) => terminateProcessTree(child, process.platform, process.env.SystemRoot, graceMs),
}

async function run<A, E>(
  config: DocumentRuntime.Config | undefined,
  effect: Effect.Effect<A, E, DocumentRuntime.Service>,
  launcher = testLauncher,
) {
  return Effect.runPromise(
    effect.pipe(Effect.provide(DocumentRuntime.layer(config, launcher))),
  )
}

async function temporaryFile(name: string, body: Uint8Array) {
  const root = await mkdtemp(path.join(os.tmpdir(), "document-adapter-input-"))
  roots.push(root)
  const file = path.join(root, name)
  await writeFile(file, body)
  return file
}

async function makeRuntime(worker: string, releaseReady: boolean) {
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
  await copyFile(
    path.isAbsolute(worker) ? worker : path.join(import.meta.dir, worker),
    path.join(root, "worker", "worker.js"),
  )
  await Promise.all(
    files
      .slice(1)
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
        sourceRevision: "test",
        sourceSha256: DocumentRuntimeManifest.Digest.make("1".repeat(64)),
        licenseFiles: ["LICENSE"],
      },
    ],
    files: manifestFiles,
    dependencies: [],
  })
  const manifestBody = `${JSON.stringify(manifest)}\n`
  await writeFile(path.join(root, "manifest.json"), manifestBody)
  return {
    root,
    config: {
      runtimePath: root,
      manifestSha256: createHash("sha256").update(manifestBody).digest("hex"),
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
