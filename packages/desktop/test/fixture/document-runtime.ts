import type { DocumentRuntimeTarget } from "@koala-ai/core/document-runtime/target"
import {
  DocumentRuntimeAttestation,
  DocumentRuntimeManifest,
  runtimeNativeBinary,
  runtimeNativePackage,
} from "@koala-ai/document-runtime"
import { Schema } from "effect"
import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { chmod, lstat, mkdir, opendir, readFile, writeFile } from "node:fs/promises"
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
  requiredDependencyPaths,
  requiredSigningPaths,
  type ReleaseIdentity,
} from "../../src/main/document-confinement"

const TessdataRevision = "87416418657359cb625c412a48b6e1d6d41c29bd"

export async function productionRuntimeFixture(
  root: string,
  target: DocumentRuntimeTarget.Target,
  attestationPath: string,
  releaseReady = true,
  smokeEvidence = false,
) {
  const nativePackage = runtimeNativePackage(target)
  const components = [
    component("document-runtime", "0.1.0", `git-${"1".repeat(40)}`),
    component("pdfjs-dist", "6.3.289", "npm-6.3.289"),
    component("@napi-rs/canvas", "1.0.9", "npm-1.0.9"),
    component(nativePackage, "1.0.9", "npm-1.0.9"),
    component("tesseract", "5.5.3", "v5.5.3"),
    component("leptonica", "1.87.0", "1.87.0"),
    component("tessdata-fast-eng", TessdataRevision, TessdataRevision),
    component("tessdata-fast-osd", TessdataRevision, TessdataRevision),
  ]
  const required = [
    ["package.json", "document-runtime", 0o644],
    ["worker/bootstrap.js", "document-runtime", 0o644],
    ["worker/worker.js", "document-runtime", 0o644],
    ["node_modules/pdfjs-dist/legacy/build/pdf.mjs", "pdfjs-dist", 0o644],
    ["node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs", "pdfjs-dist", 0o644],
    ["node_modules/pdfjs-dist/LICENSE", "pdfjs-dist", 0o644],
    ["node_modules/pdfjs-dist/package.json", "pdfjs-dist", 0o644],
    ["node_modules/pdfjs-dist/cmaps/fixture.bcmap", "pdfjs-dist", 0o644],
    ["node_modules/pdfjs-dist/iccs/fixture.icc", "pdfjs-dist", 0o644],
    ["node_modules/pdfjs-dist/standard_fonts/fixture.pfb", "pdfjs-dist", 0o644],
    ["node_modules/pdfjs-dist/wasm/fixture.wasm", "pdfjs-dist", 0o644],
    ["node_modules/@napi-rs/canvas/LICENSE", "@napi-rs/canvas", 0o644],
    ["node_modules/@napi-rs/canvas/geometry.js", "@napi-rs/canvas", 0o644],
    ["node_modules/@napi-rs/canvas/index.js", "@napi-rs/canvas", 0o644],
    ["node_modules/@napi-rs/canvas/js-binding.js", "@napi-rs/canvas", 0o644],
    ["node_modules/@napi-rs/canvas/load-image.js", "@napi-rs/canvas", 0o644],
    ["node_modules/@napi-rs/canvas/node-canvas.js", "@napi-rs/canvas", 0o644],
    ["node_modules/@napi-rs/canvas/package.json", "@napi-rs/canvas", 0o644],
    [`node_modules/${nativePackage}/package.json`, nativePackage, 0o644],
    [`node_modules/${nativePackage}/${runtimeNativeBinary(target)}`, nativePackage, 0o644],
    ...(target.includes("windows")
      ? ([[`node_modules/${nativePackage}/icudtl.dat`, nativePackage, 0o644]] as const)
      : []),
    [target.includes("windows") ? "bin/tesseract.exe" : "bin/tesseract", "tesseract", 0o755],
    ["tessdata/eng.traineddata", "tessdata-fast-eng", 0o644],
    ["tessdata/osd.traineddata", "tessdata-fast-osd", 0o644],
  ] as const
  const entries = [
    ...required,
    ...components.map((value) => [value.licenseFiles[0], value.name, 0o644] as const),
  ]
  for (const [file, , mode] of entries) {
    const absolute = path.join(root, ...file.split("/"))
    await mkdir(path.dirname(absolute), { recursive: true })
    await writeFile(
      absolute,
      mode === 0o755 || file.endsWith(".node")
        ? binaryHeader(target)
        : file === "package.json"
          ? '{"type":"module"}\n'
          : `fixture:${file}`,
      { mode },
    )
    await chmod(absolute, mode)
  }
  const files = await Promise.all(
    entries.map(async ([file, owner, mode]) => {
      const body = await readFile(path.join(root, ...file.split("/")))
      return {
        path: file,
        component: owner,
        sha256: createHash("sha256").update(body).digest("hex"),
        bytes: body.byteLength,
        mode,
      }
    }),
  )
  const dependencies = [
    dependency("pdfjs-dist", "6.3.289", "document-runtime", "javascript"),
    dependency("@napi-rs/canvas", "1.0.9", "document-runtime", "javascript"),
    dependency(nativePackage, "1.0.9", "@napi-rs/canvas", "dynamic"),
    dependency("tesseract", "5.5.3", "document-runtime", "dynamic"),
    dependency("leptonica", "1.87.0", "tesseract", "static"),
    dependency("tessdata-fast-eng", TessdataRevision, "tesseract", "data"),
    dependency("tessdata-fast-osd", TessdataRevision, "tesseract", "data"),
  ]
  const manifest = Schema.decodeUnknownSync(DocumentRuntimeManifest.Manifest)({
    manifestVersion: 1,
    protocolVersion: 1,
    releaseReady,
    runtimeVersion: "0.1.0",
    target,
    architecture: target.startsWith("aarch64-") ? "aarch64" : "x86_64",
    components,
    files,
    dependencies,
  })
  const body = `${JSON.stringify(manifest, null, 2)}\n`
  await writeFile(path.join(root, "manifest.json"), body)
  const attestation = Schema.decodeUnknownSync(DocumentRuntimeAttestation.Attestation)({
    attestationVersion: 1,
    profileVersion: 1,
    target,
    manifestSha256: createHash("sha256").update(body).digest("hex"),
    runtimeVersion: manifest.runtimeVersion,
    components: manifest.components,
    dependencies: manifest.dependencies,
    executables: [target.includes("windows") ? "bin/tesseract.exe" : "bin/tesseract"],
    ...(smokeEvidence
      ? {
          smokeEvidence: {
            evidenceVersion: 1,
            target,
            manifestSha256: createHash("sha256").update(body).digest("hex"),
            tesseractVersion: "5.5.3",
            render: "passed",
            ocr: "passed",
            reportSha256: "abcdef0123456789".repeat(4),
          },
        }
      : {}),
  })
  await writeFile(attestationPath, `${JSON.stringify(attestation, null, 2)}\n`)
  return attestation
}

