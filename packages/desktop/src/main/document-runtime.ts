import {
  loadAndVerifyManifest,
  loadAndVerifyProductionManifest,
  loadTrustedAttestation,
} from "@koala-ai/document-runtime/manifest"
import { lstat, realpath } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { verifyConfinementResources } from "./document-confinement"
import { hostTarget, verifySandboxRuntimeRoot, type ResolvedSandboxRuntime } from "./sandbox-runtime"

export const DOCUMENT_RUNTIME_PATH = "KOALA_DOCUMENT_RUNTIME_PATH"
export const DOCUMENT_RUNTIME_MANIFEST_SHA256 = "KOALA_DOCUMENT_RUNTIME_MANIFEST_SHA256"
export const DOCUMENT_RUNTIME_REQUIRE_RELEASE_READY = "KOALA_DOCUMENT_RUNTIME_REQUIRE_RELEASE_READY"
export const DOCUMENT_RUNTIME_OVERRIDE = "KOALA_DOCUMENT_RUNTIME_OVERRIDE"
export const DOCUMENT_RUNTIME_RELEASE_ROOT = "KOALA_DOCUMENT_RUNTIME_RELEASE_ROOT"
export const DOCUMENT_RUNTIME_ATTESTATION = "KOALA_DOCUMENT_RUNTIME_ATTESTATION"
export const DOCUMENT_RUNTIME_PROXY_PATH = "KOALA_DOCUMENT_RUNTIME_PROXY_PATH"
export const DOCUMENT_RUNTIME_PROXY_ASSETS_ROOT = "KOALA_DOCUMENT_RUNTIME_PROXY_ASSETS_ROOT"

export type ResolvedDocumentRuntime = {
  readonly root: string
  readonly manifestSha256: string
  readonly releaseReady: boolean
  readonly proxyPath: string
  readonly proxyAssetsRoot: string
}

export async function resolveDocumentRuntime(input: {
  readonly packaged: boolean
  readonly resourcesPath: string
  readonly moduleURL: string
  readonly environment?: NodeJS.ProcessEnv
  readonly platform?: NodeJS.Platform
  readonly architecture?: string
  readonly sandboxRuntime?: ResolvedSandboxRuntime
  readonly releaseVersion?: string
  /** Dev-channel packages ship the unattested development runtime without confinement evidence. */
  readonly developmentChannel?: boolean
  /** Receives the reason when no runtime is resolved. */
  readonly onUnavailable?: (reason: string) => void
}): Promise<ResolvedDocumentRuntime | undefined> {
  const unavailable = (reason: string) => {
    input.onUnavailable?.(reason)
    return undefined
  }

  const target = hostTarget(input.platform ?? process.platform, input.architecture ?? process.arch)
  if (!target) return unavailable("unsupported host platform or architecture")
  if (input.packaged && !input.releaseVersion) return unavailable("packaged app has no release version")
  if (!input.sandboxRuntime) return unavailable("sandbox runtime was not resolved")
  if (input.sandboxRuntime.target !== target) return unavailable("sandbox runtime target mismatch")

  const environment = input.environment ?? process.env
  const override = input.packaged ? undefined : environment[DOCUMENT_RUNTIME_OVERRIDE]
  if (override !== undefined && !path.isAbsolute(override)) return unavailable("override path is not absolute")
  const desktop = path.resolve(path.dirname(fileURLToPath(input.moduleURL)), "../..")
  const resourcesRoot = input.packaged ? await realpath(input.resourcesPath).catch(() => undefined) : undefined
  if (input.packaged && !resourcesRoot) return unavailable(`resources path is unreadable: ${input.resourcesPath}`)
  const attestationPath = resourcesRoot ? path.join(resourcesRoot, "document-runtime.attestation.json") : undefined
  const development =
    !input.packaged ||
    (input.developmentChannel === true && attestationPath !== undefined && !(await exists(attestationPath)))
  // Dev packages nest the runtime under its target so electron-builder keeps `node_modules` when copying.
  const root = input.packaged
    ? path.join(resourcesRoot!, "document-runtime", ...(development ? [target] : []))
    : (override ?? path.resolve(desktop, "../document-runtime/dist", target))

  const verified = await Promise.all([
    development
      ? loadAndVerifyManifest(root, target).then((runtime) => ({ runtime }))
      : loadTrustedAttestation(attestationPath!).then((attestation) => {
          if (attestation.target !== target) throw new Error("Document runtime attestation target mismatch")
          return loadAndVerifyProductionManifest(root, target, attestation).then((runtime) => ({ runtime }))
        }),
    verifySandboxRuntimeRoot(input.sandboxRuntime.root, target),
  ]).catch((error: unknown) => {
    input.onUnavailable?.(
      `${development ? "development" : "attested"} runtime at ${root} failed verification: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    return undefined
  })
  if (!verified) return undefined
  const runtime = verified[0].runtime
  if (
    resourcesRoot &&
    (!inside(resourcesRoot, runtime.root) || !inside(resourcesRoot, verified[1].root))
  ) {
    return unavailable("runtime or sandbox root escaped the resources directory")
  }
  if (inside(runtime.root, verified[1].root) || inside(verified[1].root, runtime.root)) {
    return unavailable("runtime and sandbox roots overlap")
  }
  if (
    verified[1].workerPath !== input.sandboxRuntime.workerPath ||
    verified[1].documentProxyPath !== input.sandboxRuntime.documentProxyPath
  ) {
    return unavailable("sandbox runtime changed between resolutions")
  }
  if (input.packaged && !development) {
    const evidence = await verifyConfinementResources({
      resourcesRoot: resourcesRoot!,
      target,
      runtimeManifestSha256: runtime.manifestSha256,
      sandboxRuntime: verified[1],
      releaseVersion: input.releaseVersion,
    }).catch((error: unknown) => {
      input.onUnavailable?.(`confinement evidence rejected: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    })
    if (!evidence) return undefined
  }
  return {
    root: runtime.root,
    manifestSha256: runtime.manifestSha256,
    releaseReady: runtime.manifest.releaseReady,
    proxyPath: verified[1].documentProxyPath,
    proxyAssetsRoot: verified[1].root,
  }
}

function inside(root: string, value: string) {
  const relation = path.relative(root, value)
  return relation === "" || (!relation.startsWith(`..${path.sep}`) && relation !== ".." && !path.isAbsolute(relation))
}

function exists(value: string) {
  return lstat(value).then(
    () => true,
    () => false,
  )
}
