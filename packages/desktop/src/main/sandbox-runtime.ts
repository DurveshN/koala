import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { lstat, opendir, readFile, realpath } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ManifestName = "sandbox-runtime.manifest.json"
const MaxManifestBytes = 1024 * 1024
const Pe32PlusMinimumOptionalHeaderBytes = 0x70
const targets = [
  "x86_64-apple-darwin",
  "aarch64-apple-darwin",
  "x86_64-pc-windows-msvc",
  "aarch64-pc-windows-msvc",
  "x86_64-unknown-linux-gnu",
  "aarch64-unknown-linux-gnu",
] as const

export type SandboxRuntimeTarget = (typeof targets)[number]

export type ResolvedSandboxRuntime = {
  readonly root: string
  readonly workerPath: string
  readonly documentProxyPath: string
  readonly documentProxySha256: string
  readonly manifestSha256: string
  readonly target: SandboxRuntimeTarget
}

type SandboxRuntimeManifest = {
  readonly manifestVersion: 1
  readonly target: SandboxRuntimeTarget
  readonly files: ReadonlyArray<{
    readonly path: string
    readonly sha256: string
    readonly bytes: number
    readonly mode: number
  }>
}

export async function resolveSandboxRuntime(input: {
  readonly packaged: boolean
  readonly resourcesPath: string
  readonly moduleURL: string
  readonly platform?: NodeJS.Platform
  readonly architecture?: string
}): Promise<ResolvedSandboxRuntime | undefined> {
  const target = hostTarget(input.platform ?? process.platform, input.architecture ?? process.arch)
  if (!target) return undefined
  const desktop = path.resolve(path.dirname(fileURLToPath(input.moduleURL)), "../..")
  try {
    if (input.packaged) {
      const resources = await canonicalDirectory(input.resourcesPath)
      return await verifySandboxRuntimeRoot(path.join(resources, "sandbox-runtime"), target)
    }
    return await verifySandboxRuntimeRoot(path.resolve(desktop, "../opencode/dist/node/sandbox-runtime"), target)
  } catch {
    return undefined
  }
}

export async function verifySandboxRuntimeRoot(
  root: string,
  expectedTarget: SandboxRuntimeTarget,
): Promise<ResolvedSandboxRuntime> {
  const canonicalRoot = await canonicalDirectory(root)
  const manifestPath = path.join(canonicalRoot, ManifestName)
  const manifestInfo = await lstat(manifestPath)
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.size > MaxManifestBytes) {
    throw new Error("Invalid sandbox runtime manifest")
  }
  const manifestBytes = await readFile(manifestPath)
  if (manifestBytes.byteLength !== manifestInfo.size) throw new Error("Invalid sandbox runtime manifest")
  const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex")
  const manifest = decodeManifest(JSON.parse(manifestBytes.toString("utf8")))
  if (manifest.target !== expectedTarget) throw new Error("Sandbox runtime target mismatch")
  const expected = expectedFiles(expectedTarget)
  if (
    manifest.files.length !== expected.length ||
    manifest.files.some((file) => !expected.includes(file.path)) ||
    manifest.files.some((file) => file.mode !== requiredMode(file.path)) ||
    new Set(manifest.files.map((file) => file.path)).size !== manifest.files.length
  ) {
    throw new Error("Sandbox runtime file inventory mismatch")
  }
  const actual = await listFiles(canonicalRoot)
  if (
    actual.length !== expected.length + 1 ||
    actual.some((file) => file !== ManifestName && !expected.includes(file))
  ) {
    throw new Error("Sandbox runtime contains unexpected files")
  }
  await Promise.all(
    manifest.files.map(async (file) => {
      const absolute = path.join(canonicalRoot, ...file.path.split("/"))
      if (!inside(canonicalRoot, absolute)) throw new Error("Sandbox runtime file escaped its root")
      const info = await lstat(absolute)
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size !== file.bytes ||
        (!expectedTarget.includes("windows") && (info.mode & 0o777) !== requiredMode(file.path)) ||
        (await hashFile(absolute)) !== file.sha256
      ) {
        throw new Error("Sandbox runtime file mismatch")
      }
    }),
  )
  await verifyHelperArchitecture(canonicalRoot, expectedTarget)
  const documentProxy = manifest.files.find((file) => file.path === "document-runtime-proxy.mjs")
  if (!documentProxy) throw new Error("Document proxy is absent from sandbox runtime manifest")
  return {
    root: canonicalRoot,
    workerPath: path.join(canonicalRoot, "sandbox-worker.mjs"),
    documentProxyPath: path.join(canonicalRoot, "document-runtime-proxy.mjs"),
    documentProxySha256: documentProxy.sha256,
    manifestSha256,
    target: expectedTarget,
  }
}

export function hostTarget(platform: NodeJS.Platform, architecture: string): SandboxRuntimeTarget | undefined {
  if (platform === "darwin" && architecture === "x64") return "x86_64-apple-darwin"
  if (platform === "darwin" && architecture === "arm64") return "aarch64-apple-darwin"
  if (platform === "win32" && architecture === "x64") return "x86_64-pc-windows-msvc"
  if (platform === "win32" && architecture === "arm64") return "aarch64-pc-windows-msvc"
  if (platform === "linux" && architecture === "x64") return "x86_64-unknown-linux-gnu"
  if (platform === "linux" && architecture === "arm64") return "aarch64-unknown-linux-gnu"
}

