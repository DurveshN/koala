#!/usr/bin/env bun

import { Script } from "@opencode-ai/script"
import fs from "node:fs/promises"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

const generated = await import("./generate.ts")

const node = await Bun.build({
  target: "node",
  entrypoints: ["./src/node.ts"],
  outdir: "./dist/node",
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

const sandboxOutdir = path.resolve("dist/node/sandbox-runtime")
await fs.rm(sandboxOutdir, { recursive: true, force: true })
const sandbox = await Bun.build({
  target: "node",
  entrypoints: ["./src/sandbox/worker.ts"],
  outdir: sandboxOutdir,
  naming: "sandbox-worker.mjs",
  format: "esm",
  sourcemap: "linked",
})
if (!sandbox.success) throw new AggregateError(sandbox.logs, "Sandbox worker build failed")

const sandboxRuntime = fileURLToPath(import.meta.resolve("@anthropic-ai/sandbox-runtime"))
const sandboxPackage = path.resolve(path.dirname(sandboxRuntime), "..")
const vendor = path.join(sandboxPackage, "vendor")
await Promise.all(
  [
    "java-proxy-agent/srt-proxy-agent.jar",
    "seccomp/arm64/apply-seccomp",
    "seccomp/x64/apply-seccomp",
    "srt-win/arm64/srt-win.exe",
    "srt-win/x64/srt-win.exe",
  ].map((name) => copyAsset(path.join(vendor, name), path.join(sandboxOutdir, "vendor", name))),
)
await copyAsset(path.join(sandboxPackage, "LICENSE"), path.join(sandboxOutdir, "LICENSE"))

console.log("Build complete")

async function copyAsset(source: string, target: string) {
  const stat = await fs.stat(source)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.copyFile(source, target)
  await fs.chmod(target, stat.mode)
}
