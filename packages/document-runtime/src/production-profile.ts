import { DocumentRuntimeAttestation } from "@koala-ai/core/document-runtime/attestation"
import { DocumentRuntimeManifest } from "@koala-ai/core/document-runtime/manifest"
import type { DocumentRuntimeTarget } from "@koala-ai/core/document-runtime/target"
import { open } from "node:fs/promises"
import path from "node:path"
import { runtimeNativeBinary, runtimeNativePackage } from "./runtime"

const TessdataRevision = "87416418657359cb625c412a48b6e1d6d41c29bd"
const RuntimePackageSha256 = "1239d4d885dcad42201a27ed9324f8f0f760b78700d8db9ced39a511cffe7eae"

export function verifyProductionProfile(
  manifest: DocumentRuntimeManifest.Manifest,
  manifestSha256: string,
  attestation: DocumentRuntimeAttestation.Attestation,
) {
  if (
    !manifest.releaseReady ||
    manifest.runtimeVersion !== "0.1.0" ||
    attestation.target !== manifest.target ||
    attestation.manifestSha256 !== manifestSha256 ||
    attestation.runtimeVersion !== manifest.runtimeVersion ||
    (attestation.smokeEvidence !== undefined &&
      (attestation.smokeEvidence.target !== manifest.target ||
        attestation.smokeEvidence.manifestSha256 !== manifestSha256)) ||
    !same(attestation.components, manifest.components) ||
    !same(attestation.dependencies, manifest.dependencies)
  ) {
    return false
  }

  const components = new Map(manifest.components.map((component) => [component.name, component]))
  const required = requiredComponents(manifest.target)
  if (components.size !== required.length) return false
  if (
    required.some((expected) => {
      const actual = components.get(expected.name)
      return (
        !actual ||
        actual.version !== expected.version ||
        (typeof expected.sourceRevision === "string"
          ? actual.sourceRevision !== expected.sourceRevision
          : !expected.sourceRevision.test(actual.sourceRevision))
      )
    })
  ) {
    return false
  }

  const files = new Map<string, DocumentRuntimeManifest.File>(manifest.files.map((file) => [file.path, file]))
  const runtimePackage = files.get("package.json")
  if (
    runtimePackage?.sha256 !== RuntimePackageSha256 ||
    runtimePackage.bytes !== 18 ||
    requiredFiles(manifest.target).some(
      (expected) => files.get(expected.path)?.component !== expected.component || files.get(expected.path)?.mode !== expected.mode,
    )
  ) {
    return false
  }
  if (
    !same(
      componentFiles(manifest, "@napi-rs/canvas", "node_modules/@napi-rs/canvas/"),
      canvasFiles(),
    ) ||
    !same(
      componentFiles(
        manifest,
        runtimeNativePackage(manifest.target),
        `node_modules/${runtimeNativePackage(manifest.target)}/`,
      ),
      nativePackageFiles(manifest.target),
    ) ||
    pdfAssetDirectories().some(
      (directory) =>
        !manifest.files.some(
          (file) => file.component === "pdfjs-dist" && file.mode === 0o644 && file.path.startsWith(directory),
        ),
    )
  ) {
    return false
  }

  const executable = runtimeExecutable(manifest.target)
  const actualExecutables = manifest.files
    .filter((file) => file.mode === 0o755)
    .map((file) => file.path)
    .sort()
  if (!same(attestation.executables, [executable]) || !same(actualExecutables, [executable])) return false

  const dependencies = new Set(
    manifest.dependencies.map((dependency) =>
      dependencyKey(dependency.component, dependency.name, dependency.version, dependency.linkage),
    ),
  )
  return requiredDependencies(manifest.target).every((dependency) => dependencies.has(dependency))
}

export async function verifyProductionTargetBinaries(root: string, target: DocumentRuntimeTarget.Target) {
  const nativePackage = runtimeNativePackage(target)
  const binaries = [
    path.join(root, ...(runtimeExecutable(target).split("/"))),
    path.join(root, "node_modules", ...nativePackage.split("/"), runtimeNativeBinary(target)),
  ]
  const results = await Promise.all(binaries.map((file) => targetBinary(file, target)))
  return results.every(Boolean)
}

function requiredComponents(target: DocumentRuntimeTarget.Target) {
  return [
    { name: "document-runtime", version: "0.1.0", sourceRevision: /^git-[a-f0-9]{40}$/ },
    { name: "pdfjs-dist", version: "6.3.289", sourceRevision: "npm-6.3.289" },
    { name: "@napi-rs/canvas", version: "1.0.9", sourceRevision: "npm-1.0.9" },
    { name: runtimeNativePackage(target), version: "1.0.9", sourceRevision: "npm-1.0.9" },
    { name: "tesseract", version: "5.5.3", sourceRevision: "v5.5.3" },
    { name: "leptonica", version: "1.87.0", sourceRevision: "1.87.0" },
    { name: "tessdata-fast-eng", version: TessdataRevision, sourceRevision: TessdataRevision },
    { name: "tessdata-fast-osd", version: TessdataRevision, sourceRevision: TessdataRevision },
  ]
}

