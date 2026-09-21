#!/usr/bin/env bun
import { loadAndVerifyProductionManifest, loadTrustedAttestation } from "@koala-ai/document-runtime"
import { randomUUID } from "node:crypto"
import { cp, lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { verifyConfinementResources, type ReleaseIdentity } from "../src/main/document-confinement"
import { hostTarget, verifySandboxRuntimeRoot, type SandboxRuntimeTarget } from "../src/main/sandbox-runtime"
import { releaseIdentity } from "./document-runtime-evidence"

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const workspaceDir = path.resolve(packageDir, "../..")
const MarkerName = ".koala-document-staging.json"
export const stagedDocumentRuntime = path.join(packageDir, "resources", "document-runtime")
export const documentRuntimeAttestation = path.join(packageDir, "resources", "document-runtime.attestation.json")
export const sandboxRuntimeRoot = path.join(workspaceDir, "packages", "opencode", "dist", "node", "sandbox-runtime")
const targets = [
  "x86_64-apple-darwin",
  "aarch64-apple-darwin",
  "x86_64-pc-windows-msvc",
  "aarch64-pc-windows-msvc",
  "x86_64-unknown-linux-gnu",
  "aarch64-unknown-linux-gnu",
] as const

export async function buildDevelopmentDocumentRuntime() {
  await Promise.all([
    rm(stagedDocumentRuntime, { recursive: true, force: true }),
    rm(documentRuntimeAttestation, { force: true }),
  ])
  const environment = { ...process.env }
  delete environment.OPENCODE_CHANNEL
  delete environment.OPENCODE_VERSION
  delete environment.RUST_TARGET
  const child = Bun.spawn(["bun", "run", "build"], {
    cwd: path.join(workspaceDir, "packages", "document-runtime"),
    env: environment,
    stdout: "inherit",
    stderr: "inherit",
  })
  const code = await child.exited
  if (code !== 0) throw new Error(`Development document runtime build failed with exit code ${code}`)
}

export async function prepareReleaseDocumentRuntime(input?: {
  readonly sourceResourcesRoot?: string
  readonly stagingParent?: string
  readonly stagingRoot?: string
  readonly environment?: NodeJS.ProcessEnv
  readonly release?: ReleaseIdentity
}) {
  const environment = input?.environment ?? process.env
  const target = parseTarget(environment.RUST_TARGET)
  const release = input?.release ?? releaseIdentity(environment)
  const source = input?.sourceResourcesRoot ?? required(environment, "KOALA_DOCUMENT_CONFINEMENT_RESOURCES_ROOT")
  const stagingParent = input?.stagingParent ?? required(environment, "KOALA_DOCUMENT_RUNTIME_STAGING_PARENT")
  const destination = input?.stagingRoot ?? required(environment, "KOALA_DOCUMENT_RUNTIME_STAGING_ROOT")
  const [sourceRoot, parentRoot] = await Promise.all([canonicalDirectory(source), canonicalDirectory(stagingParent)])
  const destinationPath = path.resolve(destination)
  if (!samePath(path.dirname(destinationPath), parentRoot)) {
    throw new Error("Document runtime staging root must be a direct child of its explicit parent")
  }
  if (overlap(sourceRoot, parentRoot) || overlap(sourceRoot, destinationPath)) {
    throw new Error("Source and staged document resources must not overlap")
  }
  if (await exists(destinationPath)) throw new Error("Document runtime staging root must be fresh")

  const sourceContext = await verifyResourceTree(sourceRoot, target, release)
  await mkdir(destinationPath, { mode: 0o700 })
  const created = await identity(destinationPath)
  try {
    await Promise.all([
      cp(path.join(sourceRoot, "document-runtime"), path.join(destinationPath, "document-runtime"), { recursive: true }),
      cp(path.join(sourceRoot, "sandbox-runtime"), path.join(destinationPath, "sandbox-runtime"), { recursive: true }),
      cp(
        path.join(sourceRoot, "document-runtime.attestation.json"),
        path.join(destinationPath, "document-runtime.attestation.json"),
      ),
      cp(
        path.join(sourceRoot, "document-confinement-evidence"),
        path.join(destinationPath, "document-confinement-evidence"),
        { recursive: true },
      ),
    ])
    await writeFile(
      path.join(destinationPath, MarkerName),
      `${JSON.stringify({ ownerVersion: 1, target, nonce: randomUUID() })}\n`,
      { flag: "wx", mode: 0o600 },
    )
    const staged = await verifyResourceTree(await realpath(destinationPath), target, release)
    if (
      staged.runtime.manifestSha256 !== sourceContext.runtime.manifestSha256 ||
      staged.sandbox.manifestSha256 !== sourceContext.sandbox.manifestSha256 ||
      staged.evidence.keyID !== sourceContext.evidence.keyID
    ) {
      throw new Error("Staged document resources changed during copy")
    }
    return result(destinationPath, staged, target)
  } catch (error) {
    if (await sameIdentity(destinationPath, created)) await rm(destinationPath, { recursive: true, force: true })
    throw error
  }
}

export async function verifyPreparedReleaseDocumentRuntime(input?: {
  readonly stagingRoot?: string
  readonly environment?: NodeJS.ProcessEnv
  readonly release?: ReleaseIdentity
}) {
  const environment = input?.environment ?? process.env
  const target = parseTarget(environment.RUST_TARGET)
  const release = input?.release ?? releaseIdentity(environment)
  const root = await canonicalDirectory(
    input?.stagingRoot ?? required(environment, "KOALA_DOCUMENT_RUNTIME_STAGING_ROOT"),
  )
  const markerPath = path.join(root, MarkerName)
  const markerInfo = await lstat(markerPath)
  if (!markerInfo.isFile() || markerInfo.isSymbolicLink() || markerInfo.size > 4096) {
    throw new Error("Document runtime staging ownership marker is invalid")
  }
  const marker = JSON.parse(await readFile(markerPath, "utf8")) as {
    readonly ownerVersion?: unknown
    readonly target?: unknown
    readonly nonce?: unknown
  }
  if (
    marker.ownerVersion !== 1 ||
    marker.target !== target ||
    typeof marker.nonce !== "string" ||
    !/^[a-f0-9-]{36}$/.test(marker.nonce)
  ) {
    throw new Error("Document runtime staging ownership marker is invalid")
  }
  return result(root, await verifyResourceTree(root, target, release), target)
}

export async function prepareOrVerifyReleaseDocumentRuntime() {
  const root = required(process.env, "KOALA_DOCUMENT_RUNTIME_STAGING_ROOT")
  return (await exists(root))
    ? verifyPreparedReleaseDocumentRuntime({ stagingRoot: root })
    : prepareReleaseDocumentRuntime({ stagingRoot: root })
}

export function verifyPreparedSandboxRuntime(environment: NodeJS.ProcessEnv = process.env) {
  const target = environment.RUST_TARGET !== undefined
    ? parseTarget(environment.RUST_TARGET)
    : hostTarget(process.platform, process.arch)
  if (!target) throw new Error("Current host does not have a supported sandbox runtime target")
  return verifySandboxRuntimeRoot(sandboxRuntimeRoot, target)
}

async function verifyResourceTree(root: string, target: SandboxRuntimeTarget, release: ReleaseIdentity) {
  const attestation = await loadTrustedAttestation(path.join(root, "document-runtime.attestation.json"))
  if (attestation.target !== target) throw new Error("Prepared document runtime target does not match RUST_TARGET")
  const [runtime, sandbox] = await Promise.all([
    loadAndVerifyProductionManifest(path.join(root, "document-runtime"), target, attestation),
    verifySandboxRuntimeRoot(path.join(root, "sandbox-runtime"), target),
  ])
  const evidence = await verifyConfinementResources({
    resourcesRoot: root,
    target,
    runtimeManifestSha256: runtime.manifestSha256,
    sandboxRuntime: sandbox,
    release,
  })
  return { runtime, sandbox, evidence }
}

function result(
  root: string,
  verified: Awaited<ReturnType<typeof verifyResourceTree>>,
  target: SandboxRuntimeTarget,
) {
  return {
    resourcesRoot: root,
    root: verified.runtime.root,
    attestation: path.join(root, "document-runtime.attestation.json"),
    evidenceRoot: path.join(root, "document-confinement-evidence"),
    sandboxRoot: verified.sandbox.root,
    manifestSha256: verified.runtime.manifestSha256,
    target,
  }
}

async function canonicalDirectory(value: string) {
  if (!path.isAbsolute(value)) throw new Error("Document runtime staging paths must be absolute")
  const info = await lstat(value)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Document runtime staging path is invalid")
  const canonical = await realpath(value)
  if (!samePath(canonical, path.normalize(value))) throw new Error("Document runtime staging path is not canonical")
  return canonical
}

async function identity(value: string) {
  const info = await lstat(value, { bigint: true })
  return { dev: info.dev, ino: info.ino }
}

async function sameIdentity(value: string, expected: { readonly dev: bigint; readonly ino: bigint }) {
  const info = await lstat(value, { bigint: true }).catch(() => undefined)
  return Boolean(info?.isDirectory() && !info.isSymbolicLink() && info.dev === expected.dev && info.ino === expected.ino)
}

async function exists(value: string) {
  return lstat(value).then(
    () => true,
    () => false,
  )
}

function overlap(left: string, right: string) {
  const relation = path.relative(left, right)
  const reverse = path.relative(right, left)
  return relation === "" || inside(relation) || inside(reverse)
}

function inside(relation: string) {
  return relation !== ".." && !relation.startsWith(`..${path.sep}`) && !path.isAbsolute(relation)
}

function samePath(left: string, right: string) {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right
}

function required(environment: NodeJS.ProcessEnv, key: string) {
  const value = environment[key]
  if (!value || !path.isAbsolute(value)) throw new Error(`${key} must be an absolute path`)
  return value
}

function parseTarget(value: unknown) {
  if (typeof value === "string" && targets.some((target) => target === value)) return value as SandboxRuntimeTarget
  throw new Error("RUST_TARGET must identify a supported document runtime target")
}

if (import.meta.main) {
  const mode = process.argv[2]
  if (mode !== "prepare" && mode !== "verify" && mode !== "verify-sandbox") {
    throw new Error("Expected prepare, verify, or verify-sandbox")
  }
  const output =
    mode === "prepare"
      ? await prepareReleaseDocumentRuntime()
      : mode === "verify"
        ? await verifyPreparedReleaseDocumentRuntime()
        : await verifyPreparedSandboxRuntime()
  console.log(JSON.stringify(output))
}
