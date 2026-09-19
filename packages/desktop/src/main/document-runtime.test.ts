import { afterAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { resolveDocumentRuntime } from "./document-runtime"
import { productionRuntimeFixture } from "../../test/fixture/document-runtime"

const target = "x86_64-pc-windows-msvc" as const
const roots: string[] = []

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

describe("document runtime resolution", () => {
  test("resolves a release-ready packaged runtime from Electron resources", async () => {
    const resourcesPath = await temporaryDirectory()
    const runtime = path.join(resourcesPath, "document-runtime")
    await productionRuntimeFixture(runtime, target, path.join(resourcesPath, "document-runtime.attestation.json"))

    const resolved = await resolveDocumentRuntime({
      packaged: true,
      resourcesPath,
      moduleURL: pathToFileURL(path.resolve("out/main/index.js")).href,
      environment: { KOALA_DOCUMENT_RUNTIME_OVERRIDE: "C:\\untrusted\\runtime" },
      platform: "win32",
      architecture: "x64",
    })

    expect(resolved).toEqual({
      root: await realpath(runtime),
      manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      releaseReady: true,
    })
  })

  test("resolves the host-target build in development", async () => {
    const workspace = await temporaryDirectory()
    const desktop = path.join(workspace, "packages", "desktop")
    const runtime = path.join(workspace, "packages", "document-runtime", "dist", target)
    await fixture(runtime, false)

    expect(
      await resolveDocumentRuntime({
        packaged: false,
        resourcesPath: path.resolve("unused"),
        moduleURL: pathToFileURL(path.join(desktop, "out", "main", "index.js")).href,
        environment: {},
        platform: "win32",
        architecture: "x64",
      }),
    ).toEqual({
      root: await realpath(runtime),
      manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      releaseReady: false,
    })
  })

  test("uses only an absolute explicit override in development", async () => {
    const runtime = await temporaryDirectory()
    await fixture(runtime, false)
    const input = {
      packaged: false,
      resourcesPath: path.resolve("unused"),
      moduleURL: pathToFileURL(path.resolve("workspace/packages/desktop/out/main/index.js")).href,
      platform: "win32" as const,
      architecture: "x64",
    }

    expect(
      await resolveDocumentRuntime({
        ...input,
        environment: { KOALA_DOCUMENT_RUNTIME_OVERRIDE: runtime },
      }),
    ).toEqual({
      root: await realpath(runtime),
      manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      releaseReady: false,
    })
    expect(
      await resolveDocumentRuntime({
        ...input,
        environment: { KOALA_DOCUMENT_RUNTIME_OVERRIDE: "relative/runtime" },
      }),
    ).toBeUndefined()
  })

  test("rejects changed runtime files", async () => {
    const runtime = await temporaryDirectory()
    await fixture(runtime, false)
    await writeFile(path.join(runtime, "worker", "worker.js"), "changed")

    expect(
      await resolveDocumentRuntime({
        packaged: false,
        resourcesPath: path.resolve("unused"),
        moduleURL: pathToFileURL(path.resolve("workspace/packages/desktop/out/main/index.js")).href,
        environment: { KOALA_DOCUMENT_RUNTIME_OVERRIDE: runtime },
        platform: "win32",
        architecture: "x64",
      }),
    ).toBeUndefined()
  })

  test("rejects an incomplete packaged runtime", async () => {
    const resourcesPath = await temporaryDirectory()
    await productionRuntimeFixture(
      path.join(resourcesPath, "document-runtime"),
      target,
      path.join(resourcesPath, "document-runtime.attestation.json"),
      false,
    )

    expect(
      await resolveDocumentRuntime({
        packaged: true,
        resourcesPath,
        moduleURL: pathToFileURL(path.resolve("out/main/index.js")).href,
        platform: "win32",
        architecture: "x64",
      }),
    ).toBeUndefined()
  })

  test("rejects a packaged runtime without its detached attestation", async () => {
    const resourcesPath = await temporaryDirectory()
    const runtime = path.join(resourcesPath, "document-runtime")
    const attestation = path.join(resourcesPath, "document-runtime.attestation.json")
    await productionRuntimeFixture(runtime, target, attestation)
    await rm(attestation)

    expect(
      await resolveDocumentRuntime({
        packaged: true,
        resourcesPath,
        moduleURL: pathToFileURL(path.resolve("out/main/index.js")).href,
        platform: "win32",
        architecture: "x64",
      }),
    ).toBeUndefined()
  })
})

async function temporaryDirectory() {
  const root = await mkdtemp(path.join(os.tmpdir(), "desktop-document-runtime-"))
  roots.push(root)
  return root
}

async function fixture(root: string, releaseReady: boolean) {
  const contents = Buffer.from("worker")
  const digest = createHash("sha256").update(contents).digest("hex")
  await mkdir(path.join(root, "worker"), { recursive: true })
  await writeFile(path.join(root, "worker", "worker.js"), contents, { mode: 0o644 })
  await chmod(path.join(root, "worker", "worker.js"), 0o644)
  await writeFile(
    path.join(root, "manifest.json"),
    JSON.stringify({
      manifestVersion: 1,
      protocolVersion: 1,
      releaseReady,
      runtimeVersion: "0.1.0-test",
      target,
      architecture: "x86_64",
      components: [
        {
          name: "fixture",
          version: "0.1.0",
          sourceRevision: "fixture",
          sourceSha256: digest,
          licenseFiles: ["worker/worker.js"],
        },
      ],
      files: [
        {
          path: "worker/worker.js",
          component: "fixture",
          sha256: digest,
          bytes: contents.byteLength,
          mode: 0o644,
        },
      ],
      dependencies: [],
    }),
  )
}
