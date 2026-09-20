import {
  SandboxRuntimeConfigSchema,
  getDefaultWritePaths,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime"
import { DocumentRuntimeManifest } from "@koala-ai/core/document-runtime/manifest"
import { DocumentRuntimeTarget } from "@koala-ai/core/document-runtime/target"
import { runtimeNativeBinary, runtimeNativePackage } from "@koala-ai/document-runtime"
import { constants } from "node:fs"
import { access, lstat, realpath } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export const PolicyVersion = 1

export type UnavailableCode =
  | "unsupported-host"
  | "target-mismatch"
  | "invalid-path"
  | "overlapping-roots"
  | "runtime-asset-unavailable"
  | "sandbox-asset-unavailable"
  | "host-helper-unavailable"
  | "sandbox-dependency-unavailable"
  | "sandbox-policy-mismatch"

export type EvidenceCode =
  | "windows-path-evidence-required"
  | "windows-volume-evidence-required"
  | "windows-loader-evidence-required"
  | "windows-acl-reset-evidence-required"

export type Result<A> =
  | { readonly status: "available"; readonly value: A }
  | { readonly status: "unavailable"; readonly code: UnavailableCode }
  | { readonly status: "evidence-required"; readonly code: EvidenceCode }

export interface SandboxAssets {
  readonly root: string
  readonly javaAgentJarPath: string
  readonly seccompApplyPath?: string
  readonly srtWinPath?: string
}

export interface ResolvedRuntimeAssets {
  readonly packageJson: string
  readonly bootstrap: string
  readonly worker: string
  readonly tesseract: string
  readonly tessdata: string
  readonly pdfRoot: string
  readonly canvasEntry: string
  readonly canvasNativeRoot: string
  readonly canvasNativeBinary: string
}

export interface WindowsVolumeEvidence {
  readonly target: "x86_64-pc-windows-msvc" | "aarch64-pc-windows-msvc"
  readonly complete: boolean
  readonly reparseComplete: boolean
  readonly loaderComplete: boolean
  readonly aclReset: "verified" | "unverified"
  readonly executablePath: string
  readonly systemRoot: string
  readonly volumes: ReadonlyArray<{
    readonly root: string
    readonly kind: "fixed" | "network" | "removable" | "unknown"
    readonly local: boolean
    readonly filesystem: string | undefined
  }>
  readonly reparsePoints: ReadonlyArray<string>
  readonly loaderEntries: ReadonlyArray<{
    readonly path: string
    readonly kind: "directory" | "file"
    readonly identity: string
  }>
}

export interface PathInspection {
  readonly canonicalPath: string
  readonly kind: "directory" | "file"
  readonly reparsePoint: boolean
  readonly identity: string
}

export interface PolicyDependencies {
  readonly inspectPath: (value: string) => Promise<PathInspection | undefined>
  readonly accessExecutable: (value: string) => Promise<boolean>
  readonly environment?: NodeJS.ProcessEnv
}

export interface PrepareInput {
  readonly target: DocumentRuntimeTarget.Target
  readonly runtimeRoot: string
  readonly jobRoot: string
  readonly sandboxAssetsRoot: string
  readonly executablePath: string
  readonly manifestSha256: DocumentRuntimeManifest.Digest
  readonly platform?: NodeJS.Platform
  readonly architecture?: string
  readonly windowsEvidence?: WindowsVolumeEvidence
}

export interface PreparedPolicy {
  readonly target: DocumentRuntimeTarget.Target
  readonly runtimeRoot: string
  readonly jobRoot: string
  readonly sandboxAssets: SandboxAssets
  readonly runtimeAssets: ResolvedRuntimeAssets
  readonly executablePath: string
  readonly hostHelpers: HostHelpers
  readonly config: SandboxRuntimeConfig
  readonly command: BootstrapCommand
  readonly brokerEnvironment: NodeJS.ProcessEnv
  readonly handoffEnvironment: NodeJS.ProcessEnv
}

export interface VerifiedExecutable {
  readonly path: string
  readonly identity: string
}

export interface HostHelpers {
  readonly shell?: VerifiedExecutable
  readonly env?: VerifiedExecutable
  readonly sandboxExec?: VerifiedExecutable
  readonly bwrap?: VerifiedExecutable
  readonly socat?: VerifiedExecutable
  readonly ripgrep?: VerifiedExecutable
}

export type BootstrapCommand = {
  readonly command: string
  readonly binShell: string | { readonly exe: string; readonly args: ReadonlyArray<string> }
}

export interface WrappedCommand {
  readonly argv: ReadonlyArray<string>
  readonly env: NodeJS.ProcessEnv
}

export interface InspectableSandboxManager {
  readonly isSupportedPlatform: () => boolean
  readonly checkDependenciesAsync: () => Promise<{
    readonly errors: ReadonlyArray<string>
    readonly warnings?: ReadonlyArray<string>
  }>
  readonly getConfig: () => SandboxRuntimeConfig | undefined
  readonly getFsReadConfig: () => { readonly denyOnly: string[]; readonly allowWithinDeny?: string[] }
  readonly getFsWriteConfig: () => { readonly allowOnly: string[]; readonly denyWithinAllow: string[] }
  readonly getNetworkRestrictionConfig: () => { readonly allowedHosts?: string[]; readonly deniedHosts?: string[] }
  readonly getAllowUnixSockets: () => string[] | undefined
  readonly getAllowLocalBinding: () => boolean | undefined
  readonly getAllowMachLookup: () => string[] | undefined
}

const defaultDependencies: PolicyDependencies = {
  inspectPath: async (value) => {
    const info = await lstat(value).catch(() => undefined)
    if (!info) return
    return {
      canonicalPath: await realpath(value),
      kind: info.isDirectory() ? "directory" : info.isFile() ? "file" : "directory",
      reparsePoint: info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()),
      identity: `${info.dev}:${info.ino}`,
    }
  },
  accessExecutable: async (value) =>
    access(value, constants.X_OK).then(
      () => true,
      () => false,
    ),
}

