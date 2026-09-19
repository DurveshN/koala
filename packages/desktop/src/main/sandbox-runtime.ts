import path from "node:path"
import { fileURLToPath } from "node:url"

export function resolveSandboxWorkerPath(input: {
  readonly packaged: boolean
  readonly resourcesPath: string
  readonly moduleURL: string
}) {
  if (input.packaged) return path.join(input.resourcesPath, "sandbox-runtime", "sandbox-worker.mjs")
  const desktop = path.resolve(path.dirname(fileURLToPath(input.moduleURL)), "../..")
  return path.resolve(desktop, "../opencode/dist/node/sandbox-runtime/sandbox-worker.mjs")
}
