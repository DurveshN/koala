import { DocumentRuntimeManifest } from "@koala-ai/core/document-runtime/manifest"
import { DocumentRuntimeAttestation } from "@koala-ai/core/document-runtime/attestation"
import type { DocumentRuntimeTarget } from "@koala-ai/core/document-runtime/target"
import { Schema } from "effect"
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { lstat, opendir, readFile, realpath } from "node:fs/promises"
import path from "node:path"
import { verifyProductionProfile, verifyProductionTargetBinaries } from "./production-profile.ts"

const ManifestName = "manifest.json"
const MaxManifestBytes = 8 * 1024 * 1024
const MaxAttestationBytes = 1024 * 1024
const HashConcurrency = 4
const decodeManifest = Schema.decodeUnknownSync(DocumentRuntimeManifest.Manifest)
const decodeAttestation = Schema.decodeUnknownSync(DocumentRuntimeAttestation.Attestation)

export type VerifiedManifest = {
  readonly manifest: DocumentRuntimeManifest.Manifest
  readonly manifestSha256: string
  readonly root: string
}

export class ManifestVerificationError extends Error {
  override readonly name = "ManifestVerificationError"
  readonly code:
    | "invalid-manifest"
    | "invalid-attestation"
    | "target-mismatch"
    | "file-mismatch"
    | "release-incomplete"
    | "profile-mismatch"

  constructor(
    code:
      | "invalid-manifest"
      | "invalid-attestation"
      | "target-mismatch"
      | "file-mismatch"
      | "release-incomplete"
      | "profile-mismatch",
  ) {
    super(code)
    this.code = code
  }
}

export async function loadAndVerifyManifest(
  root: string,
  expectedTarget: DocumentRuntimeTarget.Target,
  expectedManifestSha256?: string,
  requireReleaseReady = false,
): Promise<VerifiedManifest> {
  if (!path.isAbsolute(root)) throw new ManifestVerificationError("invalid-manifest")
  const rootInfo = await lstat(root).catch(() => undefined)
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) throw new ManifestVerificationError("invalid-manifest")
  const verifiedRoot = await realpath(root)

  const manifestPath = path.join(verifiedRoot, ManifestName)
  const manifestInfo = await lstat(manifestPath).catch(() => undefined)
  if (!manifestInfo?.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.size > MaxManifestBytes) {
    throw new ManifestVerificationError("invalid-manifest")
  }
  const bytes = await readFile(manifestPath).catch(() => undefined)
  if (!bytes || bytes.byteLength !== manifestInfo.size) throw new ManifestVerificationError("invalid-manifest")
  const manifestSha256 = createHash("sha256").update(bytes).digest("hex")
  if (expectedManifestSha256 !== undefined && manifestSha256 !== expectedManifestSha256) {
    throw new ManifestVerificationError("invalid-manifest")
  }

  const manifest = decode(bytes)
  if (manifest.target !== expectedTarget) throw new ManifestVerificationError("target-mismatch")
  if (requireReleaseReady && expectedManifestSha256 === undefined) {
    throw new ManifestVerificationError("invalid-attestation")
  }
  if (requireReleaseReady && !manifest.releaseReady) throw new ManifestVerificationError("release-incomplete")
  await verifyFiles(verifiedRoot, manifest.files)
  return { manifest, manifestSha256, root: verifiedRoot }
}

export async function loadAndVerifyProductionManifest(
  root: string,
  expectedTarget: DocumentRuntimeTarget.Target,
  attestation: DocumentRuntimeAttestation.Attestation,
) {
  const verified = await loadAndVerifyManifest(root, expectedTarget, attestation.manifestSha256, true)
  if (
    !verifyProductionProfile(verified.manifest, verified.manifestSha256, attestation) ||
    !(await verifyProductionTargetBinaries(verified.root, expectedTarget))
  ) {
    throw new ManifestVerificationError("profile-mismatch")
  }
  return verified
}

export async function loadTrustedAttestation(file: string) {
  if (!path.isAbsolute(file)) throw new ManifestVerificationError("invalid-attestation")
  const info = await lstat(file).catch(() => undefined)
  if (!info?.isFile() || info.isSymbolicLink() || info.size > MaxAttestationBytes) {
    throw new ManifestVerificationError("invalid-attestation")
  }
  const bytes = await readFile(file).catch(() => undefined)
  if (!bytes || bytes.byteLength !== info.size) throw new ManifestVerificationError("invalid-attestation")
  try {
    return decodeAttestation(JSON.parse(bytes.toString("utf8")), { onExcessProperty: "error" })
  } catch {
    throw new ManifestVerificationError("invalid-attestation")
  }
}

function decode(bytes: Buffer) {
  try {
    return decodeManifest(JSON.parse(bytes.toString("utf8")))
  } catch {
    throw new ManifestVerificationError("invalid-manifest")
  }
}

async function verifyFiles(root: string, expected: ReadonlyArray<DocumentRuntimeManifest.File>) {
  const actual = await listFiles(root)
  const expectedPaths = new Set<string>(expected.map((file) => file.path))
  if (actual.length !== expected.length || actual.some((file) => !expectedPaths.has(file))) {
    throw new ManifestVerificationError("file-mismatch")
  }

  for (let offset = 0; offset < expected.length; offset += HashConcurrency) {
    await Promise.all(
      expected.slice(offset, offset + HashConcurrency).map(async (file) => {
        const absolute = path.join(root, ...file.path.split("/"))
        const info = await lstat(absolute).catch(() => undefined)
        if (
          !info?.isFile() ||
          info.isSymbolicLink() ||
          info.size !== file.bytes ||
          !matchesMode(file.path, info.mode, file.mode)
        ) {
          throw new ManifestVerificationError("file-mismatch")
        }
        if ((await hashFile(absolute)) !== file.sha256) {
          throw new ManifestVerificationError("file-mismatch")
        }
      }),
    )
  }
}

async function hashFile(file: string) {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest("hex")
}

async function listFiles(root: string) {
  const directories = [""]
  const files: string[] = []
  let entries = 0
  while (directories.length > 0) {
    const relative = directories.pop() ?? ""
    const directory = await opendir(path.join(root, ...relative.split("/").filter(Boolean)))
    for await (const entry of directory) {
      entries++
      if (entries > DocumentRuntimeManifest.MaxFiles * 2) throw new ManifestVerificationError("file-mismatch")
      const item = relative ? `${relative}/${entry.name}` : entry.name
      if (!relative && item === ManifestName) continue
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
        throw new ManifestVerificationError("file-mismatch")
      }
      if (entry.isDirectory()) directories.push(item)
      else files.push(item)
      if (files.length > DocumentRuntimeManifest.MaxFiles) throw new ManifestVerificationError("file-mismatch")
    }
  }
  return files.sort()
}

function matchesMode(file: string, actual: number, expected: DocumentRuntimeManifest.FileMode) {
  if (process.platform !== "win32") return (actual & 0o777) === expected
  return expected === (file.toLowerCase().endsWith(".exe") ? 0o755 : 0o644)
}