export async function prepare(
  input: PrepareInput,
  dependencies: PolicyDependencies = defaultDependencies,
): Promise<Result<PreparedPolicy>> {
  const platform = input.platform ?? process.platform
  const architecture = input.architecture ?? process.arch
  const host = validateHostTarget(input.target, platform, architecture)
  if (host.status !== "available") return host

  const roots = await validateRoots(input, platform, dependencies)
  if (roots.status !== "available") return roots

  const runtimeAssets = resolveRuntimeAssets(roots.value.runtimeRoot, input.target)
  const sandboxAssets = resolveSandboxAssets(roots.value.sandboxAssetsRoot, input.target)
  const assets = await validateAssets(runtimeAssets, roots.value.runtimeRoot, sandboxAssets, platform, dependencies)
  if (assets.status !== "available") return assets

  const hostHelpers = await resolveHostHelpers(input.target, dependencies)
  if (hostHelpers.status !== "available") return hostHelpers

  if (platform === "win32") {
    if (
      !input.windowsEvidence ||
      input.windowsEvidence.target !== input.target ||
      !samePath(input.windowsEvidence.executablePath, roots.value.executablePath, true) ||
      !samePath(input.windowsEvidence.systemRoot, roots.value.systemRoot ?? "", true)
    ) {
      return evidenceRequired("windows-loader-evidence-required")
    }
    const evidence = await validateWindowsEvidence(
      [
        roots.value.runtimeRoot,
        roots.value.jobRoot,
        roots.value.sandboxAssetsRoot,
        roots.value.executablePath,
        roots.value.systemRoot,
      ],
      input.windowsEvidence,
      dependencies,
    )
    if (evidence.status !== "available") return evidence
  }

  const environment = dependencies.environment ?? process.env
  const config = buildConfig({
    target: input.target,
    runtimeRoot: roots.value.runtimeRoot,
    jobRoot: roots.value.jobRoot,
    executablePath: roots.value.executablePath,
    systemRoot: roots.value.systemRoot,
    sandboxAssets,
    hostHelpers: hostHelpers.value,
    windowsLoaderPaths: input.windowsEvidence?.loaderEntries.map((entry) => entry.path),
    windowsVolumes: input.windowsEvidence?.volumes
      .filter((volume) => volume.kind === "fixed")
      .map((volume) => volume.root),
    environment,
  })
  return available({
    target: input.target,
    runtimeRoot: roots.value.runtimeRoot,
    jobRoot: roots.value.jobRoot,
    sandboxAssets,
    runtimeAssets,
    executablePath: roots.value.executablePath,
    hostHelpers: hostHelpers.value,
    config,
    command: bootstrapCommand(
      input.target,
      roots.value.executablePath,
      runtimeAssets.bootstrap,
      hostHelpers.value.shell?.path,
    ),
    brokerEnvironment: brokerEnvironment(roots.value.sandboxAssetsRoot, environment, platform),
    handoffEnvironment: handoffEnvironment({
      target: input.target,
      runtimeRoot: roots.value.runtimeRoot,
      jobRoot: roots.value.jobRoot,
      manifestSha256: input.manifestSha256,
      systemRoot: roots.value.systemRoot,
    }),
  })
}

export function validateHostTarget(
  target: DocumentRuntimeTarget.Target,
  platform: NodeJS.Platform,
  architecture: string,
): Result<void> {
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32") {
    return unavailable("unsupported-host")
  }
  if (architecture !== "x64" && architecture !== "arm64") {
    return unavailable("unsupported-host")
  }
  return DocumentRuntimeTarget.fromHost(platform, architecture) === target
    ? available(undefined)
    : unavailable("target-mismatch")
}

