#!/usr/bin/env bun
import { fileURLToPath } from "node:url"
import fs from "node:fs"
import path from "node:path"
import { SandboxWorker } from "./src/sandbox/worker.ts"

console.log("=== Debugging Sandbox Worker Availability ===\n")

// Test asset resolution
console.log("1. Testing resolveSandboxAssets:")
const moduleURL = import.meta.url
const assets = SandboxWorker.resolveSandboxAssets(moduleURL, "win32", "x64")

console.log("   Module URL:", moduleURL)
console.log("   Java Agent JAR:", assets.javaAgentJarPath)
console.log("     Exists?", fs.existsSync(assets.javaAgentJarPath))

if (assets.srtWinPath) {
  console.log("   SRT-Win Path:", assets.srtWinPath)
  console.log("     Exists?", fs.existsSync(assets.srtWinPath))
}

// Test if we can create a config
console.log("\n2. Testing strictConfig creation:")
try {
  const config = SandboxWorker.strictConfig(
    {
      command: "test",
      cwd: process.cwd(),
      readRoots: [],
      writeRoots: [],
      env: {},
      network: [],
      timeoutMs: 1000,
      maxOutputBytes: 1024,
    },
    "win32",
    assets,
  )
  
  console.log("   Config created successfully ✅")
  if (config.windows?.srtWin?.path) {
    console.log("   Windows SRT-Win path in config:", config.windows.srtWin.path)
    console.log("     Exists?", fs.existsSync(config.windows.srtWin.path))
  } else {
    console.log("   ❌ No windows.srtWin.path in config!")
  }
} catch (error) {
  console.log("   ❌ Failed to create config:", error)
}

// Now test availability with our own dependencies
console.log("\n3. Testing availability with real sandbox manager:")
const result = await SandboxWorker.availability()
console.log("   Status:", result.availability.status)
if (result.availability.status === "unavailable") {
  console.log("   Reason:", result.availability.reason)
}