function requiredFiles(target: DocumentRuntimeTarget.Target) {
  const nativePackage = runtimeNativePackage(target)
  return [
    { path: "package.json", component: "document-runtime", mode: 0o644 },
    { path: "worker/bootstrap.js", component: "document-runtime", mode: 0o644 },
    { path: "worker/worker.js", component: "document-runtime", mode: 0o644 },
    { path: "node_modules/pdfjs-dist/legacy/build/pdf.mjs", component: "pdfjs-dist", mode: 0o644 },
    { path: "node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs", component: "pdfjs-dist", mode: 0o644 },
    { path: "node_modules/pdfjs-dist/LICENSE", component: "pdfjs-dist", mode: 0o644 },
    { path: "node_modules/pdfjs-dist/package.json", component: "pdfjs-dist", mode: 0o644 },
    { path: "node_modules/@napi-rs/canvas/index.js", component: "@napi-rs/canvas", mode: 0o644 },
    {
      path: `node_modules/${nativePackage}/${runtimeNativeBinary(target)}`,
      component: nativePackage,
      mode: 0o644,
    },
    { path: runtimeExecutable(target), component: "tesseract", mode: 0o755 },
    { path: "tessdata/eng.traineddata", component: "tessdata-fast-eng", mode: 0o644 },
    { path: "tessdata/osd.traineddata", component: "tessdata-fast-osd", mode: 0o644 },
  ] as const
}

function canvasFiles() {
  return [
    "node_modules/@napi-rs/canvas/LICENSE",
    "node_modules/@napi-rs/canvas/geometry.js",
    "node_modules/@napi-rs/canvas/index.js",
    "node_modules/@napi-rs/canvas/js-binding.js",
    "node_modules/@napi-rs/canvas/load-image.js",
    "node_modules/@napi-rs/canvas/node-canvas.js",
    "node_modules/@napi-rs/canvas/package.json",
  ]
}

function nativePackageFiles(target: DocumentRuntimeTarget.Target) {
  const root = `node_modules/${runtimeNativePackage(target)}`
  return [
    `${root}/package.json`,
    `${root}/${runtimeNativeBinary(target)}`,
    ...(target.includes("windows") ? [`${root}/icudtl.dat`] : []),
  ].sort()
}

function pdfAssetDirectories() {
  return [
    "node_modules/pdfjs-dist/cmaps/",
    "node_modules/pdfjs-dist/iccs/",
    "node_modules/pdfjs-dist/standard_fonts/",
    "node_modules/pdfjs-dist/wasm/",
  ]
}

function componentFiles(manifest: DocumentRuntimeManifest.Manifest, component: string, prefix: string) {
  return manifest.files
    .filter((file) => file.component === component && file.path.startsWith(prefix))
    .map((file) => file.path)
    .sort()
}

function requiredDependencies(target: DocumentRuntimeTarget.Target) {
  return [
    dependencyKey("document-runtime", "pdfjs-dist", "6.3.289", "javascript"),
    dependencyKey("document-runtime", "@napi-rs/canvas", "1.0.9", "javascript"),
    dependencyKey("@napi-rs/canvas", runtimeNativePackage(target), "1.0.9", "dynamic"),
    dependencyKey("document-runtime", "tesseract", "5.5.3", "dynamic"),
    dependencyKey("tesseract", "leptonica", "1.87.0", "static"),
    dependencyKey("tesseract", "tessdata-fast-eng", TessdataRevision, "data"),
    dependencyKey("tesseract", "tessdata-fast-osd", TessdataRevision, "data"),
  ]
}

function dependencyKey(component: string, name: string, version: string, linkage: string) {
  return [component, name, version, linkage].join("\0")
}

function runtimeExecutable(target: DocumentRuntimeTarget.Target) {
  return target.includes("windows") ? "bin/tesseract.exe" : "bin/tesseract"
}

function same(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right)
}

async function targetBinary(file: string, target: DocumentRuntimeTarget.Target) {
  const handle = await open(file, "r").catch(() => undefined)
  if (!handle) return false
  try {
    const header = Buffer.alloc(4_096)
    const { bytesRead } = await handle.read(header, 0, header.byteLength, 0)
    const bytes = header.subarray(0, bytesRead)
    if (target.includes("windows")) return peArchitecture(bytes) === architecture(target)
    if (target.includes("linux")) return elfArchitecture(bytes) === architecture(target)
    return machArchitecture(bytes) === architecture(target)
  } finally {
    await handle.close()
  }
}

function peArchitecture(bytes: Buffer) {
  if (bytes.byteLength < 64 || bytes.toString("ascii", 0, 2) !== "MZ") return
  const offset = bytes.readUInt32LE(0x3c)
  if (offset + 6 > bytes.byteLength || bytes.toString("binary", offset, offset + 4) !== "PE\0\0") return
  const machine = bytes.readUInt16LE(offset + 4)
  if (machine === 0x8664) return "x86_64"
  if (machine === 0xaa64) return "aarch64"
}

function elfArchitecture(bytes: Buffer) {
  if (
    bytes.byteLength < 20 ||
    !bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
    bytes[4] !== 2 ||
    bytes[5] !== 1
  ) {
    return
  }
  const machine = bytes.readUInt16LE(18)
  if (machine === 62) return "x86_64"
  if (machine === 183) return "aarch64"
}

function machArchitecture(bytes: Buffer) {
  if (bytes.byteLength < 8) return
  const littleEndian = bytes.subarray(0, 4).equals(Buffer.from([0xcf, 0xfa, 0xed, 0xfe]))
  const bigEndian = bytes.subarray(0, 4).equals(Buffer.from([0xfe, 0xed, 0xfa, 0xcf]))
  if (!littleEndian && !bigEndian) return
  const cpu = littleEndian ? bytes.readUInt32LE(4) : bytes.readUInt32BE(4)
  if (cpu === 0x01000007) return "x86_64"
  if (cpu === 0x0100000c) return "aarch64"
}

function architecture(target: DocumentRuntimeTarget.Target) {
  return target.startsWith("x86_64-") ? "x86_64" : "aarch64"
}
