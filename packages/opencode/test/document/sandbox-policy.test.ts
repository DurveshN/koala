import { describe, expect, test } from "bun:test"
import { getDefaultWritePaths, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime"
import { DocumentRuntimeManifest } from "@koala-ai/core/document-runtime/manifest"
import { DocumentRuntimeTarget } from "@koala-ai/core/document-runtime/target"
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  applyHandoffEnvironment,
  bootstrapCommand,
  brokerEnvironment,
  buildConfig,
  fixedLoaderRoots,
  handoffEnvironment,
  prepare,
  resolveHostHelpers,
  resolveRuntimeAssets,
  resolveSandboxAssets,
  validateHostTarget,
  validateWindowsEvidence,
  verifyDependencies,
  verifyEffectivePolicy,
  windowsLoaderPolicy,
  type InspectableSandboxManager,
  type PathInspection,
  type WindowsVolumeEvidence,
} from "@/document/sandbox-policy"

const digest = DocumentRuntimeManifest.Digest.make("a".repeat(64))
const filesystemLinksAvailable = await supportsDirectoryLinks()

describe("document sandbox target policy", () => {
  test.each([...DocumentRuntimeTarget.Targets])("resolves fixed assets and strict policy for %s", (target) => {
    const windows = target === "x86_64-pc-windows-msvc" || target === "aarch64-pc-windows-msvc"
    const paths = windows ? path.win32 : path.posix
    const root = windows ? "C:\\Koala Runtime" : "/opt/koala runtime"
    const job = windows ? "D:\\Koala Jobs\\one" : "/var/koala jobs/one"
    const assetsRoot = windows ? "C:\\Koala App\\sandbox-runtime" : "/opt/koala app/sandbox-runtime"
    const executable = windows ? "C:\\Koala App\\node.exe" : "/opt/koala app/node"
    const systemRoot = windows ? "C:\\Windows" : undefined
    const assets = resolveSandboxAssets(assetsRoot, target)
    const hostHelpers = helpersFor(target)
    const windowsLoaderPaths: ReadonlyArray<string> = []
    const config = buildConfig({
      target,
      runtimeRoot: root,
      jobRoot: job,
      executablePath: executable,
      systemRoot,
      sandboxAssets: assets,
      hostHelpers,
      windowsLoaderPaths,
      windowsVolumes: windows ? ["C:\\", "D:\\"] : [],
      environment: windows
        ? { USERPROFILE: "C:\\Users\\broker", TEMP: "C:\\Users\\broker\\Temp", SystemRoot: systemRoot }
        : { HOME: "/home/broker", TMPDIR: "/var/tmp" },
    })

    expect(config.network).toEqual({
      allowedDomains: [],
      deniedDomains: [],
      strictAllowlist: true,
      allowUnixSockets: [],
      allowAllUnixSockets: false,
      allowLocalBinding: false,
      allowMachLookup: [],
    })
    expect(config.filesystem.allowWrite).toEqual([job])
    expect(config.filesystem.allowRead).toEqual(
      expect.arrayContaining([root, job, executable, assets.javaAgentJarPath]),
    )
    if (target.includes("linux")) {
      expect(config).toMatchObject({
        bwrapPath: "/usr/bin/bwrap",
        socatPath: "/usr/bin/socat",
        ripgrep: { command: "/usr/bin/rg", args: [] },
      })
    }
    expect(config.filesystem.denyWrite).toEqual(expect.arrayContaining([root, assetsRoot]))
    if (!windows) {
      expect(config.filesystem.denyWrite).toEqual(
        expect.arrayContaining(["/tmp/claude", "/private/tmp/claude", "/home/broker/.npm/_logs"]),
      )
    }
    if (windows) expect(config.filesystem.denyRead).toEqual(["C:\\", "D:\\"])
    expect(config).toMatchObject({
      enableWeakerNestedSandbox: false,
      enableWeakerNetworkIsolation: false,
      allowAppleEvents: false,
      allowPty: false,
    })
    expect(resolveRuntimeAssets(root, target).bootstrap).toBe(paths.join(root, "worker", "bootstrap.js"))
    if (target.includes("linux"))
      expect(assets.seccompApplyPath).toContain(paths.join("seccomp", target.startsWith("x86_64") ? "x64" : "arm64"))
    if (windows)
      expect(assets.srtWinPath).toContain(paths.join("srt-win", target.startsWith("x86_64") ? "x64" : "arm64"))
  })

  test("checks the exact target against the host platform and architecture", () => {
    expect(validateHostTarget("x86_64-unknown-linux-gnu", "linux", "x64")).toEqual({
      status: "available",
      value: undefined,
    })
    expect(validateHostTarget("aarch64-unknown-linux-gnu", "linux", "x64")).toEqual({
      status: "unavailable",
      code: "target-mismatch",
    })
    expect(validateHostTarget("x86_64-unknown-linux-gnu", "freebsd", "x64")).toEqual({
      status: "unavailable",
      code: "unsupported-host",
    })
  })

  test("uses fixed loader roots instead of PATH entries", () => {
    expect(fixedLoaderRoots("x86_64-unknown-linux-gnu", "/app/node", helpersFor("x86_64-unknown-linux-gnu"))).toEqual([
      "/app/node",
      "/bin/sh",
      "/usr/bin/bwrap",
      "/usr/bin/socat",
      "/usr/bin/rg",
      "/lib",
      "/lib64",
      "/usr/lib",
      "/usr/lib64",
      "/etc/ld.so.cache",
      "/dev/null",
    ])
    expect(fixedLoaderRoots("aarch64-pc-windows-msvc", "C:\\App\\node.exe", {}, [])).toEqual(["C:\\App\\node.exe"])
    expect(windowsLoaderPolicy("aarch64-pc-windows-msvc", "C:\\Windows")).toEqual({
      status: "evidence-required",
      code: "windows-loader-evidence-required",
    })
  })

  test("canonicalizes fixed POSIX helpers once and records their identities", async () => {
    const inspected: string[] = []
    const result = await resolveHostHelpers("x86_64-unknown-linux-gnu", {
      inspectPath: async (value) => {
        inspected.push(value)
        const canonicalPath = value === "/bin/sh" ? "/usr/bin/dash" : value
        return { canonicalPath, kind: "file", reparsePoint: value === "/bin/sh", identity: `id:${canonicalPath}` }
      },
      accessExecutable: async () => true,
    })
    expect(result).toEqual({
      status: "available",
      value: {
        shell: { path: "/usr/bin/dash", identity: "id:/usr/bin/dash" },
        bwrap: { path: "/usr/bin/bwrap", identity: "id:/usr/bin/bwrap" },
        socat: { path: "/usr/bin/socat", identity: "id:/usr/bin/socat" },
        ripgrep: { path: "/usr/bin/rg", identity: "id:/usr/bin/rg" },
      },
    })
    expect(inspected.filter((value) => value === "/usr/bin/dash")).toHaveLength(1)
  })

  test("requires the fixed macOS env and sandbox-exec helpers", async () => {
    expect(
      await resolveHostHelpers("aarch64-apple-darwin", {
        inspectPath: async (value) => ({
          canonicalPath: value,
          kind: "file",
          reparsePoint: false,
          identity: `id:${value}`,
        }),
        accessExecutable: async () => true,
      }),
    ).toEqual({
      status: "available",
      value: {
        shell: { path: "/bin/sh", identity: "id:/bin/sh" },
        env: { path: "/usr/bin/env", identity: "id:/usr/bin/env" },
        sandboxExec: { path: "/usr/bin/sandbox-exec", identity: "id:/usr/bin/sandbox-exec" },
      },
    })
  })

  test("fails closed when any fixed POSIX helper cannot be resolved", async () => {
    expect(
      await resolveHostHelpers("x86_64-unknown-linux-gnu", {
        inspectPath: async (value) =>
          value.endsWith("bwrap")
            ? undefined
            : { canonicalPath: value, kind: "file", reparsePoint: false, identity: `id:${value}` },
        accessExecutable: async () => true,
      }),
    ).toEqual({ status: "unavailable", code: "host-helper-unavailable" })
  })
})

