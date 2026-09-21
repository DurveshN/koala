import { afterAll, describe, expect, test } from "bun:test"
import { createHash, generateKeyPairSync } from "node:crypto"
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { resolveDocumentRuntime } from "./document-runtime"
import { resolveSandboxRuntime } from "./sandbox-runtime"
import { confinementEvidenceFixture, productionRuntimeFixture } from "../../test/fixture/document-runtime"

const target = "x86_64-pc-windows-msvc" as const
const roots: string[] = []

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

describe("document runtime resolution", () => {
  test("resolves a release-ready packaged runtime from Electron resources", async () => {
    const resourcesPath = await temporaryDirectory()
    const runtime = path.join(resourcesPath, "document-runtime")
    const sandboxRuntime = await packagedSandboxFixture(resourcesPath)
    await productionRuntimeFixture(runtime, target, path.join(resourcesPath, "document-runtime.attestation.json"))
    const confinement = await confinementEvidenceFixture(resourcesPath, target, sandboxRuntime)
    expect(confinement.keyID).toBe(
      createHash("sha256")
        .update(await Bun.file(path.join(resourcesPath, "document-confinement-evidence", "issuer-public-key.spki.der")).bytes())
        .digest("hex"),
    )

    const resolved = await resolveDocumentRuntime({
      packaged: true,
      releaseVersion: "1.2.3",
      resourcesPath,
      moduleURL: pathToFileURL(path.resolve("out/main/index.js")).href,
      environment: { KOALA_DOCUMENT_RUNTIME_OVERRIDE: "C:\\untrusted\\runtime" },
      platform: "win32",
      architecture: "x64",
      sandboxRuntime,
    })

    expect(resolved).toEqual({
      root: await realpath(runtime),
      manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      releaseReady: true,
      proxyPath: sandboxRuntime.documentProxyPath,
      proxyAssetsRoot: sandboxRuntime.root,
    })
    expect(
      await resolveDocumentRuntime({
        packaged: true,
        releaseVersion: "9.9.9",
        resourcesPath,
        moduleURL: pathToFileURL(path.resolve("out/main/index.js")).href,
        platform: "win32",
        architecture: "x64",
        sandboxRuntime,
      }),
    ).toBeUndefined()

    const evidencePath = path.join(resourcesPath, "document-confinement-evidence", "evidence.json")
    const evidence = await Bun.file(evidencePath).json()
    evidence.signature = Buffer.alloc(64, 1).toString("base64")
    await writeFile(evidencePath, JSON.stringify(evidence))
    expect(
      await resolveDocumentRuntime({
        packaged: true,
        releaseVersion: "1.2.3",
        resourcesPath,
        moduleURL: pathToFileURL(path.resolve("out/main/index.js")).href,
        platform: "win32",
        architecture: "x64",
        sandboxRuntime,
      }),
    ).toBeUndefined()

  })

  test("resolves the host-target build in development", async () => {
    const workspace = await temporaryDirectory()
    const desktop = path.join(workspace, "packages", "desktop")
    const runtime = path.join(workspace, "packages", "document-runtime", "dist", target)
    await fixture(runtime, false)
    const sandboxRuntime = await developmentSandboxFixture(workspace)

    expect(
      await resolveDocumentRuntime({
        packaged: false,
        resourcesPath: path.resolve("unused"),
        moduleURL: pathToFileURL(path.join(desktop, "out", "main", "index.js")).href,
        environment: {},
        platform: "win32",
        architecture: "x64",
        sandboxRuntime,
      }),
    ).toEqual({
      root: await realpath(runtime),
      manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      releaseReady: false,
      proxyPath: sandboxRuntime.documentProxyPath,
      proxyAssetsRoot: sandboxRuntime.root,
    })
  })

  test("uses only an absolute explicit override in development", async () => {
    const runtime = await temporaryDirectory()
    await fixture(runtime, false)
    const workspace = await temporaryDirectory()
    const sandboxRuntime = await developmentSandboxFixture(workspace)
    const input = {
      packaged: false,
      resourcesPath: path.resolve("unused"),
      moduleURL: pathToFileURL(path.join(workspace, "packages/desktop/out/main/index.js")).href,
      platform: "win32" as const,
      architecture: "x64",
      sandboxRuntime,
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
      proxyPath: sandboxRuntime.documentProxyPath,
      proxyAssetsRoot: sandboxRuntime.root,
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
    const workspace = await temporaryDirectory()
    const sandboxRuntime = await developmentSandboxFixture(workspace)
    await writeFile(path.join(runtime, "worker", "worker.js"), "changed")

    expect(
      await resolveDocumentRuntime({
        packaged: false,
        resourcesPath: path.resolve("unused"),
        moduleURL: pathToFileURL(path.join(workspace, "packages/desktop/out/main/index.js")).href,
        environment: { KOALA_DOCUMENT_RUNTIME_OVERRIDE: runtime },
        platform: "win32",
        architecture: "x64",
        sandboxRuntime,
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
    const sandboxRuntime = await packagedSandboxFixture(resourcesPath)

    expect(
      await resolveDocumentRuntime({
        packaged: true,
        releaseVersion: "1.2.3",
        resourcesPath,
        moduleURL: pathToFileURL(path.resolve("out/main/index.js")).href,
        platform: "win32",
        architecture: "x64",
        sandboxRuntime,
      }),
    ).toBeUndefined()
  })

  test("rejects a packaged runtime without its detached attestation", async () => {
    const resourcesPath = await temporaryDirectory()
    const runtime = path.join(resourcesPath, "document-runtime")
    const attestation = path.join(resourcesPath, "document-runtime.attestation.json")
    await productionRuntimeFixture(runtime, target, attestation)
    const sandboxRuntime = await packagedSandboxFixture(resourcesPath)
    await rm(attestation)

    expect(
      await resolveDocumentRuntime({
        packaged: true,
        releaseVersion: "1.2.3",
        resourcesPath,
        moduleURL: pathToFileURL(path.resolve("out/main/index.js")).href,
        platform: "win32",
        architecture: "x64",
        sandboxRuntime,
      }),
    ).toBeUndefined()
  })

  test("rejects a missing or mismatched sandbox runtime configuration", async () => {
    const workspace = await temporaryDirectory()
    const desktop = path.join(workspace, "packages", "desktop")
    const runtime = path.join(workspace, "packages", "document-runtime", "dist", target)
    await fixture(runtime, false)
    const input = {
      packaged: false,
      resourcesPath: path.resolve("unused"),
      moduleURL: pathToFileURL(path.join(desktop, "out/main/index.js")).href,
      environment: {},
      platform: "win32" as const,
      architecture: "x64",
    }
    expect(await resolveDocumentRuntime(input)).toBeUndefined()
    const sandboxRuntime = await developmentSandboxFixture(workspace)
    expect(
      await resolveDocumentRuntime({
        ...input,
        sandboxRuntime: { ...sandboxRuntime, documentProxyPath: path.join(sandboxRuntime.root, "missing-proxy.mjs") },
      }),
    ).toBeUndefined()
  })

  test("keeps packaged runtimes unavailable without confinement evidence", async () => {
    const resourcesPath = await temporaryDirectory()
    const runtime = path.join(resourcesPath, "document-runtime")
    const attestation = path.join(resourcesPath, "document-runtime.attestation.json")
    const sandboxRuntime = await packagedSandboxFixture(resourcesPath)
    await productionRuntimeFixture(runtime, target, attestation)
    expect(
      await resolveDocumentRuntime({
        packaged: true,
        releaseVersion: "1.2.3",
        resourcesPath,
        moduleURL: pathToFileURL(path.resolve("out/main/index.js")).href,
        platform: "win32",
        architecture: "x64",
        sandboxRuntime,
      }),
    ).toBeUndefined()

  })

  test.each(["public-key", "attestation-bytes", "native-report"] as const)(
    "rejects changed signed confinement resource %s",
    async (mode) => {
      const resourcesPath = await temporaryDirectory()
      const runtime = path.join(resourcesPath, "document-runtime")
      const attestation = path.join(resourcesPath, "document-runtime.attestation.json")
      const sandboxRuntime = await packagedSandboxFixture(resourcesPath)
      await productionRuntimeFixture(runtime, target, attestation)
      await confinementEvidenceFixture(resourcesPath, target, sandboxRuntime)
      if (mode === "public-key") {
        await writeFile(
          path.join(resourcesPath, "document-confinement-evidence", "issuer-public-key.spki.der"),
          generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }),
        )
      }
      if (mode === "attestation-bytes") await writeFile(attestation, `${await Bun.file(attestation).text()}\n`)
      if (mode === "native-report") {
        const report = path.join(resourcesPath, "document-confinement-evidence", "native-report.json")
        const value = await Bun.file(report).json()
        value.status = "skipped"
        await writeFile(report, JSON.stringify(value))
      }
      expect(
        await resolveDocumentRuntime({
          packaged: true,
          releaseVersion: "1.2.3",
          resourcesPath,
          moduleURL: pathToFileURL(path.resolve("out/main/index.js")).href,
          platform: "win32",
          architecture: "x64",
          sandboxRuntime,
        }),
      ).toBeUndefined()
    },
  )
})

async function temporaryDirectory() {
  const root = await mkdtemp(path.join(os.tmpdir(), "desktop-document-runtime-"))
  roots.push(root)
  return root
}

async function fixture(root: string, releaseReady: boolean) {
  const contents = new Map([
    ["package.json", Buffer.from('{"type":"module"}\n')],
    ["worker/bootstrap.js", Buffer.from("bootstrap")],
    ["worker/worker.js", Buffer.from("worker")],
  ])
  const digest = createHash("sha256").update(Buffer.concat(Array.from(contents.values()))).digest("hex")
  await mkdir(path.join(root, "worker"), { recursive: true })
  for (const [file, body] of contents) {
    await writeFile(path.join(root, ...file.split("/")), body, { mode: 0o644 })
    await chmod(path.join(root, ...file.split("/")), 0o644)
  }
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
          licenseFiles: ["worker/bootstrap.js", "worker/worker.js"],
        },
      ],
      files: Array.from(contents, ([file, body]) => ({
        path: file,
        component: "fixture",
        sha256: createHash("sha256").update(body).digest("hex"),
        bytes: body.byteLength,
        mode: 0o644,
      })),
      dependencies: [],
    }),
  )
}

