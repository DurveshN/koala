#!/usr/bin/env bun
import { DocumentRuntimeAttestation } from "@koala-ai/document-runtime"
import { Deferred, Effect, Fiber, Schema } from "effect"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { chmod, lstat, mkdir, mkdtemp, open, opendir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DocumentRuntime } from "../../opencode/src/document/runtime"
import {
  EvidenceDirectoryName,
  SignedFileInventoryName,
  verifyConfinementResources,
  verifySignedFileInventory,
} from "../src/main/document-confinement"
import { hostTarget, type SandboxRuntimeTarget } from "../src/main/sandbox-runtime"
import { readReport, releaseIdentity, requireNativeTarget, resourceContext } from "./document-runtime-evidence"

export async function runInstalledDocumentRuntimeSmoke(input: {
  readonly target: SandboxRuntimeTarget
  readonly artifactPath: string
  readonly reportPath: string
  readonly release: DocumentRuntimeAttestation.ReleaseIdentity
  readonly verifyEvidence?: boolean
  readonly installerVerifier?: string
}) {
  const host = hostTarget(process.platform, process.arch)
  if (host !== input.target) throw new Error("Installed document smoke requires a target-native host")
  const artifact = await canonicalFile(input.artifactPath)
  if (input.installerVerifier) {
    await run(await canonicalFile(input.installerVerifier), ["verify", "--target", input.target, "--artifact", artifact], path.dirname(artifact))
  } else if (input.target.includes("linux")) {
    throw new Error("Linux installed smoke requires a trusted package-signature verifier")
  }
  const temporary = await mkdtemp(path.join(os.tmpdir(), "koala-installed-document-smoke-"))
  let detach: (() => Promise<void>) | undefined
  try {
    const installed = await installResources(artifact, input.target, temporary)
    detach = installed.detach
    return await runPackagedDocumentRuntimeSmoke({
      target: input.target,
      resourcesRoot: installed.resourcesRoot,
      reportPath: input.reportPath,
      release: input.release,
      verifyEvidence: input.verifyEvidence,
    })
  } finally {
    await detach?.()
    await rm(temporary, { recursive: true, force: true })
  }
}

export async function locateInstaller(directory: string, target: SandboxRuntimeTarget) {
  const root = await canonicalDirectory(directory)
  const extension = target.includes("windows") ? ".exe" : target.includes("apple") ? ".dmg" : ".appimage"
  const entries = (await readdir(root)).filter((entry) => entry.toLowerCase().endsWith(extension))
  const artifact = entries.length === 1 ? entries[0] : undefined
  if (!artifact) throw new Error(`Installed smoke requires exactly one ${extension} artifact`)
  return canonicalFile(path.join(root, artifact))
}