export function resolveRuntimeAssets(root: string, target: DocumentRuntimeTarget.Target): ResolvedRuntimeAssets {
  const paths = pathForTarget(target)
  const nativePackage = runtimeNativePackage(target)
  return {
    packageJson: paths.join(root, "package.json"),
    bootstrap: paths.join(root, "worker", "bootstrap.js"),
    worker: paths.join(root, "worker", "worker.js"),
    tesseract: paths.join(root, "bin", target.includes("windows") ? "tesseract.exe" : "tesseract"),
    tessdata: paths.join(root, "tessdata"),
    pdfRoot: paths.join(root, "node_modules", "pdfjs-dist"),
    canvasEntry: paths.join(root, "node_modules", "@napi-rs", "canvas", "index.js"),
    canvasNativeRoot: paths.join(root, "node_modules", ...nativePackage.split("/")),
    canvasNativeBinary: paths.join(root, "node_modules", ...nativePackage.split("/"), runtimeNativeBinary(target)),
  }
}

export function resolveSandboxAssets(root: string, target: DocumentRuntimeTarget.Target): SandboxAssets {
  const paths = pathForTarget(target)
  const architecture = target.startsWith("x86_64-") ? "x64" : "arm64"
  return {
    root,
    javaAgentJarPath: paths.join(root, "vendor", "java-proxy-agent", "srt-proxy-agent.jar"),
    ...(target.includes("linux")
      ? { seccompApplyPath: paths.join(root, "vendor", "seccomp", architecture, "apply-seccomp") }
      : {}),
    ...(target.includes("windows")
      ? { srtWinPath: paths.join(root, "vendor", "srt-win", architecture, "srt-win.exe") }
      : {}),
  }
}

export async function resolveHostHelpers(
  target: DocumentRuntimeTarget.Target,
  dependencies: PolicyDependencies = defaultDependencies,
): Promise<Result<HostHelpers>> {
  if (target.includes("windows")) return available({})
  if (target.includes("apple")) {
    const [shell, env, sandboxExec] = await Promise.all([
      resolveExecutable(["/bin/sh"], dependencies),
      resolveExecutable(["/usr/bin/env"], dependencies, true),
      resolveExecutable(["/usr/bin/sandbox-exec"], dependencies, true),
    ])
    return shell && env && sandboxExec ? available({ shell, env, sandboxExec }) : unavailable("host-helper-unavailable")
  }
  const [shell, bwrap, socat, ripgrep] = await Promise.all([
    resolveExecutable(["/bin/sh", "/usr/bin/sh"], dependencies),
    resolveExecutable(["/usr/bin/bwrap", "/bin/bwrap"], dependencies),
    resolveExecutable(["/usr/bin/socat", "/bin/socat"], dependencies),
    resolveExecutable(["/usr/bin/rg", "/bin/rg"], dependencies),
  ])
  return shell && bwrap && socat && ripgrep
    ? available({ shell, bwrap, socat, ripgrep })
    : unavailable("host-helper-unavailable")
}

export function fixedLoaderRoots(
  target: DocumentRuntimeTarget.Target,
  executablePath: string,
  hostHelpers: HostHelpers,
  windowsLoaderPaths: ReadonlyArray<string> = [],
): ReadonlyArray<string> {
  if (target.includes("windows")) {
    return unique([executablePath, ...windowsLoaderPaths], true)
  }
  const helpers = [
    hostHelpers.shell,
    hostHelpers.env,
    hostHelpers.sandboxExec,
    hostHelpers.bwrap,
    hostHelpers.socat,
    hostHelpers.ripgrep,
  ].flatMap((helper) => (helper ? [helper.path] : []))
  if (target.includes("apple")) {
    return unique([executablePath, ...helpers, "/usr/lib", "/System/Library", "/dev/null"])
  }
  return unique([
    executablePath,
    ...helpers,
    "/lib",
    "/lib64",
    "/usr/lib",
    "/usr/lib64",
    "/etc/ld.so.cache",
    "/dev/null",
  ])
}

const windowsLoaderFiles: Partial<Record<"x86_64-pc-windows-msvc" | "aarch64-pc-windows-msvc", ReadonlyArray<string>>> =
  {}

export function windowsLoaderPolicy(
  target: "x86_64-pc-windows-msvc" | "aarch64-pc-windows-msvc",
  systemRoot: string,
): Result<ReadonlyArray<string>> {
  const files = windowsLoaderFiles[target]
  if (!files) return evidenceRequired("windows-loader-evidence-required")
  return available(files.map((file) => path.win32.join(systemRoot, ...file.split("/"))))
}

