import { SandboxWorker } from "./src/sandbox/worker.ts"

console.log("Checking sandbox availability (full flow)...\n")

// This tests the actual availability check that the app uses
const result = await SandboxWorker.availability()

console.log("Sandbox Availability Result:")
console.log(JSON.stringify(result, null, 2))

if (result.availability.status === "available") {
  console.log("\n✅ SANDBOX IS AVAILABLE!")
} else {
  console.log(`\n❌ SANDBOX IS NOT AVAILABLE`)
  console.log(`   Reason: ${result.availability.reason}`)
  
  if (result.availability.reason === "initialization-failed") {
    console.log("\n   This usually means:")
    console.log("   - srt-win.exe path could not be resolved")
    console.log("   - Sandbox user not created")
    console.log("   - Windows Filtering Platform not configured")
    console.log("\n   To fix, run as Administrator:")
    console.log("   npx sandbox-runtime windows-install")
  }
}
