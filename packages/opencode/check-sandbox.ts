import { SandboxManager } from "@anthropic-ai/sandbox-runtime"

console.log("Checking sandbox configuration...\n")

// Check platform support
console.log("1. Platform Support:")
const supported = SandboxManager.isSupportedPlatform()
console.log(`   Platform: ${process.platform}`)
console.log(`   Supported: ${supported}`)

if (!supported) {
  console.log("\n❌ Platform not supported")
  process.exit(1)
}

// Check dependencies
console.log("\n2. Checking Dependencies:")
try {
  const deps = await SandboxManager.checkDependenciesAsync()
  
  if (deps.errors.length > 0) {
    console.log("   ❌ Errors found:")
    for (const error of deps.errors) {
      console.log(`      - ${error}`)
    }
  } else {
    console.log("   ✅ No errors")
  }
  
  if (deps.warnings && deps.warnings.length > 0) {
    console.log("   ⚠️  Warnings:")
    for (const warning of deps.warnings) {
      console.log(`      - ${warning}`)
    }
  }
  
  if (deps.errors.length === 0 && (!deps.warnings || deps.warnings.length === 0)) {
    console.log("\n✅ SANDBOX IS AVAILABLE!")
  } else if (deps.errors.length > 0) {
    console.log("\n❌ SANDBOX IS NOT AVAILABLE - Errors must be resolved")
  } else {
    console.log("\n⚠️  SANDBOX MAY HAVE ISSUES - Check warnings")
  }
} catch (error) {
  console.log(`   ❌ Error checking dependencies: ${error}`)
  process.exit(1)
}
