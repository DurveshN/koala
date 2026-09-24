#!/usr/bin/env bun
import { DocumentRuntimeManifest } from "@koala-ai/core/document-runtime/manifest"
import { DocumentRuntimeTarget } from "@koala-ai/core/document-runtime/target"
import { Schema } from "effect"
import { createHash } from "node:crypto"
import { createReadStream, existsSync } from "node:fs"
import { chmod, cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import { requestedTarget } from "./target"

const root = path.resolve(import.meta.dir, "..")
const workspaceRoot = path.resolve(root, "..", "..")
const require = createRequire(import.meta.url)
const HashConcurrency = 4
const nativePackages = {
  "x86_64-apple-darwin": "@napi-rs/canvas-darwin-x64",
  "aarch64-apple-darwin": "@napi-rs/canvas-darwin-arm64",
  "x86_64-pc-windows-msvc": "@napi-rs/canvas-win32-x64-msvc",
  "aarch64-pc-windows-msvc": "@napi-rs/canvas-win32-arm64-msvc",
  "x86_64-unknown-linux-gnu": "@napi-rs/canvas-linux-x64-gnu",
  "aarch64-unknown-linux-gnu": "@napi-rs/canvas-linux-arm64-gnu",
} as const satisfies Record<DocumentRuntimeTarget.Target, string>
const SourceLock = Schema.Struct({
  packages: Schema.Record(
    Schema.String,
    Schema.Struct({
      version: Schema.String,
      integrity: Schema.String.check(Schema.isPattern(/^sha512-[A-Za-z0-9+/]+=*$/)),
    }),
  ),
})
const sourceLock = Schema.decodeUnknownSync(SourceLock)(await Bun.file(path.join(root, "source-lock.json")).json())
const bunLock = await Bun.file(path.join(workspaceRoot, "bun.lock")).text()

const target = requestedTarget(process.argv.slice(2))
const output = path.join(root, "dist", target)
const buildOutput = path.join(root, "dist", ".build")
await rm(output, { recursive: true, force: true })
await rm(buildOutput, { recursive: true, force: true })

await buildEntry("bootstrap")
await buildEntry("worker", ["@napi-rs/canvas", "pdfjs-dist"])
await mkdir(path.join(output, "worker"), { recursive: true })
await Promise.all(
  ["bootstrap", "worker"].map((entry) =>
    cp(path.join(buildOutput, entry, `${entry}.js`), path.join(output, "worker", `${entry}.js`)),
  ),
)
await rm(buildOutput, { recursive: true, force: true })
await writeFile(path.join(output, "package.json"), '{"type":"module"}\n', { mode: 0o644, flag: "wx" })

const pdfRoot = packageRoot("pdfjs-dist")
const canvasRoot = packageRoot("@napi-rs/canvas")
const nativePackage = nativePackages[target]
const nativeRoot = packageRoot(nativePackage)
const officePackages = [
  { name: "docx", version: "9.7.1", licenseFile: "LICENSE" },
  { name: "mammoth", version: "1.9.0", licenseFile: "LICENSE" },
  { name: "xlsx", version: "0.18.5", licenseFile: "LICENSE" },
  { name: "jszip", version: "3.10.1", licenseFile: "LICENSE.markdown" },
  { name: "fast-xml-parser", version: "4.5.0", licenseFile: "LICENSE" },
  { name: "pptxgenjs", version: "4.0.1", licenseFile: "LICENSE" },
  { name: "pdf-lib", version: "1.17.1", licenseFile: "LICENSE.md" },
] as const
await Promise.all([
  verifyPackageLock("pdfjs-dist", pdfRoot),
  verifyPackageLock("@napi-rs/canvas", canvasRoot),
  verifyPackageLock(nativePackage, nativeRoot),
  ...officePackages.map((pkg) => verifyPackageLock(pkg.name, packageRoot(pkg.name))),
])
await copyEntries(pdfRoot, path.join(output, "node_modules", "pdfjs-dist"), [
  "LICENSE",
  "package.json",
  "legacy/build/pdf.mjs",
  "legacy/build/pdf.worker.mjs",
  "cmaps",
  "iccs",
  "standard_fonts",
  "wasm",
])
await copyEntries(canvasRoot, path.join(output, "node_modules", "@napi-rs", "canvas"), [
  "LICENSE",
  "package.json",
  "index.js",
  "geometry.js",
  "js-binding.js",
  "load-image.js",
  "node-canvas.js",
])
await copyEntries(
  nativeRoot,
  path.join(output, "node_modules", ...nativePackage.split("/")),
  (await readdir(nativeRoot)).filter((file) => file !== "README.md"),
)
await mkdir(path.join(output, "licenses"), { recursive: true })
await cp(
  path.join(workspaceRoot, "THIRD_PARTY_NOTICES.md"),
  path.join(output, "licenses", "THIRD_PARTY_NOTICES.md"),
)
const officeLicensePaths = await Promise.all(
  officePackages.map(async (pkg) => {
    const destination = `licenses/${pkg.name}-${pkg.licenseFile}`
    await cp(
      path.join(packageRoot(pkg.name), pkg.licenseFile),
      path.join(output, ...destination.split("/")),
    )
    return { name: pkg.name, path: destination }
  }),
)

const tesseract = await bundleTesseract()

const filePaths = await listFiles(output)
const files: DocumentRuntimeManifest.File[] = []
for (let offset = 0; offset < filePaths.length; offset += HashConcurrency) {
  files.push(
    ...(await Promise.all(
      filePaths.slice(offset, offset + HashConcurrency).map(async (file) => {
        const absolute = path.join(output, ...file.split("/"))
        const mode: DocumentRuntimeManifest.FileMode = executable(file) ? 0o755 : 0o644
        await chmod(absolute, mode)
        const info = await stat(absolute)
        return {
          path: DocumentRuntimeManifest.RelativePath.make(file),
          component: component(file, nativePackage),
          sha256: DocumentRuntimeManifest.Digest.make(await hashFile(absolute)),
          bytes: info.size,
          mode,
        }
      }),
    )),
  )
}
const runtimeSourceHash = await hashSources(path.join(root, "src"))
const pdfLicenses = files.filter((file) => file.path.startsWith("node_modules/pdfjs-dist/") && isLicense(file.path))
const officeComponents = officePackages.map((pkg) => ({
  name: pkg.name,
  version: pkg.version,
  sourceRevision: `npm-${pkg.version}`,
  sourceSha256: DocumentRuntimeManifest.Digest.make(componentHash(files, pkg.name)),
  licenseFiles: [officeLicensePaths.find((item) => item.name === pkg.name)!.path],
}))
const officeDependencies = officePackages.map((pkg) => {
  const licensePath = officeLicensePaths.find((item) => item.name === pkg.name)!.path
  return {
    name: pkg.name,
    version: pkg.version,
    component: "document-runtime",
    linkage: "javascript" as const,
    licenseFiles: [licensePath],
  }
})
const ocrComponents = tesseract
  ? [
      {
        name: "tesseract",
        version: tesseract.version,
        sourceRevision: tesseract.version,
        sourceSha256: DocumentRuntimeManifest.Digest.make(componentHash(files, "tesseract")),
        licenseFiles: tesseract.licensePaths,
      },
      ...(["eng", "osd"] as const).map((language) => ({
        name: `tessdata-fast-${language}`,
        version: tesseract.tessdataRevision,
        sourceRevision: tesseract.tessdataRevision,
        sourceSha256: DocumentRuntimeManifest.Digest.make(componentHash(files, `tessdata-fast-${language}`)),
        licenseFiles: [],
      })),
    ]
  : []
const manifest = Schema.decodeUnknownSync(DocumentRuntimeManifest.Manifest)({
  manifestVersion: 1,
  protocolVersion: 1,
  releaseReady: false,
  runtimeVersion: "0.1.0",
  target,
  architecture: DocumentRuntimeTarget.architecture(target),
  components: [
    {
      name: "document-runtime",
      version: "0.1.0",
      sourceRevision: "phase-9b",
      sourceSha256: DocumentRuntimeManifest.Digest.make(runtimeSourceHash),
      licenseFiles: [],
    },
    {
      name: "pdfjs-dist",
      version: "6.3.289",
      sourceRevision: "npm-6.3.289",
      sourceSha256: DocumentRuntimeManifest.Digest.make(componentHash(files, "pdfjs-dist")),
      licenseFiles: pdfLicenses.map((file) => file.path),
    },
    {
      name: "@napi-rs/canvas",
      version: "1.0.9",
      sourceRevision: "npm-1.0.9",
      sourceSha256: DocumentRuntimeManifest.Digest.make(componentHash(files, "@napi-rs/canvas")),
      licenseFiles: ["node_modules/@napi-rs/canvas/LICENSE"],
    },
    {
      name: nativePackage,
      version: "1.0.9",
      sourceRevision: "npm-1.0.9",
      sourceSha256: DocumentRuntimeManifest.Digest.make(componentHash(files, nativePackage)),
      licenseFiles: [],
    },
    ...officeComponents,
    ...ocrComponents,
  ],
  files,
  dependencies: [
    {
      name: "pdfjs-dist",
      version: "6.3.289",
      component: "document-runtime",
      linkage: "javascript",
      licenseFiles: pdfLicenses.map((file) => file.path),
    },
    {
      name: "@napi-rs/canvas",
      version: "1.0.9",
      component: "document-runtime",
      linkage: "javascript",
      licenseFiles: ["node_modules/@napi-rs/canvas/LICENSE"],
    },
    {
      name: nativePackage,
      version: "1.0.9",
      component: "@napi-rs/canvas",
      linkage: "dynamic",
      licenseFiles: [],
    },
    ...officeDependencies,
    ...(tesseract
      ? [
          {
            name: "tesseract",
            version: tesseract.version,
            component: "document-runtime",
            linkage: "dynamic" as const,
            licenseFiles: tesseract.licensePaths,
          },
        ]
      : []),
  ],
})
await writeFile(path.join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
  mode: 0o644,
  flag: "wx",
})