export async function runPackagedDocumentRuntimeSmoke(input: {
  readonly target: SandboxRuntimeTarget
  readonly resourcesRoot: string
  readonly reportPath: string
  readonly release: DocumentRuntimeAttestation.ReleaseIdentity
  readonly verifyEvidence?: boolean
}) {
  const context = await resourceContext(input.resourcesRoot, input.target, input.release)
  const inventoryPath = path.join(context.resourcesRoot, EvidenceDirectoryName, SignedFileInventoryName)
  const inventoryBytes = await readFile(inventoryPath)
  const inventory = await readReport(inventoryPath, DocumentRuntimeAttestation.SignedFileInventoryReport)
  if (
    inventory.target !== input.target ||
    inventory.runtimeManifestSha256 !== context.bindings.runtimeManifestSha256 ||
    inventory.runtimeAttestationSha256 !== context.bindings.runtimeAttestationSha256 ||
    inventory.proxySha256 !== context.bindings.proxySha256 ||
    inventory.sandboxRuntimeManifestSha256 !== context.bindings.sandboxRuntimeManifestSha256 ||
    JSON.stringify(inventory.release) !== JSON.stringify(input.release) ||
    inventory.status !== "passed"
  ) {
    throw new Error("Installed smoke inventory bindings mismatch")
  }
  await verifySignedFileInventory(context.resourcesRoot, inventory.files)

  const before = await documentRoots()
  const temporary = await mkdtemp(path.join(os.tmpdir(), "koala-document-smoke-"))
  const marker = path.join(temporary, "system-tesseract-used")
  const trap = path.join(temporary, process.platform === "win32" ? "tesseract.cmd" : "tesseract")
  const pdf = path.join(temporary, "smoke.pdf")
  const previousPath = process.env.PATH
  await writeFile(
    trap,
    process.platform === "win32"
      ? `@echo off\r\ncopy /y NUL "${marker}" >NUL\r\nexit /b 90\r\n`
      : `#!/bin/sh\n: > '${marker.replaceAll("'", `'"'"'`)}'\nexit 90\n`,
    { mode: 0o700 },
  )
  if (process.platform !== "win32") await chmod(trap, 0o700)
  await writeFile(pdf, smokePdf())
  process.env.PATH = temporary

  try {
    const observations = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* DocumentRuntime.Service
        const probe = yield* service.probe()
        let rendered = false
        let ocr = false
        yield* service.renderAndOcr({ inputPath: pdf, startPage: 1, pageCount: 1 }, (page) =>
          Effect.tryPromise(async () => {
            const [png, tsv] = await Promise.all([readFile(page.pagePath), readFile(page.tsvPath, "utf8")])
            if (png.byteLength !== page.pngBytes || !tsv.toUpperCase().includes("HELLO")) {
              throw new Error("Installed render/OCR output mismatch")
            }
            rendered = true
            ocr = true
          }),
        )
        const entered = yield* Deferred.make<void>()
        const cancellation = yield* service
          .renderAndOcr({ inputPath: pdf, startPage: 1, pageCount: 1 }, () =>
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
          )
          .pipe(Effect.forkChild)
        yield* Deferred.await(entered).pipe(Effect.timeout("30 seconds"))
        yield* Fiber.interrupt(cancellation)
        return { probe, rendered, ocr }
      }).pipe(
        Effect.provide(
          DocumentRuntime.layer({
            runtimePath: path.join(context.resourcesRoot, "document-runtime"),
            manifestSha256: context.bindings.runtimeManifestSha256,
            proxyPath: path.join(context.resourcesRoot, "sandbox-runtime", "document-runtime-proxy.mjs"),
            proxyAssetsRoot: path.join(context.resourcesRoot, "sandbox-runtime"),
            requireReleaseReady: true,
          }),
        ),
      ),
    )
    if (!observations.rendered || !observations.ocr || observations.probe.target !== input.target) {
      throw new Error("Installed document smoke did not complete every operation")
    }
    if (await Bun.file(marker).exists()) throw new Error("Installed smoke used a system Tesseract fallback")
    if (!sameSet(before, await documentRoots())) throw new Error("Installed smoke left a document job root behind")

    const report = makeSmokeReport({
      ...context.bindings,
      signedFileInventorySha256: sha256(inventoryBytes),
      installedRuntimeAttestationSha256: context.bindings.runtimeAttestationSha256,
    })
    await mkdir(path.dirname(input.reportPath), { recursive: true, mode: 0o700 })
    const reportBytes = Buffer.from(`${JSON.stringify(report)}\n`)
    await writeFile(input.reportPath, reportBytes, { flag: "wx", mode: 0o600 })
    if (input.verifyEvidence) {
      const evidence = await verifyConfinementResources({
        resourcesRoot: context.resourcesRoot,
        target: input.target,
        runtimeManifestSha256: context.bindings.runtimeManifestSha256,
        sandboxRuntime: context.sandbox,
        release: input.release,
      })
      if (evidence.envelope.subject.packagedSmokeReportSha256 !== sha256(reportBytes)) {
        throw new Error("Installed smoke result does not match signed packaged evidence")
      }
    }
    return report
  } finally {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    await rm(temporary, { recursive: true, force: true })
  }
}