export function buildConfig(input: {
  readonly target: DocumentRuntimeTarget.Target
  readonly runtimeRoot: string
  readonly jobRoot: string
  readonly executablePath: string
  readonly systemRoot?: string
  readonly sandboxAssets: SandboxAssets
  readonly hostHelpers: HostHelpers
  readonly windowsLoaderPaths?: ReadonlyArray<string>
  readonly windowsVolumes?: ReadonlyArray<string>
  readonly environment?: NodeJS.ProcessEnv
}): SandboxRuntimeConfig {
  const platform = targetPlatform(input.target)
  const environment = input.environment ?? process.env
  const helperPaths = [
    input.sandboxAssets.javaAgentJarPath,
    input.sandboxAssets.seccompApplyPath,
    input.sandboxAssets.srtWinPath,
  ].filter((value): value is string => value !== undefined)
  const denyWrite = unique(
    [
      input.runtimeRoot,
      input.sandboxAssets.root,
      ...persistentCompatibilityWritePaths(platform, environment),
      ...ambientWriteRoots(platform, environment),
    ],
    platform === "win32",
  )

  return SandboxRuntimeConfigSchema.parse({
    network: {
      allowedDomains: [],
      deniedDomains: [],
      strictAllowlist: true,
      allowUnixSockets: [],
      allowAllUnixSockets: false,
      allowLocalBinding: false,
      allowMachLookup: [],
    },
    filesystem: {
      denyRead: platform === "win32" ? unique(input.windowsVolumes ?? [], true) : ["/"],
      allowRead: unique(
        [
          ...fixedLoaderRoots(input.target, input.executablePath, input.hostHelpers, input.windowsLoaderPaths),
          input.runtimeRoot,
          input.jobRoot,
          ...helperPaths,
        ],
        platform === "win32",
      ),
      allowWrite: [input.jobRoot],
      denyWrite,
      allowGitConfig: false,
    },
    enableWeakerNestedSandbox: false,
    enableWeakerNetworkIsolation: false,
    allowAppleEvents: false,
    allowPty: false,
    javaAgentJarPath: input.sandboxAssets.javaAgentJarPath,
    ...(input.hostHelpers.ripgrep ? { ripgrep: { command: input.hostHelpers.ripgrep.path, args: [] } } : {}),
    ...(input.hostHelpers.bwrap ? { bwrapPath: input.hostHelpers.bwrap.path } : {}),
    ...(input.hostHelpers.socat ? { socatPath: input.hostHelpers.socat.path } : {}),
    ...(input.sandboxAssets.seccompApplyPath ? { seccomp: { applyPath: input.sandboxAssets.seccompApplyPath } } : {}),
    ...(input.sandboxAssets.srtWinPath ? { windows: { srtWin: { path: input.sandboxAssets.srtWinPath } } } : {}),
  })
}

export function brokerEnvironment(
  sandboxAssetsRoot: string,
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const pathKeys = new Set(["HOME", "LOCALAPPDATA", "PROGRAMDATA", "TEMP", "TMP", "TMPDIR", "USERPROFILE"])
  const values: Record<string, string> = {}
  for (const key of [
    "HOME",
    "LANG",
    "LC_ALL",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "TEMP",
    "TMP",
    "TMPDIR",
    "USERPROFILE",
  ] as const) {
    const value = source[key]
    if (!validEnvironmentValue(value)) continue
    if (pathKeys.has(key) && !pathForPlatform(platform).isAbsolute(value)) continue
    values[key] = value
  }
  const systemRoot = source.SystemRoot ?? source.SYSTEMROOT
  if (platform === "win32" && validEnvironmentValue(systemRoot) && path.win32.isAbsolute(systemRoot)) {
    values.SystemRoot = systemRoot
    values.WINDIR = systemRoot
  }
  const fixedPath = fixedBrokerPath(platform, systemRoot)
  return {
    ...values,
    ...(fixedPath ? { PATH: fixedPath } : {}),
    ...(platform === "win32" ? { PATHEXT: ".COM;.EXE;.BAT;.CMD" } : {}),
    KOALA_DOCUMENT_RUNTIME_PROXY_ASSETS_ROOT: sandboxAssetsRoot,
    ELECTRON_RUN_AS_NODE: "1",
  }
}

export function handoffEnvironment(input: {
  readonly target: DocumentRuntimeTarget.Target
  readonly runtimeRoot: string
  readonly jobRoot: string
  readonly manifestSha256: DocumentRuntimeManifest.Digest
  readonly systemRoot?: string
}): NodeJS.ProcessEnv {
  const paths = pathForTarget(input.target)
  const environment: NodeJS.ProcessEnv = {
    DISABLE_SYSTEM_FONTS_LOAD: "1",
    DOCUMENT_JOB_ROOT: input.jobRoot,
    DOCUMENT_RUNTIME_MANIFEST_SHA256: input.manifestSha256,
    DOCUMENT_RUNTIME_ROOT: input.runtimeRoot,
    DOCUMENT_RUNTIME_TARGET: input.target,
    ELECTRON_RUN_AS_NODE: "1",
    LANG: "C",
    LC_ALL: "C",
    TEMP: paths.join(input.jobRoot, "tmp"),
    TMP: paths.join(input.jobRoot, "tmp"),
    TMPDIR: paths.join(input.jobRoot, "tmp"),
    TZ: "UTC",
  }
  if (!input.target.includes("windows") || !input.systemRoot) return environment
  return { ...environment, SystemRoot: input.systemRoot, WINDIR: input.systemRoot }
}

export function bootstrapCommand(
  target: DocumentRuntimeTarget.Target,
  executablePath: string,
  bootstrapPath: string,
  shellPath?: string,
): BootstrapCommand {
  if (target.includes("windows")) {
    return {
      command: "document-runtime-bootstrap",
      binShell: { exe: executablePath, args: [bootstrapPath] },
    }
  }
  if (!shellPath || !path.posix.isAbsolute(shellPath)) throw new Error("invalid-shell-path")
  return {
    command: `exec ${quotePosix(executablePath)} ${quotePosix(bootstrapPath)}`,
    binShell: shellPath,
  }
}

