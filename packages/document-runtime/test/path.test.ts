import { afterEach, describe, expect, test } from "bun:test"
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { resolveInRoot, validateInputFile } from "../src/path"

const roots: string[] = []
const symlinksSupported = await supportsSymlinks()

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("document runtime path boundaries", () => {
  test("rejects lexical traversal and absolute paths outside the job root", async () => {
    const root = await temporary("document-path-root-")
    expect(() => resolveInRoot(root, "../outside.pdf")).toThrow()
    expect(() => resolveInRoot(root, path.resolve(root, "..", "outside.pdf"))).toThrow()
  })

  test.skipIf(!symlinksSupported)("rejects a file symlink that crosses the real job-root boundary", async () => {
    const root = await temporary("document-path-root-")
    const outside = await temporary("document-path-outside-")
    const target = path.join(outside, "outside.pdf")
    const link = path.join(root, "input", "linked.pdf")
    await mkdir(path.dirname(link), { mode: 0o700 })
    await writeFile(target, "private")
    await symlink(target, link, "file")
    expect((await lstat(link)).isSymbolicLink()).toBe(true)
    await expect(validateInputFile(root, link)).rejects.toEqual(expect.objectContaining({ code: "invalid-request" }))
  })
})

async function temporary(prefix: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix))
  roots.push(root)
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