export function makeSmokeReport(
  input: DocumentRuntimeAttestation.EvidenceBindings & {
    readonly signedFileInventorySha256: string
    readonly installedRuntimeAttestationSha256: string
  },
) {
  return Schema.decodeUnknownSync(DocumentRuntimeAttestation.PackagedSmokeReport)({
    ...input,
    status: "passed",
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
}

async function installResources(artifact: string, target: SandboxRuntimeTarget, root: string) {
  if (target.includes("linux")) {
    if (!artifact.toLowerCase().endsWith(".appimage")) throw new Error("Linux installed smoke requires an AppImage")
    await verifyExecutableArchitecture(artifact, target)
    await run(artifact, ["--appimage-extract"], root)
    return { resourcesRoot: await findInstalledResources(path.join(root, "squashfs-root")) }
  }
  if (target.includes("windows")) {
    if (!artifact.toLowerCase().endsWith(".exe")) throw new Error("Windows installed smoke requires an NSIS installer")
    await verifyExecutableArchitecture(artifact, target)
    const systemRoot = process.env.SystemRoot
    if (!systemRoot) throw new Error("Windows installed smoke requires SystemRoot")
    await run(
      path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "if ((Get-AuthenticodeSignature -LiteralPath $args[0]).Status -ne 'Valid') { exit 91 }",
        artifact,
      ],
      root,
    )
    const installed = path.join(root, "installed")
    await mkdir(installed)
    await run(artifact, ["/S", `/D=${installed}`], root)
    await run(
      path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$files=Get-ChildItem -LiteralPath $args[0] -Recurse -File | Where-Object { $_.Extension -in '.exe','.dll','.node' }; if (-not $files) { exit 92 }; foreach ($file in $files) { if ((Get-AuthenticodeSignature -LiteralPath $file.FullName).Status -ne 'Valid') { exit 93 } }",
        installed,
      ],
      root,
    )
    const uninstallers = (await readdir(installed)).filter(
      (entry) => entry.toLowerCase().startsWith("uninstall") && entry.toLowerCase().endsWith(".exe"),
    )
    const uninstaller = uninstallers.length === 1 ? uninstallers[0] : undefined
    if (!uninstaller) throw new Error("Installed application must contain exactly one uninstaller")
    return {
      resourcesRoot: await findInstalledResources(installed),
      detach: () => run(path.join(installed, uninstaller), ["/S"], root),
    }
  }
  if (!artifact.toLowerCase().endsWith(".dmg")) throw new Error("macOS installed smoke requires a DMG")
  const mount = path.join(root, "mounted")
  await mkdir(mount)
  await run("/usr/bin/hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mount, artifact], root)
  const detach = () => run("/usr/bin/hdiutil", ["detach", mount], root)
  try {
    const applications = (await readdir(mount)).filter((entry) => entry.endsWith(".app"))
    const applicationName = applications.length === 1 ? applications[0] : undefined
    if (!applicationName) throw new Error("Mounted DMG must contain exactly one application")
    const application = path.join(mount, applicationName)
    const executables = (await readdir(path.join(application, "Contents", "MacOS"))).filter(
      (entry) => !entry.startsWith("."),
    )
    const executable = executables.length === 1 ? executables[0] : undefined
    if (!executable) throw new Error("Mounted application must contain exactly one main executable")
    await verifyMachArchitecture(path.join(application, "Contents", "MacOS", executable), target)
    await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", application], root)
    await run("/usr/sbin/spctl", ["--assess", "--type", "execute", application], root)
    return {
      resourcesRoot: await canonicalDirectory(path.join(application, "Contents", "Resources")),
      detach,
    }
  } catch (error) {
    await detach().catch(() => undefined)
    throw error
  }
}

export async function findInstalledResources(root: string) {
  const pending = [await canonicalDirectory(root)]
  const matches: string[] = []
  let visited = 0
  while (pending.length > 0) {
    const directory = pending.pop() ?? ""
    for await (const entry of await opendir(directory)) {
      if (entry.isSymbolicLink()) continue
      if (!entry.isDirectory()) continue
      const child = path.join(directory, entry.name)
      visited++
      if (visited > 4096) throw new Error("Installed artifact directory limit exceeded")
      if (
        entry.name === "resources" &&
        (await Bun.file(path.join(child, "document-runtime.attestation.json")).exists()) &&
        (await directoryExists(path.join(child, "document-runtime"))) &&
        (await directoryExists(path.join(child, "sandbox-runtime")))
      ) {
        matches.push(await canonicalDirectory(child))
        continue
      }
      pending.push(child)
    }
  }
  const resources = matches.length === 1 ? matches[0] : undefined
  if (!resources) throw new Error("Installed artifact must contain exactly one document resource root")
  return resources
}

async function verifyMachArchitecture(file: string, target: SandboxRuntimeTarget) {
  const bytes = await readPrefix(file, 8)
  if (bytes.length < 8 || bytes.readUInt32LE(0) !== 0xfeedfacf) throw new Error("Invalid macOS application binary")
  const expected = target.startsWith("x86_64-") ? 0x01000007 : 0x0100000c
  if (bytes.readUInt32LE(4) !== expected) throw new Error("macOS application architecture mismatch")
}

async function verifyExecutableArchitecture(file: string, target: SandboxRuntimeTarget) {
  const header = await readPrefix(file, 4096)
  if (target.includes("windows")) {
    if (header.length < 64 || header.toString("ascii", 0, 2) !== "MZ") throw new Error("Invalid Windows installer")
    const offset = header.readUInt32LE(0x3c)
    if (offset + 6 > header.length || header.toString("binary", offset, offset + 4) !== "PE\0\0") {
      throw new Error("Invalid Windows installer")
    }
    const expected = target.startsWith("x86_64-") ? 0x8664 : 0xaa64
    if (header.readUInt16LE(offset + 4) !== expected) throw new Error("Windows installer architecture mismatch")
    return
  }
  if (
    header.length < 20 ||
    !header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
    header[4] !== 2 ||
    header[5] !== 1 ||
    header.readUInt16LE(18) !== (target.startsWith("x86_64-") ? 62 : 183)
  ) {
    throw new Error("AppImage architecture mismatch")
  }
}

async function readPrefix(file: string, bytes: number) {
  const handle = await open(file, "r")
  const buffer = Buffer.alloc(bytes)
  const result = await handle.read(buffer, 0, buffer.byteLength, 0).finally(() => handle.close())
  return buffer.subarray(0, result.bytesRead)
}

async function run(executable: string, args: ReadonlyArray<string>, cwd: string) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env: process.env, shell: false, stdio: "inherit", windowsHide: true })
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (code === 0 && signal === null) resolve()
      else reject(new Error("Installed artifact operation failed"))
    })
  })
}