const { loadAndVerifyManifest } = await import("../src/manifest")
await loadAndVerifyManifest(output, target)
if (process.env.OPENCODE_CHANNEL || process.env.OPENCODE_VERSION) {
  throw new Error("The development document runtime builder cannot produce release-ready artifacts")
}
console.log(output)

async function buildEntry(entry: "bootstrap" | "worker", external: ReadonlyArray<string> = []) {
  const build = await Bun.build({
    entrypoints: [path.join(root, "src", `${entry}.ts`)],
    outdir: path.join(buildOutput, entry),
    target: "node",
    format: "esm",
    external: [...external],
    naming: `${entry}.js`,
    minify: false,
    sourcemap: "none",
  })
  if (!build.success) throw new AggregateError(build.logs, `Failed to build the document ${entry}`)
}

function packageRoot(name: string) {
  try {
    return path.dirname(require.resolve(`${name}/package.json`))
  } catch {
    let directory = path.dirname(require.resolve(name))
    while (directory !== path.dirname(directory)) {
      if (existsSync(path.join(directory, "package.json"))) return directory
      directory = path.dirname(directory)
    }
    throw new Error(`Could not resolve package root for ${name}`)
  }
}

async function copyEntries(from: string, to: string, entries: ReadonlyArray<string>) {
  await Promise.all(
    entries.map(async (entry) => {
      const destination = path.join(to, ...entry.split("/"))
      await mkdir(path.dirname(destination), { recursive: true })
      await cp(path.join(from, ...entry.split("/")), destination, { recursive: true })
    }),
  )
}