async function packagedSandboxFixture(resourcesPath: string) {
  const root = path.join(resourcesPath, "sandbox-runtime")
  await sandboxFixture(root)
  const resolved = await resolveSandboxRuntime({
    packaged: true,
    resourcesPath,
    moduleURL: pathToFileURL(path.resolve("out/main/index.js")).href,
    platform: "win32",
    architecture: "x64",
  })
  if (!resolved) throw new Error("Sandbox runtime fixture did not resolve")
  return resolved
}

async function developmentSandboxFixture(workspace: string) {
  const root = path.join(workspace, "packages", "opencode", "dist", "node", "sandbox-runtime")
  await sandboxFixture(root)
  const resolved = await resolveSandboxRuntime({
    packaged: false,
    resourcesPath: path.resolve("unused"),
    moduleURL: pathToFileURL(path.join(workspace, "packages/desktop/out/main/index.js")).href,
    platform: "win32",
    architecture: "x64",
  })
  if (!resolved) throw new Error("Sandbox runtime fixture did not resolve")
  return resolved
}

async function sandboxFixture(root: string) {
  const helper = Buffer.alloc(512)
  helper.write("MZ", 0, "ascii")
  helper.writeUInt32LE(128, 0x3c)
  helper.write("PE\0\0", 128, "binary")
  helper.writeUInt16LE(0x8664, 132)
  helper.writeUInt16LE(0xf0, 148)
  helper.writeUInt16LE(0x0002, 150)
  helper.writeUInt16LE(0x20b, 152)
  const contents = new Map<string, Buffer>([
    ["LICENSE", Buffer.from("license")],
    ["document-runtime-proxy.mjs", Buffer.from("proxy")],
    ["sandbox-worker.mjs", Buffer.from("worker")],
    ["vendor/java-proxy-agent/srt-proxy-agent.jar", Buffer.from("jar")],
    ["vendor/srt-win/x64/srt-win.exe", helper],
  ])
  for (const [file, body] of contents) {
    const absolute = path.join(root, ...file.split("/"))
    await mkdir(path.dirname(absolute), { recursive: true })
    await writeFile(absolute, body, { mode: file.endsWith(".exe") ? 0o755 : 0o644 })
    await chmod(absolute, file.endsWith(".exe") ? 0o755 : 0o644)
  }
  await writeFile(
    path.join(root, "sandbox-runtime.manifest.json"),
    JSON.stringify({
      manifestVersion: 1,
      target,
      files: Array.from(contents, ([file, body]) => ({
        path: file,
        sha256: createHash("sha256").update(body).digest("hex"),
        bytes: body.byteLength,
        mode: file.endsWith(".exe") ? 0o755 : 0o644,
      })),
    }),
  )
}
