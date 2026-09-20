import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  prepareReleaseDocumentRuntime,
  verifyPreparedReleaseDocumentRuntime,
  verifyPreparedSandboxRuntime,
} from "./document-runtime"
import { productionRuntimeFixture } from "../test/fixture/document-runtime"

const roots: string[] = []
const target = "x86_64-pc-windows-msvc" as const
const sandboxRuntime = await verifyPreparedSandboxRuntime({ RUST_TARGET: target })

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

describe("release document runtime staging", () => {
  test("stages and re-verifies a release-ready runtime", async () => {
    const root = await temporaryDirectory()
    const source = path.join(root, "source")
    const destination = path.join(root, "staged")
    const attestation = path.join(root, "runtime.verified.json")
    const trustedAttestation = path.join(root, "trusted-attestation.json")
    await trustedRuntimeFixture(source, trustedAttestation)

    const prepared = await prepareReleaseDocumentRuntime({
      source,
      trustedAttestation,
      destination,
      attestation,
      environment: { RUST_TARGET: target },
      probe: async () => ({ performed: true }),
    })
    expect(prepared).toEqual({
      root: await realpath(destination),
      manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      target,
      probe: { performed: true },
    })
    await expect(
      verifyPreparedReleaseDocumentRuntime({ root: destination, attestation, environment: { RUST_TARGET: target } }),
    ).resolves.toEqual({ root: prepared.root, manifestSha256: prepared.manifestSha256, target })
    await expect(
      verifyPreparedReleaseDocumentRuntime({
        root: destination,
        attestation,
        environment: { RUST_TARGET: "aarch64-pc-windows-msvc" },
      }),
    ).rejects.toThrow("Prepared document runtime target does not match RUST_TARGET")

    await writeFile(path.join(destination, "worker", "worker.js"), "changed")
    await expect(
      verifyPreparedReleaseDocumentRuntime({ root: destination, attestation, environment: { RUST_TARGET: target } }),
    ).rejects.toEqual(expect.objectContaining({ code: "file-mismatch" }))
  })

  test("does not stage an incomplete release runtime", async () => {
    const root = await temporaryDirectory()
    const source = path.join(root, "source")
    const destination = path.join(root, "staged")
    const attestation = path.join(root, "runtime.verified.json")
    const trustedAttestation = path.join(root, "trusted-attestation.json")
    await trustedRuntimeFixture(source, trustedAttestation, false)

    await expect(
      prepareReleaseDocumentRuntime({
        source,
        trustedAttestation,
        destination,
        attestation,
        environment: { RUST_TARGET: target },
        probe: async () => ({ performed: true }),
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "release-incomplete" }))
    expect(await Bun.file(attestation).exists()).toBe(false)
  })

  test("requires explicit RUST_TARGET and rejects stale target attestations", async () => {
    const root = await temporaryDirectory()
    const source = path.join(root, "source")
    const trustedAttestation = path.join(root, "trusted-attestation.json")
    await trustedRuntimeFixture(source, trustedAttestation)
    await expect(
      prepareReleaseDocumentRuntime({
        source,
        trustedAttestation,
        destination: path.join(root, "staged"),
        attestation: path.join(root, "staged-attestation.json"),
        environment: {},
        probe: async () => ({ performed: true }),
      }),
    ).rejects.toThrow("RUST_TARGET must identify a supported document runtime target")
    await expect(
      prepareReleaseDocumentRuntime({
        source,
        trustedAttestation,
        destination: path.join(root, "staged"),
        attestation: path.join(root, "staged-attestation.json"),
        environment: { RUST_TARGET: "aarch64-pc-windows-msvc" },
        probe: async () => ({ performed: true }),
      }),
    ).rejects.toThrow("Document runtime attestation target does not match RUST_TARGET")
  })

  test("cleans stale staged runtime, attestation, and temporary outputs before validation", async () => {
    const root = await temporaryDirectory()
    const source = path.join(root, "source")
    const destination = path.join(root, "staged")
    const attestation = path.join(root, "staged-attestation.json")
    const trustedAttestation = path.join(root, "trusted-attestation.json")
    await trustedRuntimeFixture(source, trustedAttestation)
    await mkdir(path.join(destination, "worker"), { recursive: true })
    await writeFile(path.join(destination, "worker", "bootstrap.js"), "stale")
    await writeFile(attestation, "stale-digest")
    await mkdir(`${destination}.tmp-stale`, { recursive: true })
    await writeFile(`${attestation}.tmp-stale`, "stale-attestation")

    await expect(
      prepareReleaseDocumentRuntime({
        source,
        trustedAttestation,
        destination,
        attestation,
        environment: { RUST_TARGET: "aarch64-pc-windows-msvc" },
        probe: async () => ({ performed: true }),
      }),
    ).rejects.toThrow("Document runtime attestation target does not match RUST_TARGET")
    expect(await Bun.file(destination).exists()).toBe(false)
    expect(await Bun.file(attestation).exists()).toBe(false)
    expect(await Bun.file(`${destination}.tmp-stale`).exists()).toBe(false)
    expect(await Bun.file(`${attestation}.tmp-stale`).exists()).toBe(false)
  })

  test("rejects overlapping source and staging roots without deleting the source", async () => {
    const root = await temporaryDirectory()
    const source = path.join(root, "source")
    const trustedAttestation = path.join(root, "trusted-attestation.json")
    await productionRuntimeFixture(source, target, trustedAttestation)

    await expect(
      prepareReleaseDocumentRuntime({
        source,
        trustedAttestation,
        destination: source,
        attestation: path.join(root, "staged-attestation.json"),
        environment: { RUST_TARGET: target },
        probe: async () => ({ performed: true }),
      }),
    ).rejects.toThrow("Source and staged document runtimes must not overlap")
    expect(await Bun.file(path.join(source, "manifest.json")).exists()).toBe(true)
  })

  test("requires the trust input outside the runtime and publishes nothing when the offline probe fails", async () => {
    const root = await temporaryDirectory()
    const source = path.join(root, "source")
    const nestedAttestation = path.join(source, "trusted-attestation.json")
    await trustedRuntimeFixture(source, nestedAttestation)
    await expect(
      prepareReleaseDocumentRuntime({
        source,
        trustedAttestation: nestedAttestation,
        destination: path.join(root, "staged"),
        attestation: path.join(root, "staged-attestation.json"),
        environment: { RUST_TARGET: target },
        probe: async () => ({ performed: true }),
      }),
    ).rejects.toThrow("Trusted document runtime attestation must be outside the runtime root")

    await rm(nestedAttestation)
    const trustedAttestation = path.join(root, "trusted-attestation.json")
    await trustedRuntimeFixture(source, trustedAttestation)
    const stagedAttestation = path.join(root, "staged-attestation.json")
    await expect(
      prepareReleaseDocumentRuntime({
        source,
        trustedAttestation,
        destination: path.join(root, "staged"),
        attestation: stagedAttestation,
        environment: { RUST_TARGET: target },
        probe: async () => {
          throw new Error("offline probe failed")
        },
      }),
    ).rejects.toThrow("offline probe failed")
    expect(await Bun.file(stagedAttestation).exists()).toBe(false)
  })

  test("requires digest-bound target-native smoke evidence when a local cross-target probe cannot run", async () => {
    const root = await temporaryDirectory()
    const source = path.join(root, "source")
    const trustedAttestation = path.join(root, "trusted-attestation.json")
    const destination = path.join(root, "staged")
    const stagedAttestation = path.join(root, "staged-attestation.json")
    await trustedRuntimeFixture(source, trustedAttestation)

    await expect(
      prepareReleaseDocumentRuntime({
        source,
        trustedAttestation,
        destination,
        attestation: stagedAttestation,
        environment: { RUST_TARGET: target },
        probe: async () => ({ performed: false, reason: "cross-target" }),
      }),
    ).rejects.toThrow("Cross-target document runtime staging requires attested target-native smoke evidence")

    await trustedRuntimeFixture(source, trustedAttestation, true, true)
    await expect(
      prepareReleaseDocumentRuntime({
        source,
        trustedAttestation,
        destination,
        attestation: stagedAttestation,
        environment: { RUST_TARGET: target },
        probe: async () => ({ performed: false, reason: "cross-target" }),
      }),
    ).resolves.toEqual(expect.objectContaining({ probe: { performed: false, reason: "cross-target" } }))
  })

  test("rejects missing or mismatched confinement evidence before staging", async () => {
    const root = await temporaryDirectory()
    const source = path.join(root, "source")
    const trustedAttestation = path.join(root, "trusted-attestation.json")
    const destination = path.join(root, "staged")
    const attestation = path.join(root, "staged-attestation.json")
    await productionRuntimeFixture(source, target, trustedAttestation)
    await expect(
      prepareReleaseDocumentRuntime({
        source,
        trustedAttestation,
        destination,
        attestation,
        environment: { RUST_TARGET: target },
        sandboxRuntime,
        probe: async () => ({ performed: true }),
      }),
    ).rejects.toThrow("Document confinement evidence is missing or does not match packaged resources")
    expect(await Bun.file(destination).exists()).toBe(false)

    await trustedRuntimeFixture(source, trustedAttestation)
    const evidence = await Bun.file(trustedAttestation).json()
    evidence.confinementEvidence.sandboxRuntimeManifestSha256 = "0".repeat(64)
    await writeFile(trustedAttestation, JSON.stringify(evidence))
    await expect(
      prepareReleaseDocumentRuntime({
        source,
        trustedAttestation,
        destination,
        attestation,
        environment: { RUST_TARGET: target },
        sandboxRuntime,
        probe: async () => ({ performed: true }),
      }),
    ).rejects.toThrow("Document confinement evidence is missing or does not match packaged resources")
    expect(await Bun.file(attestation).exists()).toBe(false)
  })
})

async function temporaryDirectory() {
  const root = await mkdtemp(path.join(os.tmpdir(), "desktop-release-runtime-"))
  roots.push(root)
  return root
}

function trustedRuntimeFixture(root: string, attestation: string, releaseReady = true, smokeEvidence = false) {
  return productionRuntimeFixture(root, target, attestation, releaseReady, smokeEvidence, {
    proxySha256: sandboxRuntime.documentProxySha256,
    sandboxRuntimeManifestSha256: sandboxRuntime.manifestSha256,
  })
}