describe("document sandbox path validation", () => {
  const evidence = windowsEvidence({ reparsePoints: ["C:\\linked"] })
  const windowsDependencies = {
    inspectPath: async (value: string): Promise<PathInspection> => ({
      canonicalPath: value,
      kind: value.toLowerCase().endsWith(".dll") ? "file" : "directory",
      reparsePoint: false,
      identity: value.toLowerCase().endsWith(".dll") ? `loader:${value.toLowerCase()}` : `id:${value}`,
    }),
    accessExecutable: async () => true,
  }

  test.each([
    "\\\\server\\share\\runtime",
    "\\\\?\\C:\\runtime",
    "\\\\.\\C:\\runtime",
    "C:\\runtime:stream",
    "C:\\linked\\runtime",
    "Z:\\runtime",
    "Q:\\runtime",
    "C:\\runtime. ",
    "C:\\CON\\runtime",
  ])("rejects unsafe or unproved Windows path %s", async (value) => {
    expect(await validateWindowsEvidence([value], evidence, windowsDependencies)).toEqual({
      status: "unavailable",
      code: "invalid-path",
    })
  })

  test("rejects the entire Windows inventory when any visible volume is not local and fixed", async () => {
    expect(
      await validateWindowsEvidence(
        ["C:\\runtime"],
        {
          ...evidence,
          volumes: [...evidence.volumes, { root: "Z:\\", kind: "network", local: false, filesystem: "NTFS" }],
        },
        windowsDependencies,
      ),
    ).toEqual({ status: "unavailable", code: "invalid-path" })
  })

  test("requires complete volume, loader, and ACL reset evidence", async () => {
    expect(await validateWindowsEvidence(["C:\\runtime"])).toEqual({
      status: "evidence-required",
      code: "windows-path-evidence-required",
    })
    expect(await validateWindowsEvidence(["C:\\runtime"], { ...evidence, complete: false })).toEqual({
      status: "evidence-required",
      code: "windows-volume-evidence-required",
    })
    expect(await validateWindowsEvidence(["C:\\runtime"], { ...evidence, loaderComplete: false })).toEqual({
      status: "evidence-required",
      code: "windows-loader-evidence-required",
    })
    expect(await validateWindowsEvidence(["C:\\runtime"], { ...evidence, reparseComplete: false })).toEqual({
      status: "evidence-required",
      code: "windows-path-evidence-required",
    })
    expect(
      await validateWindowsEvidence(
        ["C:\\runtime"],
        {
          ...evidence,
          loaderEntries: [{ path: "C:\\Windows", kind: "directory", identity: "broad-root" }],
        },
        windowsDependencies,
      ),
    ).toEqual({ status: "unavailable", code: "invalid-path" })
    expect(await validateWindowsEvidence(["C:\\runtime"], { ...evidence, aclReset: "unverified" })).toEqual({
      status: "evidence-required",
      code: "windows-acl-reset-evidence-required",
    })
  })

  test.each([
    ["C:\\", "directory"],
    ["C:\\Users", "directory"],
    ["C:\\Users\\broker\\AppData", "directory"],
    ["C:\\project", "directory"],
    ["C:\\app", "directory"],
    ["C:\\project\\loader.dll", "file"],
  ] as const)("rejects identity-valid loader entry outside the closed policy: %s", async (loader, kind) => {
    const changed = {
      ...evidence,
      loaderEntries: [{ path: loader, kind, identity: `id:${loader}` }],
    }
    expect(await validateWindowsEvidence(["C:\\runtime"], changed, windowsPolicyDependencies(changed))).toEqual({
      status: "unavailable",
      code: "invalid-path",
    })
  })

  test("rejects overlapping roots and noncanonical path inspection", async () => {
    const input = linuxInput({ jobRoot: "/runtime/job" })
    const overlap = await prepare(input, fakeFilesystem(input))
    expect(overlap).toEqual({ status: "unavailable", code: "overlapping-roots" })

    const noncanonical = await prepare(
      linuxInput(),
      fakeFilesystem(linuxInput(), (value) => (value === "/runtime" ? "/replacement" : value)),
    )
    expect(noncanonical).toEqual({ status: "unavailable", code: "invalid-path" })
  })

  test("prepares only explicit runtime and sandbox assets", async () => {
    const input = linuxInput()
    const result = await prepare(input, fakeFilesystem(input))
    expect(result.status).toBe("available")
    if (result.status !== "available") return
    expect(result.value.runtimeAssets.bootstrap).toBe("/runtime/worker/bootstrap.js")
    expect(result.value.runtimeAssets.canvasNativeBinary).toEndWith("skia.linux-x64-gnu.node")
    expect(result.value.sandboxAssets.seccompApplyPath).toBe("/sandbox/vendor/seccomp/x64/apply-seccomp")
    expect(result.value.config.filesystem.allowWrite).toEqual(["/jobs/one"])
    expect(result.value.config.bwrapPath).toBe("/usr/bin/bwrap")
    expect(result.value.brokerEnvironment.PATH).toBe("/usr/bin:/bin")
  })

  test.skipIf(!filesystemLinksAvailable)("rejects a filesystem-backed symlink or junction root", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "document-policy-link-"))
    try {
      const runtime = path.join(parent, "runtime")
      const linked = path.join(parent, "linked")
      const jobRoot = path.join(parent, "job")
      const sandboxAssetsRoot = path.join(parent, "sandbox")
      await Promise.all([mkdir(runtime), mkdir(jobRoot), mkdir(sandboxAssetsRoot)])
      await symlink(runtime, linked, process.platform === "win32" ? "junction" : "dir")
      if (
        (process.platform !== "darwin" && process.platform !== "linux" && process.platform !== "win32") ||
        (process.arch !== "x64" && process.arch !== "arm64")
      ) {
        return
      }
      const target = DocumentRuntimeTarget.fromHost(process.platform, process.arch)
      expect(
        await prepare({
          target,
          runtimeRoot: linked,
          jobRoot,
          sandboxAssetsRoot,
          executablePath: process.execPath,
          manifestSha256: digest,
        }),
      ).toEqual({ status: "unavailable", code: "invalid-path" })
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })
})

