import { Schema } from "effect"
import { randomUUID } from "node:crypto"
import { spawn, type ChildProcess } from "node:child_process"
import { chmod, lstat, mkdir, mkdtemp, readdir, realpath, rename, rmdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const DeletionTimeoutMs = 2_000
const HelperKillReserveMs = 250
const DeleteScript =
  'const fs=require("node:fs");for(const value of process.argv.slice(1))fs.rmSync(value,{recursive:true,force:false,maxRetries:40,retryDelay:25})'
const unreconciled = new Set<string>()

export interface Identity {
  readonly dev: bigint
  readonly ino: bigint
}

export interface Root {
  readonly parent: string
  readonly parentIdentity: Identity
  readonly childName: string
  readonly path: string
  readonly identity: Identity
  readonly tmp: string
  readonly pendingName: string
  readonly pending: string
  readonly pendingIdentity: Identity
  readonly parentMode?: number
  readonly tombstones: string[]
  cleanupDeadline?: number
}

export class LifecycleError extends Schema.TaggedErrorClass<LifecycleError>()("DocumentJobRootError", {
  code: Schema.Literals([
    "creation-failed",
    "creation-cleanup-failed",
    "parent-replaced",
    "child-replaced",
    "pending-replaced",
    "tombstone-failed",
    "deletion-failed",
    "deletion-timeout",
    "helper-exit-unconfirmed",
    "absence-unconfirmed",
  ]),
  unhealthy: Schema.Boolean,
}) {
  override get message() {
    return `Document job-root lifecycle failed: ${this.code}`
  }
}

interface OwnedEntry {
  readonly value: string
  readonly identity: Identity
  readonly replacementCode: "child-replaced" | "pending-replaced"
}

export type DeleteProcess = Pick<ChildProcess, "exitCode" | "signalCode" | "once" | "off" | "kill">

export interface CreateOptions {
  readonly temporaryRoot?: string
  readonly makeDirectory?: (value: string, options: { readonly mode: number }) => Promise<unknown>
  readonly cleanup?: RemoveOptions
}

export interface RemoveOptions {
  readonly timeoutMs?: number
  readonly deadline?: number
  readonly spawnDelete?: (paths: ReadonlyArray<string>) => DeleteProcess
}

export async function create(options: CreateOptions = {}): Promise<Root> {
  const makeDirectory = options.makeDirectory ?? mkdir
  let parent: string | undefined
  let parentIdentity: Identity | undefined
  const entries: OwnedEntry[] = []
  try {
    parent = await mkdtemp(path.join(options.temporaryRoot ?? os.tmpdir(), "opencode-document-"))
    const canonicalParent = await realpath(parent)
    parent = canonicalParent
    parentIdentity = await inspectDirectory(canonicalParent)
    await chmod(canonicalParent, 0o700)

    const childName = `job-${randomUUID()}`
    const child = path.join(canonicalParent, childName)
    await makeDirectory(child, { mode: 0o700 })
    const childIdentity = await inspectDirectory(child)
    entries.push({ value: child, identity: childIdentity, replacementCode: "child-replaced" })
    await chmod(child, 0o700)

    const tmp = path.join(child, "tmp")
    await makeDirectory(tmp, { mode: 0o700 })
    await inspectDirectory(tmp)
    await chmod(tmp, 0o700)

    const pendingName = `pending-${randomUUID()}`
    const pending = path.join(canonicalParent, pendingName)
    await makeDirectory(pending, { mode: 0o700 })
    const pendingIdentity = await inspectDirectory(pending)
    entries.push({ value: pending, identity: pendingIdentity, replacementCode: "pending-replaced" })
    await chmod(pending, 0o700)
    const parentMode = process.platform === "win32" ? undefined : 0o500
    if (parentMode !== undefined) await chmod(canonicalParent, parentMode)

    return {
      parent: canonicalParent,
      parentIdentity,
      childName,
      path: child,
      identity: childIdentity,
      tmp,
      pendingName,
      pending,
      pendingIdentity,
      parentMode,
      tombstones: [],
    }
  } catch {
    if (!parent || !parentIdentity) {
      throw new LifecycleError({ code: "creation-cleanup-failed", unhealthy: true })
    }
    const partial = await cleanupOwned(parent, parentIdentity, entries, [], options.cleanup).then(
      () => true,
      () => false,
    )
    throw new LifecycleError({
      code: partial ? "creation-failed" : "creation-cleanup-failed",
      unhealthy: !partial,
    })
  }
}

export async function remove(root: Root, options: RemoveOptions = {}): Promise<void> {
  try {
    await verifyDirectory(root.parent, root.parentIdentity, "parent-replaced", root.parentMode)
    if (root.parentMode !== undefined) await chmod(root.parent, 0o700)
    await cleanupOwned(
      root.parent,
      root.parentIdentity,
      [
        { value: root.path, identity: root.identity, replacementCode: "child-replaced" },
        { value: root.pending, identity: root.pendingIdentity, replacementCode: "pending-replaced" },
      ],
      root.tombstones,
      options,
    )
  } catch (error) {
    if (error instanceof LifecycleError) throw error
    throw new LifecycleError({ code: "deletion-failed", unhealthy: true })
  }
}

export async function verifyForLaunch(root: Root) {
  try {
    await verifyDirectory(root.parent, root.parentIdentity, "parent-replaced", root.parentMode)
    await verifyDirectory(root.path, root.identity, "child-replaced")
    await verifyDirectory(root.pending, root.pendingIdentity, "pending-replaced")
  } catch (error) {
    if (error instanceof LifecycleError) throw error
    throw new LifecycleError({ code: "creation-cleanup-failed", unhealthy: true })
  }
}

async function cleanupOwned(
  parent: string,
  parentIdentity: Identity,
  entries: ReadonlyArray<OwnedEntry>,
  knownTombstones: string[],
  options: RemoveOptions = {},
) {
  checkDeadline(options)
  await verifyDirectory(parent, parentIdentity, "parent-replaced")
  for (const entry of entries) {
    checkDeadline(options)
    await verifyDirectory(entry.value, entry.identity, entry.replacementCode)
    const tombstone = path.join(parent, `.delete-${randomUUID()}`)
    try {
      await rename(entry.value, tombstone)
    } catch {
      throw new LifecycleError({ code: "tombstone-failed", unhealthy: true })
    }
    knownTombstones.push(tombstone)
    unreconciled.add(tombstone)
    const renamed = await inspect(tombstone)
    if (
      !renamed ||
      !renamed.directory ||
      renamed.link ||
      !sameIdentity(renamed.identity, entry.identity) ||
      (await inspect(entry.value))
    ) {
      throw new LifecycleError({ code: "tombstone-failed", unhealthy: true })
    }
  }

  if (knownTombstones.length > 0) {
    checkDeadline(options)
    const result = await runDeleteHelper(knownTombstones, options)
    if (result !== "exited") {
      throw new LifecycleError({
        code:
          result === "timeout"
            ? "deletion-timeout"
            : result === "unconfirmed"
              ? "helper-exit-unconfirmed"
              : "deletion-failed",
        unhealthy: true,
      })
    }
    if ((await Promise.all(knownTombstones.map(inspect))).some(Boolean)) {
      throw new LifecycleError({ code: "absence-unconfirmed", unhealthy: true })
    }
    for (const tombstone of knownTombstones) unreconciled.delete(tombstone)
  }

  checkDeadline(options)
  await verifyDirectory(parent, parentIdentity, "parent-replaced")
  if ((await readdir(parent)).length !== 0) {
    throw new LifecycleError({ code: "absence-unconfirmed", unhealthy: true })
  }
  try {
    await rmdir(parent)
  } catch {
    throw new LifecycleError({ code: "deletion-failed", unhealthy: true })
  }
  if (await inspect(parent)) throw new LifecycleError({ code: "absence-unconfirmed", unhealthy: true })
}

async function runDeleteHelper(paths: ReadonlyArray<string>, options: RemoveOptions) {
  const timeoutMs = Math.min(options.timeoutMs ?? DeletionTimeoutMs, remaining(options))
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= HelperKillReserveMs) return "timeout" as const
  let child: DeleteProcess
  try {
    child = (options.spawnDelete ?? spawnDeleteHelper)(paths)
  } catch {
    return "error" as const
  }
  const initial = observedExit(child)
  if (initial) return initial.code === 0 && initial.signal === null ? ("exited" as const) : ("error" as const)

  return new Promise<"exited" | "timeout" | "unconfirmed" | "error">((resolve) => {
    let settled = false
    let timedOut = false
    const finish = (result: "exited" | "timeout" | "unconfirmed" | "error") => {
      if (settled) return
      settled = true
      clearTimeout(killTimer)
      clearTimeout(deadlineTimer)
      child.off("error", onError)
      child.off("exit", onExit)
      resolve(result)
    }
    const onError = () => finish("error")
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (timedOut) return finish("timeout")
      finish(code === 0 && signal === null ? "exited" : "error")
    }
    const killTimer = setTimeout(() => {
      timedOut = true
      try {
        child.kill("SIGKILL")
      } catch {}
    }, timeoutMs - HelperKillReserveMs)
    const deadlineTimer = setTimeout(() => finish("unconfirmed"), timeoutMs)
    child.once("error", onError)
    child.once("exit", onExit)
    const raced = observedExit(child)
    if (raced) onExit(raced.code, raced.signal)
  })
}

