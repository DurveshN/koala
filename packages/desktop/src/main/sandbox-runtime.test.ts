import { describe, expect, test } from "bun:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { resolveSandboxWorkerPath } from "./sandbox-runtime"

describe("sandbox runtime resources", () => {
  test("resolves the worker from Electron resources in a packaged app", () => {
    expect(
      resolveSandboxWorkerPath({
        packaged: true,
        resourcesPath: path.resolve("packaged-resources"),
        moduleURL: pathToFileURL(path.resolve("out/main/index.js")).href,
      }),
    ).toBe(path.resolve("packaged-resources/sandbox-runtime/sandbox-worker.mjs"))
  })

  test("resolves the worker from the OpenCode Node build in development", () => {
    const desktop = path.resolve("workspace/packages/desktop")
    expect(
      resolveSandboxWorkerPath({
        packaged: false,
        resourcesPath: path.resolve("unused"),
        moduleURL: pathToFileURL(path.join(desktop, "out/main/index.js")).href,
      }),
    ).toBe(path.resolve("workspace/packages/opencode/dist/node/sandbox-runtime/sandbox-worker.mjs"))
  })
})
