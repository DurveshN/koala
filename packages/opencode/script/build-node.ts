#!/usr/bin/env bun

import { Script } from "@opencode-ai/script"
import { DocumentRuntimeTarget } from "@koala-ai/core/document-runtime/target"
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import fs from "node:fs/promises"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

const generated = await import("./generate.ts")
const target = buildTarget()
const nodeOutdir = path.resolve(process.env.OPENCODE_NODE_BUILD_DIR ?? "dist/node")
const sandboxOutdir = path.join(nodeOutdir, "sandbox-runtime")
await fs.rm(sandboxOutdir, { recursive: true, force: true })

const node = await Bun.build({
  target: "node",
  entrypoints: ["./src/node.ts"],
  outdir: nodeOutdir,
  format: "esm",
  sourcemap: "linked",
  external: ["jsonc-parser", "@lydell/node-pty"],
  define: {
    OPENCODE_MODELS_DEV: generated.modelsData,
    OPENCODE_VERSION: `'${Script.version}'`,
    OPENCODE_CHANNEL: `'${Script.channel}'`,
  },
  files: {
    "opencode-web-ui.gen.ts": "",
  },
})
if (!node.success) throw new AggregateError(node.logs, "Node build failed")

const sandbox = await Bun.build({
  target: "node",
  entrypoints: ["./src/sandbox/worker.ts"],
  outdir: sandboxOutdir,
  naming: "sandbox-worker.mjs",
  format: "esm",
  sourcemap: "none",
})
if (!sandbox.success) throw new AggregateError(sandbox.logs, "Sandbox worker build failed")
const documentProxy = await Bun.build({
  target: "node",
  entrypoints: ["./src/document/proxy.ts"],
  outdir: sandboxOutdir,
  naming: "document-runtime-proxy.mjs",
  format: "esm",
  minify: true,
  sourcemap: "none",
})
if (!documentProxy.success) throw new AggregateError(documentProxy.logs, "Document runtime proxy build failed")

const sandboxRuntime = fileURLToPath(import.meta.resolve("@anthropic-ai/sandbox-runtime"))
const sandboxPackage = path.resolve(path.dirname(sandboxRuntime), "..")
const vendor = path.join(sandboxPackage, "vendor")
const architecture = target.startsWith("x86_64-") ? "x64" : "arm64"
await Promise.all(
  [
    "java-proxy-agent/srt-proxy-agent.jar",
    ...(target.includes("linux") ? [`seccomp/${architecture}/apply-seccomp`] : []),
    ...(target.includes("windows") ? [`srt-win/${architecture}/srt-win.exe`] : []),
  ].map((name) =>
    copyAsset(path.join(vendor, name), path.join(sandboxOutdir, "vendor", name), executable(name) ? 0o755 : 0o644),
  ),
)
await copyAsset(path.join(sandboxPackage, "LICENSE"), path.join(sandboxOutdir, "LICENSE"), 0o644)
const files = await Promise.all(
  (await listFiles(sandboxOutdir)).map(async (name) => {
    const file = path.join(sandboxOutdir, ...name.split("/"))
    const mode = executable(name) ? 0o755 : 0o644
    await fs.chmod(file, mode)
    const info = await fs.stat(file)
    return {
      path: name,
      sha256: await hashFile(file),
      bytes: info.size,
      mode,
    }
  }),
)
await fs.writeFile(
  path.join(sandboxOutdir, "sandbox-runtime.manifest.json"),
  `${JSON.stringify({ manifestVersion: 1, target, files }, null, 2)}\n`,
  { mode: 0o644, flag: "wx" },
)

console.log("Build complete")

async function copyAsset(source: string, target: string, mode: number) {
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.copyFile(source, target)
  await fs.chmod(target, mode)
}

function buildTarget(): DocumentRuntimeTarget.Target {
  const configured = process.env.RUST_TARGET
  if (configured !== undefined) {
    const target = DocumentRuntimeTarget.Targets.find((target) => target === configured)
    if (target) return target
    throw new Error("RUST_TARGET must identify a supported sandbox runtime target")
  }
  if (process.platform !== "darwin" && process.platform !== "linux" && process.platform !== "win32") {
    throw new Error("Unsupported sandbox runtime platform")
  }
  if (process.arch !== "x64" && process.arch !== "arm64") throw new Error("Unsupported sandbox runtime architecture")
  return DocumentRuntimeTarget.fromHost(process.platform, process.arch)
}

async function listFiles(directory: string, relative = ""): Promise<string[]> {
  const entries = await fs.readdir(path.join(directory, ...relative.split("/").filter(Boolean)), { withFileTypes: true })
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

async function hashFile(file: string) {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest("hex")
}

function executable(file: string) {
  return file.endsWith(".exe") || file.endsWith("/apply-seccomp")
}
