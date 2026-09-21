#!/usr/bin/env bun
import {
  DocumentRuntimeAttestation,
  loadAndVerifyProductionManifest,
  loadTrustedAttestation,
} from "@koala-ai/document-runtime"
import { Schema } from "effect"
import { createHash, createPublicKey } from "node:crypto"
import { createReadStream } from "node:fs"
import { chmod, cp, lstat, mkdir, opendir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import {
  DependencyReportName,
  EvidenceDirectoryName,
  EvidenceEnvelopeName,
  IssuerPublicKeyName,
  NativeTestReportName,
  PackagedSmokeReportName,
  ReleaseIdentityName,
  SignedFileInventoryName,
  SigningReportName,
  verifyConfinementResources,
  requiredDependencyPaths,
  requiredSigningPaths,
  type ReleaseIdentity,
} from "../src/main/document-confinement"
import { hostTarget, verifySandboxRuntimeRoot, type SandboxRuntimeTarget } from "../src/main/sandbox-runtime"

const MaxReportBytes = 16 * 1024 * 1024
const targets = [
  "x86_64-apple-darwin",
  "aarch64-apple-darwin",
  "x86_64-pc-windows-msvc",
  "aarch64-pc-windows-msvc",
  "x86_64-unknown-linux-gnu",
  "aarch64-unknown-linux-gnu",
] as const

export type EvidencePaths = {
  readonly nativeTestReport: string
  readonly packagedSmokeReport: string
  readonly signingReport: string
  readonly signedFileInventory: string
  readonly dependencyReport: string
}

export function requireNativeTarget(environment: NodeJS.ProcessEnv = process.env) {
  const target = parseTarget(environment.RUST_TARGET)
  const host = hostTarget(process.platform, process.arch)
  if (!host || host !== target) {
    throw new Error(`Document confinement requires target-native execution: host=${host ?? "unsupported"} target=${target}`)
  }
  return target
}

export function releaseIdentity(environment: NodeJS.ProcessEnv = process.env) {
  return Schema.decodeUnknownSync(DocumentRuntimeAttestation.ReleaseIdentity)({
    version: required(environment, "OPENCODE_VERSION"),
    sourceCommit: required(environment, "GITHUB_SHA"),
    buildID: required(environment, "KOALA_DOCUMENT_CONFINEMENT_BUILD_ID"),
  })
}

export async function stageCandidateResources(input: {
  readonly target: SandboxRuntimeTarget
  readonly runtimeRoot: string
  readonly attestationPath: string
  readonly sandboxRuntimeRoot: string
  readonly publicKeyPath: string
  readonly stagingParent: string
  readonly destination: string
  readonly release: ReleaseIdentity
}) {
  const [runtimeRoot, attestationPath, sandboxRuntimeRoot, publicKeyPath, stagingParent] = await Promise.all([
    trustedDirectory(input.runtimeRoot),
    trustedFile(input.attestationPath),
    trustedDirectory(input.sandboxRuntimeRoot),
    trustedFile(input.publicKeyPath),
    trustedDirectory(input.stagingParent),
  ])
  const destination = path.resolve(input.destination)
  if (path.dirname(destination) !== stagingParent || (await exists(destination))) {
    throw new Error("Candidate resources must be a fresh direct child of the explicit staging parent")
  }
  if (
    overlap(runtimeRoot, sandboxRuntimeRoot) ||
    overlap(runtimeRoot, attestationPath) ||
    overlap(runtimeRoot, publicKeyPath) ||
    overlap(sandboxRuntimeRoot, attestationPath) ||
    overlap(sandboxRuntimeRoot, publicKeyPath) ||
    samePath(attestationPath, publicKeyPath)
  ) {
    throw new Error("Document confinement source inputs must be disjoint")
  }
  for (const value of [runtimeRoot, attestationPath, sandboxRuntimeRoot, publicKeyPath]) {
    if (overlap(destination, value) || overlap(stagingParent, value)) {
      throw new Error("Document confinement staging paths overlap an input")
    }
  }
  const attestation = await loadTrustedAttestation(attestationPath)
  if (attestation.target !== input.target) throw new Error("Document runtime attestation target mismatch")
  const runtime = await loadAndVerifyProductionManifest(runtimeRoot, input.target, attestation)
  await verifySandboxRuntimeRoot(sandboxRuntimeRoot, input.target)
  await verifyPublicKey(publicKeyPath)

  await mkdir(destination, { mode: 0o700 })
  const created = await identity(destination)
  try {
    const evidenceRoot = path.join(destination, EvidenceDirectoryName)
    await mkdir(evidenceRoot, { mode: 0o700 })
    await Promise.all([
      cp(runtime.root, path.join(destination, "document-runtime"), { recursive: true }),
      cp(sandboxRuntimeRoot, path.join(destination, "sandbox-runtime"), { recursive: true }),
      cp(attestationPath, path.join(destination, "document-runtime.attestation.json")),
      cp(publicKeyPath, path.join(evidenceRoot, IssuerPublicKeyName)),
    ])
    await writeFile(path.join(evidenceRoot, ReleaseIdentityName), `${JSON.stringify(input.release)}\n`, {
      flag: "wx",
      mode: 0o644,
    })
    if (process.platform !== "win32") await chmod(path.join(evidenceRoot, IssuerPublicKeyName), 0o644)
    await Promise.all([
      loadAndVerifyProductionManifest(path.join(destination, "document-runtime"), input.target, attestation),
      verifySandboxRuntimeRoot(path.join(destination, "sandbox-runtime"), input.target),
      verifyPublicKey(path.join(evidenceRoot, IssuerPublicKeyName)),
    ])
  } catch (error) {
    if (await sameIdentity(destination, created)) await rm(destination, { recursive: true, force: true })
    throw error
  }
}

export async function writeSignedFileInventory(input: {
  readonly resourcesRoot: string
  readonly target: SandboxRuntimeTarget
  readonly release: ReleaseIdentity
  readonly output: string
}) {
  const context = await resourceContext(input.resourcesRoot, input.target, input.release)
  const files = (await listFiles(context.resourcesRoot)).filter(
    (file) =>
      file.startsWith("document-runtime/") ||
      file.startsWith("sandbox-runtime/") ||
      file === `${EvidenceDirectoryName}/${IssuerPublicKeyName}` ||
      file === `${EvidenceDirectoryName}/${ReleaseIdentityName}`,
  )
  const report = Schema.decodeUnknownSync(DocumentRuntimeAttestation.SignedFileInventoryReport)({
    ...context.bindings,
    status: "passed",
    files: await Promise.all(
      files.map(async (relative) => {
        const absolute = path.join(context.resourcesRoot, ...relative.split("/"))
        const info = await lstat(absolute)
        return { path: relative, bytes: info.size, mode: mode(relative, info.mode), sha256: await hashFile(absolute) }
      }),
    ),
  })
  await writeExclusive(input.output, `${JSON.stringify(report)}\n`)
  return report
}

export async function runExternalReport(input: {
  readonly executable: string
  readonly kind: "signing" | "dependencies"
  readonly resourcesRoot: string
  readonly target: SandboxRuntimeTarget
  readonly release: ReleaseIdentity
  readonly inventoryPath: string
  readonly output: string
}) {
  const executable = await trustedFile(input.executable)
  const context = await resourceContext(input.resourcesRoot, input.target, input.release)
  const inventory = await readReport(input.inventoryPath, DocumentRuntimeAttestation.SignedFileInventoryReport)
  assertInventoryBindings(inventory, context.bindings)
  const inventorySha256 = await hashReport(input.inventoryPath)
  if (await Bun.file(input.output).exists()) throw new Error(`Document confinement ${input.kind} report already exists`)
  await mkdir(path.dirname(input.output), { recursive: true })
  const args = [
    input.kind,
    "--target",
    input.target,
    "--resources",
    context.resourcesRoot,
    "--runtime-manifest-sha256",
    context.bindings.runtimeManifestSha256,
    "--runtime-attestation-sha256",
    context.bindings.runtimeAttestationSha256,
    "--proxy-sha256",
    context.bindings.proxySha256,
    "--sandbox-runtime-manifest-sha256",
    context.bindings.sandboxRuntimeManifestSha256,
    "--policy-version",
    String(context.bindings.policyVersion),
    "--release-version",
    input.release.version,
    "--source-commit",
    input.release.sourceCommit,
    "--build-id",
    input.release.buildID,
    "--inventory",
    await trustedFile(input.inventoryPath),
    "--inventory-sha256",
    inventorySha256,
    "--output",
    input.output,
  ]
  const child = Bun.spawn([executable, ...args], {
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
    cwd: context.resourcesRoot,
  })
  if ((await child.exited) !== 0) throw new Error(`Document confinement ${input.kind} reporter failed`)
  if (input.kind === "signing") {
    const report = await readReport(input.output, DocumentRuntimeAttestation.SigningReport)
    assertReportBindings(report, context.bindings, inventorySha256)
    assertExactPaths(report.files, requiredSigningPaths(inventory.files, input.target), input.kind)
    return report
  }
  const report = await readReport(input.output, DocumentRuntimeAttestation.DependencyReport)
  assertReportBindings(report, context.bindings, inventorySha256)
  assertExactPaths(report.entries, requiredDependencyPaths(inventory.files, input.target), input.kind)
  if (
    report.entries.some(
      (entry) => entry.architecture !== (input.target.startsWith("x86_64-") ? "x86_64" : "aarch64"),
    )
  ) {
    throw new Error("Document confinement dependency report architecture mismatch")
  }
  return report
}

function assertExactPaths(
  entries: ReadonlyArray<{ readonly path: string }>,
  requiredPaths: ReadonlyArray<string>,
  kind: "signing" | "dependencies",
) {
  if (entries.length !== requiredPaths.length || entries.some((entry, index) => entry.path !== requiredPaths[index])) {
    throw new Error(`Document confinement ${kind} report does not cover the exact required file set`)
  }
}

export async function buildIssuanceSubject(input: {
  readonly resourcesRoot: string
  readonly target: SandboxRuntimeTarget
  readonly release: ReleaseIdentity
  readonly reports: EvidencePaths
}) {
  const context = await resourceContext(input.resourcesRoot, input.target, input.release)
  const [inventory, native, smoke, signing, dependencies] = await Promise.all([
    readReport(input.reports.signedFileInventory, DocumentRuntimeAttestation.SignedFileInventoryReport),
    readReport(input.reports.nativeTestReport, DocumentRuntimeAttestation.NativeTestReport),
    readReport(input.reports.packagedSmokeReport, DocumentRuntimeAttestation.PackagedSmokeReport),
    readReport(input.reports.signingReport, DocumentRuntimeAttestation.SigningReport),
    readReport(input.reports.dependencyReport, DocumentRuntimeAttestation.DependencyReport),
  ])
  assertInventoryBindings(inventory, context.bindings)
  const inventorySha256 = await hashReport(input.reports.signedFileInventory)
  for (const report of [native, smoke, signing, dependencies]) {
    assertReportBindings(report, context.bindings, inventorySha256)
  }
  return Schema.decodeUnknownSync(DocumentRuntimeAttestation.ConfinementEvidenceSubject)({
    evidenceVersion: 3,
    target: input.target,
    runtimeManifestSha256: context.bindings.runtimeManifestSha256,
    runtimeAttestationSha256: context.bindings.runtimeAttestationSha256,
    proxySha256: context.bindings.proxySha256,
    sandboxRuntimeManifestSha256: context.bindings.sandboxRuntimeManifestSha256,
    srtVersion: "0.0.76",
    policyVersion: 1,
    release: input.release,
    nativeTestReportSha256: await hashReport(input.reports.nativeTestReport),
    packagedSmokeReportSha256: await hashReport(input.reports.packagedSmokeReport),
    signingReportSha256: await hashReport(input.reports.signingReport),
    signedFileInventorySha256: inventorySha256,
    dependencyReportSha256: await hashReport(input.reports.dependencyReport),
    issuerKeyID: context.issuerKeyID,
  })
}

export async function writeIssuanceRequest(
  input: Parameters<typeof buildIssuanceSubject>[0],
  output: string,
) {
  const subject = await buildIssuanceSubject(input)
  await writeExclusive(output, DocumentRuntimeAttestation.confinementEvidenceSubject(subject))
  return subject
}

export async function issueEvidence(input: {
  readonly issuerExecutable: string
  readonly request: string
  readonly publicKey: string
  readonly runtimeAttestation: string
  readonly resourcesRoot: string
  readonly reports: EvidencePaths
  readonly outputEnvelope: string
}) {
  const files = await Promise.all([
    trustedFile(input.issuerExecutable),
    trustedFile(input.request),
    trustedFile(input.publicKey),
    trustedFile(input.runtimeAttestation),
    trustedFile(input.reports.nativeTestReport),
    trustedFile(input.reports.packagedSmokeReport),
    trustedFile(input.reports.signingReport),
    trustedFile(input.reports.signedFileInventory),
    trustedFile(input.reports.dependencyReport),
  ])
  if (await Bun.file(input.outputEnvelope).exists()) throw new Error("Confinement envelope output already exists")
  const child = Bun.spawn(
    [
      files[0],
      "issue-document-confinement",
      "--request",
      files[1],
      "--public-key",
      files[2],
      "--native-report",
      files[4],
      "--smoke-report",
      files[5],
      "--signing-report",
      files[6],
      "--inventory",
      files[7],
      "--dependency-report",
      files[8],
      "--runtime-attestation",
      files[3],
      "--resources",
      await trustedDirectory(input.resourcesRoot),
      "--output",
      input.outputEnvelope,
    ],
    { stdin: "ignore", stdout: "inherit", stderr: "inherit", env: process.env, cwd: path.dirname(files[1]) },
  )
  if ((await child.exited) !== 0) throw new Error("Independent document confinement issuer failed")
  await readReport(input.outputEnvelope, DocumentRuntimeAttestation.ConfinementEvidenceEnvelope)
}

export async function verifyIssuedEvidence(input: {
  readonly resourcesRoot: string
  readonly target: SandboxRuntimeTarget
  readonly release: ReleaseIdentity
}) {
  const context = await resourceContext(input.resourcesRoot, input.target, input.release)
  return verifyConfinementResources({
    resourcesRoot: context.resourcesRoot,
    target: input.target,
    runtimeManifestSha256: context.bindings.runtimeManifestSha256,
    sandboxRuntime: context.sandbox,
    release: input.release,
  })
}

export async function verifyCandidateResources(input: {
  readonly resourcesRoot: string
  readonly target: SandboxRuntimeTarget
  readonly release: ReleaseIdentity
}) {
  const context = await resourceContext(input.resourcesRoot, input.target, input.release)
  const reports = reportPaths(context.resourcesRoot)
  if (
    (await Bun.file(path.join(context.resourcesRoot, EvidenceDirectoryName, EvidenceEnvelopeName)).exists()) ||
    (await Bun.file(reports.packagedSmokeReport).exists())
  ) {
    throw new Error("Candidate resources must not contain issued evidence or smoke results")
  }
  const [inventory, native, signing, dependencies] = await Promise.all([
    readReport(reports.signedFileInventory, DocumentRuntimeAttestation.SignedFileInventoryReport),
    readReport(reports.nativeTestReport, DocumentRuntimeAttestation.NativeTestReport),
    readReport(reports.signingReport, DocumentRuntimeAttestation.SigningReport),
    readReport(reports.dependencyReport, DocumentRuntimeAttestation.DependencyReport),
  ])
  assertInventoryBindings(inventory, context.bindings)
  const inventorySha256 = await hashReport(reports.signedFileInventory)
  for (const report of [native, signing, dependencies]) assertReportBindings(report, context.bindings, inventorySha256)
  return {
    resourcesRoot: context.resourcesRoot,
    root: path.join(context.resourcesRoot, "document-runtime"),
    attestation: path.join(context.resourcesRoot, "document-runtime.attestation.json"),
    evidenceRoot: path.join(context.resourcesRoot, EvidenceDirectoryName),
    sandboxRoot: path.join(context.resourcesRoot, "sandbox-runtime"),
  }
}

export async function resourceContext(resourcesRoot: string, target: SandboxRuntimeTarget, release: ReleaseIdentity) {
  const root = await trustedDirectory(resourcesRoot)
  const attestationPath = await trustedFile(path.join(root, "document-runtime.attestation.json"))
  const attestationBytes = await readFile(attestationPath)
  const attestation = await loadTrustedAttestation(attestationPath)
  const packagedRelease = await readReport(
    path.join(root, EvidenceDirectoryName, ReleaseIdentityName),
    DocumentRuntimeAttestation.ReleaseIdentity,
  )
  if (JSON.stringify(packagedRelease) !== JSON.stringify(release)) {
    throw new Error("Document confinement release identity mismatch")
  }
  if (attestation.target !== target) throw new Error("Document runtime attestation target mismatch")
  const [runtime, sandbox, publicKey] = await Promise.all([
    loadAndVerifyProductionManifest(path.join(root, "document-runtime"), target, attestation),
    verifySandboxRuntimeRoot(path.join(root, "sandbox-runtime"), target),
    verifyPublicKey(path.join(root, EvidenceDirectoryName, IssuerPublicKeyName)),
  ])
  return {
    resourcesRoot: root,
    sandbox,
    issuerKeyID: publicKey.keyID,
    bindings: {
      reportVersion: 1 as const,
      target,
      runtimeManifestSha256: runtime.manifestSha256,
      runtimeAttestationSha256: sha256(attestationBytes),
      proxySha256: sandbox.documentProxySha256,
      sandboxRuntimeManifestSha256: sandbox.manifestSha256,
      policyVersion: 1 as const,
      release,
    },
  }
}

export async function verifyPublicKey(file: string) {
  const canonical = await trustedFile(file)
  const bytes = await readFile(canonical)
  if (bytes.byteLength > 16 * 1024) throw new Error("Document confinement issuer key is too large")
  const key = createPublicKey({ key: bytes, format: "der", type: "spki" })
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Document confinement issuer key must be Ed25519")
  return { path: canonical, keyID: sha256(bytes) }
}

export async function readReport<A>(file: string, schema: Schema.Decoder<A>) {
  const bytes = await readFile(await trustedFile(file))
  if (bytes.byteLength > MaxReportBytes) throw new Error("Document confinement report is too large")
  try {
    return Schema.decodeUnknownSync(schema)(JSON.parse(bytes.toString("utf8")), { onExcessProperty: "error" })
  } catch {
    throw new Error("Invalid typed document confinement report")
  }
}

function assertInventoryBindings(
  report: DocumentRuntimeAttestation.SignedFileInventoryReport,
  bindings: DocumentRuntimeAttestation.EvidenceBindings,
) {
  if (!sameBindings(report, bindings) || report.status !== "passed") {
    throw new Error("Signed-file inventory bindings do not match release resources")
  }
}

function assertReportBindings(
  report:
    | DocumentRuntimeAttestation.NativeTestReport
    | DocumentRuntimeAttestation.PackagedSmokeReport
    | DocumentRuntimeAttestation.SigningReport
    | DocumentRuntimeAttestation.DependencyReport,
  bindings: DocumentRuntimeAttestation.EvidenceBindings,
  inventorySha256: string,
) {
  if (!sameBindings(report, bindings) || report.signedFileInventorySha256 !== inventorySha256 || report.status !== "passed") {
    throw new Error("Document confinement report bindings do not match release resources")
  }
}

function sameBindings(left: DocumentRuntimeAttestation.EvidenceBindings, right: DocumentRuntimeAttestation.EvidenceBindings) {
  return (
    left.reportVersion === right.reportVersion &&
    left.target === right.target &&
    left.runtimeManifestSha256 === right.runtimeManifestSha256 &&
    left.runtimeAttestationSha256 === right.runtimeAttestationSha256 &&
    left.proxySha256 === right.proxySha256 &&
    left.sandboxRuntimeManifestSha256 === right.sandboxRuntimeManifestSha256 &&
    left.policyVersion === right.policyVersion &&
    left.release.version === right.release.version &&
    left.release.sourceCommit === right.release.sourceCommit &&
    left.release.buildID === right.release.buildID
  )
}

function reportPaths(resourcesRoot: string): EvidencePaths {
  const root = path.join(resourcesRoot, EvidenceDirectoryName)
  return {
    nativeTestReport: path.join(root, NativeTestReportName),
    packagedSmokeReport: path.join(root, PackagedSmokeReportName),
    signingReport: path.join(root, SigningReportName),
    signedFileInventory: path.join(root, SignedFileInventoryName),
    dependencyReport: path.join(root, DependencyReportName),
  }
}

async function hashReport(file: string) {
  const canonical = await trustedFile(file)
  const info = await lstat(canonical)
  if (info.size < 1 || info.size > MaxReportBytes) throw new Error("Invalid document confinement report size")
  return hashFile(canonical)
}

async function hashFile(file: string) {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest("hex")
}

async function trustedFile(value: string) {
  if (!path.isAbsolute(value)) throw new Error("Trusted evidence paths must be absolute")
  const info = await lstat(value)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Trusted evidence input must be a regular file")
  const canonical = await realpath(value)
  if (!samePath(canonical, path.normalize(value))) throw new Error("Trusted evidence input must be canonical")
  return canonical
}

async function trustedDirectory(value: string) {
  if (!path.isAbsolute(value)) throw new Error("Trusted resource paths must be absolute")
  const info = await lstat(value)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Trusted resource input must be a directory")
  const canonical = await realpath(value)
  if (!samePath(canonical, path.normalize(value))) throw new Error("Trusted resource input must be canonical")
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

async function listFiles(root: string) {
  const pending = [""]
  const files: string[] = []
  while (pending.length > 0) {
    const relative = pending.pop() ?? ""
    const directory = await opendir(path.join(root, ...relative.split("/").filter(Boolean)))
    for await (const entry of directory) {
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
        throw new Error("Package inventory contains a link or special file")
      }
      const child = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) pending.push(child)
      else files.push(child)
    }
  }
  return files.sort()
}