async function listFiles(directory: string, relative = ""): Promise<string[]> {
  const entries = await readdir(path.join(directory, ...relative.split("/").filter(Boolean)), { withFileTypes: true })
  return (
    await Promise.all(
      entries.map(async (entry) => {
        const item = relative ? `${relative}/${entry.name}` : entry.name
        return entry.isDirectory() ? listFiles(directory, item) : [item]
      }),
    )
  )
    .flat()
    .sort()
}

async function hashSources(directory: string) {
  const hash = createHash("sha256")
  for (const file of await listFiles(directory)) {
    hash.update(file)
    for await (const chunk of createReadStream(path.join(directory, ...file.split("/")))) hash.update(chunk)
  }
  return hash.digest("hex")
}

async function hashFile(file: string) {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest("hex")
}

function componentHash(files: ReadonlyArray<DocumentRuntimeManifest.File>, name: string) {
  const hash = createHash("sha256")
  for (const file of files.filter((file) => file.component === name)) {
    hash.update(`${file.path}\0${file.sha256}\0${file.bytes}\0${file.mode}\n`)
  }
  return hash.digest("hex")
}

async function verifyPackageLock(name: string, directory: string) {
  const locked = sourceLock.packages[name]
  if (!locked) throw new Error(`Missing source lock for ${name}`)
  const metadata = Schema.decodeUnknownSync(Schema.Struct({ name: Schema.String, version: Schema.String }))(
    await Bun.file(path.join(directory, "package.json")).json(),
  )
  if (metadata.name !== name || metadata.version !== locked.version)
    throw new Error(`Installed package mismatch for ${name}`)
  const marker = `"${name}": ["${name}@${locked.version}"`
  const line = bunLock.split("\n").find((line) => line.includes(marker))
  if (!line?.includes(`"${locked.integrity}"`)) throw new Error(`bun.lock integrity mismatch for ${name}`)
}

