import { describe, expect, test } from "bun:test"
import { DocumentRuntimeAttestation } from "@koala-ai/core/document-runtime/attestation"
import { DocumentRuntimeManifest } from "@koala-ai/core/document-runtime/manifest"
import { Schema } from "effect"
import { runtimeNativeBinary, runtimeNativePackage } from "../src/runtime"
import { verifyProductionProfile } from "../src/production-profile"

const target = "x86_64-pc-windows-msvc" as const
const digest = "0123456789abcdef".repeat(4)
const runtimePackageDigest = "1239d4d885dcad42201a27ed9324f8f0f760b78700d8db9ced39a511cffe7eae"
const tessdata = "87416418657359cb625c412a48b6e1d6d41c29bd"

describe("production document runtime profile", () => {
  test("requires the exact attested identities, target paths, dependencies, licenses, and executable set", () => {
    const manifest = productionManifest()
    const attestation = productionAttestation(manifest)
    expect(verifyProductionProfile(manifest, digest, attestation)).toBe(true)
    expect(verifyProductionProfile({ ...manifest, target: "aarch64-pc-windows-msvc" }, digest, attestation)).toBe(false)
    expect(
      verifyProductionProfile(
        manifest,
        digest,
        Schema.decodeUnknownSync(DocumentRuntimeAttestation.Attestation)({
          ...attestation,
          executables: ["worker/worker.js"],
        }),
      ),
    ).toBe(false)

    for (const required of [
      "package.json",
      "worker/bootstrap.js",
      "worker/worker.js",
      "node_modules/pdfjs-dist/cmaps/fixture.bcmap",
      "node_modules/pdfjs-dist/iccs/fixture.icc",
      "node_modules/pdfjs-dist/standard_fonts/fixture.pfb",
      "node_modules/pdfjs-dist/wasm/fixture.wasm",
      "node_modules/@napi-rs/canvas/geometry.js",
      `node_modules/${runtimeNativePackage(target)}/package.json`,
      `node_modules/${runtimeNativePackage(target)}/icudtl.dat`,
    ]) {
      const incomplete = { ...manifest, files: manifest.files.filter((file) => file.path !== required) }
      expect(verifyProductionProfile(incomplete, digest, productionAttestation(incomplete))).toBe(false)
    }

    const extraCanvas = {
      ...manifest,
      files: [
        ...manifest.files,
        {
          path: DocumentRuntimeManifest.RelativePath.make("node_modules/@napi-rs/canvas/undeclared.js"),
          component: "@napi-rs/canvas",
          sha256: DocumentRuntimeManifest.Digest.make(digest),
          bytes: 1,
          mode: 0o644 as const,
        },
      ],
    }
    expect(verifyProductionProfile(extraCanvas, digest, productionAttestation(extraCanvas))).toBe(false)
  })
})

function productionManifest() {
  const nativePackage = runtimeNativePackage(target)
  const identities = [
    ["document-runtime", "0.1.0", `git-${"1".repeat(40)}`],
    ["pdfjs-dist", "6.3.289", "npm-6.3.289"],
    ["@napi-rs/canvas", "1.0.9", "npm-1.0.9"],
    [nativePackage, "1.0.9", "npm-1.0.9"],
    ["tesseract", "5.5.3", "v5.5.3"],
    ["leptonica", "1.87.0", "1.87.0"],
    ["tessdata-fast-eng", tessdata, tessdata],
    ["tessdata-fast-osd", tessdata, tessdata],
  ] as const
  const components = identities.map(([name, version, sourceRevision]) => ({
    name,
    version,
    sourceRevision,
    sourceSha256: digest,
    licenseFiles: [`licenses/${name.replaceAll("/", "-")}.txt`],
  }))
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
    [`node_modules/${nativePackage}/icudtl.dat`, nativePackage, 0o644],
    ["bin/tesseract.exe", "tesseract", 0o755],
    ["tessdata/eng.traineddata", "tessdata-fast-eng", 0o644],
    ["tessdata/osd.traineddata", "tessdata-fast-osd", 0o644],
  ] as const
  const files = [
    ...required.map(([file, component, mode]) => ({
      path: file,
      component,
      sha256: file === "package.json" ? runtimePackageDigest : digest,
      bytes: file === "package.json" ? 18 : 1,
      mode,
    })),
    ...components.map((component) => ({
        path: component.licenseFiles[0],
        component: component.name,
        sha256: digest,
        bytes: 1,
        mode: 0o644 as const,
      })),
  ]
  const dependencies = [
    dependency("pdfjs-dist", "6.3.289", "document-runtime", "javascript"),
    dependency("@napi-rs/canvas", "1.0.9", "document-runtime", "javascript"),
    dependency(nativePackage, "1.0.9", "@napi-rs/canvas", "dynamic"),
    dependency("tesseract", "5.5.3", "document-runtime", "dynamic"),
    dependency("leptonica", "1.87.0", "tesseract", "static"),
    dependency("tessdata-fast-eng", tessdata, "tesseract", "data"),
    dependency("tessdata-fast-osd", tessdata, "tesseract", "data"),
  ]
  return Schema.decodeUnknownSync(DocumentRuntimeManifest.Manifest)({
    manifestVersion: 1,
    protocolVersion: 1,
    releaseReady: true,
    runtimeVersion: "0.1.0",
    target,
    architecture: "x86_64",
    components,
    files,
    dependencies,
  })
}

function productionAttestation(manifest: ReturnType<typeof productionManifest>) {
  return Schema.decodeUnknownSync(DocumentRuntimeAttestation.Attestation)({
    attestationVersion: 1,
    profileVersion: 1,
    target,
    manifestSha256: digest,
    runtimeVersion: manifest.runtimeVersion,
    components: manifest.components,
    dependencies: manifest.dependencies,
    executables: ["bin/tesseract.exe"],
  })
}

function dependency(
  name: string,
  version: string,
  component: string,
  linkage: DocumentRuntimeManifest.Linkage,
) {
  return { name, version, component, linkage, licenseFiles: [`licenses/${name.replaceAll("/", "-")}.txt`] }
}
