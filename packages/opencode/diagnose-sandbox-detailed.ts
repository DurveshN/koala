import { SandboxManager } from "@anthropic-ai/sandbox-runtime"
import { resolveSandboxAssets } from "./src/sandbox/worker"
import { strictConfig } from "./src/sandbox/worker"

console.log("=" * 70)
console.log("DETAILED SANDBOX DIAGNOSTICS")
console.log("=" * 70)
console.log()

// Step 1: Check platform support
console.log("Step 1: Platform Support")
console.log("-".repeat(70))
const platform = process.platform
const arch = process.arch
console.log("  Platform:", platform)
console.log("  Architecture:", arch)
console.log("  Supported?", SandboxManager.isSupportedPlatform())
console.log()

if (!SandboxManager.isSupportedPlatform()) {
  console.log("❌ Platform not supported. This is the root cause.")
  console.log("Supported platforms: Windows (x64/arm64), macOS (x64/arm64), Linux (x64/arm64)")
  process.exit(1)
}

// Step 2: Check sandbox assets
console.log("Step 2: Sandbox Assets")
console.log("-".repeat(70))
const assets = resolveSandboxAssets(import.meta.url, platform, arch)
console.log("  Assets resolved:")
console.log("    Java agent JAR:", assets.javaAgentJarPath)
if (platform === "linux") console.log("    Seccomp apply:", assets.seccompApplyPath)
if (platform === "win32") console.log("    SRT-Win:", assets.srtWinPath)
console.log()

// Verify files exist
const fs = await import("node:fs")

console.log("  File existence checks:")
if (assets.javaAgentJarPath) {
  const javaExists = fs.existsSync(assets.javaAgentJarPath)
  console.log("    Java agent JAR:", javaExists ? "✅ EXISTS" : "❌ MISSING")
  if (!javaExists) {
    console.log("      Expected:", assets.javaAgentJarPath)
  }
}

if (platform === "win32" && assets.srtWinPath) {
  const srtExists = fs.existsSync(assets.srtWinPath)
  console.log("    SRT-Win:", srtExists ? "✅ EXISTS" : "❌ MISSING")
  if (!srtExists) {
    console.log("      Expected:", assets.srtWinPath)
  }
}

if (platform === "linux" && assets.seccompApplyPath) {
  const seccompExists = fs.existsSync(assets.seccompApplyPath)
  console.log("    Seccomp:", seccompExists ? "✅ EXISTS" : "❌ MISSING")
  if (!seccompExists) {
    console.log("      Expected:", assets.seccompApplyPath)
  }
}
console.log()

// Step 3: Check dependencies
console.log("Step 3: Check Dependencies")
console.log("-".repeat(70))

try {
  const result = await SandboxManager.checkDependenciesAsync()
  
  console.log("  Errors:", result.errors.length)
  if (result.errors.length > 0) {
    console.log()
    for (const error of result.errors) {
      console.log("    ❌", error)
    }
  }
  
  console.log()
  console.log("  Warnings:", result.warnings?.length ?? 0)
  if (result.warnings && result.warnings.length > 0) {
    console.log()
    for (const warning of result.warnings) {
      console.log("    ⚠️ ", warning)
    }
  }
  
  console.log()
  if (result.errors.length > 0) {
    console.log("❌ DEPENDENCIES CHECK FAILED")
    console.log()
    console.log("This is the root cause. The sandbox needs:")
    console.log()
    
    if (platform === "win32") {
      console.log("Windows Requirements:")
      console.log("  1. A dedicated Windows user account for sandboxing")
      console.log("     - Created by elevated 'windows-install' script")
      console.log("     - Used to run isolated processes")
      console.log()
      console.log("  2. Windows Filtering Platform (WFP) filters")
      console.log("     - Network traffic filtering rules")
      console.log("     - Configured by 'windows-install' script")
      console.log()
      console.log("  3. All required executables accessible")
      console.log("     - srt-win.exe must be in vendor directory")
      console.log("     - Java proxy agent JAR must exist")
      console.log()
      console.log("To fix:")
      console.log("  - Run the @anthropic-ai/sandbox-runtime windows-install script")
      console.log("  - Requires administrator/elevated privileges")
      console.log("  - Creates the sandbox user and configures WFP")
    } else if (platform === "linux") {
      console.log("Linux Requirements:")
      console.log("  1. bubblewrap installed")
      console.log("  2. socat installed")
      console.log("  3. ripgrep installed")
      console.log("  4. AppArmor profile OR privileged sysctl for user namespaces")
      console.log()
      console.log("To fix:")
      console.log("  sudo apt-get install bubblewrap socat ripgrep")
    } else if (platform === "darwin") {
      console.log("macOS Requirements:")
      console.log("  1. System Integrity Protection considerations")
      console.log("  2. All vendor executables must be accessible")
    }
  } else {
    console.log("✅ DEPENDENCIES CHECK PASSED")
  }
  
} catch (error) {
  console.log("❌ Failed to check dependencies")
  console.error(error)
}
console.log()

// Step 4: Try initialization
console.log("Step 4: Try Initialization")
console.log("-".repeat(70))

try {
  const config = strictConfig(
    {
      command: "test",
      cwd: process.cwd(),
      readRoots: [],
      writeRoots: [],
      env: {},
      network: [],
      timeoutMs: 1000,
      maxOutputBytes: 1000,
    },
    platform,
    assets,
  )
  
  console.log("  Attempting to initialize sandbox...")
  await SandboxManager.initialize(config, undefined, false)
  console.log("  ✅ Initialization succeeded!")
  
  await SandboxManager.reset()
  
} catch (error: any) {
  console.log("  ❌ Initialization failed")
  console.log()
  console.log("  Error:", error.message)
  console.log()
  console.log("This is likely because:")
  if (platform === "win32") {
    console.log("  - Windows sandbox user account not created")
    console.log("  - WFP filters not configured")
    console.log("  - srt-win.exe can't execute or missing prerequisites")
  }
  console.log()
  console.log("The sandbox initialization calls the underlying OS-level")
  console.log("sandboxing mechanisms which require specific setup.")
}

console.log()
console.log("=" * 70)
console.log("SUMMARY")
console.log("=" * 70)
console.log()
console.log("The sandbox is failing NOT because it's running locally.")
console.log("It's designed to work locally but requires OS-level setup:")
console.log()
if (platform === "win32") {
  console.log("On Windows:")
  console.log("  • Needs a dedicated sandbox user account")
  console.log("  • Needs Windows Filtering Platform filters")
  console.log("  • These are created by an elevated install script")
  console.log("  • Without these, the sandbox cannot initialize")
}
console.log()
console.log("This is NOT about local vs. remote - it's about:")
console.log("  • OS-level process isolation")
console.log("  • Security boundaries")
console.log("  • Privileged system configuration")
console.log()
console.log("The sandbox WILL work locally once prerequisites are installed.")