export function applyHandoffEnvironment(
  wrapped: WrappedCommand,
  handoff: NodeJS.ProcessEnv,
  broker: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): WrappedCommand {
  const entries = Object.entries(
    platform === "win32"
      ? {
          ...(broker.PATH ? { PATH: broker.PATH } : {}),
          ...(broker.PATHEXT ? { PATHEXT: broker.PATHEXT } : {}),
          ...handoff,
        }
      : handoff,
  )
  const allowedKeys = new Set([
    "DISABLE_SYSTEM_FONTS_LOAD",
    "DOCUMENT_JOB_ROOT",
    "DOCUMENT_RUNTIME_MANIFEST_SHA256",
    "DOCUMENT_RUNTIME_ROOT",
    "DOCUMENT_RUNTIME_TARGET",
    "ELECTRON_RUN_AS_NODE",
    "LANG",
    "LC_ALL",
    "TEMP",
    "TMP",
    "TMPDIR",
    "TZ",
    "SystemRoot",
    "WINDIR",
    "PATH",
    "PATHEXT",
  ])
  if (entries.some(([key, value]) => !allowedKeys.has(key) || !validEnvironmentValue(value))) {
    throw new Error("invalid-handoff-environment")
  }
  if (platform !== "win32") return { argv: [...wrapped.argv], env: { ...broker, ...handoff } }

  const separator = wrapped.argv.lastIndexOf("--")
  if (separator < 0) throw new Error("invalid-windows-sandbox-descriptor")
  const handoffKeys = new Set(entries.map(([key]) => key.toLowerCase()))
  const prefix: string[] = []
  for (let index = 0; index < separator; index++) {
    const value = wrapped.argv[index]
    const entry = wrapped.argv[index + 1]
    if (value === "--env" && entry) {
      const equals = entry.indexOf("=")
      if (equals < 1) throw new Error("invalid-windows-sandbox-descriptor")
      if (!handoffKeys.has(entry.slice(0, equals).toLowerCase())) prefix.push(value, entry)
      index++
      continue
    }
    prefix.push(value ?? "")
  }
  return {
    argv: [
      ...prefix,
      ...entries.flatMap(([key, value]) => ["--env", `${key}=${value}`]),
      ...wrapped.argv.slice(separator),
    ],
    env: { ...broker },
  }
}

export async function verifyDependencies(
  manager: Pick<InspectableSandboxManager, "isSupportedPlatform" | "checkDependenciesAsync">,
): Promise<Result<void>> {
  if (!manager.isSupportedPlatform()) return unavailable("sandbox-dependency-unavailable")
  const dependencies = await manager.checkDependenciesAsync().catch(() => undefined)
  if (!dependencies || dependencies.errors.length > 0 || (dependencies.warnings?.length ?? 0) > 0) {
    return unavailable("sandbox-dependency-unavailable")
  }
  return available(undefined)
}

export async function verifyEffectivePolicy(
  manager: InspectableSandboxManager,
  expected: SandboxRuntimeConfig,
  target: DocumentRuntimeTarget.Target,
  options: {
    readonly windowsEvidence?: WindowsVolumeEvidence
    readonly dependencies?: PolicyDependencies
    readonly srtDefaultWritePaths?: ReadonlyArray<string>
  } = {},
): Promise<Result<void>> {
  const actual = manager.getConfig()
  if (!actual || !samePolicy(actual, expected)) return unavailable("sandbox-policy-mismatch")
  if (
    manager.getAllowLocalBinding() !== false ||
    !sameSet(manager.getAllowUnixSockets() ?? [], []) ||
    !sameSet(manager.getAllowMachLookup() ?? [], []) ||
    !sameSet(manager.getNetworkRestrictionConfig().allowedHosts ?? [], []) ||
    (manager.getNetworkRestrictionConfig().deniedHosts?.length ?? 0) > 0
  ) {
    return unavailable("sandbox-policy-mismatch")
  }

  const reads = manager.getFsReadConfig()
  if (
    !sameSet(reads.denyOnly, expected.filesystem.denyRead, target.includes("windows")) ||
    !sameSet(reads.allowWithinDeny ?? [], expected.filesystem.allowRead ?? [], target.includes("windows"))
  ) {
    return unavailable("sandbox-policy-mismatch")
  }

  const writes = manager.getFsWriteConfig()
  const denied = writes.denyWithinAllow
  const defaults = options.srtDefaultWritePaths ?? getDefaultWritePaths()
  const expectedAllow = unique([...defaults, ...expected.filesystem.allowWrite], target.includes("windows"))
  if (
    expected.filesystem.allowWrite.length !== 1 ||
    !sameSet(writes.allowOnly, expectedAllow, target.includes("windows")) ||
    !sameSet(denied, expected.filesystem.denyWrite, target.includes("windows")) ||
    defaults.some(
      (value) =>
        defaultWriteRequiresDeny(value, target) &&
        !denied.some((entry) => samePath(entry, value, target.includes("windows"))),
    )
  ) {
    return unavailable("sandbox-policy-mismatch")
  }

  if (!target.includes("windows")) return available(undefined)
  const executablePath = expected.filesystem.allowRead?.[0]
  if (
    !options.windowsEvidence ||
    options.windowsEvidence.target !== target ||
    !executablePath ||
    !samePath(options.windowsEvidence.executablePath, executablePath, true)
  ) {
    return evidenceRequired("windows-loader-evidence-required")
  }
  const evidence = await validateWindowsEvidence(
    [
      ...expected.filesystem.denyRead,
      ...(expected.filesystem.allowRead ?? []),
      ...expected.filesystem.allowWrite,
      ...expected.filesystem.denyWrite,
      expected.javaAgentJarPath,
      expected.windows?.srtWin?.path,
    ],
    options.windowsEvidence,
    options.dependencies ?? defaultDependencies,
  )
  if (evidence.status !== "available") return evidence
  if (
    !sameSet(expected.filesystem.denyRead, options.windowsEvidence?.volumes.map((volume) => volume.root) ?? [], true)
  ) {
    return unavailable("sandbox-policy-mismatch")
  }
  return available(undefined)
}

