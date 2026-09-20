import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const targets = [
  "x86_64-apple-darwin",
  "aarch64-apple-darwin",
  "x86_64-pc-windows-msvc",
  "aarch64-pc-windows-msvc",
  "x86_64-unknown-linux-gnu",
  "aarch64-unknown-linux-gnu",
] as const

type WorkerModule = {
  readonly startWorkerProcess: (environment: NodeJS.ProcessEnv) => unknown
}

export function bootstrapEnvironment(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform) {
  const runtimeRoot = requirePath(environment.DOCUMENT_RUNTIME_ROOT, platform)
  const jobRoot = requirePath(environment.DOCUMENT_JOB_ROOT, platform)
  const target = environment.DOCUMENT_RUNTIME_TARGET
  const manifestSha256 = environment.DOCUMENT_RUNTIME_MANIFEST_SHA256
  if (!target || !targets.some((value) => value === target)) throw new Error("invalid-target")
  const validatedTarget = target as (typeof targets)[number]
  if (targetPlatform(validatedTarget) !== platform) throw new Error("invalid-target")
  if (!manifestSha256 || !/^[a-f0-9]{64}$/.test(manifestSha256)) throw new Error("invalid-manifest-digest")

  const clean: Record<string, string> = {
    DISABLE_SYSTEM_FONTS_LOAD: "1",
    DOCUMENT_JOB_ROOT: jobRoot,
    DOCUMENT_RUNTIME_MANIFEST_SHA256: manifestSha256,
    DOCUMENT_RUNTIME_ROOT: runtimeRoot,
    DOCUMENT_RUNTIME_TARGET: validatedTarget,
    ELECTRON_RUN_AS_NODE: "1",
    LANG: "C",
    LC_ALL: "C",
    TEMP: pathFor(platform).join(jobRoot, "tmp"),
    TMP: pathFor(platform).join(jobRoot, "tmp"),
    TMPDIR: pathFor(platform).join(jobRoot, "tmp"),
    TZ: "UTC",
  }
  if (platform !== "win32") return clean

  const systemRoot = requirePath(environment.SystemRoot, platform)
  const windir = requirePath(environment.WINDIR, platform)
  if (systemRoot.toLowerCase() !== windir.toLowerCase()) throw new Error("invalid-system-root")
  return { ...clean, SystemRoot: systemRoot, WINDIR: systemRoot }
}

export async function runBootstrap(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  loadWorker: (url: string) => Promise<WorkerModule> = (url) => import(url),
) {
  const clean = bootstrapEnvironment(environment, platform)
  const worker = pathFor(platform).join(clean.DOCUMENT_RUNTIME_ROOT, "worker", "worker.js")
  for (const key of Object.keys(environment)) delete environment[key]
  Object.assign(environment, clean)
  const module = await loadWorker(pathToFileURL(worker).href)
  if (typeof module.startWorkerProcess !== "function") throw new Error("invalid-worker-module")
  return module.startWorkerProcess(environment)
}

function requirePath(value: string | undefined, platform: NodeJS.Platform) {
  if (!value || value.includes("\0")) throw new Error("invalid-path")
  const paths = pathFor(platform)
  if (!paths.isAbsolute(value) || paths.normalize(value) !== value) throw new Error("invalid-path")
  return value
}

function pathFor(platform: NodeJS.Platform) {
  return platform === "win32" ? path.win32 : path.posix
}

function targetPlatform(target: (typeof targets)[number]) {
  if (target.includes("windows")) return "win32"
  if (target.includes("apple")) return "darwin"
  return "linux"
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runBootstrap()