export async function confinementEvidenceFixture(
  resourcesRoot: string,
  target: DocumentRuntimeTarget.Target,
  sandboxRuntime: {
    readonly documentProxySha256: string
    readonly manifestSha256: string
  },
  release: ReleaseIdentity = { version: "1.2.3", sourceCommit: "a".repeat(40), buildID: "test-build-1" },
) {
  const evidenceRoot = path.join(resourcesRoot, EvidenceDirectoryName)
  await mkdir(evidenceRoot, { recursive: true })
  const keys = generateKeyPairSync("ed25519")
  const publicKey = keys.publicKey.export({ format: "der", type: "spki" })
  await writeFile(path.join(evidenceRoot, IssuerPublicKeyName), publicKey)
  await writeFile(path.join(evidenceRoot, ReleaseIdentityName), `${JSON.stringify(release)}\n`)
  const attestationBytes = await readFile(path.join(resourcesRoot, "document-runtime.attestation.json"))
  const runtimeManifestSha256 = JSON.parse(attestationBytes.toString("utf8")).manifestSha256 as string
  const bindings = {
    reportVersion: 1 as const,
    target,
    runtimeManifestSha256,
    runtimeAttestationSha256: sha256(attestationBytes),
    proxySha256: sandboxRuntime.documentProxySha256,
    sandboxRuntimeManifestSha256: sandboxRuntime.manifestSha256,
    policyVersion: 1 as const,
    release,
  }
  const inventory = Schema.decodeUnknownSync(DocumentRuntimeAttestation.SignedFileInventoryReport)({
    ...bindings,
    status: "passed",
    files: await inventoryFiles(resourcesRoot),
  })
  const inventoryBody = `${JSON.stringify(inventory)}\n`
  await writeFile(path.join(evidenceRoot, SignedFileInventoryName), inventoryBody)
  const reportBindings = { ...bindings, signedFileInventorySha256: sha256(Buffer.from(inventoryBody)), status: "passed" as const }
  const native = Schema.decodeUnknownSync(DocumentRuntimeAttestation.NativeTestReport)({
    ...reportBindings,
    checks: {
      allowedRuntimeAndJobOperations: "passed",
      deniedFilesystemReadsAndWrites: "passed",
      deniedDnsTcpUdpLoopbackBindAndSockets: "passed",
      childAndGrandchildReaping: "passed",
      cleanupAndResetCompletion: "passed",
      proxyNonreuse: "passed",
      replacementAndLinkAttacks: "passed",
      outputSubstitution: "passed",
      workerCrash: "passed",
      innerDisconnect: "passed",
      proxyCrashContained: "passed",
      heldOpenCleanup: "passed",
      parentDisconnectReconciled: "passed",
      systemTesseractUnused: "passed",
      jobPendingAndParentRootAbsence: "passed",
      authenticPdfRenderAndTesseractOcr: "passed",
    },
  })
  const smoke = Schema.decodeUnknownSync(DocumentRuntimeAttestation.PackagedSmokeReport)({
    ...reportBindings,
    installedRuntimeAttestationSha256: bindings.runtimeAttestationSha256,
    operations: {
      proxyProbe: "passed",
      pdfRender: "passed",
      tesseractOcr: "passed",
      release: "passed",
      cancellation: "passed",
      rootCleanup: "passed",
      systemTesseractUnused: "passed",
      installedLayout: "passed",
    },
  })
  const byPath = new Map(inventory.files.map((file) => [file.path, file]))
  const signingPaths = requiredSigningPaths(inventory.files, target)
  const dependencyPaths = requiredDependencyPaths(inventory.files, target)
  const signingFiles = signingPaths.map((file) => byPath.get(file)).filter((file) => file !== undefined)
  const dependencyFiles = dependencyPaths.map((file) => byPath.get(file)).filter((file) => file !== undefined)
  if (signingFiles.length !== signingPaths.length || dependencyFiles.length !== dependencyPaths.length) {
    throw new Error("Fixture inventory is incomplete")
  }
  const signing = Schema.decodeUnknownSync(DocumentRuntimeAttestation.SigningReport)({
    ...reportBindings,
    files: signingFiles.map((file) => ({ path: file.path, sha256: file.sha256, signature: "passed" })),
  })
  const dependencies = Schema.decodeUnknownSync(DocumentRuntimeAttestation.DependencyReport)({
    ...reportBindings,
    entries: dependencyFiles.map((file) => ({
        path: file.path,
        sha256: file.sha256,
        architecture: target.startsWith("x86_64-") ? "x86_64" : "aarch64",
        closure: "passed",
      })),
  })
  const reports = [
    [NativeTestReportName, native],
    [PackagedSmokeReportName, smoke],
    [SigningReportName, signing],
    [DependencyReportName, dependencies],
  ] as const
  for (const [name, report] of reports) await writeFile(path.join(evidenceRoot, name), `${JSON.stringify(report)}\n`)
  const subject = Schema.decodeUnknownSync(DocumentRuntimeAttestation.ConfinementEvidenceSubject)({
    evidenceVersion: 3,
    target,
    runtimeManifestSha256,
    runtimeAttestationSha256: bindings.runtimeAttestationSha256,
    proxySha256: sandboxRuntime.documentProxySha256,
    sandboxRuntimeManifestSha256: sandboxRuntime.manifestSha256,
    srtVersion: "0.0.76",
    policyVersion: 1,
    release,
    nativeTestReportSha256: sha256(Buffer.from(`${JSON.stringify(native)}\n`)),
    packagedSmokeReportSha256: sha256(Buffer.from(`${JSON.stringify(smoke)}\n`)),
    signingReportSha256: sha256(Buffer.from(`${JSON.stringify(signing)}\n`)),
    signedFileInventorySha256: reportBindings.signedFileInventorySha256,
    dependencyReportSha256: sha256(Buffer.from(`${JSON.stringify(dependencies)}\n`)),
    issuerKeyID: sha256(publicKey),
  })
  const envelope = Schema.decodeUnknownSync(DocumentRuntimeAttestation.ConfinementEvidenceEnvelope)({
    envelopeVersion: 1,
    algorithm: "Ed25519",
    keyID: subject.issuerKeyID,
    subject,
    signature: sign(null, Buffer.from(DocumentRuntimeAttestation.confinementEvidenceSubject(subject)), keys.privateKey).toString("base64"),
  })
  await writeFile(path.join(evidenceRoot, EvidenceEnvelopeName), `${JSON.stringify(envelope)}\n`)
  return { release, keyID: subject.issuerKeyID, envelope }
}