export async function validateWindowsEvidence(
  values: ReadonlyArray<string | undefined>,
  evidence?: WindowsVolumeEvidence,
  dependencies: PolicyDependencies = defaultDependencies,
): Promise<Result<void>> {
  if (!evidence) return evidenceRequired("windows-path-evidence-required")
  if (!evidence.target.includes("windows")) return evidenceRequired("windows-loader-evidence-required")
  if (!evidence.complete || evidence.volumes.length === 0) {
    return evidenceRequired("windows-volume-evidence-required")
  }
  if (!evidence.reparseComplete) return evidenceRequired("windows-path-evidence-required")
  if (!evidence.loaderComplete || evidence.loaderEntries.length === 0) {
    return evidenceRequired("windows-loader-evidence-required")
  }
  if (evidence.aclReset !== "verified") return evidenceRequired("windows-acl-reset-evidence-required")
  if (!validWindowsPath(evidence.executablePath) || !validWindowsPath(evidence.systemRoot)) {
    return unavailable("invalid-path")
  }

  const volumes = evidence.volumes.map((volume) => ({ ...volume, root: path.win32.normalize(volume.root) }))
  if (
    new Set(volumes.map((volume) => volume.root.toLowerCase())).size !== volumes.length ||
    volumes.some(
      (volume) =>
        !/^[A-Za-z]:\\$/.test(volume.root) ||
        volume.kind !== "fixed" ||
        !volume.local ||
        !["NTFS", "ReFS"].includes(volume.filesystem ?? ""),
    )
  ) {
    return unavailable("invalid-path")
  }
  for (const value of [...values, ...evidence.loaderEntries.map((entry) => entry.path)]) {
    if (!value || !validWindowsPath(value)) return unavailable("invalid-path")
    const volume = volumes.find((entry) => atOrUnder(value, entry.root, true))
    if (!volume) return unavailable("invalid-path")
    if (evidence.reparsePoints.some((entry) => atOrUnder(value, entry, true))) return unavailable("invalid-path")
  }
  if (
    new Set(evidence.loaderEntries.map((entry) => entry.path.toLowerCase())).size !== evidence.loaderEntries.length ||
    evidence.loaderEntries.some(
      (entry) =>
        !entry.identity ||
        entry.kind !== "file" ||
        samePath(entry.path, path.win32.parse(entry.path).root, true) ||
        samePath(entry.path, evidence.systemRoot, true) ||
        !atOrUnder(entry.path, evidence.systemRoot, true),
    )
  ) {
    return unavailable("invalid-path")
  }
  const loaderPolicy = windowsLoaderPolicy(evidence.target, evidence.systemRoot)
  if (loaderPolicy.status !== "available") return loaderPolicy
  if (
    !sameSet(
      evidence.loaderEntries.map((entry) => entry.path),
      loaderPolicy.value,
      true,
    )
  ) {
    return evidenceRequired("windows-loader-evidence-required")
  }
  for (const entry of evidence.loaderEntries) {
    const info = await dependencies.inspectPath(entry.path).catch(() => undefined)
    if (
      !info ||
      info.kind !== entry.kind ||
      info.reparsePoint ||
      !samePath(info.canonicalPath, entry.path, true) ||
      info.identity !== entry.identity
    ) {
      return evidenceRequired("windows-loader-evidence-required")
    }
  }
  return available(undefined)
}

