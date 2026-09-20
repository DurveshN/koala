import type { DocumentSandboxProtocol } from "@koala-ai/core/document-runtime/sandbox-protocol"
import { lstat, realpath } from "node:fs/promises"
import path from "node:path"

export class EvidenceError extends Error {
  override readonly name = "DocumentPendingRootEvidenceError"
}

export interface Identity {
  readonly dev: bigint
  readonly ino: bigint
}

export interface Evidence {
  readonly parentRoot: string
  readonly parentIdentity: Identity
  readonly pendingRoot: string
  readonly pendingRootIdentity: Identity
  readonly parentMode: number | null
}

export interface Dependencies {
  readonly inspect: typeof lstat
  readonly canonicalize: typeof realpath
}

const defaults: Dependencies = { inspect: lstat, canonicalize: realpath }

export function identityFromWire(identity: DocumentSandboxProtocol.FilesystemIdentity): Identity {
  return { dev: BigInt(identity.dev), ino: BigInt(identity.ino) }
}

export function identityToWire(identity: Identity): DocumentSandboxProtocol.FilesystemIdentity {
  return { dev: identity.dev.toString(), ino: identity.ino.toString() }
}

export async function verify(evidence: Evidence, dependencies: Dependencies = defaults) {
  try {
    const parent = await inspectDirectory(evidence.parentRoot, evidence.parentIdentity, dependencies)
    const pending = await inspectDirectory(evidence.pendingRoot, evidence.pendingRootIdentity, dependencies)
    if (!samePath(path.dirname(evidence.pendingRoot), evidence.parentRoot)) throw new Error("pending-not-sibling")
    if (process.platform !== "win32" && evidence.parentMode !== 0o500) throw new EvidenceError("parent-mode-missing")
    if (evidence.parentMode !== null && Number(parent.mode & 0o777n) !== evidence.parentMode) {
      throw new EvidenceError("parent-mode-changed")
    }
    return { parent, pending }
  } catch (error) {
    if (error instanceof EvidenceError) throw error
    throw new EvidenceError("pending-root-replaced")
  }
}

async function inspectDirectory(value: string, identity: Identity, dependencies: Dependencies) {
  const info = await dependencies.inspect(value, { bigint: true })
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.dev !== identity.dev ||
    info.ino !== identity.ino ||
    !samePath(await dependencies.canonicalize(value), value)
  ) {
    throw new EvidenceError("pending-root-replaced")
  }
  return info
}

function samePath(left: string, right: string) {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right
}

export * as DocumentPendingRoot from "./pending-root"