function decodeManifest(input: unknown): SandboxRuntimeManifest {
  if (!record(input) || !exactKeys(input, ["manifestVersion", "target", "files"])) {
    throw new Error("Invalid sandbox runtime manifest")
  }
  if (input.manifestVersion !== 1 || !targets.some((target) => target === input.target) || !Array.isArray(input.files)) {
    throw new Error("Invalid sandbox runtime manifest")
  }
  const files = input.files.map((file) => {
    if (!record(file) || !exactKeys(file, ["path", "sha256", "bytes", "mode"])) {
      throw new Error("Invalid sandbox runtime manifest")
    }
    if (
      typeof file.path !== "string" ||
      !/^[A-Za-z0-9@._+-]+(?:\/[A-Za-z0-9@._+-]+)*$/.test(file.path) ||
      typeof file.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      typeof file.bytes !== "number" ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      typeof file.mode !== "number" ||
      !Number.isSafeInteger(file.mode) ||
      file.mode < 0 ||
      file.mode > 0o777
    ) {
      throw new Error("Invalid sandbox runtime manifest")
    }
    return { path: file.path, sha256: file.sha256, bytes: file.bytes, mode: file.mode }
  })
  return { manifestVersion: 1, target: input.target as SandboxRuntimeTarget, files }
}

function expectedFiles(target: SandboxRuntimeTarget) {
  const architecture = target.startsWith("x86_64-") ? "x64" : "arm64"
  return [
    "LICENSE",
    "document-runtime-proxy.mjs",
    "sandbox-worker.mjs",
    "vendor/java-proxy-agent/srt-proxy-agent.jar",
    ...(target.includes("linux") ? [`vendor/seccomp/${architecture}/apply-seccomp`] : []),
    ...(target.includes("windows") ? [`vendor/srt-win/${architecture}/srt-win.exe`] : []),
  ]
}

async function verifyHelperArchitecture(root: string, target: SandboxRuntimeTarget) {
  const architecture = target.startsWith("x86_64-") ? "x64" : "arm64"
  if (target.includes("windows")) {
    verifyNativeHelperArchitecture(
      await readFile(path.join(root, "vendor", "srt-win", architecture, "srt-win.exe")),
      target,
    )
  }
  if (target.includes("linux")) {
    verifyNativeHelperArchitecture(
      await readFile(path.join(root, "vendor", "seccomp", architecture, "apply-seccomp")),
      target,
    )
  }
}

export function verifyNativeHelperArchitecture(bytes: Buffer, target: SandboxRuntimeTarget) {
  const architecture = target.startsWith("x86_64-") ? "x64" : "arm64"
  if (target.includes("windows")) {
    if (bytes.length < 64 || bytes.toString("ascii", 0, 2) !== "MZ") throw new Error("Invalid SRT helper")
    const header = bytes.readUInt32LE(0x3c)
    const coffEnd = header + 24
    if (header < 64 || coffEnd > bytes.length || bytes.toString("binary", header, header + 4) !== "PE\0\0") {
      throw new Error("Invalid SRT helper")
    }
    if (bytes.readUInt16LE(header + 4) !== (architecture === "x64" ? 0x8664 : 0xaa64)) {
      throw new Error("SRT helper architecture mismatch")
    }
    const optionalHeaderBytes = bytes.readUInt16LE(header + 20)
    const optionalHeader = coffEnd
    if (
      optionalHeaderBytes < Pe32PlusMinimumOptionalHeaderBytes ||
      optionalHeaderBytes > bytes.length - optionalHeader
    ) {
      throw new Error("Invalid SRT helper")
    }
    if (
      bytes.readUInt16LE(optionalHeader) !== 0x20b ||
      (bytes.readUInt16LE(header + 22) & 0x0002) === 0
    ) {
      throw new Error("Invalid SRT helper")
    }
  }
  if (target.includes("linux")) {
    if (
      bytes.length < 20 ||
      !bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
      bytes[4] !== 2 ||
      bytes[5] !== 1 ||
      bytes[6] !== 1
    ) {
      throw new Error("Invalid SRT helper")
    }
    if (bytes.readUInt16LE(18) !== (architecture === "x64" ? 62 : 183)) {
      throw new Error("SRT helper architecture mismatch")
    }
  }
}

function requiredMode(file: string) {
  return file.endsWith(".exe") || file.endsWith("/apply-seccomp") ? 0o755 : 0o644
}

async function canonicalDirectory(value: string) {
  if (!path.isAbsolute(value)) throw new Error("Sandbox runtime path must be absolute")
  const info = await lstat(value)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Invalid sandbox runtime directory")
  return realpath(value)
}

async function listFiles(root: string) {
  const directories = [""]
  const files: string[] = []
  while (directories.length > 0) {
    const relative = directories.pop() ?? ""
    const directory = await opendir(path.join(root, ...relative.split("/").filter(Boolean)))
    for await (const entry of directory) {
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
        throw new Error("Invalid sandbox runtime entry")
      }
      const item = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) directories.push(item)
      else files.push(item)
    }
  }
  return files.sort()
}

async function hashFile(file: string) {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest("hex")
}

function record(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

function exactKeys(input: Record<string, unknown>, expected: ReadonlyArray<string>) {
  const keys = Object.keys(input)
  return keys.length === expected.length && keys.every((key) => expected.includes(key))
}

function inside(root: string, value: string) {
  const relation = path.relative(root, value)
  return relation === "" || (!relation.startsWith(`..${path.sep}`) && relation !== ".." && !path.isAbsolute(relation))
}
