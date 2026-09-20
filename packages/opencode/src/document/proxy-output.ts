import { DocumentRuntimeManifest } from "@koala-ai/core/document-runtime/manifest"
import { DocumentRuntimeProtocol } from "@koala-ai/core/document-runtime/protocol"
import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, realpath, rm } from "node:fs/promises"
import path from "node:path"
import { DocumentPendingRoot } from "./pending-root"

export interface OutputFileHandle {
  readonly stat: (options: { readonly bigint: true }) => Promise<{
    readonly dev: bigint
    readonly ino: bigint
    readonly size: bigint
    readonly isFile: () => boolean
  }>
  readonly write: (buffer: Uint8Array, offset: number, length: number) => Promise<{ readonly bytesWritten: number }>
  readonly read: (
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ) => Promise<{ readonly bytesRead: number }>
  readonly sync: () => Promise<void>
  readonly close: () => Promise<void>
}

interface StableOutput {
  readonly outputID: DocumentRuntimeProtocol.OutputID
  readonly absolutePath: string
  readonly relativePath: DocumentRuntimeManifest.RelativePath
  readonly identity: { readonly dev: bigint; readonly ino: bigint }
  readonly bytes: number
  readonly sha256: DocumentRuntimeManifest.Digest
  readonly page: number
  readonly pageID: DocumentRuntimeProtocol.PageID
}

interface CloseRecord {
  readonly handle: OutputFileHandle
  closeState: "open" | "closed" | "failed"
}

interface ActiveOutput extends CloseRecord {
  readonly start: DocumentRuntimeProtocol.OutputStart
  readonly absolutePath: string
  readonly relativePath: DocumentRuntimeManifest.RelativePath
  readonly identity: { readonly dev: bigint; readonly ino: bigint }
  readonly digest: ReturnType<typeof createHash>
  bytes: number
}

export interface Receiver {
  readonly handle: (
    message: DocumentRuntimeProtocol.WorkerOutput,
  ) => Promise<DocumentRuntimeProtocol.WorkerEvent | undefined>
  readonly release: (request: typeof DocumentRuntimeProtocol.ReleasePageRequest.Type) => Promise<boolean>
  readonly cleanup: () => Promise<void>
}

export interface ReceiverDependencies {
  readonly openFile: (value: string, flags: number, mode?: number) => Promise<OutputFileHandle>
  readonly inspect: typeof lstat
  readonly canonicalize: typeof realpath
  readonly removeFile: typeof rm
  readonly verifyRoot: (evidence: DocumentPendingRoot.Evidence) => Promise<unknown>
}

export const defaultDependencies: ReceiverDependencies = {
  openFile: open,
  inspect: lstat,
  canonicalize: realpath,
  removeFile: rm,
  verifyRoot: DocumentPendingRoot.verify,
}

