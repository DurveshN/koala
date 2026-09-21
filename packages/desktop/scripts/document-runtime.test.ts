import { afterAll, describe, expect, test } from "bun:test"
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { prepareReleaseDocumentRuntime, verifyPreparedReleaseDocumentRuntime, verifyPreparedSandboxRuntime } from "./document-runtime"
import { confinementEvidenceFixture, productionRuntimeFixture } from "../test/fixture/document-runtime"

const roots: string[] = []
const target = "x86_64-pc-windows-msvc" as const
const release = { version: "1.2.3", sourceCommit: "a".repeat(40), buildID: "test-build-1" } as const
const sandboxRuntime = await verifyPreparedSandboxRuntime({ RUST_TARGET: target })

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

describe("release document runtime staging", () => {
  test("copies a verified resource tree into one fresh owned staging child and re-verifies it", async () => {
    const root = await temporaryDirectory()
    const source = await sourceResources(root)
    const parent = await canonicalChild(root, "staging-parent")
    const destination = path.join(parent, "release-resources")
    const prepared = await prepareReleaseDocumentRuntime({
      sourceResourcesRoot: source,
      stagingParent: parent,
      stagingRoot: destination,
      environment: { RUST_TARGET: target },
      release,
    })
    expect(prepared.resourcesRoot).toBe(await realpath(destination))
    expect(prepared.root).toBe(path.join(prepared.resourcesRoot, "document-runtime"))
    expect(prepared.evidenceRoot).toBe(path.join(prepared.resourcesRoot, "document-confinement-evidence"))
    await expect(
      verifyPreparedReleaseDocumentRuntime({ stagingRoot: destination, environment: { RUST_TARGET: target }, release }),
    ).resolves.toEqual(prepared)
  })

  test("rejects an existing destination without deleting it", async () => {
    const root = await temporaryDirectory()
    const source = await sourceResources(root)
    const parent = await canonicalChild(root, "staging-parent")
    const destination = path.join(parent, "existing")
    await mkdir(destination)
    await writeFile(path.join(destination, "canary"), "owned elsewhere")
    await expect(
      prepareReleaseDocumentRuntime({
        sourceResourcesRoot: source,
        stagingParent: parent,
        stagingRoot: destination,
        environment: { RUST_TARGET: target },
        release,
      }),
    ).rejects.toThrow("must be fresh")
    expect(await Bun.file(path.join(destination, "canary")).text()).toBe("owned elsewhere")
  })

  test("rejects non-child and overlapping staging roots before deletion or creation", async () => {
    const root = await temporaryDirectory()
    const source = await sourceResources(root)
    const parent = await canonicalChild(root, "staging-parent")
    await expect(
      prepareReleaseDocumentRuntime({
        sourceResourcesRoot: source,
        stagingParent: parent,
        stagingRoot: path.join(root, "not-a-child"),
        environment: { RUST_TARGET: target },
        release,
      }),
    ).rejects.toThrow("direct child")
    await expect(
      prepareReleaseDocumentRuntime({
        sourceResourcesRoot: source,
        stagingParent: source,
        stagingRoot: path.join(source, "nested"),
        environment: { RUST_TARGET: target },
        release,
      }),
    ).rejects.toThrow("overlap")
    expect(await Bun.file(path.join(source, "document-runtime", "manifest.json")).exists()).toBe(true)
  })

  test("rejects modified signed evidence before creating staging", async () => {
    const root = await temporaryDirectory()
    const source = await sourceResources(root)
    const parent = await canonicalChild(root, "staging-parent")
    const evidence = path.join(source, "document-confinement-evidence", "evidence.json")
    const value = await Bun.file(evidence).json()
    value.signature = Buffer.alloc(64, 9).toString("base64")
    await writeFile(evidence, JSON.stringify(value))
    const destination = path.join(parent, "release-resources")
    await expect(
      prepareReleaseDocumentRuntime({
        sourceResourcesRoot: source,
        stagingParent: parent,
        stagingRoot: destination,
        environment: { RUST_TARGET: target },
        release,
      }),
    ).rejects.toThrow("signature")
    expect(await Bun.file(destination).exists()).toBe(false)
  })

  test("rejects a staging root without its ownership marker", async () => {
    const root = await temporaryDirectory()
    const destination = await canonicalChild(root, "unowned")
    await expect(
      verifyPreparedReleaseDocumentRuntime({ stagingRoot: destination, environment: { RUST_TARGET: target }, release }),
    ).rejects.toThrow()
  })
})

async function sourceResources(root: string) {
  const resources = path.join(root, "candidate")
  await mkdir(resources)
  await cp(sandboxRuntime.root, path.join(resources, "sandbox-runtime"), { recursive: true })
  await productionRuntimeFixture(
    path.join(resources, "document-runtime"),
    target,
    path.join(resources, "document-runtime.attestation.json"),
  )
  await confinementEvidenceFixture(resources, target, sandboxRuntime, release)
  return realpath(resources)
}

async function canonicalChild(root: string, name: string) {
  const child = path.join(root, name)
  await mkdir(child)
  return realpath(child)
}

async function temporaryDirectory() {
  const root = await mkdtemp(path.join(os.tmpdir(), "desktop-release-runtime-"))
  roots.push(root)
  return realpath(root)
}