describe("document sandbox command and environments", () => {
  test("keeps only the broker allowlist and trusted fixed values", () => {
    expect(
      brokerEnvironment(
        "C:\\Program Files\\Koala\\sandbox-runtime",
        {
          HOME: "C:\\Users\\broker",
          LANG: "en_US.UTF-8",
          PATH: "C:\\Windows\\System32;C:\\Program Files\\Node",
          PATHEXT: ".EXE;.CMD",
          SystemRoot: "C:\\Windows",
          HTTP_PROXY: "credential-canary",
          NODE_OPTIONS: "--require=canary",
          AWS_SECRET_ACCESS_KEY: "credential-canary",
        },
        "win32",
      ),
    ).toEqual({
      HOME: "C:\\Users\\broker",
      LANG: "en_US.UTF-8",
      PATH: "C:\\Windows\\System32",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      SystemRoot: "C:\\Windows",
      WINDIR: "C:\\Windows",
      KOALA_DOCUMENT_RUNTIME_PROXY_ASSETS_ROOT: "C:\\Program Files\\Koala\\sandbox-runtime",
      ELECTRON_RUN_AS_NODE: "1",
    })
  })

  test("builds the exact bootstrap handoff environment", () => {
    expect(
      handoffEnvironment({
        target: "x86_64-pc-windows-msvc",
        runtimeRoot: "C:\\Program Files\\Koala\\runtime",
        jobRoot: "D:\\Koala Jobs\\one",
        manifestSha256: digest,
        systemRoot: "C:\\Windows",
      }),
    ).toEqual({
      DISABLE_SYSTEM_FONTS_LOAD: "1",
      DOCUMENT_JOB_ROOT: "D:\\Koala Jobs\\one",
      DOCUMENT_RUNTIME_MANIFEST_SHA256: "a".repeat(64),
      DOCUMENT_RUNTIME_ROOT: "C:\\Program Files\\Koala\\runtime",
      DOCUMENT_RUNTIME_TARGET: "x86_64-pc-windows-msvc",
      ELECTRON_RUN_AS_NODE: "1",
      LANG: "C",
      LC_ALL: "C",
      TEMP: "D:\\Koala Jobs\\one\\tmp",
      TMP: "D:\\Koala Jobs\\one\\tmp",
      TMPDIR: "D:\\Koala Jobs\\one\\tmp",
      TZ: "UTC",
      SystemRoot: "C:\\Windows",
      WINDIR: "C:\\Windows",
    })
  })

  test("applies only broker and handoff values to SRT launch descriptors", () => {
    const handoff = { DOCUMENT_JOB_ROOT: "C:\\jobs\\one", ELECTRON_RUN_AS_NODE: "1" }
    const broker = {
      SystemRoot: "C:\\Windows",
      PATH: "C:\\Windows\\System32",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
    }
    expect(
      applyHandoffEnvironment(
        {
          argv: ["srt-win.exe", "exec", "--env", "PATH=child-path", "--env", "DOCUMENT_JOB_ROOT=old", "--", "node"],
          env: { SECRET: "canary" },
        },
        handoff,
        broker,
        "win32",
      ),
    ).toEqual({
      argv: [
        "srt-win.exe",
        "exec",
        "--env",
        "PATH=C:\\Windows\\System32",
        "--env",
        "PATHEXT=.COM;.EXE;.BAT;.CMD",
        "--env",
        "DOCUMENT_JOB_ROOT=C:\\jobs\\one",
        "--env",
        "ELECTRON_RUN_AS_NODE=1",
        "--",
        "node",
      ],
      env: broker,
    })
    expect(
      applyHandoffEnvironment(
        { argv: ["/bin/sh", "-c", "fixed"], env: { SECRET: "canary" } },
        handoff,
        broker,
        "linux",
      ),
    ).toEqual({ argv: ["/bin/sh", "-c", "fixed"], env: { ...broker, ...handoff } })
  })

  test("encodes hostile bootstrap paths without host-shell interpolation", () => {
    const special = "space ' single \" double % amp& caret^ parens() dollar$ tick` trail\\"
    const posix = bootstrapCommand(
      "x86_64-apple-darwin",
      `/Applications/${special}/node`,
      `/Applications/${special}/bootstrap.js`,
      "/bin/sh",
    )
    expect(posix.binShell).toBe("/bin/sh")
    expect(posix.command).toBe(
      `exec '/Applications/space '"'"' single " double % amp& caret^ parens() dollar$ tick\` trail\\/node' '/Applications/space '"'"' single " double % amp& caret^ parens() dollar$ tick\` trail\\/bootstrap.js'`,
    )

    const windows = bootstrapCommand(
      "aarch64-pc-windows-msvc",
      `C:\\Program Files\\${special}\\node.exe`,
      `C:\\Program Files\\${special}\\bootstrap.js`,
    )
    expect(windows).toEqual({
      command: "document-runtime-bootstrap",
      binShell: {
        exe: `C:\\Program Files\\${special}\\node.exe`,
        args: [`C:\\Program Files\\${special}\\bootstrap.js`],
      },
    })
  })
})

