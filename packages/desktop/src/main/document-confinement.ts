import { DocumentRuntimeAttestation, type DocumentRuntimeManifest } from "@koala-ai/document-runtime"
import { Schema } from "effect"
import { createHash, createPublicKey, verify } from "node:crypto"
import { createReadStream } from "node:fs"
import { lstat, opendir, readFile, realpath } from "node:fs/promises"
import path from "node:path"
import type { ResolvedSandboxRuntime, SandboxRuntimeTarget } from "./sandbox-runtime"

export const EvidenceDirectoryName = "document-confinement-evidence"
export const EvidenceEnvelopeName = "evidence.json"
export const IssuerPublicKeyName = "issuer-public-key.spki.der"
export const NativeTestReportName = "native-report.json"
export const PackagedSmokeReportName = "smoke-report.json"
export const SigningReportName = "signing-report.json"
export const SignedFileInventoryName = "signed-file-inventory.json"
export const DependencyReportName = "dependency-report.json"
export const ReleaseIdentityName = "release-identity.json"

const MaxJsonBytes = 16 * 1024 * 1024
const MaxPublicKeyBytes = 16 * 1024
const evidenceFiles = [
  EvidenceEnvelopeName,
  IssuerPublicKeyName,
  NativeTestReportName,
  PackagedSmokeReportName,
  SigningReportName,
  SignedFileInventoryName,
  DependencyReportName,
  ReleaseIdentityName,
] as const

export type ReleaseIdentity = DocumentRuntimeAttestation.ReleaseIdentity

export async function verifyConfinementResources(input: {
  readonly resourcesRoot: string
  readonly target: SandboxRuntimeTarget
  readonly runtimeManifestSha256: string
  readonly sandboxRuntime: ResolvedSandboxRuntime
  readonly release?: ReleaseIdentity
  readonly releaseVersion?: string
}) {
  const resourcesRoot = await canonicalDirectory(input.resourcesRoot)
  const evidenceRoot = await canonicalDirectory(path.join(resourcesRoot, EvidenceDirectoryName))
  if (!inside(resourcesRoot, evidenceRoot)) throw new Error("Document confinement evidence escaped resources")
  const entries = await listFiles(evidenceRoot)
  const expectedEvidence = new Set<string>(evidenceFiles)
  if (entries.length !== expectedEvidence.size || entries.some((file) => !expectedEvidence.has(file))) {
    throw new Error("Document confinement evidence inventory mismatch")
  }

  const [attestationBytes, publicKeyDer, releaseIdentity, envelope, native, smoke, signing, inventory, dependencies] =
    await Promise.all([
      readTrustedFile(path.join(resourcesRoot, "document-runtime.attestation.json"), MaxJsonBytes),
      readTrustedFile(path.join(evidenceRoot, IssuerPublicKeyName), MaxPublicKeyBytes),
      readJson(path.join(evidenceRoot, ReleaseIdentityName), DocumentRuntimeAttestation.ReleaseIdentity),
      readJson(path.join(evidenceRoot, EvidenceEnvelopeName), DocumentRuntimeAttestation.ConfinementEvidenceEnvelope),
      readJson(path.join(evidenceRoot, NativeTestReportName), DocumentRuntimeAttestation.NativeTestReport),
      readJson(path.join(evidenceRoot, PackagedSmokeReportName), DocumentRuntimeAttestation.PackagedSmokeReport),
      readJson(path.join(evidenceRoot, SigningReportName), DocumentRuntimeAttestation.SigningReport),
      readJson(path.join(evidenceRoot, SignedFileInventoryName), DocumentRuntimeAttestation.SignedFileInventoryReport),
      readJson(path.join(evidenceRoot, DependencyReportName), DocumentRuntimeAttestation.DependencyReport),
    ])

  const keyID = sha256(publicKeyDer)
  if (envelope.keyID !== keyID || envelope.subject.issuerKeyID !== keyID) {
    throw new Error("Document confinement issuer key mismatch")
  }
  const publicKey = createPublicKey({ key: publicKeyDer, format: "der", type: "spki" })
  if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("Document confinement issuer key must be Ed25519")
  if (
    !verify(
      null,
      Buffer.from(DocumentRuntimeAttestation.confinementEvidenceSubject(envelope.subject)),
      publicKey,
      Buffer.from(envelope.signature, "base64"),
    )
  ) {
    throw new Error("Document confinement evidence signature is invalid")
  }

  const subject = envelope.subject
  if (
    subject.target !== input.target ||
    subject.runtimeManifestSha256 !== input.runtimeManifestSha256 ||
    subject.runtimeAttestationSha256 !== sha256(attestationBytes) ||
    subject.proxySha256 !== input.sandboxRuntime.documentProxySha256 ||
    subject.sandboxRuntimeManifestSha256 !== input.sandboxRuntime.manifestSha256 ||
    subject.policyVersion !== 1 ||
    !sameRelease(subject.release, releaseIdentity) ||
    (input.release && !sameRelease(subject.release, input.release)) ||
    (input.releaseVersion !== undefined && subject.release.version !== input.releaseVersion)
  ) {
    throw new Error("Document confinement signed subject does not match packaged resources")
  }

  const reportDigests = {
    nativeTestReportSha256: await hashFile(path.join(evidenceRoot, NativeTestReportName)),
    packagedSmokeReportSha256: await hashFile(path.join(evidenceRoot, PackagedSmokeReportName)),
    signingReportSha256: await hashFile(path.join(evidenceRoot, SigningReportName)),
    signedFileInventorySha256: await hashFile(path.join(evidenceRoot, SignedFileInventoryName)),
    dependencyReportSha256: await hashFile(path.join(evidenceRoot, DependencyReportName)),
  }
  if (Object.entries(reportDigests).some(([key, value]) => subject[key as keyof typeof reportDigests] !== value)) {
    throw new Error("Document confinement report digest mismatch")
  }

  verifyReportBindings(native, subject, reportDigests.signedFileInventorySha256)
  verifyReportBindings(smoke, subject, reportDigests.signedFileInventorySha256)
  verifyReportBindings(signing, subject, reportDigests.signedFileInventorySha256)
  verifyReportBindings(dependencies, subject, reportDigests.signedFileInventorySha256)
  verifyInventoryBindings(inventory, subject)
  if (smoke.installedRuntimeAttestationSha256 !== subject.runtimeAttestationSha256) {
    throw new Error("Packaged smoke attestation digest mismatch")
  }
  await verifySignedFileInventory(resourcesRoot, inventory.files)
  verifyReportedFiles(signing.files, inventory.files, requiredSigningPaths(inventory.files, input.target))
  verifyReportedFiles(dependencies.entries, inventory.files, requiredDependencyPaths(inventory.files, input.target))
  const architecture = input.target.startsWith("x86_64-") ? "x86_64" : "aarch64"
  if (dependencies.entries.some((entry) => entry.architecture !== architecture)) {
    throw new Error("Document confinement dependency architecture mismatch")
  }
  return { envelope, keyID, release: subject.release }
}