async function writeExclusive(file: string, body: string) {
  if (!path.isAbsolute(file)) throw new Error("Evidence output path must be absolute")
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, body, { flag: "wx", mode: 0o600 })
}

function overlap(left: string, right: string) {
  const relation = path.relative(left, right)
  const reverse = path.relative(right, left)
  return relation === "" || inside(relation) || inside(reverse)
}

function inside(relation: string) {
  return relation !== ".." && !relation.startsWith(`..${path.sep}`) && !path.isAbsolute(relation)
}

function parseTarget(value: unknown): SandboxRuntimeTarget {
  if (typeof value === "string" && targets.some((target) => target === value)) return value as SandboxRuntimeTarget
  throw new Error("RUST_TARGET must identify a supported document runtime target")
}

function mode(file: string, value: number) {
  if (process.platform !== "win32") return value & 0o777
  return file.toLowerCase().endsWith(".exe") ? 0o755 : 0o644
}

function required(environment: NodeJS.ProcessEnv, key: string) {
  const value = environment[key]
  if (!value) throw new Error(`${key} is required`)
  return value
}

function samePath(left: string, right: string) {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex")
}

if (import.meta.main) {
  const mode = process.argv[2]
  const target = requireNativeTarget()
  const release = releaseIdentity()
  const resourcesRoot = required(process.env, "KOALA_DOCUMENT_CONFINEMENT_RESOURCES_ROOT")
  const reports = reportPaths(resourcesRoot)
  if (mode === "check-host") {
    // Parsing the target and release identity above is the check.
  } else if (mode === "stage") {
    await stageCandidateResources({
      target,
      runtimeRoot: required(process.env, "KOALA_DOCUMENT_RUNTIME_RELEASE_ROOT"),
      attestationPath: required(process.env, "KOALA_DOCUMENT_RUNTIME_BASE_ATTESTATION"),
      sandboxRuntimeRoot: required(process.env, "KOALA_DOCUMENT_RUNTIME_PROXY_ASSETS_ROOT"),
      publicKeyPath: required(process.env, "KOALA_DOCUMENT_CONFINEMENT_ISSUER_PUBLIC_KEY"),
      stagingParent: required(process.env, "KOALA_DOCUMENT_CONFINEMENT_STAGING_PARENT"),
      destination: resourcesRoot,
      release,
    })
  } else if (mode === "inventory") {
    await writeSignedFileInventory({ resourcesRoot, target, release, output: reports.signedFileInventory })
  } else if (mode === "external-reports") {
    await runExternalReport({
      executable: required(process.env, "KOALA_DOCUMENT_CONFINEMENT_SIGNING_REPORTER"),
      kind: "signing",
      resourcesRoot,
      target,
      release,
      inventoryPath: reports.signedFileInventory,
      output: reports.signingReport,
    })
    await runExternalReport({
      executable: required(process.env, "KOALA_DOCUMENT_CONFINEMENT_DEPENDENCY_REPORTER"),
      kind: "dependencies",
      resourcesRoot,
      target,
      release,
      inventoryPath: reports.signedFileInventory,
      output: reports.dependencyReport,
    })
  } else if (mode === "request") {
    await writeIssuanceRequest(
      { resourcesRoot, target, release, reports },
      required(process.env, "KOALA_DOCUMENT_CONFINEMENT_REQUEST"),
    )
  } else if (mode === "issue") {
    await issueEvidence({
      issuerExecutable: required(process.env, "KOALA_DOCUMENT_CONFINEMENT_ISSUER"),
      request: required(process.env, "KOALA_DOCUMENT_CONFINEMENT_REQUEST"),
      publicKey: path.join(resourcesRoot, EvidenceDirectoryName, IssuerPublicKeyName),
      runtimeAttestation: path.join(resourcesRoot, "document-runtime.attestation.json"),
      resourcesRoot,
      reports,
      outputEnvelope: path.join(resourcesRoot, EvidenceDirectoryName, EvidenceEnvelopeName),
    })
  } else if (mode === "verify") {
    await verifyIssuedEvidence({ resourcesRoot, target, release })
  } else if (mode === "verify-candidate") {
    console.log(JSON.stringify(await verifyCandidateResources({ resourcesRoot, target, release })))
  } else {
    throw new Error("Expected check-host, stage, inventory, external-reports, request, issue, verify-candidate, or verify")
  }
}
