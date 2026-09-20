#!/usr/bin/env bun
import {
  loadAndVerifyProductionManifest,
  loadTrustedAttestation,
  probeProductionRuntime,
  type ProductionProbeResult,
  type VerifiedManifest,
} from "@koala-ai/document-runtime"
import { copyFile, cp, mkdir, readdir, realpath, rename, rm } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { hostTarget, verifySandboxRuntimeRoot } from "../src/main/sandbox-runtime"
import { matchesConfinementEvidence } from "../src/main/document-runtime"
import type { ResolvedSandboxRuntime } from "../src/main/sandbox-runtime"

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const workspaceDir = path.resolve(packageDir, "../..")
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
  await cleanStaging(stagedDocumentRuntime, documentRuntimeAttestation)
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
  readonly source?: string
  readonly trustedAttestation?: string
  readonly destination?: string
  readonly attestation?: string
  readonly environment?: NodeJS.ProcessEnv
  readonly probe?: (runtime: VerifiedManifest) => Promise<ProductionProbeResult>
  readonly sandboxRuntime?: ResolvedSandboxRuntime
}) {
  const environment = input?.environment ?? process.env
  const source = input?.source ?? environment.KOALA_DOCUMENT_RUNTIME_RELEASE_ROOT
  if (!source || !path.isAbsolute(source)) {
    throw new Error("KOALA_DOCUMENT_RUNTIME_RELEASE_ROOT must be an absolute path")
  }
  const trustedAttestation = input?.trustedAttestation ?? environment.KOALA_DOCUMENT_RUNTIME_ATTESTATION
  if (!trustedAttestation || !path.isAbsolute(trustedAttestation)) {
    throw new Error("KOALA_DOCUMENT_RUNTIME_ATTESTATION must be an absolute path")
  }

  const destination = input?.destination ?? stagedDocumentRuntime
  const attestation = input?.attestation ?? documentRuntimeAttestation
  const sourceRoot = await realpath(source)
  const destinationPath = path.resolve(destination)
  const existingDestination = await realpath(destination).catch(() => destinationPath)
  if (inside(sourceRoot, existingDestination) || inside(existingDestination, sourceRoot)) {
    throw new Error("Source and staged document runtimes must not overlap")
  }
  if (path.resolve(trustedAttestation) === path.resolve(attestation)) {
    throw new Error("Trusted and staged document runtime attestations must be different files")
  }
  const trustedFile = await realpath(trustedAttestation)
  if (inside(sourceRoot, trustedFile)) {
    throw new Error("Trusted document runtime attestation must be outside the runtime root")
  }
  await cleanStaging(destination, attestation)
  const target = parseTarget(environment.RUST_TARGET)
  const trust = await loadTrustedAttestation(trustedAttestation)
  if (trust.target !== target) throw new Error("Document runtime attestation target does not match RUST_TARGET")
  const sourceRuntime = await loadAndVerifyProductionManifest(source, target, trust)
  const sandboxRuntime = input?.sandboxRuntime ?? (await verifyPreparedSandboxRuntime(environment))
  if (!matchesConfinementEvidence(trust.confinementEvidence, target, sourceRuntime.manifestSha256, sandboxRuntime)) {
    throw new Error("Document confinement evidence is missing or does not match packaged resources")
  }
  const temporary = `${destination}.tmp-${process.pid}`
  const temporaryAttestation = `${attestation}.tmp-${process.pid}`

  await mkdir(path.dirname(destination), { recursive: true })
  await mkdir(path.dirname(attestation), { recursive: true })
  try {
    await cp(source, temporary, { recursive: true })
    const staged = await loadAndVerifyProductionManifest(temporary, target, trust)
    const probe = await (input?.probe ?? probeProductionRuntime)(staged)
    if (
      !probe.performed &&
      (!trust.smokeEvidence ||
        trust.smokeEvidence.target !== target ||
        trust.smokeEvidence.manifestSha256 !== staged.manifestSha256)
    ) {
      throw new Error("Cross-target document runtime staging requires attested target-native smoke evidence")
    }
    await rm(destination, { recursive: true, force: true })
    await rename(temporary, destination)
    await copyFile(trustedAttestation, temporaryAttestation)
    await rename(temporaryAttestation, attestation)
    return { root: await realpath(destination), manifestSha256: staged.manifestSha256, target, probe }
  } finally {
    await rm(temporary, { recursive: true, force: true })
    await rm(temporaryAttestation, { force: true })
  }
}

export function prepareOrVerifyReleaseDocumentRuntime() {
  return prepareReleaseDocumentRuntime()
}

export function verifyPreparedSandboxRuntime(environment: NodeJS.ProcessEnv = process.env) {
  const target = environment.RUST_TARGET !== undefined
    ? parseTarget(environment.RUST_TARGET)
    : hostTarget(process.platform, process.arch)
  if (!target) throw new Error("Current host does not have a supported sandbox runtime target")
  return verifySandboxRuntimeRoot(sandboxRuntimeRoot, target)
}

export async function verifyPreparedReleaseDocumentRuntime(input?: {
  readonly root?: string
  readonly attestation?: string
  readonly environment?: NodeJS.ProcessEnv
  readonly sandboxRuntime?: ResolvedSandboxRuntime
}) {
  const root = input?.root ?? stagedDocumentRuntime
  const target = parseTarget((input?.environment ?? process.env).RUST_TARGET)
  const trust = await loadTrustedAttestation(input?.attestation ?? documentRuntimeAttestation)
  if (target !== trust.target) throw new Error("Prepared document runtime target does not match RUST_TARGET")
  const verified = await loadAndVerifyProductionManifest(root, target, trust)
  const sandboxRuntime = input?.sandboxRuntime ?? (await verifyPreparedSandboxRuntime(input?.environment ?? process.env))
  if (!matchesConfinementEvidence(trust.confinementEvidence, target, verified.manifestSha256, sandboxRuntime)) {
    throw new Error("Document confinement evidence is missing or does not match packaged resources")
  }
  return { root: verified.root, manifestSha256: verified.manifestSha256, target: trust.target }
}

function parseTarget(value: unknown) {
  if (typeof value === "string" && targets.some((target) => target === value)) {
    return value as (typeof targets)[number]
  }
  throw new Error("RUST_TARGET must identify a supported document runtime target")
}

function inside(root: string, value: string) {
  const relation = path.relative(root, value)
  return relation === "" || (!relation.startsWith(`..${path.sep}`) && relation !== ".." && !path.isAbsolute(relation))
}

async function cleanStaging(destination: string, attestation: string) {
  await Promise.all([rm(destination, { recursive: true, force: true }), rm(attestation, { force: true })])
  await Promise.all(
    [
      [path.dirname(destination), `${path.basename(destination)}.tmp-`],
      [path.dirname(attestation), `${path.basename(attestation)}.tmp-`],
    ].map(async ([directory, prefix]) => {
      const entries = await readdir(directory).catch(() => [])
      await Promise.all(
        entries
          .filter((entry) => entry.startsWith(prefix))
          .map((entry) => rm(path.join(directory, entry), { recursive: true, force: true })),
      )
    }),
  )
}

if (import.meta.main) {
  const mode = process.argv[2]
  if (mode !== "prepare" && mode !== "verify" && mode !== "verify-sandbox") {
    throw new Error("Expected prepare, verify, or verify-sandbox")
  }
  const runtime =
    mode === "prepare"
      ? await prepareReleaseDocumentRuntime()
      : mode === "verify"
        ? await verifyPreparedReleaseDocumentRuntime()
        : await verifyPreparedSandboxRuntime()
  console.log(runtime.root)
}
