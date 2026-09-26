#!/usr/bin/env bun
import { fileURLToPath } from "node:url"
import fs from "node:fs"
import path from "node:path"

console.log("Testing sandbox path resolution...\n")

// Simulate what happens in worker.ts
const moduleURL = import.meta.url
console.log("1. import.meta.url:", moduleURL)

const adjacent = fileURLToPath(new URL("./vendor/", moduleURL))
console.log("2. Adjacent vendor path:", adjacent)
console.log("   Exists?", fs.existsSync(adjacent))

// Try the fallback
try {
  const runtimePath = fileURLToPath(import.meta.resolve("@anthropic-ai/sandbox-runtime"))
  console.log("\n3. @anthropic-ai/sandbox-runtime resolved to:", runtimePath)
  
  const vendorFallback = path.resolve(path.dirname(runtimePath), "../vendor")
  console.log("4. Vendor fallback path:", vendorFallback)
  console.log("   Exists?", fs.existsSync(vendorFallback))
  
  if (fs.existsSync(vendorFallback)) {
    const srtWinPath = path.join(vendorFallback, "srt-win", "x64", "srt-win.exe")
    console.log("\n5. srt-win.exe path:", srtWinPath)
    console.log("   Exists?", fs.existsSync(srtWinPath))
  }
} catch (error) {
  console.log("\n3. Failed to resolve @anthropic-ai/sandbox-runtime:", error)
}

// Check if the sandbox runtime vendor exists in the built location
const distVendor = path.resolve("dist/node/sandbox-runtime/vendor/srt-win/x64/srt-win.exe")
console.log("\n6. Dist sandbox runtime:", distVendor)
console.log("   Exists?", fs.existsSync(distVendor))

// Check desktop resources location
const desktopVendor = path.resolve("../desktop/out/main/resources/sandbox-runtime/vendor/srt-win/x64/srt-win.exe")
console.log("\n7. Desktop resources:", desktopVendor)
console.log("   Exists?", fs.existsSync(desktopVendor))
