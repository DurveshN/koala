import type { DocumentRuntimeManifest } from "@koala-ai/core/document-runtime/manifest"
import { lstat, mkdir, realpath } from "node:fs/promises"
import path from "node:path"
import { RuntimeFailure } from "./error.ts"

export async function validatePrivateJobRoot(root: string) {
  if (!path.isAbsolute(root)) throw new RuntimeFailure("invalid-request", "input")
  const info = await lstat(root).catch(() => undefined)
  if (!info?.isDirectory() || info.isSymbolicLink()) throw new RuntimeFailure("invalid-request", "input")
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new RuntimeFailure("invalid-request", "input")
  }
  return path.resolve(await realpath(root))
}

export function resolveInRoot(root: string, relative: DocumentRuntimeManifest.RelativePath | string) {
  if (path.isAbsolute(relative) || relative.startsWith("\\") || /^[a-zA-Z]:/.test(relative)) {
    throw new RuntimeFailure("invalid-request", "input")
  }
  const resolved = path.resolve(root, ...relative.split("/"))
  const relation = path.relative(root, resolved)
  if (relation === "" || relation.startsWith(`..${path.sep}`) || relation === ".." || path.isAbsolute(relation)) {
    throw new RuntimeFailure("invalid-request", "input")
  }
  return resolved
}

export async function makePrivateDirectory(root: string, relative: string) {
  const directory = resolveInRoot(root, relative)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink() || !inside(root, await realpath(directory))) {
    throw new RuntimeFailure("invalid-request", "input")
  }
  return directory
}

export async function validateInputFile(root: string, file: string, declaredBytes?: number) {
  const verifiedRoot = await realpath(root).catch(() => "")
  const info = await lstat(file).catch(() => undefined)
  if (
    !info?.isFile() ||
    info.isSymbolicLink() ||
    (declaredBytes !== undefined && info.size !== declaredBytes) ||
    !inside(verifiedRoot, await realpath(file).catch(() => ""))
  ) {
    throw new RuntimeFailure("invalid-request", "input")
  }
  return info
}

export async function validateOutputFile(root: string, file: string, expectedBytes: number) {
  const verifiedRoot = await realpath(root).catch(() => "")
  const info = await lstat(file).catch(() => undefined)
  if (
    !info?.isFile() ||
    info.isSymbolicLink() ||
    info.size !== expectedBytes ||
    !inside(verifiedRoot, await realpath(file).catch(() => ""))
  ) {
    throw new RuntimeFailure("invalid-request", "cleanup")
  }
  return info
}

function inside(root: string, file: string) {
  const relation = path.relative(root, file)
  return relation !== "" && relation !== ".." && !relation.startsWith(`..${path.sep}`) && !path.isAbsolute(relation)
}