function checkDeadline(options: RemoveOptions) {
  if (remaining(options) < 1) throw new LifecycleError({ code: "deletion-timeout", unhealthy: true })
}

function remaining(options: RemoveOptions) {
  return options.deadline === undefined ? (options.timeoutMs ?? DeletionTimeoutMs) : options.deadline - Date.now()
}

function spawnDeleteHelper(paths: ReadonlyArray<string>): DeleteProcess {
  return spawn(process.execPath, ["-e", DeleteScript, ...paths], {
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      ...(process.platform === "win32" && process.env.SystemRoot
        ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot }
        : {}),
    },
    shell: false,
    stdio: "ignore",
    windowsHide: true,
  })
}

async function verifyDirectory(
  value: string,
  identity: Identity,
  code: "parent-replaced" | "child-replaced" | "pending-replaced",
  mode?: number,
) {
  const info = await inspect(value)
  if (!info || !info.directory || info.link || !sameIdentity(info.identity, identity)) {
    throw new LifecycleError({ code, unhealthy: true })
  }
  const canonical = await realpath(value).catch(() => undefined)
  if (!canonical || !samePath(canonical, value)) throw new LifecycleError({ code, unhealthy: true })
  if (mode !== undefined) {
    const current = await lstat(value, { bigint: true })
    if (Number(current.mode & 0o777n) !== mode) throw new LifecycleError({ code, unhealthy: true })
  }
}

async function inspect(value: string) {
  try {
    const info = await lstat(value, { bigint: true })
    return {
      directory: info.isDirectory(),
      link: info.isSymbolicLink(),
      identity: { dev: info.dev, ino: info.ino },
    }
  } catch (error) {
    if (missing(error)) return undefined
    throw error
  }
}

async function inspectDirectory(value: string) {
  const info = await inspect(value)
  if (!info?.directory || info.link) throw new Error("not-private-directory")
  return info.identity
}

function observedExit(child: DeleteProcess) {
  if (child.exitCode === null && child.signalCode === null) return
  return { code: child.exitCode, signal: child.signalCode }
}

function sameIdentity(left: Identity, right: Identity) {
  return left.dev === right.dev && left.ino === right.ino
}

function samePath(left: string, right: string) {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right
}

function missing(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

export function unreconciledTombstones() {
  return [...unreconciled]
}

export * as DocumentJobRoot from "./job-root"
