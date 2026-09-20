import { describe, expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import path from "node:path"

const repository = path.resolve(import.meta.dir, "../../../..")

describe("document runtime production structure", () => {
  test("contains no direct document-worker launch or source proxy fallback", async () => {
    const source = await Bun.file(path.join(repository, "packages/opencode/src/document/runtime.ts")).text()
    const documentFiles = await readdir(path.join(repository, "packages/opencode/src/document"))
    expect(source).not.toContain("NativeConfinementLauncher")
    expect(source).not.toContain("workerEnvironment")
    expect(source).not.toContain('"worker/worker.js"')
    expect(source).not.toContain("src/document/proxy")
    expect(source).not.toContain("function outputPath")
    expect(source).toContain("fork(runtime.proxyPath")
    expect(source).toContain("DocumentPendingOutput.resolve")
    expect(source).not.toContain("DocumentOutput.copy")
    expect(documentFiles).not.toContain("output.ts")
    expect(source).not.toMatch(/fork\([^)]*worker/)
    expect(source).toContain("KOALA_DOCUMENT_RUNTIME_PROXY_PATH")
    expect(source).toContain("KOALA_DOCUMENT_RUNTIME_PROXY_ASSETS_ROOT")
  })

  test("contains no legacy document IPC module or production process.send path", async () => {
    const root = path.join(repository, "packages/document-runtime/src")
    const files = (await readdir(root)).filter((file) => file.endsWith(".ts"))
    expect(files).not.toContain("legacy-ipc.ts")
    const sources = await Promise.all(files.map((file) => Bun.file(path.join(root, file)).text()))
    expect(sources.join("\n")).not.toContain("process.send")
    expect(sources.join("\n")).not.toContain("startLegacyIpcWorker")
  })
})