function component(name: string, version: string, sourceRevision: string) {
  return {
    name,
    version,
    sourceRevision,
    sourceSha256: "0123456789abcdef".repeat(4),
    licenseFiles: [`licenses/${name.replaceAll("/", "-")}.txt`],
  }
}

function dependency(
  name: string,
  version: string,
  component: string,
  linkage: DocumentRuntimeManifest.Linkage,
) {
  return { name, version, component, linkage, licenseFiles: [`licenses/${name.replaceAll("/", "-")}.txt`] }
}

function binaryHeader(target: DocumentRuntimeTarget.Target) {
  const bytes = Buffer.alloc(256)
  if (target.includes("windows")) {
    bytes.write("MZ", 0, "ascii")
    bytes.writeUInt32LE(128, 0x3c)
    bytes.write("PE\0\0", 128, "binary")
    bytes.writeUInt16LE(target.startsWith("x86_64-") ? 0x8664 : 0xaa64, 132)
    return bytes
  }
  if (target.includes("linux")) {
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(bytes)
    bytes.writeUInt16LE(target.startsWith("x86_64-") ? 62 : 183, 18)
    return bytes
  }
  Buffer.from([0xcf, 0xfa, 0xed, 0xfe]).copy(bytes)
  bytes.writeUInt32LE(target.startsWith("x86_64-") ? 0x01000007 : 0x0100000c, 4)
  return bytes
}

async function inventoryFiles(root: string) {
  const directories = ["document-runtime", "sandbox-runtime"]
  const files: string[] = []
  while (directories.length > 0) {
    const relative = directories.pop() ?? ""
    const directory = await opendir(path.join(root, ...relative.split("/")))
    for await (const entry of directory) {
      if (entry.isDirectory()) directories.push(`${relative}/${entry.name}`)
      else files.push(`${relative}/${entry.name}`)
    }
  }
  files.push(
    `${EvidenceDirectoryName}/${IssuerPublicKeyName}`,
    `${EvidenceDirectoryName}/${ReleaseIdentityName}`,
  )
  return Promise.all(
    files.sort().map(async (file) => {
      const absolute = path.join(root, ...file.split("/"))
      const body = await readFile(absolute)
      const info = await lstat(absolute)
      return {
        path: file,
        sha256: sha256(body),
        bytes: body.byteLength,
        mode: process.platform === "win32" ? (file.toLowerCase().endsWith(".exe") ? 0o755 : 0o644) : info.mode & 0o777,
      }
    }),
  )
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex")
}
