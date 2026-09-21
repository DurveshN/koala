import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { findInstalledResources, locateInstaller, makeSmokeReport } from "./document-runtime-smoke"

const roots: string[] = []

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

describe("packaged document runtime smoke report", () => {
  test("is deterministic and records every required operation", () => {
    const input = {
      reportVersion: 1 as const,
      target: "x86_64-pc-windows-msvc" as const,
      runtimeManifestSha256: "1".repeat(64),
      runtimeAttestationSha256: "4".repeat(64),
      proxySha256: "2".repeat(64),
      sandboxRuntimeManifestSha256: "3".repeat(64),
      policyVersion: 1 as const,
      release: { version: "1.2.3", sourceCommit: "a".repeat(40), buildID: "test-build-1" },
      signedFileInventorySha256: "5".repeat(64),
      installedRuntimeAttestationSha256: "4".repeat(64),
    }
    const report = makeSmokeReport(input)
    expect(report).toEqual(makeSmokeReport(input))
    expect(report.operations).toEqual({
      proxyProbe: "passed",
      pdfRender: "passed",
      tesseractOcr: "passed",
      release: "passed",
      cancellation: "passed",
      rootCleanup: "passed",
      systemTesseractUnused: "passed",
      installedLayout: "passed",
    })
  })

  test("requires exactly one platform installer and has no unpacked-layout fallback", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "document-installer-test-"))
    roots.push(root)
    await expect(locateInstaller(await realpath(root), "x86_64-pc-windows-msvc")).rejects.toThrow("exactly one")
    await writeFile(path.join(root, "koala.exe"), "installer")
    await expect(locateInstaller(await realpath(root), "x86_64-pc-windows-msvc")).resolves.toBe(
      path.join(await realpath(root), "koala.exe"),
    )
    await writeFile(path.join(root, "other.exe"), "installer")
    await expect(locateInstaller(await realpath(root), "x86_64-pc-windows-msvc")).rejects.toThrow("exactly one")
  })

  test.skipIf(process.platform === "win32")(
    "skips unrelated links while discovering one installed resource tree",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "document-installed-layout-"))
      roots.push(root)
      const resources = path.join(root, "app", "resources")
      await Promise.all([
        mkdir(path.join(resources, "document-runtime"), { recursive: true }),
        mkdir(path.join(resources, "sandbox-runtime"), { recursive: true }),
      ])
      await writeFile(path.join(resources, "document-runtime.attestation.json"), "fixture")
      await symlink(os.tmpdir(), path.join(root, "unrelated"), "dir")
      expect(await findInstalledResources(await realpath(root))).toBe(await realpath(resources))
    },
  )
})