export function create(
  root: DocumentPendingRoot.Evidence,
  request: DocumentRuntimeProtocol.StartRequest,
  dependencies: ReceiverDependencies = defaultDependencies,
): Receiver {
  let state = DocumentRuntimeProtocol.beginOutputOrder(request)
  let active: ActiveOutput | undefined
  const stable = new Map<DocumentRuntimeProtocol.OutputID, StableOutput>()
  const owned = new Map<string, { readonly dev: bigint; readonly ino: bigint }>()

  const cleanup = async () => {
    if (active) {
      await closeOnce(active)
      active = undefined
    }
    await dependencies.verifyRoot(root)
    stable.clear()
    const entries = [...owned]
    await Promise.all(entries.map(([value, identity]) => removeWithRetry(root, value, identity, dependencies)))
    owned.clear()
    await dependencies.verifyRoot(root)
  }

  return {
    async handle(message) {
      const next = DocumentRuntimeProtocol.advanceOutputOrder(state, message)
      if (!next.ok) throw new Error(next.code)
      state = next.state

      if (message.type === "output-start") {
        if (active) throw new Error("interleaved-output")
        const extension = message.kind === "page-png" ? ".png" : ".tsv"
        const relativePath = DocumentRuntimeManifest.RelativePath.make(`output-${randomUUID()}${extension}`)
        await dependencies.verifyRoot(root)
        const absolutePath = path.join(root.pendingRoot, relativePath)
        const handle = await dependencies
          .openFile(
            absolutePath,
            constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
            0o600,
          )
          .catch(async (error) => {
            await dependencies.verifyRoot(root)
            throw error
          })
        const acquisition: {
          readonly absolutePath: string
          readonly relativePath: DocumentRuntimeManifest.RelativePath
          readonly handle: OutputFileHandle
          identity?: { readonly dev: bigint; readonly ino: bigint }
          closeState: "open" | "closed" | "failed"
        } = {
          absolutePath,
          relativePath,
          handle,
          closeState: "open",
        }
        let accepted = false
        try {
          const info = await handle.stat({ bigint: true })
          const identity = { dev: info.dev, ino: info.ino }
          acquisition.identity = identity
          if (!info.isFile() || info.size !== 0n) throw new Error("invalid-output-file")
          await dependencies.verifyRoot(root)
          await verifyAcquiredPath(root, acquisition.absolutePath, identity, dependencies)
          await dependencies.verifyRoot(root)
          owned.set(absolutePath, identity)
          active = {
            start: message,
            ...acquisition,
            identity,
            closeState: acquisition.closeState,
            digest: createHash("sha256"),
            bytes: 0,
          }
          accepted = true
        } finally {
          if (!accepted) {
            await closeOnce(acquisition)
            if (acquisition.identity) {
              await removeAcquisitionIfSafe(root, acquisition.absolutePath, acquisition.identity, dependencies)
            }
          }
        }
        return
      }

      if (message.type === "output-chunk") {
        if (
          !active ||
          active.closeState !== "open" ||
          active.start.outputID !== message.outputID ||
          !next.decodedChunk
        ) {
          throw new Error("invalid-output-chunk")
        }
        await writeAll(active.handle, next.decodedChunk)
        active.digest.update(next.decodedChunk)
        active.bytes += next.decodedChunk.byteLength
        return
      }

      if (message.type === "output-end") {
        if (!active || active.start.outputID !== message.outputID) throw new Error("invalid-output-end")
        const output = active
        try {
          await dependencies.verifyRoot(root)
          await output.handle.sync()
          await dependencies.verifyRoot(root)
          const sha256 = DocumentRuntimeManifest.Digest.make(output.digest.digest("hex"))
          if (output.bytes !== message.actualBytes || sha256 !== message.sha256) {
            throw new Error("output-digest-mismatch")
          }
          await closeOnce(output)
          await dependencies.verifyRoot(root)
          const verified = await verifyFile(
            root,
            output.absolutePath,
            output.identity,
            output.bytes,
            sha256,
            dependencies,
          )
          stable.set(message.outputID, {
            outputID: message.outputID,
            absolutePath: output.absolutePath,
            relativePath: output.relativePath,
            identity: verified.identity,
            bytes: output.bytes,
            sha256,
            page: output.start.page,
            pageID: output.start.pageID,
          })
          active = undefined
        } catch (error) {
          await closeOnce(output)
          throw error
        }
        return
      }

      if (message.type !== "page-ready" && message.type !== "ocr-result") return message
      const output = stable.get(message.outputID)
      if (!output || output.bytes !== (message.type === "page-ready" ? message.pngBytes : message.tsvBytes)) {
        throw new Error("missing-stable-output")
      }
      return {
        ...message,
        outputPath: output.relativePath,
        outputSha256: output.sha256,
      }
    },
    async release(release) {
      await dependencies.verifyRoot(root)
      const outputs = [...stable.values()].filter(
        (output) => output.page === release.page && output.pageID === release.pageID,
      )
      if (outputs.length === 0) return false
      if ((await Promise.all(outputs.map((output) => exists(output.absolutePath, dependencies)))).some(Boolean))
        return false
      await dependencies.verifyRoot(root)
      const next = DocumentRuntimeProtocol.advanceOutputOrder(state, release)
      if (!next.ok) return false
      state = next.state
      for (const output of outputs) stable.delete(output.outputID)
      for (const output of outputs) owned.delete(output.absolutePath)
      await dependencies.verifyRoot(root)
      return true
    },
    cleanup,
  }
}

async function verifyAcquiredPath(
  root: DocumentPendingRoot.Evidence,
  value: string,
  identity: { readonly dev: bigint; readonly ino: bigint },
  dependencies: ReceiverDependencies,
) {
  await dependencies.verifyRoot(root)
  const info = await dependencies.inspect(value, { bigint: true })
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.dev !== identity.dev ||
    info.ino !== identity.ino ||
    info.size !== 0n ||
    !samePath(await dependencies.canonicalize(value), value)
  ) {
    throw new DocumentPendingRoot.EvidenceError("pending-entry-replaced")
  }
  await dependencies.verifyRoot(root)
}