function component(file: string, nativePackage: string) {
  if (file.startsWith("node_modules/pdfjs-dist/")) return "pdfjs-dist"
  if (file.startsWith(`node_modules/${nativePackage}/`)) return nativePackage
  if (file.startsWith("node_modules/@napi-rs/canvas/")) return "@napi-rs/canvas"
  if (file.startsWith("bin/") || file.startsWith("licenses/tesseract-")) return "tesseract"
  if (file === "tessdata/eng.traineddata") return "tessdata-fast-eng"
  if (file === "tessdata/osd.traineddata") return "tessdata-fast-osd"
  for (const pkg of officePackages) {
    if (file === `licenses/${pkg.name}-${pkg.licenseFile}`) return pkg.name
  }
  return "document-runtime"
}

// Development builds bundle a locally installed Tesseract when KOALA_TESSERACT_ROOT names its
// directory (for example the UB Mannheim install under Program Files). Without it the runtime
// still serves Office, PDF, and DOCX generation; only OCR reports unavailable.
async function bundleTesseract() {
  const source = process.env.KOALA_TESSERACT_ROOT
  if (!source) return undefined
  if (!path.isAbsolute(source)) throw new Error("KOALA_TESSERACT_ROOT must be an absolute path")
  const windows = target.includes("windows")
  const executableName = windows ? "tesseract.exe" : "tesseract"
  const tessdata = path.join(source, "tessdata")
  for (const file of [
    path.join(source, executableName),
    path.join(tessdata, "eng.traineddata"),
    path.join(tessdata, "osd.traineddata"),
  ]) {
    if (!existsSync(file)) throw new Error(`KOALA_TESSERACT_ROOT is missing ${file}`)
  }
  const entries = await readdir(source)
  // Windows builds resolve their DLLs from the executable directory.
  const binaries = windows ? entries.filter((entry) => /\.(?:exe|dll)$/i.test(entry)) : [executableName]
  await copyEntries(source, path.join(output, "bin"), binaries)
  await copyEntries(tessdata, path.join(output, "tessdata"), ["eng.traineddata", "osd.traineddata"])
  const licensePaths = await Promise.all(
    entries
      .filter((entry) => isLicense(entry) && !entry.includes("/"))
      .map(async (entry) => {
        const destination = `licenses/tesseract-${entry}`
        await cp(path.join(source, entry), path.join(output, ...destination.split("/")))
        return destination
      }),
  )
  const probe = Bun.spawnSync([path.join(source, executableName), "--version"], {
    env: { TESSDATA_PREFIX: tessdata, ...(windows ? { SystemRoot: process.env.SystemRoot ?? "" } : {}) },
    stdout: "pipe",
    stderr: "pipe",
  })
  // The worker probe requires the first `--version` line to equal `tesseract <component version>`.
  const version = `${probe.stdout.toString()}\n${probe.stderr.toString()}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("tesseract "))
    ?.slice("tesseract ".length)
  if (!version || !/^[a-z0-9][a-z0-9._+-]{0,127}$/i.test(version)) {
    throw new Error("Could not determine the Tesseract version from KOALA_TESSERACT_ROOT")
  }
  return { version, licensePaths, tessdataRevision: process.env.KOALA_TESSDATA_REVISION ?? "local" }
}

function executable(file: string) {
  return file.endsWith(".exe")
}

function isLicense(file: string) {
  return /(?:^|\/)(?:license|copying|notice)[^/]*$/i.test(file)
}