export function quotePosix(value: string) {
  if (value.includes("\0") || /[\r\n]/.test(value)) throw new Error("invalid-path")
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

async function validateRoots(input: PrepareInput, platform: NodeJS.Platform, dependencies: PolicyDependencies) {
  const environment = dependencies.environment ?? process.env
  const systemRoot = platform === "win32" ? (environment.SystemRoot ?? environment.SYSTEMROOT) : undefined
  const expected: ReadonlyArray<readonly [string | undefined, "directory" | "file"]> = [
    [input.runtimeRoot, "directory"],
    [input.jobRoot, "directory"],
    [input.sandboxAssetsRoot, "directory"],
    [input.executablePath, "file"],
    ...(platform === "win32" ? ([[systemRoot, "directory"]] as const) : []),
  ]
  const inspected: string[] = []
  for (const [value, kind] of expected) {
    if (!value || !validPath(value, platform)) return unavailable("invalid-path")
    const info = await dependencies.inspectPath(value).catch(() => undefined)
    if (
      !info ||
      info.kind !== kind ||
      info.reparsePoint ||
      !samePath(info.canonicalPath, pathForPlatform(platform).normalize(value), platform === "win32")
    ) {
      return unavailable("invalid-path")
    }
    inspected.push(info.canonicalPath)
  }
  if (platform !== "win32" && !(await dependencies.accessExecutable(inspected[3] ?? ""))) {
    return unavailable("invalid-path")
  }
  const roots = inspected.slice(0, 3)
  if (
    roots.some((root, index) =>
      roots.some((other, otherIndex) => index !== otherIndex && overlap(root, other, platform)),
    )
  ) {
    return unavailable("overlapping-roots")
  }
  return available({
    runtimeRoot: inspected[0] ?? "",
    jobRoot: inspected[1] ?? "",
    sandboxAssetsRoot: inspected[2] ?? "",
    executablePath: inspected[3] ?? "",
    systemRoot: inspected[4],
  })
}

async function validateAssets(
  runtime: ResolvedRuntimeAssets,
  runtimeRoot: string,
  sandbox: SandboxAssets,
  platform: NodeJS.Platform,
  dependencies: PolicyDependencies,
): Promise<Result<void>> {
  const runtimeFiles = [
    runtime.packageJson,
    runtime.bootstrap,
    runtime.worker,
    runtime.tesseract,
    pathForPlatform(platform).join(runtime.tessdata, "eng.traineddata"),
    pathForPlatform(platform).join(runtime.tessdata, "osd.traineddata"),
    pathForPlatform(platform).join(runtime.pdfRoot, "legacy", "build", "pdf.mjs"),
    runtime.canvasEntry,
    runtime.canvasNativeBinary,
  ]
  if (!(await validateFiles(runtimeFiles, runtimeRoot, platform, dependencies))) {
    return unavailable("runtime-asset-unavailable")
  }
  const sandboxFiles = [sandbox.javaAgentJarPath, sandbox.seccompApplyPath, sandbox.srtWinPath].filter(
    (value): value is string => value !== undefined,
  )
  if (!(await validateFiles(sandboxFiles, sandbox.root, platform, dependencies))) {
    return unavailable("sandbox-asset-unavailable")
  }
  if (sandbox.seccompApplyPath && !(await dependencies.accessExecutable(sandbox.seccompApplyPath))) {
    return unavailable("sandbox-asset-unavailable")
  }
  return available(undefined)
}

async function validateFiles(
  files: ReadonlyArray<string>,
  root: string,
  platform: NodeJS.Platform,
  dependencies: PolicyDependencies,
) {
  for (const file of files) {
    if (!atOrUnder(file, root, platform === "win32") || !validPath(file, platform)) return false
    const info = await dependencies.inspectPath(file).catch(() => undefined)
    if (
      !info ||
      info.kind !== "file" ||
      info.reparsePoint ||
      !samePath(info.canonicalPath, pathForPlatform(platform).normalize(file), platform === "win32")
    ) {
      return false
    }
  }
  return true
}

async function resolveExecutable(
  candidates: ReadonlyArray<string>,
  dependencies: PolicyDependencies,
  requireDirectPath = false,
) {
  for (const candidate of candidates) {
    const initial = await dependencies.inspectPath(candidate).catch(() => undefined)
    if (!initial || (!initial.reparsePoint && initial.kind !== "file")) continue
    if (requireDirectPath && initial.canonicalPath !== candidate) continue
    const canonical = await dependencies.inspectPath(initial.canonicalPath).catch(() => undefined)
    if (
      !canonical ||
      canonical.kind !== "file" ||
      canonical.reparsePoint ||
      canonical.canonicalPath !== initial.canonicalPath ||
      !canonical.identity ||
      (!initial.reparsePoint && initial.identity !== canonical.identity) ||
      !(await dependencies.accessExecutable(canonical.canonicalPath))
    ) {
      continue
    }
    return { path: canonical.canonicalPath, identity: canonical.identity }
  }
}

function persistentCompatibilityWritePaths(platform: NodeJS.Platform, environment: NodeJS.ProcessEnv) {
  const paths = pathForPlatform(platform)
  const home = environment.HOME ?? (platform === "win32" ? environment.USERPROFILE : undefined) ?? os.homedir()
  return [
    ...(platform === "win32" ? [] : ["/tmp/claude", "/private/tmp/claude"]),
    paths.join(home, ".npm", "_logs"),
    paths.join(home, ".claude", "debug"),
  ]
}

function ambientWriteRoots(platform: NodeJS.Platform, environment: NodeJS.ProcessEnv) {
  const candidates =
    platform === "win32"
      ? [
          environment.USERPROFILE,
          environment.LOCALAPPDATA,
          environment.PROGRAMDATA,
          environment.TEMP,
          environment.TMP,
          environment.SystemRoot ?? environment.SYSTEMROOT,
          environment.SystemRoot || environment.SYSTEMROOT
            ? path.win32.join(
                path.win32.parse(environment.SystemRoot ?? environment.SYSTEMROOT ?? "").root,
                "Users",
                "Public",
              )
            : undefined,
        ]
      : [environment.HOME, environment.TMPDIR]
  return candidates.filter((value): value is string => Boolean(value) && validPath(value as string, platform))
}

function samePolicy(actual: SandboxRuntimeConfig, expected: SandboxRuntimeConfig) {
  return JSON.stringify(actual) === JSON.stringify(expected)
}

function reviewedDeviceWrite(value: string) {
  return ["/dev/stdout", "/dev/stderr", "/dev/null", "/dev/tty", "/dev/dtracehelper", "/dev/autofs_nowait"].includes(
    value,
  )
}

function nonApplicableWindowsDefault(value: string) {
  return value === "/tmp/claude" || value === "/private/tmp/claude" || value.startsWith("/dev/")
}

function defaultWriteRequiresDeny(value: string, target: DocumentRuntimeTarget.Target) {
  if (target.includes("windows")) return !nonApplicableWindowsDefault(value)
  return !reviewedDeviceWrite(value)
}

function validPath(value: string, platform: NodeJS.Platform) {
  if (value.includes("\0") || /[\u0001-\u001f\u007f]/.test(value)) return false
  if (platform === "win32") return validWindowsPath(value)
  return path.posix.isAbsolute(value) && path.posix.normalize(value) === value
}

function validWindowsPath(value: string) {
  if (!path.win32.isAbsolute(value) || path.win32.normalize(value) !== value) return false
  if (/^[\\/]{2}/.test(value) || /^[\\/](?:[?.]|globalroot)[\\/]/i.test(value)) return false
  if (!/^[A-Za-z]:\\/.test(value) || value.slice(2).includes(":")) return false
  return !value
    .slice(3)
    .split(/[\\/]/)
    .some((segment) => /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment) || /[. ]$/.test(segment))
}