async function canonicalFile(value: string) {
  if (!path.isAbsolute(value)) throw new Error("Installed artifact path must be absolute")
  const info = await lstat(value)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Installed artifact must be a regular file")
  const canonical = await realpath(value)
  if (!samePath(canonical, path.normalize(value))) throw new Error("Installed artifact path must be canonical")
  return canonical
}

async function canonicalDirectory(value: string) {
  const info = await lstat(value)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Installed resources must be a directory")
  return realpath(value)
}

async function directoryExists(value: string) {
  const info = await lstat(value).catch(() => undefined)
  return Boolean(info?.isDirectory() && !info.isSymbolicLink())
}

function smokePdf() {
  const content = "BT /F1 28 Tf 72 700 Td (HELLO) Tj ET"
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [4 0 R] >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ]
  const chunks = ["%PDF-1.7\n%\xE2\xE3\xCF\xD3\n"]
  const offsets = objects.map((object, index) => {
    const offset = Buffer.byteLength(chunks.join(""), "binary")
    chunks.push(`${index + 1} 0 obj\n${object}\nendobj\n`)
    return offset
  })
  const xref = Buffer.byteLength(chunks.join(""), "binary")
  chunks.push("xref\n0 6\n0000000000 65535 f \n")
  chunks.push(offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join(""))
  chunks.push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
  return Buffer.from(chunks.join(""), "binary")
}

async function documentRoots() {
  return (await readdir(os.tmpdir())).filter((entry) => entry.startsWith("opencode-document-")).sort()
}

function sameSet(left: ReadonlyArray<string>, right: ReadonlyArray<string>) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function samePath(left: string, right: string) {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex")
}

if (import.meta.main) {
  const target = requireNativeTarget()
  const artifactPath = process.env.KOALA_DOCUMENT_CONFINEMENT_INSTALLER_PATH ??
    (process.env.KOALA_DOCUMENT_CONFINEMENT_PACKAGE_DIR
      ? await locateInstaller(process.env.KOALA_DOCUMENT_CONFINEMENT_PACKAGE_DIR, target)
      : undefined)
  const reportPath = process.env.KOALA_DOCUMENT_CONFINEMENT_SMOKE_REPORT
  if (!artifactPath || !reportPath) throw new Error("Installed smoke artifact and report paths are required")
  await runInstalledDocumentRuntimeSmoke({
    target,
    artifactPath,
    reportPath,
    release: releaseIdentity(),
    verifyEvidence: process.env.KOALA_DOCUMENT_CONFINEMENT_VERIFY_INSTALLED === "1",
    installerVerifier: process.env.KOALA_DOCUMENT_CONFINEMENT_INSTALLER_VERIFIER,
  })
}
