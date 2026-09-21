import { afterAll, beforeAll, expect, test } from "bun:test"
import type { Configuration } from "electron-builder"
import { cp, mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  prepareReleaseDocumentRuntime,
  verifyPreparedSandboxRuntime,
} from "./scripts/document-runtime"
import { confinementEvidenceFixture, productionRuntimeFixture } from "./test/fixture/document-runtime"

const legacyDesktopEntry = "resources/linux/opencode-desktop.desktop"
const releaseTarget = "x86_64-pc-windows-msvc" as const
let releaseSource: string
let trustedAttestation: string
let stagingRoot: string
let prepared: Awaited<ReturnType<typeof prepareReleaseDocumentRuntime>>
const previousRustTarget = process.env.RUST_TARGET
const previousStagingRoot = process.env.KOALA_DOCUMENT_RUNTIME_STAGING_ROOT
const previousVersion = process.env.OPENCODE_VERSION
const previousSha = process.env.GITHUB_SHA
const previousBuildID = process.env.KOALA_DOCUMENT_CONFINEMENT_BUILD_ID

beforeAll(async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "desktop-config-runtime-"))
  releaseSource = path.join(root, "candidate")
  const stagingParent = path.join(root, "staging")
  trustedAttestation = path.join(releaseSource, "document-runtime.attestation.json")
  await Promise.all([mkdir(releaseSource), mkdir(stagingParent)])
  stagingRoot = path.join(await realpath(stagingParent), "release")
  process.env.RUST_TARGET = releaseTarget
  process.env.KOALA_DOCUMENT_RUNTIME_STAGING_ROOT = stagingRoot
  process.env.OPENCODE_VERSION = "1.2.3"
  process.env.GITHUB_SHA = "a".repeat(40)
  process.env.KOALA_DOCUMENT_CONFINEMENT_BUILD_ID = "test-build-1"
  const sandboxRuntime = await verifyPreparedSandboxRuntime({ RUST_TARGET: releaseTarget })
  await cp(sandboxRuntime.root, path.join(releaseSource, "sandbox-runtime"), { recursive: true })
  await productionRuntimeFixture(path.join(releaseSource, "document-runtime"), releaseTarget, trustedAttestation)
  await confinementEvidenceFixture(releaseSource, releaseTarget, sandboxRuntime)
  prepared = await prepareReleaseDocumentRuntime({
    sourceResourcesRoot: await realpath(releaseSource),
    stagingParent: await realpath(stagingParent),
    stagingRoot,
    environment: { RUST_TARGET: releaseTarget },
    release: { version: "1.2.3", sourceCommit: "a".repeat(40), buildID: "test-build-1" },
  })
})

afterAll(async () => {
  await Promise.all([
    rm(path.dirname(releaseSource), { recursive: true, force: true }),
  ])
  if (previousRustTarget === undefined) delete process.env.RUST_TARGET
  else process.env.RUST_TARGET = previousRustTarget
  if (previousStagingRoot === undefined) delete process.env.KOALA_DOCUMENT_RUNTIME_STAGING_ROOT
  else process.env.KOALA_DOCUMENT_RUNTIME_STAGING_ROOT = previousStagingRoot
  if (previousVersion === undefined) delete process.env.OPENCODE_VERSION
  else process.env.OPENCODE_VERSION = previousVersion
  if (previousSha === undefined) delete process.env.GITHUB_SHA
  else process.env.GITHUB_SHA = previousSha
  if (previousBuildID === undefined) delete process.env.KOALA_DOCUMENT_CONFINEMENT_BUILD_ID
  else process.env.KOALA_DOCUMENT_CONFINEMENT_BUILD_ID = previousBuildID
})

const channels = [
  { channel: "dev", appId: "ai.opencode.desktop.dev" },
  { channel: "beta", appId: "ai.opencode.desktop.beta" },
  { channel: "prod", appId: "ai.opencode.desktop" },
] as const

for (const channel of channels) {
  test(`uses one Linux desktop identity for ${channel.channel}`, async () => {
    const previous = process.env.OPENCODE_CHANNEL
    process.env.OPENCODE_CHANNEL = channel.channel

    const module = await import(`./electron-builder.config.ts?channel=${channel.channel}`)
    const config = module.default as Configuration

    if (previous === undefined) delete process.env.OPENCODE_CHANNEL
    else process.env.OPENCODE_CHANNEL = previous

    expect(config.appId).toBe(channel.appId)
    expect(config.extraMetadata?.desktopName).toBe(`${channel.appId}.desktop`)
    expect(config.linux?.executableName).toBe(channel.appId)
    expect(config.linux?.desktop?.entry?.StartupWMClass).toBe(channel.appId)
    expect(config.deb?.fpm).toContainEqual(expect.stringContaining(`/usr/share/metainfo/${channel.appId}.metainfo.xml`))
    expect(config.rpm?.fpm).toContainEqual(expect.stringContaining(`/usr/share/metainfo/${channel.appId}.metainfo.xml`))
  })
}

test("keeps a hidden prod launcher for old Linux pins", async () => {
  const previous = process.env.OPENCODE_CHANNEL
  process.env.OPENCODE_CHANNEL = "prod"

  const module = await import("./electron-builder.config.ts?compat=prod")
  const config = module.default as Configuration

  if (previous === undefined) delete process.env.OPENCODE_CHANNEL
  else process.env.OPENCODE_CHANNEL = previous

  expect(
    config.deb?.fpm?.some((entry) =>
      entry.endsWith("opencode-desktop.desktop=/usr/share/applications/opencode-desktop.desktop"),
    ),
  ).toBe(true)
  expect(
    config.rpm?.fpm?.some((entry) =>
      entry.endsWith("opencode-desktop.desktop=/usr/share/applications/opencode-desktop.desktop"),
    ),
  ).toBe(true)

  const desktop = await Bun.file(legacyDesktopEntry).text()
  expect(desktop).toContain("Exec=/opt/OpenCode/ai.opencode.desktop %U")
  expect(desktop).toContain("Icon=ai.opencode.desktop")
  expect(desktop).toContain("StartupWMClass=ai.opencode.desktop")
  expect(desktop).toContain("NoDisplay=true")
})