function verifyReportBindings(
  report:
    | DocumentRuntimeAttestation.NativeTestReport
    | DocumentRuntimeAttestation.PackagedSmokeReport
    | DocumentRuntimeAttestation.SigningReport
    | DocumentRuntimeAttestation.DependencyReport,
  subject: DocumentRuntimeAttestation.ConfinementEvidenceSubject,
  inventorySha256: string,
) {
  if (
    report.target !== subject.target ||
    report.runtimeManifestSha256 !== subject.runtimeManifestSha256 ||
    report.runtimeAttestationSha256 !== subject.runtimeAttestationSha256 ||
    report.proxySha256 !== subject.proxySha256 ||
    report.sandboxRuntimeManifestSha256 !== subject.sandboxRuntimeManifestSha256 ||
    report.policyVersion !== subject.policyVersion ||
    !sameRelease(report.release, subject.release) ||
    report.signedFileInventorySha256 !== inventorySha256 ||
    report.status !== "passed"
  ) {
    throw new Error("Document confinement report bindings do not match the signed subject")
  }
}

function verifyInventoryBindings(
  report: DocumentRuntimeAttestation.SignedFileInventoryReport,
  subject: DocumentRuntimeAttestation.ConfinementEvidenceSubject,
) {
  if (
    report.target !== subject.target ||
    report.runtimeManifestSha256 !== subject.runtimeManifestSha256 ||
    report.runtimeAttestationSha256 !== subject.runtimeAttestationSha256 ||
    report.proxySha256 !== subject.proxySha256 ||
    report.sandboxRuntimeManifestSha256 !== subject.sandboxRuntimeManifestSha256 ||
    report.policyVersion !== subject.policyVersion ||
    !sameRelease(report.release, subject.release) ||
    report.status !== "passed"
  ) {
    throw new Error("Document confinement inventory bindings do not match the signed subject")
  }
}

