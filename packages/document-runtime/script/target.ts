import { DocumentRuntimeTarget } from "@koala-ai/core/document-runtime/target"
import { Schema } from "effect"

const decodeTarget = Schema.decodeUnknownSync(DocumentRuntimeTarget.Target)

export function requestedTarget(
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
) {
  const index = args.indexOf("--target")
  const explicit = index === -1 ? undefined : decodeTarget(args[index + 1])
  const rust = environment.RUST_TARGET ? decodeTarget(environment.RUST_TARGET) : undefined
  if (explicit && rust && explicit !== rust) throw new Error("--target must match RUST_TARGET")
  if ((environment.OPENCODE_CHANNEL || environment.OPENCODE_VERSION) && !rust) {
    throw new Error("Release/channel document runtime builds require RUST_TARGET")
  }
  return explicit ?? rust ?? hostTarget(platform, architecture)
}

function hostTarget(platform: NodeJS.Platform, architecture: string) {
  if (platform !== "darwin" && platform !== "win32" && platform !== "linux") {
    throw new Error("Unsupported build platform")
  }
  if (architecture !== "x64" && architecture !== "arm64") throw new Error("Unsupported build architecture")
  return DocumentRuntimeTarget.fromHost(platform, architecture)
}
