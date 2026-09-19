import { describe, expect, test } from "bun:test"
import { DocumentRuntimeAttestation } from "@koala-ai/core/document-runtime/attestation"
import { Schema } from "effect"
import { createHash } from "node:crypto"
import { chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { loadAndVerifyManifest, loadAndVerifyProductionManifest } from "../src/manifest"

const target = "x86_64-pc-windows-msvc" as const
const symlinksSupported = await supportsSymlinks()

describe("runtime manifest verification", () => {
  test("verifies target, every hash, byte count, mode, and the complete file set", async () => {
    const root = await fixture()
    try {
      const verified = await loadAndVerifyManifest(root, target)
      expect(verified.manifest.target).toBe(target)
      expect(verified.manifest.releaseReady).toBe(false)
      expect(verified.manifestSha256).toHaveLength(64)

      await writeFile(path.join(root, "unexpected.txt"), "unexpected")
      await expect(loadAndVerifyManifest(root, target)).rejects.toEqual(
        expect.objectContaining({ code: "file-mismatch" }),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("rejects target substitution and changed bytes", async () => {
    const root = await fixture()
    try {
      await expect(loadAndVerifyManifest(root, "aarch64-pc-windows-msvc")).rejects.toEqual(
        expect.objectContaining({ code: "target-mismatch" }),
      )
      await writeFile(path.join(root, "worker", "worker.js"), "changed")
      await expect(loadAndVerifyManifest(root, target)).rejects.toEqual(
        expect.objectContaining({ code: "file-mismatch" }),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("rejects a manifest digest mismatch", async () => {
    const root = await fixture()
    try {
      await expect(loadAndVerifyManifest(root, target, "0".repeat(64))).rejects.toEqual(
        expect.objectContaining({ code: "invalid-manifest" }),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("rejects an incomplete runtime during production verification", async () => {
    const root = await fixture()
    try {
      const verified = await loadAndVerifyManifest(root, target)
      const attestation = Schema.decodeUnknownSync(DocumentRuntimeAttestation.Attestation)({
        attestationVersion: 1,
        profileVersion: 1,
        target,
        manifestSha256: verified.manifestSha256,
        runtimeVersion: verified.manifest.runtimeVersion,
        components: verified.manifest.components,
        dependencies: verified.manifest.dependencies,
        executables: ["worker/worker.js"],
      })
      await expect(loadAndVerifyProductionManifest(root, target, attestation)).rejects.toEqual(
        expect.objectContaining({ code: "release-incomplete" }),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("does not accept a release manifest without a detached attestation", async () => {
    const root = await fixture()
    try {
      await expect(loadAndVerifyManifest(root, target, undefined, true)).rejects.toEqual(
        expect.objectContaining({ code: "invalid-attestation" }),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("rejects a declared mode that does not match the staged file", async () => {
    const root = await fixture(0o755)
    try {
      await expect(loadAndVerifyManifest(root, target)).rejects.toEqual(
        expect.objectContaining({ code: "file-mismatch" }),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test.skipIf(!symlinksSupported)("rejects real root, directory, and file symlinks", async () => {
    const root = await fixture()
    const outside = await mkdtemp(path.join(os.tmpdir(), "document-manifest-outside-"))
    const linkedRoot = `${root}-link`
    try {
      await symlink(root, linkedRoot, process.platform === "win32" ? "junction" : "dir")
      expect((await lstat(linkedRoot)).isSymbolicLink()).toBe(true)
      await expect(loadAndVerifyManifest(linkedRoot, target)).rejects.toEqual(
        expect.objectContaining({ code: "invalid-manifest" }),
      )

      await writeFile(path.join(outside, "worker.js"), "worker")
      await rm(path.join(root, "worker", "worker.js"))
      await symlink(path.join(outside, "worker.js"), path.join(root, "worker", "worker.js"), "file")
      expect((await lstat(path.join(root, "worker", "worker.js"))).isSymbolicLink()).toBe(true)
      await expect(loadAndVerifyManifest(root, target)).rejects.toEqual(
        expect.objectContaining({ code: "file-mismatch" }),
      )

      await rm(path.join(root, "worker"), { recursive: true, force: true })
      await symlink(outside, path.join(root, "worker"), process.platform === "win32" ? "junction" : "dir")
      expect((await lstat(path.join(root, "worker"))).isSymbolicLink()).toBe(true)
      await expect(loadAndVerifyManifest(root, target)).rejects.toEqual(
        expect.objectContaining({ code: "file-mismatch" }),
      )
    } finally {
      await Promise.all([
        rm(linkedRoot, { recursive: true, force: true }),
        rm(root, { recursive: true, force: true }),
        rm(outside, { recursive: true, force: true }),
      ])
    }
  })
})

async function fixture(mode: 0o644 | 0o755 = 0o644) {
  const root = await mkdtemp(path.join(os.tmpdir(), "document-manifest-"))
  await mkdir(path.join(root, "worker"), { mode: 0o700 })
  const contents = Buffer.from("worker")
  const worker = path.join(root, "worker", "worker.js")
  await writeFile(worker, contents, { mode: 0o644 })
  await chmod(worker, 0o644)
  await writeFile(
    path.join(root, "manifest.json"),
    JSON.stringify({
      manifestVersion: 1,
      protocolVersion: 1,
      releaseReady: false,
      runtimeVersion: "0.1.0",
      target,
      architecture: "x86_64",
      components: [
        {
          name: "worker",
          version: "0.1.0",
          sourceRevision: "fixture",
          sourceSha256: createHash("sha256").update(contents).digest("hex"),
          licenseFiles: ["worker/worker.js"],
        },
      ],
      files: [
        {
          path: "worker/worker.js",
          component: "worker",
          sha256: createHash("sha256").update(contents).digest("hex"),
          bytes: contents.byteLength,
          mode,
        },
      ],
      dependencies: [],
    }),
  )
  return root
}

async function supportsSymlinks() {
  const root = await mkdtemp(path.join(os.tmpdir(), "document-symlink-capability-"))
  try {
    const target = path.join(root, "target")
    const link = path.join(root, "link")
    await writeFile(target, "target")
    await symlink(target, link, "file")
    return (await lstat(link)).isSymbolicLink()
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && ["EPERM", "EACCES", "ENOSYS"].includes(String(error.code))) {
      return false
    }
    throw error
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