export async function verifySignedFileInventory(
  root: string,
  expected: ReadonlyArray<{
    readonly path: DocumentRuntimeManifest.RelativePath
    readonly sha256: DocumentRuntimeManifest.Digest
    readonly bytes: number
    readonly mode: DocumentRuntimeManifest.FileMode
  }>,
) {
  const actual = [
    ...(await listFiles(path.join(root, "document-runtime"))).map((file) => `document-runtime/${file}`),
    ...(await listFiles(path.join(root, "sandbox-runtime"))).map((file) => `sandbox-runtime/${file}`),
    `${EvidenceDirectoryName}/${IssuerPublicKeyName}`,
    `${EvidenceDirectoryName}/${ReleaseIdentityName}`,
  ].sort()
  if (
    actual.length !== expected.length ||
    new Set(expected.map((file) => file.path)).size !== expected.length ||
    expected.some((file, index) => file.path !== actual[index])
  ) {
    throw new Error("Document confinement signed-file inventory is not exact")
  }
  await Promise.all(
    expected.map(async (file) => {
      const absolute = path.join(root, ...file.path.split("/"))
      const info = await lstat(absolute)
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size !== file.bytes ||
        (process.platform !== "win32" && (info.mode & 0o777) !== file.mode) ||
        (await hashFile(absolute)) !== file.sha256
      ) {
        throw new Error("Document confinement signed-file mismatch")
      }
    }),
  )
}

function verifyReportedFiles(
  reported: ReadonlyArray<{ readonly path: string; readonly sha256: string }>,
  inventory: ReadonlyArray<{ readonly path: string; readonly sha256: string }>,
  required: ReadonlyArray<string>,
) {
  const paths = reported.map((file) => file.path)
  if (
    new Set(paths).size !== paths.length ||
    paths.length !== required.length ||
    paths.some((file, index) => file !== required[index])
  ) {
    throw new Error("Document confinement report contains duplicate files")
  }
  if (
    reported.some((file) => !inventory.some((entry) => entry.path === file.path && entry.sha256 === file.sha256))
  ) {
    throw new Error("Document confinement report references a file outside the signed inventory")
  }
}

export function requiredSigningPaths(
  inventory: ReadonlyArray<{ readonly path: string; readonly mode: number }>,
  target: SandboxRuntimeTarget,
) {
  return inventory
    .filter((file) => {
      const lower = file.path.toLowerCase()
      if (target.includes("windows")) return lower.endsWith(".exe") || lower.endsWith(".dll") || lower.endsWith(".node")
      if (target.includes("apple")) return file.mode === 0o755 || lower.endsWith(".dylib") || lower.endsWith(".node")
      return file.mode === 0o755 || lower.endsWith(".so") || lower.includes(".so.") || lower.endsWith(".node")
    })
    .map((file) => file.path)
    .sort()
}

export function requiredDependencyPaths(
  inventory: ReadonlyArray<{ readonly path: string; readonly mode: number }>,
  target: SandboxRuntimeTarget,
) {
  return requiredSigningPaths(inventory, target)
}

async function readJson<A>(file: string, schema: Schema.Decoder<A>) {
  const bytes = await readTrustedFile(file, MaxJsonBytes)
  try {
    return Schema.decodeUnknownSync(schema)(JSON.parse(bytes.toString("utf8")), { onExcessProperty: "error" })
  } catch {
    throw new Error("Invalid document confinement evidence file")
  }
}

async function readTrustedFile(file: string, maximumBytes: number) {
  const info = await lstat(file)
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > maximumBytes) {
    throw new Error("Invalid document confinement evidence file")
  }
  const canonical = await realpath(file)
  if (!samePath(canonical, path.normalize(file))) throw new Error("Document confinement evidence path is not canonical")
  const bytes = await readFile(canonical)
  if (bytes.byteLength !== info.size) throw new Error("Document confinement evidence file changed during read")
  return bytes
}

async function canonicalDirectory(value: string) {
  if (!path.isAbsolute(value)) throw new Error("Document confinement resource root must be absolute")
  const info = await lstat(value)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Invalid document confinement resource root")
  const canonical = await realpath(value)
  if (!samePath(canonical, path.normalize(value))) throw new Error("Document confinement resource root is not canonical")
  return canonical
}

async function listFiles(root: string) {
  const pending = [""]
  const files: string[] = []
  while (pending.length > 0) {
    const relative = pending.pop() ?? ""
    const directory = await opendir(path.join(root, ...relative.split("/").filter(Boolean)))
    for await (const entry of directory) {
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
        throw new Error("Document confinement resources contain a link or special file")
      }
      const child = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) pending.push(child)
      else files.push(child)
    }
  }
  return files.sort()
}

async function hashFile(file: string) {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest("hex")
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex")
}

function sameRelease(left: ReleaseIdentity, right: ReleaseIdentity) {
  return left.version === right.version && left.sourceCommit === right.sourceCommit && left.buildID === right.buildID
}

function samePath(left: string, right: string) {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right
}

function inside(root: string, value: string) {
  const relation = path.relative(root, value)
  return relation !== "" && relation !== ".." && !relation.startsWith(`..${path.sep}`) && !path.isAbsolute(relation)
}