async function removeAcquisitionIfSafe(
  root: DocumentPendingRoot.Evidence,
  value: string,
  identity: { readonly dev: bigint; readonly ino: bigint },
  dependencies: ReceiverDependencies,
) {
  try {
    await dependencies.verifyRoot(root)
    const info = await dependencies.inspect(value, { bigint: true })
    if (info.isSymbolicLink() || info.dev !== identity.dev || info.ino !== identity.ino || info.size !== 0n) return
    await dependencies.removeFile(value)
    await dependencies.verifyRoot(root)
  } catch (error) {
    if (error instanceof DocumentPendingRoot.EvidenceError) return
    throw error
  }
}

async function closeOnce(record: CloseRecord) {
  if (record.closeState === "closed") return
  if (record.closeState === "failed") throw new DocumentPendingRoot.EvidenceError("output-close-unconfirmed")
  try {
    await record.handle.close()
    record.closeState = "closed"
  } catch {
    record.closeState = "failed"
    throw new DocumentPendingRoot.EvidenceError("output-close-unconfirmed")
  }
}

async function verifyFile(
  root: DocumentPendingRoot.Evidence,
  value: string,
  identity: { readonly dev: bigint; readonly ino: bigint },
  expectedBytes: number,
  expectedDigest: DocumentRuntimeManifest.Digest,
  dependencies: ReceiverDependencies,
) {
  await dependencies.verifyRoot(root)
  const pathInfo = await dependencies.inspect(value, { bigint: true })
  if (
    !pathInfo.isFile() ||
    pathInfo.isSymbolicLink() ||
    pathInfo.dev !== identity.dev ||
    pathInfo.ino !== identity.ino
  ) {
    throw new Error("output-identity-mismatch")
  }
  if (!samePath(await dependencies.canonicalize(value), value) || pathInfo.size !== BigInt(expectedBytes)) {
    throw new Error("output-size-mismatch")
  }
  await dependencies.verifyRoot(root)
  const handle = await dependencies.openFile(value, constants.O_RDONLY | constants.O_NOFOLLOW).catch(async (error) => {
    await dependencies.verifyRoot(root)
    throw error
  })
  try {
    await dependencies.verifyRoot(root)
    const opened = await handle.stat({ bigint: true })
    if (opened.dev !== identity.dev || opened.ino !== identity.ino || opened.size !== BigInt(expectedBytes)) {
      throw new Error("output-identity-mismatch")
    }
    const digest = createHash("sha256")
    let bytes = 0
    const buffer = Buffer.allocUnsafe(64 * 1024)
    await dependencies.verifyRoot(root)
    while (true) {
      const result = await handle.read(buffer, 0, buffer.byteLength, null)
      if (result.bytesRead === 0) break
      bytes += result.bytesRead
      if (bytes > expectedBytes) throw new Error("output-size-mismatch")
      digest.update(buffer.subarray(0, result.bytesRead))
    }
    await dependencies.verifyRoot(root)
    if (bytes !== expectedBytes || digest.digest("hex") !== expectedDigest) throw new Error("output-digest-mismatch")
    return { identity: { dev: opened.dev, ino: opened.ino } }
  } finally {
    await handle.close()
    await dependencies.verifyRoot(root)
  }
}

async function writeAll(handle: OutputFileHandle, bytes: Uint8Array) {
  let offset = 0
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset)
    if (result.bytesWritten < 1) throw new Error("output-write-failed")
    offset += result.bytesWritten
  }
}

async function exists(value: string, dependencies: ReceiverDependencies) {
  return dependencies.inspect(value).then(
    () => true,
    (error: unknown) => {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false
      throw error
    },
  )
}

async function removeWithRetry(
  root: DocumentPendingRoot.Evidence,
  value: string,
  identity: { readonly dev: bigint; readonly ino: bigint },
  dependencies: ReceiverDependencies,
) {
  const deadline = Date.now() + 250
  while (true) {
    await dependencies.verifyRoot(root)
    try {
      const info = await dependencies.inspect(value, { bigint: true })
      if (info.isSymbolicLink() || info.dev !== identity.dev || info.ino !== identity.ino) {
        throw new DocumentPendingRoot.EvidenceError("pending-entry-replaced")
      }
      await dependencies.removeFile(value, { force: true })
      await dependencies.verifyRoot(root)
      return
    } catch (error) {
      await dependencies.verifyRoot(root)
      if (!transient(error) || Date.now() >= deadline) throw error
      await new Promise<void>((resolve) => setTimeout(resolve, 10))
    }
  }
}

function transient(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "EBUSY" || error.code === "EPERM" || error.code === "EACCES" || error.code === "EFAULT")
  )
}

function samePath(left: string, right: string) {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right
}

export * as DocumentProxyOutput from "./proxy-output"
