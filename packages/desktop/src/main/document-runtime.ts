import {
  loadAndVerifyManifest,
  loadAndVerifyProductionManifest,
  loadTrustedAttestation,
} from "@koala-ai/document-runtime/manifest"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const DOCUMENT_RUNTIME_PATH = "KOALA_DOCUMENT_RUNTIME_PATH"
export const DOCUMENT_RUNTIME_MANIFEST_SHA256 = "KOALA_DOCUMENT_RUNTIME_MANIFEST_SHA256"
export const DOCUMENT_RUNTIME_REQUIRE_RELEASE_READY = "KOALA_DOCUMENT_RUNTIME_REQUIRE_RELEASE_READY"
export const DOCUMENT_RUNTIME_OVERRIDE = "KOALA_DOCUMENT_RUNTIME_OVERRIDE"
export const DOCUMENT_RUNTIME_RELEASE_ROOT = "KOALA_DOCUMENT_RUNTIME_RELEASE_ROOT"
export const DOCUMENT_RUNTIME_ATTESTATION = "KOALA_DOCUMENT_RUNTIME_ATTESTATION"

export type ResolvedDocumentRuntime = {
  readonly root: string
  readonly manifestSha256: string
  readonly releaseReady: boolean
}

export async function resolveDocumentRuntime(input: {
  readonly packaged: boolean
  readonly resourcesPath: string
  readonly moduleURL: string
  readonly environment?: NodeJS.ProcessEnv
  readonly platform?: NodeJS.Platform
  readonly architecture?: string
}): Promise<ResolvedDocumentRuntime | undefined> {
  const target = hostTarget(input.platform ?? process.platform, input.architecture ?? process.arch)
  if (!target) return undefined

  const environment = input.environment ?? process.env
  const override = input.packaged ? undefined : environment[DOCUMENT_RUNTIME_OVERRIDE]
  if (override !== undefined && !path.isAbsolute(override)) return undefined
  const desktop = path.resolve(path.dirname(fileURLToPath(input.moduleURL)), "../..")
  const root = input.packaged
    ? path.join(input.resourcesPath, "document-runtime")
    : (override ?? path.resolve(desktop, "../document-runtime/dist", target))

  const verified = await (input.packaged
    ? loadTrustedAttestation(path.join(input.resourcesPath, "document-runtime.attestation.json")).then((attestation) => {
        if (attestation.target !== target) throw new Error("Document runtime attestation target mismatch")
        return loadAndVerifyProductionManifest(root, target, attestation)
      })
    : loadAndVerifyManifest(root, target)).catch(() => undefined)
  if (!verified) return undefined
  return {
    root: verified.root,
    manifestSha256: verified.manifestSha256,
    releaseReady: verified.manifest.releaseReady,
  }
}

export function hostTarget(platform: NodeJS.Platform, architecture: string) {
  if (platform === "darwin" && architecture === "x64") return "x86_64-apple-darwin" as const
  if (platform === "darwin" && architecture === "arm64") return "aarch64-apple-darwin" as const
  if (platform === "win32" && architecture === "x64") return "x86_64-pc-windows-msvc" as const
  if (platform === "win32" && architecture === "arm64") return "aarch64-pc-windows-msvc" as const
  if (platform === "linux" && architecture === "x64") return "x86_64-unknown-linux-gnu" as const
  if (platform === "linux" && architecture === "arm64") return "aarch64-unknown-linux-gnu" as const
}
