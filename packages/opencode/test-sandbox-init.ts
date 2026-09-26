#!/usr/bin/env bun
import { SandboxManager } from "@anthropic-ai/sandbox-runtime"
import { SandboxWorker } from "./src/sandbox/worker.ts"
import { Schema } from "effect"
import { SandboxProtocol } from "@koala-ai/core/sandbox/protocol"

console.log("=== Testing Sandbox Initialization ===\n")

// Get assets
const moduleURL = import.meta.url
const assets = SandboxWorker.resolveSandboxAssets(moduleURL, "win32", "x64")

console.log("1. Assets:")
console.log("   Java Agent:", assets.javaAgentJarPath)
console.log("   SRT-Win:", assets.srtWinPath)

// Create config
const decodeAbsolutePath = Schema.decodeUnknownSync(SandboxProtocol.AbsolutePath)
const cwd = decodeAbsolutePath(process.cwd())

const config = SandboxWorker.strictConfig(
  {
    command: "test",
    cwd,
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

console.log("\n2. Config created ✅")
console.log("   SRT-Win in config:", config.windows?.srtWin?.path)

// Try to initialize
console.log("\n3. Attempting initialize...")
try {
  await SandboxManager.initialize(config, undefined, false)
  console.log("   ✅ Initialize succeeded!")
  
  // Now check dependencies
  console.log("\n4. Checking dependencies after init...")
  const deps = await SandboxManager.checkDependenciesAsync()
  
  if (deps.errors.length > 0) {
    console.log("   ❌ Dependency errors:")
    for (const error of deps.errors) {
      console.log("      -", error)
    }
  } else {
    console.log("   ✅ No dependency errors")
  }
  
  if (deps.warnings && deps.warnings.length > 0) {
    console.log("   ⚠️  Warnings:")
    for (const warning of deps.warnings) {
      console.log("      -", warning)
    }
  }
  
  // Cleanup
  console.log("\n5. Cleaning up...")
  SandboxManager.cleanupAfterCommand()
  await SandboxManager.reset()
  console.log("   ✅ Cleanup succeeded")
  
  console.log("\n✅ SANDBOX IS FULLY FUNCTIONAL!")
} catch (error) {
  console.log("   ❌ Initialize failed with error:")
  console.log("      ", error)
  console.log("\n   Error details:")
  if (error instanceof Error) {
    console.log("      Message:", error.message)
    console.log("      Stack:", error.stack?.split('\n').slice(0, 5).join('\n      '))
  }
}