describe("document sandbox effective policy", () => {
  test("rejects dependency errors and every degradation warning", async () => {
    expect(
      await verifyDependencies({
        isSupportedPlatform: () => true,
        checkDependenciesAsync: async () => ({ errors: [], warnings: ["seccomp unavailable"] }),
      }),
    ).toEqual({ status: "unavailable", code: "sandbox-dependency-unavailable" })
    expect(
      await verifyDependencies({
        isSupportedPlatform: () => false,
        checkDependenciesAsync: async () => ({ errors: [] }),
      }),
    ).toEqual({ status: "unavailable", code: "sandbox-dependency-unavailable" })
  })

  test("accepts only the exact effective policy and denies SRT persistent defaults", async () => {
    const expected = linuxConfig()
    const defaults = posixSrtDefaults("/home/broker")
    const manager = effectiveManager(expected, defaults)
    expect(
      await verifyEffectivePolicy(manager, expected, "x86_64-unknown-linux-gnu", {
        srtDefaultWritePaths: defaults,
      }),
    ).toEqual({
      status: "available",
      value: undefined,
    })

    expect(
      await verifyEffectivePolicy(
        { ...manager, getAllowLocalBinding: () => true },
        expected,
        "x86_64-unknown-linux-gnu",
        {
          srtDefaultWritePaths: defaults,
        },
      ),
    ).toEqual({ status: "unavailable", code: "sandbox-policy-mismatch" })

    expect(
      await verifyEffectivePolicy(
        {
          ...manager,
          getFsWriteConfig: () => ({
            allowOnly: ["/jobs/one", "/tmp/claude"],
            denyWithinAllow: expected.filesystem.denyWrite.filter((value) => value !== "/tmp/claude"),
          }),
        },
        expected,
        "x86_64-unknown-linux-gnu",
        { srtDefaultWritePaths: defaults },
      ),
    ).toEqual({ status: "unavailable", code: "sandbox-policy-mismatch" })
  })

  test("models the pinned Windows getter defaults but keeps Windows disabled without ACL reset evidence", async () => {
    const expected = windowsConfig()
    const defaults = getDefaultWritePaths()
    expect(defaults).toEqual(expect.arrayContaining(["/dev/null", "/tmp/claude", "/private/tmp/claude"]))
    expect(expected.filesystem.allowRead).not.toContain("C:\\Windows")
    expect(expected.filesystem.allowRead).not.toContain("C:\\app")
    expect(expected.filesystem.allowWrite).toEqual(["D:\\jobs\\one"])
    const unverified = windowsEvidence({ aclReset: "unverified" })
    expect(
      await verifyEffectivePolicy(effectiveManager(expected, defaults), expected, "x86_64-pc-windows-msvc", {
        windowsEvidence: unverified,
        dependencies: windowsPolicyDependencies(unverified),
        srtDefaultWritePaths: defaults,
      }),
    ).toEqual({
      status: "evidence-required",
      code: "windows-acl-reset-evidence-required",
    })

    const verified = windowsEvidence()
    expect(
      await verifyEffectivePolicy(effectiveManager(expected, defaults), expected, "x86_64-pc-windows-msvc", {
        windowsEvidence: verified,
        dependencies: windowsPolicyDependencies(verified),
        srtDefaultWritePaths: defaults,
      }),
    ).toEqual({ status: "evidence-required", code: "windows-loader-evidence-required" })

    const changed = windowsEvidence({
      volumes: [
        { root: "C:\\", kind: "fixed", local: true, filesystem: "NTFS" },
        { root: "D:\\", kind: "network", local: false, filesystem: "NTFS" },
      ],
    })
    expect(
      await verifyEffectivePolicy(effectiveManager(expected, defaults), expected, "x86_64-pc-windows-msvc", {
        windowsEvidence: changed,
        dependencies: windowsPolicyDependencies(changed),
        srtDefaultWritePaths: defaults,
      }),
    ).toEqual({ status: "unavailable", code: "invalid-path" })
  })
})