function validEnvironmentValue(value: string | undefined): value is string {
  return value !== undefined && value.length > 0 && !/[\u0000-\u001f\u007f]/.test(value)
}

function fixedBrokerPath(platform: NodeJS.Platform, systemRoot: string | undefined) {
  if (platform !== "win32") return "/usr/bin:/bin"
  return systemRoot && validPath(systemRoot, "win32") ? path.win32.join(systemRoot, "System32") : ""
}

function overlap(left: string, right: string, platform: NodeJS.Platform) {
  return atOrUnder(left, right, platform === "win32") || atOrUnder(right, left, platform === "win32")
}

function atOrUnder(value: string, root: string, insensitive: boolean) {
  const paths = /^[A-Za-z]:[\\/]/.test(value) || /^[A-Za-z]:[\\/]/.test(root) ? path.win32 : path.posix
  const relation = paths.relative(root, value)
  const normalized = insensitive ? relation.toLowerCase() : relation
  return (
    normalized === "" ||
    (normalized !== ".." && !normalized.startsWith(`..${paths.sep}`) && !paths.isAbsolute(normalized))
  )
}

function samePath(left: string, right: string, insensitive = false) {
  return insensitive ? left.toLowerCase() === right.toLowerCase() : left === right
}

function sameSet(left: ReadonlyArray<string>, right: ReadonlyArray<string>, insensitive = false) {
  const normalize = (value: string) => (insensitive ? value.toLowerCase() : value)
  return (
    left.length === right.length &&
    new Set(left.map(normalize)).size === left.length &&
    left.every((value) => right.map(normalize).includes(normalize(value)))
  )
}

function unique(values: ReadonlyArray<string>, insensitive = false) {
  const seen = new Set<string>()
  return values.filter((value) => {
    const key = insensitive ? value.toLowerCase() : value
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function pathForTarget(target: DocumentRuntimeTarget.Target) {
  return target.includes("windows") ? path.win32 : path.posix
}

function pathForPlatform(platform: NodeJS.Platform) {
  return platform === "win32" ? path.win32 : path.posix
}

function targetPlatform(target: DocumentRuntimeTarget.Target): NodeJS.Platform {
  if (target.includes("windows")) return "win32"
  if (target.includes("apple")) return "darwin"
  return "linux"
}

function available<A>(value: A): Result<A> {
  return { status: "available", value }
}

function unavailable(code: UnavailableCode): Result<never> {
  return { status: "unavailable", code }
}

function evidenceRequired(code: EvidenceCode): Result<never> {
  return { status: "evidence-required", code }
}

export * as DocumentSandboxPolicy from "./sandbox-policy"
