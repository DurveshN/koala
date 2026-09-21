import { afterAll, describe, expect, test } from "bun:test"
import { DocumentRuntimeAttestation } from "@koala-ai/document-runtime"
import { generateKeyPairSync } from "node:crypto"
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { hostTarget } from "../src/main/sandbox-runtime"
import { requiredDependencyPaths, requiredSigningPaths } from "../src/main/document-confinement"
import {
  issueEvidence,
  readReport,
  requireNativeTarget,
  stageCandidateResources,
  writeSignedFileInventory,
} from "./document-runtime-evidence"
import { productionRuntimeFixture } from "../test/fixture/document-runtime"
import { verifyPreparedSandboxRuntime } from "./document-runtime"

const roots: string[] = []

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

describe("document confinement evidence boundary", () => {
  test("requires exact native host equality, including architecture", () => {
    const host = hostTarget(process.platform, process.arch)
    if (!host) return expect(() => requireNativeTarget({ RUST_TARGET: "x86_64-unknown-linux-gnu" })).toThrow()
    expect(requireNativeTarget({ RUST_TARGET: host })).toBe(host)
    const other = host.startsWith("x86_64-") ? host.replace("x86_64-", "aarch64-") : host.replace("aarch64-", "x86_64-")
    expect(() => requireNativeTarget({ RUST_TARGET: other })).toThrow("target-native")
  })

  test("writes a deterministic exact inventory without treating the detached attestation as signed content", async () => {
    const root = await temporaryDirectory()
    const host = hostTarget(process.platform, process.arch)
    if (!host) return
    const sandbox = await verifyPreparedSandboxRuntime({ RUST_TARGET: host })
    await cp(sandbox.root, path.join(root, "sandbox-runtime"), { recursive: true })
    await productionRuntimeFixture(
      path.join(root, "document-runtime"),
      host,
      path.join(root, "document-runtime.attestation.json"),
    )
    const evidence = path.join(root, "document-confinement-evidence")
    await mkdir(evidence)
    await writeFile(
      path.join(evidence, "issuer-public-key.spki.der"),
      generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }),
    )
    await writeFile(
      path.join(evidence, "release-identity.json"),
      `${JSON.stringify({ version: "1.2.3", sourceCommit: "a".repeat(40), buildID: "test-build-1" })}\n`,
    )
    const first = path.join(root, "inventory.json")
    const report = await writeSignedFileInventory({
      resourcesRoot: await realpath(root),
      target: host,
      release: { version: "1.2.3", sourceCommit: "a".repeat(40), buildID: "test-build-1" },
      output: first,
    })
    expect(report.files).toContainEqual(
      expect.objectContaining({ path: "sandbox-runtime/document-runtime-proxy.mjs" }),
    )
    expect(report.files[0]?.sha256).toMatch(/^[a-f0-9]{64}$/)
  })

  test("has no local evidence-issuance fallback", async () => {
    const root = await temporaryDirectory()
    await expect(
      issueEvidence({
        issuerExecutable: path.join(root, "missing-issuer"),
        request: path.join(root, "missing-request"),
        publicKey: path.join(root, "missing-key"),
        runtimeAttestation: path.join(root, "missing-attestation"),
        resourcesRoot: root,
        reports: {
          nativeTestReport: path.join(root, "missing-native"),
          packagedSmokeReport: path.join(root, "missing-smoke"),
          signingReport: path.join(root, "missing-signing"),
          signedFileInventory: path.join(root, "missing-inventory"),
          dependencyReport: path.join(root, "missing-dependencies"),
        },
        outputEnvelope: path.join(root, "issued.json"),
      }),
    ).rejects.toThrow()
    expect(await Bun.file(path.join(root, "issued.json")).exists()).toBe(false)
  })

  test("derives target-specific native signing and dependency sets from the exact inventory", () => {
    const files = [
      { path: "document-runtime/worker/worker.js", mode: 0o644 },
      { path: "document-runtime/bin/tesseract.exe", mode: 0o755 },
      { path: "document-runtime/node_modules/canvas/native.node", mode: 0o644 },
      { path: "sandbox-runtime/vendor/srt-win/x64/srt-win.exe", mode: 0o755 },
    ]
    const expected = [
      "document-runtime/bin/tesseract.exe",
      "document-runtime/node_modules/canvas/native.node",
      "sandbox-runtime/vendor/srt-win/x64/srt-win.exe",
    ]
    expect(requiredSigningPaths(files, "x86_64-pc-windows-msvc")).toEqual(expected)
    expect(requiredDependencyPaths(files, "x86_64-pc-windows-msvc")).toEqual(expected)
  })

  test("rejects excess fields in externally produced reports", async () => {
    const root = await temporaryDirectory()
    const report = path.join(root, "report.json")
    await writeFile(
      report,
      JSON.stringify({
        reportVersion: 1,
        target: "x86_64-pc-windows-msvc",
        runtimeManifestSha256: "1".repeat(64),
        runtimeAttestationSha256: "2".repeat(64),
        proxySha256: "3".repeat(64),
        sandboxRuntimeManifestSha256: "4".repeat(64),
        policyVersion: 1,
        release: { version: "1.2.3", sourceCommit: "a".repeat(40), buildID: "test-build-1" },
        signedFileInventorySha256: "5".repeat(64),
        status: "passed",
        files: [{ path: "sandbox-runtime/document-runtime-proxy.mjs", sha256: "3".repeat(64), signature: "passed" }],
        untrusted: true,
      }),
    )
    await expect(readReport(await realpath(report), DocumentRuntimeAttestation.SigningReport)).rejects.toThrow(
      "Invalid typed",
    )
  })

  test("creates only a fresh direct staging child and does not delete an existing destination", async () => {
    const host = hostTarget(process.platform, process.arch)
    if (!host) return
    const root = await temporaryDirectory()
    const runtime = path.join(root, "runtime")
    const attestation = path.join(root, "attestation.json")
    const key = path.join(root, "issuer.der")
    const staging = await temporaryDirectory()
    const parent = path.join(staging, "staging")
    await mkdir(parent)
    await productionRuntimeFixture(runtime, host, attestation)
    await writeFile(key, generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }))
    const sandbox = await verifyPreparedSandboxRuntime({ RUST_TARGET: host })
    const destination = path.join(await realpath(parent), "candidate")
    await stageCandidateResources({
      target: host,
      runtimeRoot: await realpath(runtime),
      attestationPath: await realpath(attestation),
      sandboxRuntimeRoot: sandbox.root,
      publicKeyPath: await realpath(key),
      stagingParent: await realpath(parent),
      destination,
      release: { version: "1.2.3", sourceCommit: "a".repeat(40), buildID: "test-build-1" },
    })
    expect(await Bun.file(path.join(destination, "document-runtime", "manifest.json")).exists()).toBe(true)
    await writeFile(path.join(destination, "owned-canary"), "retain")
    await expect(
      stageCandidateResources({
        target: host,
        runtimeRoot: await realpath(runtime),
        attestationPath: await realpath(attestation),
        sandboxRuntimeRoot: sandbox.root,
        publicKeyPath: await realpath(key),
        stagingParent: await realpath(parent),
        destination,
        release: { version: "1.2.3", sourceCommit: "a".repeat(40), buildID: "test-build-1" },
      }),
    ).rejects.toThrow("fresh direct child")
    expect(await Bun.file(path.join(destination, "owned-canary")).text()).toBe("retain")
  })
})

async function temporaryDirectory() {
  const root = await mkdtemp(path.join(os.tmpdir(), "document-evidence-test-"))
  roots.push(root)
  return root
}