function linuxInput(overrides: Partial<Parameters<typeof prepare>[0]> = {}) {
  return {
    target: "x86_64-unknown-linux-gnu",
    runtimeRoot: "/runtime",
    jobRoot: "/jobs/one",
    sandboxAssetsRoot: "/sandbox",
    executablePath: "/host/node",
    manifestSha256: digest,
    platform: "linux",
    architecture: "x64",
    ...overrides,
  } as const
}

function fakeFilesystem(input: Parameters<typeof prepare>[0], canonical = (value: string) => value) {
  const paths = input.target.includes("windows") ? path.win32 : path.posix
  const runtime = resolveRuntimeAssets(input.runtimeRoot, input.target)
  const sandbox = resolveSandboxAssets(input.sandboxAssetsRoot, input.target)
  const files = new Set([
    input.executablePath,
    runtime.packageJson,
    runtime.bootstrap,
    runtime.worker,
    runtime.tesseract,
    paths.join(runtime.tessdata, "eng.traineddata"),
    paths.join(runtime.tessdata, "osd.traineddata"),
    paths.join(runtime.pdfRoot, "legacy", "build", "pdf.mjs"),
    runtime.canvasEntry,
    runtime.canvasNativeBinary,
    sandbox.javaAgentJarPath,
    sandbox.seccompApplyPath,
    sandbox.srtWinPath,
    "/bin/sh",
    "/usr/bin/sh",
    "/usr/bin/bwrap",
    "/bin/bwrap",
    "/usr/bin/socat",
    "/bin/socat",
    "/usr/bin/rg",
    "/bin/rg",
    "/usr/bin/env",
    "/usr/bin/sandbox-exec",
  ])
  return {
    inspectPath: async (value: string): Promise<PathInspection> => ({
      canonicalPath: canonical(value),
      kind: files.has(value) ? "file" : "directory",
      reparsePoint: false,
      identity: `id:${canonical(value)}`,
    }),
    accessExecutable: async () => true,
    environment: { HOME: "/home/broker", PATH: "/usr/bin:/bin", TMPDIR: "/tmp" },
  }
}