test("bundles the CLI outside the dev app archive", async () => {
  const previous = process.env.OPENCODE_CHANNEL
  process.env.OPENCODE_CHANNEL = "dev"
  const module = await import("./electron-builder.config.ts?cli-resource")
  const config = module.default as Configuration
  if (previous === undefined) delete process.env.OPENCODE_CHANNEL
  else process.env.OPENCODE_CHANNEL = previous

  expect(config.files).toContain("!resources/opencode-cli*")
  expect(config.extraResources).toContainEqual({
    from: "resources/",
    to: "",
    filter: ["opencode-cli*"],
  })
})

test("bundles the sandbox worker and native assets outside the app archive", async () => {
  const module = await import("./electron-builder.config.ts?sandbox-resource")
  const config = module.default as Configuration

  expect(config.extraResources).toContainEqual({
      from: "../opencode/dist/node/sandbox-runtime/",
    to: "sandbox-runtime/",
    filter: [
      "sandbox-worker.mjs",
      "document-runtime-proxy.mjs",
      "sandbox-runtime.manifest.json",
      "LICENSE",
      "vendor/**/*",
    ],
  })
  expect(config.files).not.toContain("../opencode/dist/node/sandbox-runtime/**/*")
  const manifest = await Bun.file("../opencode/dist/node/sandbox-runtime/sandbox-runtime.manifest.json").json()
  expect(manifest.target).toBe(releaseTarget)
  expect(manifest.files.map((file: { readonly path: string }) => file.path)).toEqual(
    expect.arrayContaining([
      "sandbox-worker.mjs",
      "document-runtime-proxy.mjs",
      "LICENSE",
      "vendor/java-proxy-agent/srt-proxy-agent.jar",
      "vendor/srt-win/x64/srt-win.exe",
    ]),
  )
})

test("verifies confinement evidence before evaluating package resources", async () => {
  const config = await Bun.file("electron-builder.config.ts").text()
  const staging = await Bun.file("scripts/document-runtime.ts").text()
  expect(config).toContain('confinementCandidate ? "./scripts/document-runtime-evidence.ts" : "./scripts/document-runtime.ts"')
  expect(config).toContain('confinementCandidate ? "verify-candidate" : "verify"')
  expect(staging).toContain("verifyConfinementResources")
  expect(staging).toContain("Document runtime staging root must be fresh")
})

for (const channel of ["beta", "prod"] as const) {
  test(`does not bundle the CLI in ${channel} builds`, async () => {
    const previous = process.env.OPENCODE_CHANNEL
    process.env.OPENCODE_CHANNEL = channel
    const module = await import(`./electron-builder.config.ts?no-cli-resource=${channel}`)
    const config = module.default as Configuration
    if (previous === undefined) delete process.env.OPENCODE_CHANNEL
    else process.env.OPENCODE_CHANNEL = previous

    expect(config.extraResources).not.toContainEqual({
      from: "resources/",
      to: "",
      filter: ["opencode-cli*"],
    })
  })

  test(`bundles only the verified document runtime in ${channel} builds`, async () => {
    const previous = process.env.OPENCODE_CHANNEL
    process.env.OPENCODE_CHANNEL = channel
    const module = await import(`./electron-builder.config.ts?document-runtime-resource=${channel}`)
    const config = module.default as Configuration
    if (previous === undefined) delete process.env.OPENCODE_CHANNEL
    else process.env.OPENCODE_CHANNEL = previous

    expect(config.extraResources).toContainEqual({
      from: prepared.root,
      to: "document-runtime/",
      filter: ["**/*"],
    })
    expect(config.extraResources).toContainEqual({
      from: prepared.attestation,
      to: "document-runtime.attestation.json",
    })
    expect(config.extraResources).toContainEqual({
      from: prepared.evidenceRoot,
      to: "document-confinement-evidence/",
      filter: ["**/*"],
    })
    expect(config.extraResources).toContainEqual({
      from: prepared.sandboxRoot,
      to: "sandbox-runtime/",
      filter: [
        "sandbox-worker.mjs",
        "document-runtime-proxy.mjs",
        "sandbox-runtime.manifest.json",
        "LICENSE",
        "vendor/**/*",
      ],
    })
    expect(config.files).toContain("!resources/document-runtime{,/**/*}")
    expect(config.files).toContain("!resources/document-runtime.attestation.json")
    expect(config.files).toContain("!resources/document-confinement-evidence{,/**/*}")
    const manifest = await Bun.file(path.join(prepared.root, "manifest.json")).json()
    expect(manifest.files.map((file: { readonly path: string }) => file.path)).toEqual(
      expect.arrayContaining(["worker/bootstrap.js", "worker/worker.js"]),
    )
  })
}

test("does not bundle an incomplete development runtime", async () => {
  const previous = process.env.OPENCODE_CHANNEL
  process.env.OPENCODE_CHANNEL = "dev"
  const module = await import("./electron-builder.config.ts?no-development-document-runtime")
  const config = module.default as Configuration
  if (previous === undefined) delete process.env.OPENCODE_CHANNEL
  else process.env.OPENCODE_CHANNEL = previous

  expect(config.extraResources).not.toContainEqual({
    from: expect.stringContaining("document-runtime"),
    to: "document-runtime/",
    filter: ["**/*"],
  })
})
