import { afterAll, beforeAll, expect, test } from "bun:test"
import type { Configuration } from "electron-builder"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  documentRuntimeAttestation,
  prepareReleaseDocumentRuntime,
  stagedDocumentRuntime,
  verifyPreparedSandboxRuntime,
} from "./scripts/document-runtime"
import { productionRuntimeFixture } from "./test/fixture/document-runtime"

const legacyDesktopEntry = "resources/linux/opencode-desktop.desktop"
const releaseTarget = "x86_64-pc-windows-msvc" as const
let releaseSource: string
let trustedAttestation: string
const previousRustTarget = process.env.RUST_TARGET
const previousTrustedAttestation = process.env.KOALA_DOCUMENT_RUNTIME_ATTESTATION

beforeAll(async () => {
  releaseSource = await mkdtemp(path.join(os.tmpdir(), "desktop-config-runtime-"))
  trustedAttestation = `${releaseSource}.attestation.json`
  process.env.RUST_TARGET = releaseTarget
  process.env.KOALA_DOCUMENT_RUNTIME_ATTESTATION = trustedAttestation
  const sandboxRuntime = await verifyPreparedSandboxRuntime({ RUST_TARGET: releaseTarget })
  await productionRuntimeFixture(releaseSource, releaseTarget, trustedAttestation, true, false, {
    proxySha256: sandboxRuntime.documentProxySha256,
    sandboxRuntimeManifestSha256: sandboxRuntime.manifestSha256,
  })
  await prepareReleaseDocumentRuntime({
    source: releaseSource,
    trustedAttestation,
    environment: { RUST_TARGET: releaseTarget },
    probe: async () => ({ performed: true }),
  })
})

afterAll(async () => {
  await Promise.all([
    rm(releaseSource, { recursive: true, force: true }),
    rm(trustedAttestation, { force: true }),
    rm(stagedDocumentRuntime, { recursive: true, force: true }),
    rm(documentRuntimeAttestation, { force: true }),
  ])
  if (previousRustTarget === undefined) delete process.env.RUST_TARGET
  else process.env.RUST_TARGET = previousRustTarget
  if (previousTrustedAttestation === undefined) delete process.env.KOALA_DOCUMENT_RUNTIME_ATTESTATION
  else process.env.KOALA_DOCUMENT_RUNTIME_ATTESTATION = previousTrustedAttestation
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
  expect(config).toContain('["./scripts/document-runtime.ts", "verify"]')
  expect(staging).toContain("matchesConfinementEvidence")
  expect(staging).toContain("Document confinement evidence is missing or does not match packaged resources")
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
      from: stagedDocumentRuntime,
      to: "document-runtime/",
      filter: ["**/*"],
    })
    expect(config.extraResources).toContainEqual({
      from: documentRuntimeAttestation,
      to: "document-runtime.attestation.json",
    })
    expect(config.files).toContain("!resources/document-runtime{,/**/*}")
    expect(config.files).toContain("!resources/document-runtime.attestation.json")
    const manifest = await Bun.file(path.join(stagedDocumentRuntime, "manifest.json")).json()
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