function linuxConfig() {
  return buildConfig({
    target: "x86_64-unknown-linux-gnu",
    runtimeRoot: "/runtime",
    jobRoot: "/jobs/one",
    executablePath: "/host/node",
    sandboxAssets: resolveSandboxAssets("/sandbox", "x86_64-unknown-linux-gnu"),
    hostHelpers: helpersFor("x86_64-unknown-linux-gnu"),
    environment: { HOME: "/home/broker", TMPDIR: "/tmp" },
  })
}

function windowsConfig() {
  const home = os.homedir()
  return buildConfig({
    target: "x86_64-pc-windows-msvc",
    runtimeRoot: "C:\\runtime",
    jobRoot: "D:\\jobs\\one",
    executablePath: "C:\\app\\node.exe",
    systemRoot: "C:\\Windows",
    sandboxAssets: resolveSandboxAssets("C:\\app\\sandbox-runtime", "x86_64-pc-windows-msvc"),
    hostHelpers: {},
    windowsLoaderPaths: [],
    windowsVolumes: ["C:\\", "D:\\"],
    environment: { USERPROFILE: home, TEMP: path.win32.join(home, "Temp"), SystemRoot: "C:\\Windows" },
  })
}

function effectiveManager(config: SandboxRuntimeConfig, defaults: ReadonlyArray<string>): InspectableSandboxManager {
  return {
    isSupportedPlatform: () => true,
    checkDependenciesAsync: async () => ({ errors: [], warnings: [] }),
    getConfig: () => config,
    getFsReadConfig: () => ({ denyOnly: config.filesystem.denyRead, allowWithinDeny: config.filesystem.allowRead }),
    getFsWriteConfig: () => ({
      allowOnly: [...defaults, ...config.filesystem.allowWrite],
      denyWithinAllow: config.filesystem.denyWrite,
    }),
    getNetworkRestrictionConfig: () => ({ allowedHosts: [] }),
    getAllowUnixSockets: () => [],
    getAllowLocalBinding: () => false,
    getAllowMachLookup: () => [],
  }
}

