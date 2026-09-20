import { afterEach, describe, expect, test } from "bun:test"
import { DocumentRuntimeManifest } from "@koala-ai/core/document-runtime/manifest"
import { createHash } from "node:crypto"
import { chmod, lstat, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DocumentPendingOutput } from "@/document/pending-output"
import { DocumentPendingRoot } from "@/document/pending-root"

const roots: string[] = []
const linksSupported = await supportsLinks()

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      if (process.platform !== "win32") await chmod(root, 0o700).catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    }),
  )
})

describe("document pending output", () => {
  test("resolves, hashes, reads, and removes a stable pending file", async () => {
    const root = await temporaryRoot()
    const body = Buffer.from("stable")
    await writeFile(path.join(root.path, "output.tsv"), body)
    const output = await DocumentPendingOutput.resolve(
      root.evidence,
      DocumentRuntimeManifest.RelativePath.make("output.tsv"),
      body.byteLength,
      DocumentRuntimeManifest.Digest.make(createHash("sha256").update(body).digest("hex")),
    )
    expect(await DocumentPendingOutput.read(output)).toEqual(body)
    await DocumentPendingOutput.remove(output)
    expect(await Bun.file(output.path).exists()).toBe(false)
  })

  test("rejects path escape, size mismatch, digest mismatch, and replacement", async () => {
    const root = await temporaryRoot()
    const value = path.join(root.path, "output.tsv")
    await writeFile(value, "stable")
    const digest = DocumentRuntimeManifest.Digest.make(createHash("sha256").update("stable").digest("hex"))
    await expect(
      Promise.resolve().then(() =>
        DocumentPendingOutput.resolve(root.evidence, DocumentRuntimeManifest.RelativePath.make("../escape"), 6, digest),
      ),
    ).rejects.toThrow()
    await expect(
      DocumentPendingOutput.resolve(root.evidence, DocumentRuntimeManifest.RelativePath.make("output.tsv"), 5, digest),
    ).rejects.toThrow()
    await expect(
      DocumentPendingOutput.resolve(
        root.evidence,
        DocumentRuntimeManifest.RelativePath.make("output.tsv"),
        6,
        DocumentRuntimeManifest.Digest.make("0".repeat(64)),
      ),
    ).rejects.toThrow()
    const output = await DocumentPendingOutput.resolve(
      root.evidence,
      DocumentRuntimeManifest.RelativePath.make("output.tsv"),
      6,
      digest,
    )
    await rename(value, `${value}.old`)
    await writeFile(value, "stable")
    await expect(DocumentPendingOutput.read(output)).rejects.toThrow()
  })

  test("rejects pending-root replacement between validation and open", async () => {
    const root = await temporaryRoot()
    await writeFile(path.join(root.path, "output.tsv"), "stable")
    const digest = DocumentRuntimeManifest.Digest.make(createHash("sha256").update("stable").digest("hex"))
    let checks = 0
    await expect(
      DocumentPendingOutput.resolve(root.evidence, DocumentRuntimeManifest.RelativePath.make("output.tsv"), 6, digest, {
        ...DocumentPendingOutput.defaultDependencies,
        verifyRoot: async (evidence) => {
          await DocumentPendingRoot.verify(evidence)
          checks++
          if (checks !== 2) return
          if (process.platform !== "win32") await chmod(root.evidence.parentRoot, 0o700)
          await rm(root.path, { recursive: true })
          await mkdir(root.path)
          await DocumentPendingRoot.verify(evidence)
        },
      }),
    ).rejects.toBeInstanceOf(DocumentPendingRoot.EvidenceError)
  })

  test.skipIf(!linksSupported)("rejects a pending-root link replacement before release", async () => {
    const root = await temporaryRoot()
    const value = path.join(root.path, "output.tsv")
    await writeFile(value, "stable")
    const digest = DocumentRuntimeManifest.Digest.make(createHash("sha256").update("stable").digest("hex"))
    const output = await DocumentPendingOutput.resolve(
      root.evidence,
      DocumentRuntimeManifest.RelativePath.make("output.tsv"),
      6,
      digest,
    )
    const replacement = path.join(root.evidence.parentRoot, "replacement")
    if (process.platform !== "win32") await chmod(root.evidence.parentRoot, 0o700)
    await mkdir(replacement)
    await rm(root.path, { recursive: true })
    await symlink(replacement, root.path, process.platform === "win32" ? "junction" : "dir")
    await expect(DocumentPendingOutput.remove(output)).rejects.toBeInstanceOf(DocumentPendingRoot.EvidenceError)
  })

  test("rejects private-parent replacement before a pending read", async () => {
    const root = await temporaryRoot()
    await writeFile(path.join(root.path, "output.tsv"), "stable")
    const digest = DocumentRuntimeManifest.Digest.make(createHash("sha256").update("stable").digest("hex"))
    const output = await DocumentPendingOutput.resolve(
      root.evidence,
      DocumentRuntimeManifest.RelativePath.make("output.tsv"),
      6,
      digest,
    )
    if (process.platform !== "win32") await chmod(root.evidence.parentRoot, 0o700)
    await rm(root.evidence.parentRoot, { recursive: true })
    await mkdir(root.evidence.parentRoot)
    await mkdir(root.path)
    await expect(DocumentPendingOutput.read(output)).rejects.toBeInstanceOf(DocumentPendingRoot.EvidenceError)
  })
})

async function temporaryRoot() {
  const parentRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "document-pending-output-")))
  roots.push(parentRoot)
  const pendingRoot = path.join(parentRoot, "pending")
  await mkdir(pendingRoot)
  const parentMode = process.platform === "win32" ? null : 0o500
  if (parentMode !== null) await chmod(parentRoot, parentMode)
  const parent = await lstat(parentRoot, { bigint: true })
  const pending = await lstat(pendingRoot, { bigint: true })
  return {
    path: pendingRoot,
    evidence: {
      parentRoot,
      parentIdentity: { dev: parent.dev, ino: parent.ino },
      parentMode,
      pendingRoot,
      pendingRootIdentity: { dev: pending.dev, ino: pending.ino },
    },
  }
}

async function supportsLinks() {
  const parent = await mkdtemp(path.join(os.tmpdir(), "document-pending-link-"))
  try {
    const target = path.join(parent, "target")
    await mkdir(target)
    await symlink(target, path.join(parent, "link"), process.platform === "win32" ? "junction" : "dir")
    return true
  } catch {
    return false
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
}
