import { afterEach, describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { chmod, lstat, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DocumentJobRoot, type DeleteProcess } from "@/document/job-root"

const roots: string[] = []
const linksSupported = await supportsLinks()

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("document job-root lifecycle", () => {
  test("creates canonical private child and pending roots with bigint identities", async () => {
    const temporaryRoot = await temporaryDirectory()
    const root = await DocumentJobRoot.create({ temporaryRoot })

    expect(root.parent).toStartWith(`${await realpath(temporaryRoot)}${path.sep}`)
    expect(path.basename(root.path)).toBe(root.childName)
    expect(path.dirname(root.pending)).toBe(root.parent)
    expect(root.pending).not.toStartWith(`${root.path}${path.sep}`)
    expect(root.tmp).toBe(path.join(root.path, "tmp"))
    expect(typeof root.parentIdentity.dev).toBe("bigint")
    expect(typeof root.identity.ino).toBe("bigint")
    expect(typeof root.pendingIdentity.ino).toBe("bigint")
    if (process.platform !== "win32") {
      expect(Number((await lstat(root.parent, { bigint: true })).mode & 0o777n)).toBe(0o500)
    }

    await DocumentJobRoot.remove(root)
    expect(await exists(root.path)).toBe(false)
    expect(await exists(root.pending)).toBe(false)
    expect(await exists(root.parent)).toBe(false)
    expect(root.tombstones).toHaveLength(2)
  })

  test("uses a helper and rejects its nonzero exit while retaining the tombstones", async () => {
    const root = await DocumentJobRoot.create({ temporaryRoot: await temporaryDirectory() })
    const helper = fakeDeleteProcess()
    const pending = DocumentJobRoot.remove(root, {
      spawnDelete: () => {
        queueMicrotask(() => helper.exit(1, null))
        return helper.process
      },
    })

    await expect(pending).rejects.toEqual(
      expect.objectContaining({ _tag: "DocumentJobRootError", code: "deletion-failed", unhealthy: true }),
    )
    expect(root.tombstones).toHaveLength(2)
    expect(await Promise.all(root.tombstones.map(exists))).toEqual([true, true])
    expect(DocumentJobRoot.unreconciledTombstones()).toEqual(expect.arrayContaining(root.tombstones))
  })

  test("hard-stops a hanging delete helper and retains known tombstones", async () => {
    const root = await DocumentJobRoot.create({ temporaryRoot: await temporaryDirectory() })
    const helper = fakeDeleteProcess()
    helper.onKill = () => helper.exit(null, "SIGKILL")
    const started = Date.now()
    const pending = DocumentJobRoot.remove(root, { timeoutMs: 300, spawnDelete: () => helper.process })

    await expect(pending).rejects.toEqual(
      expect.objectContaining({ _tag: "DocumentJobRootError", code: "deletion-timeout", unhealthy: true }),
    )
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(helper.kills).toBe(1)
    expect(await Promise.all(root.tombstones.map(exists))).toEqual([true, true])
    expect(DocumentJobRoot.unreconciledTombstones()).toEqual(expect.arrayContaining(root.tombstones))
  })

  test("passes only the remaining absolute deadline to the delete helper", async () => {
    const root = await DocumentJobRoot.create({ temporaryRoot: await temporaryDirectory() })
    const helper = fakeDeleteProcess()
    helper.onKill = () => helper.exit(null, "SIGKILL")
    const started = Date.now()
    await expect(
      DocumentJobRoot.remove(root, {
        deadline: started + 350,
        timeoutMs: 2_000,
        spawnDelete: () => helper.process,
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "deletion-timeout", unhealthy: true }))
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  test("reports a helper exit that remains unobserved through the hard deadline", async () => {
    const root = await DocumentJobRoot.create({ temporaryRoot: await temporaryDirectory() })
    const helper = fakeDeleteProcess()
    const pending = DocumentJobRoot.remove(root, { timeoutMs: 300, spawnDelete: () => helper.process })

    await expect(pending).rejects.toEqual(
      expect.objectContaining({
        _tag: "DocumentJobRootError",
        code: "helper-exit-unconfirmed",
        unhealthy: true,
      }),
    )
    expect(helper.kills).toBe(1)
    expect(await Promise.all(root.tombstones.map(exists))).toEqual([true, true])
  })

  test("tracks partial creation and performs verified helper cleanup before reporting failure", async () => {
    const temporaryRoot = await temporaryDirectory()
    let calls = 0
    const helper = deletingProcess()
    await expect(
      DocumentJobRoot.create({
        temporaryRoot,
        makeDirectory: async (value, options) => {
          calls++
          if (calls === 2) throw new Error("tmp-create-failed")
          return mkdir(value, options)
        },
        cleanup: { spawnDelete: helper },
      }),
    ).rejects.toEqual(
      expect.objectContaining({ _tag: "DocumentJobRootError", code: "creation-failed", unhealthy: false }),
    )
    expect(await directories(temporaryRoot)).toEqual([])
  })

  test("marks a partial creation failure unhealthy when helper cleanup is unconfirmed", async () => {
    const temporaryRoot = await temporaryDirectory()
    let calls = 0
    const helper = fakeDeleteProcess()
    helper.onKill = () => helper.exit(null, "SIGKILL")
    const pending = DocumentJobRoot.create({
      temporaryRoot,
      makeDirectory: async (value, options) => {
        calls++
        if (calls === 2) throw new Error("tmp-create-failed")
        return mkdir(value, options)
      },
      cleanup: { timeoutMs: 300, spawnDelete: () => helper.process },
    })
    await expect(pending).rejects.toEqual(
      expect.objectContaining({ _tag: "DocumentJobRootError", code: "creation-cleanup-failed", unhealthy: true }),
    )
  })

  test("refuses to rename a replaced child directory", async () => {
    const root = await DocumentJobRoot.create({ temporaryRoot: await temporaryDirectory() })
    if (root.parentMode !== undefined) await chmod(root.parent, 0o700)
    await rm(root.path, { recursive: true })
    await mkdir(root.path)
    if (root.parentMode !== undefined) await chmod(root.parent, root.parentMode)

    await expect(DocumentJobRoot.remove(root)).rejects.toEqual(
      expect.objectContaining({ _tag: "DocumentJobRootError", code: "child-replaced", unhealthy: true }),
    )
    expect(await exists(root.path)).toBe(true)
    if (root.parentMode !== undefined) await chmod(root.parent, 0o700)
  })

  test("detects child-entry or parent-mode replacement before proxy launch", async () => {
    const root = await DocumentJobRoot.create({ temporaryRoot: await temporaryDirectory() })
    if (root.parentMode !== undefined) {
      await chmod(root.parent, 0o700)
      await expect(DocumentJobRoot.verifyForLaunch(root)).rejects.toEqual(
        expect.objectContaining({ code: "parent-replaced", unhealthy: true }),
      )
    }
    await rm(root.path, { recursive: true })
    await mkdir(root.path)
    if (root.parentMode !== undefined) await chmod(root.parent, root.parentMode)
    await expect(DocumentJobRoot.verifyForLaunch(root)).rejects.toEqual(
      expect.objectContaining({ code: "child-replaced", unhealthy: true }),
    )
    if (root.parentMode !== undefined) await chmod(root.parent, 0o700)
  })

  test.skipIf(!linksSupported)("refuses a child link or reparse-point replacement", async () => {
    const temporaryRoot = await temporaryDirectory()
    const root = await DocumentJobRoot.create({ temporaryRoot })
    const target = path.join(temporaryRoot, "link-target")
    await mkdir(target)
    if (root.parentMode !== undefined) await chmod(root.parent, 0o700)
    await rm(root.path, { recursive: true })
    await symlink(target, root.path, process.platform === "win32" ? "junction" : "dir")
    if (root.parentMode !== undefined) await chmod(root.parent, root.parentMode)

    await expect(DocumentJobRoot.remove(root)).rejects.toEqual(
      expect.objectContaining({ _tag: "DocumentJobRootError", code: "child-replaced", unhealthy: true }),
    )
    expect(await exists(target)).toBe(true)
    if (root.parentMode !== undefined) await chmod(root.parent, 0o700)
  })

  test("refuses cleanup after the private parent identity changes", async () => {
    const root = await DocumentJobRoot.create({ temporaryRoot: await temporaryDirectory() })
    if (root.parentMode !== undefined) await chmod(root.parent, 0o700)
    await rm(root.parent, { recursive: true })
    await mkdir(root.parent)

    await expect(DocumentJobRoot.remove(root)).rejects.toEqual(
      expect.objectContaining({ _tag: "DocumentJobRootError", code: "parent-replaced", unhealthy: true }),
    )
  })
})

async function temporaryDirectory() {
  const root = await mkdtemp(path.join(os.tmpdir(), "document-job-root-test-"))
  roots.push(root)
  return root
}

async function exists(value: string) {
  return lstat(value).then(
    () => true,
    () => false,
  )
}

async function directories(root: string) {
  return Array.fromAsync(new Bun.Glob("*").scan({ cwd: root, onlyFiles: false }))
}

function fakeDeleteProcess() {
  const emitter = new EventEmitter()
  let exitCode: number | null = null
  let signalCode: NodeJS.Signals | null = null
  const state = {
    kills: 0,
    onKill: (() => undefined) as () => void,
    process: Object.assign(emitter, {
      get exitCode() {
        return exitCode
      },
      get signalCode() {
        return signalCode
      },
      kill: () => {
        state.kills++
        state.onKill()
        return true
      },
    }) as unknown as DeleteProcess,
    exit: (code: number | null, signal: NodeJS.Signals | null) => {
      exitCode = code
      signalCode = signal
      emitter.emit("exit", code, signal)
    },
  }
  return state
}

function deletingProcess() {
  return (paths: ReadonlyArray<string>) => {
    const helper = fakeDeleteProcess()
    queueMicrotask(async () => {
      await Promise.all(paths.map((value) => rm(value, { recursive: true })))
      helper.exit(0, null)
    })
    return helper.process
  }
}

async function supportsLinks() {
  const root = await mkdtemp(path.join(os.tmpdir(), "document-job-root-link-test-"))
  try {
    const target = path.join(root, "target")
    await mkdir(target)
    await symlink(target, path.join(root, "link"), process.platform === "win32" ? "junction" : "dir")
    return true
  } catch {
    return false
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