function helpersFor(target: DocumentRuntimeTarget.Target) {
  if (target.includes("windows")) return {}
  if (target.includes("apple")) {
    return {
      shell: { path: "/bin/sh", identity: "shell" },
      env: { path: "/usr/bin/env", identity: "env" },
      sandboxExec: { path: "/usr/bin/sandbox-exec", identity: "sandbox-exec" },
    }
  }
  return {
    shell: { path: "/bin/sh", identity: "shell" },
    bwrap: { path: "/usr/bin/bwrap", identity: "bwrap" },
    socat: { path: "/usr/bin/socat", identity: "socat" },
    ripgrep: { path: "/usr/bin/rg", identity: "ripgrep" },
  }
}

function posixSrtDefaults(home: string) {
  return [
    "/dev/stdout",
    "/dev/stderr",
    "/dev/null",
    "/dev/tty",
    "/dev/dtracehelper",
    "/dev/autofs_nowait",
    "/tmp/claude",
    "/private/tmp/claude",
    `${home}/.npm/_logs`,
    `${home}/.claude/debug`,
  ]
}

function windowsEvidence(overrides: Partial<WindowsVolumeEvidence> = {}): WindowsVolumeEvidence {
  const target = "x86_64-pc-windows-msvc"
  const systemRoot = "C:\\Windows"
  return {
    target,
    complete: true,
    reparseComplete: true,
    loaderComplete: true,
    aclReset: "verified",
    executablePath: "C:\\app\\node.exe",
    systemRoot,
    volumes: [
      { root: "C:\\", kind: "fixed", local: true, filesystem: "NTFS" },
      { root: "D:\\", kind: "fixed", local: true, filesystem: "ReFS" },
    ],
    reparsePoints: [],
    loaderEntries: [
      {
        path: path.win32.join(systemRoot, "System32", "kernel32.dll"),
        kind: "file",
        identity: `loader:${path.win32.join(systemRoot, "System32", "kernel32.dll").toLowerCase()}`,
      },
    ],
    ...overrides,
  }
}

function windowsPolicyDependencies(evidence: WindowsVolumeEvidence) {
  const loaders = new Map(evidence.loaderEntries.map((entry) => [entry.path.toLowerCase(), entry]))
  return {
    inspectPath: async (value: string): Promise<PathInspection> => {
      const loader = loaders.get(value.toLowerCase())
      return {
        canonicalPath: value,
        kind: loader?.kind ?? "directory",
        reparsePoint: false,
        identity: loader?.identity ?? `id:${value}`,
      }
    },
    accessExecutable: async () => true,
  }
}

async function supportsDirectoryLinks() {
  const parent = await mkdtemp(path.join(os.tmpdir(), "document-policy-link-check-"))
  try {
    const target = path.join(parent, "target")
    await mkdir(target)
    await symlink(target, path.join(parent, "link"), process.platform === "win32" ? "junction" : "dir")
    return true
  } catch {
    return false
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
}
