import { spawn } from "node:child_process"
import path from "node:path"

const scenario = process.argv[2]
const outputTarget = process.argv[4]
if (!scenario) process.exit(2)

if (process.argv[3] === "--version") {
  if (scenario === "probe-success") {
    process.stdout.write("tesseract 5.5.3\n leptonica-1.85.0\n")
    process.exit(0)
  }
  if (scenario === "probe-malformed") {
    process.stdout.write("tesseract 5.5\n")
    process.exit(0)
  }
  if (scenario === "probe-failure") {
    process.stderr.write("private-version-error")
    process.exit(7)
  }
  if (scenario === "probe-overflow") {
    process.stdout.write("x".repeat(128 * 1024))
    setInterval(() => undefined, 1_000)
  }
  if (scenario === "probe-hang") {
    const marker = path.join(process.cwd(), "probe.marker")
    spawn(process.execPath, ["-e", `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'alive'), 500)`], {
      stdio: "ignore",
    }).unref()
    setInterval(() => undefined, 1_000)
  }
  process.exit(2)
}

if (outputTarget !== "stdout") process.exit(2)

if (scenario === "success") {
  process.stdout.write("level\tpage_num\ttext\n5\t1\tHELLO\n")
  process.exit(0)
}
if (scenario === "failure") {
  process.stderr.write("private-native-error")
  process.exit(7)
}
if (scenario === "stderr-overflow") {
  process.stderr.write("x".repeat(128 * 1024))
  setInterval(() => undefined, 1_000)
}
if (scenario === "tsv-overflow") {
  process.stdout.write("x".repeat(128 * 1024))
  setInterval(() => undefined, 1_000)
}
if (scenario === "timeout-tree") {
  const marker = path.join(process.cwd(), "output.marker")
  spawn(
    process.execPath,
    ["-e", `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'alive'), 500)`],
    {
      stdio: "ignore",
    },
  ).unref()
  setInterval(() => undefined, 1_000)
}
