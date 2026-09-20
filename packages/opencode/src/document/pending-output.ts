import { DocumentRuntimeManifest } from "@koala-ai/core/document-runtime/manifest"
import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, realpath, rm } from "node:fs/promises"
import path from "node:path"
import { DocumentPendingRoot } from "./pending-root"

export interface StableOutput {
  readonly path: string
  readonly bytes: number
  readonly sha256: DocumentRuntimeManifest.Digest
  readonly identity: { readonly dev: bigint; readonly ino: bigint }
  readonly root: DocumentPendingRoot.Evidence
}

export interface Dependencies {
  readonly inspect: typeof lstat
  readonly openFile: typeof open
  readonly canonicalize: typeof realpath
  readonly removeFile: typeof rm
  readonly verifyRoot: (evidence: DocumentPendingRoot.Evidence) => Promise<unknown>
}

export const defaultDependencies: Dependencies = {
  inspect: lstat,
  openFile: open,
  canonicalize: realpath,
  removeFile: rm,
  verifyRoot: DocumentPendingRoot.verify,
}

export async function resolve(
  root: DocumentPendingRoot.Evidence,
  relative: DocumentRuntimeManifest.RelativePath,
  expectedBytes: number,
  expectedDigest: DocumentRuntimeManifest.Digest,
  dependencies: Dependencies = defaultDependencies,
): Promise<StableOutput> {
  await dependencies.verifyRoot(root)
  const canonicalRoot = await dependencies.canonicalize(root.pendingRoot)
  const value = path.resolve(canonicalRoot, ...relative.split("/"))
  if (!inside(canonicalRoot, value)) throw new Error("invalid-pending-path")
  const pathInfo = await dependencies.inspect(value, { bigint: true })
  if (!pathInfo.isFile() || pathInfo.isSymbolicLink() || pathInfo.size !== BigInt(expectedBytes)) {
    throw new Error("invalid-pending-output")
  }
  if (!samePath(await dependencies.canonicalize(value), value)) throw new Error("invalid-pending-output")
  await dependencies.verifyRoot(root)
  const handle = await dependencies.openFile(value, constants.O_RDONLY | constants.O_NOFOLLOW).catch(async (error) => {
    await dependencies.verifyRoot(root)
    throw error
  })
  try {
    await dependencies.verifyRoot(root)
    const opened = await handle.stat({ bigint: true })
    if (opened.dev !== pathInfo.dev || opened.ino !== pathInfo.ino || opened.size !== BigInt(expectedBytes)) {
      throw new Error("pending-output-replaced")
    }
    const digest = createHash("sha256")
    let bytes = 0
    const buffer = Buffer.allocUnsafe(64 * 1024)
    await dependencies.verifyRoot(root)
    while (true) {
      const result = await handle.read(buffer, 0, buffer.byteLength, null)
      if (result.bytesRead === 0) break
      bytes += result.bytesRead
      if (bytes > expectedBytes) throw new Error("pending-output-overflow")
      digest.update(buffer.subarray(0, result.bytesRead))
    }
    const after = await handle.stat({ bigint: true })
    await dependencies.verifyRoot(root)
    if (
      bytes !== expectedBytes ||
      digest.digest("hex") !== expectedDigest ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      after.ctimeNs !== opened.ctimeNs
    ) {
      throw new Error("pending-output-changed")
    }
    return {
      path: value,
      bytes,
      sha256: expectedDigest,
      identity: { dev: opened.dev, ino: opened.ino },
      root,
    }
  } finally {
    await handle.close()
    await dependencies.verifyRoot(root)
  }
}

export async function read(output: StableOutput, dependencies: Dependencies = defaultDependencies) {
  await dependencies.verifyRoot(output.root)
  const handle = await dependencies
    .openFile(output.path, constants.O_RDONLY | constants.O_NOFOLLOW)
    .catch(async (error) => {
      await dependencies.verifyRoot(output.root)
      throw error
    })
  try {
    await dependencies.verifyRoot(output.root)
    const info = await handle.stat({ bigint: true })
    if (info.dev !== output.identity.dev || info.ino !== output.identity.ino || info.size !== BigInt(output.bytes)) {
      throw new Error("pending-output-replaced")
    }
    await dependencies.verifyRoot(output.root)
    const bytes = await handle.readFile()
    await dependencies.verifyRoot(output.root)
    if (bytes.byteLength !== output.bytes || createHash("sha256").update(bytes).digest("hex") !== output.sha256) {
      throw new Error("pending-output-changed")
    }
    return bytes
  } finally {
    await handle.close()
    await dependencies.verifyRoot(output.root)
  }
}

export async function remove(output: StableOutput, dependencies: Dependencies = defaultDependencies) {
  await dependencies.verifyRoot(output.root)
  const info = await dependencies.inspect(output.path, { bigint: true })
  if (info.isSymbolicLink() || info.dev !== output.identity.dev || info.ino !== output.identity.ino) {
    throw new Error("pending-output-replaced")
  }
  await dependencies.verifyRoot(output.root)
  await dependencies.removeFile(output.path).catch(async (error) => {
    await dependencies.verifyRoot(output.root)
    throw error
  })
  await dependencies.verifyRoot(output.root)
  const absent = await dependencies.inspect(output.path).then(
    () => false,
    (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT",
  )
  if (!absent) throw new Error("pending-output-not-removed")
  await dependencies.verifyRoot(output.root)
}

function inside(root: string, value: string) {
  const relation = path.relative(root, value)
  return relation !== "" && relation !== ".." && !relation.startsWith(`..${path.sep}`) && !path.isAbsolute(relation)
}

function samePath(left: string, right: string) {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right
}

export * as DocumentPendingOutput from "./pending-output"
