import { afterAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { resolveSandboxRuntime, verifyNativeHelperArchitecture, verifySandboxRuntimeRoot } from "./sandbox-runtime"

const target = "x86_64-pc-windows-msvc" as const
const roots: string[] = []

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

describe("sandbox runtime resources", () => {
  test("verifies the worker, document proxy, and assets from packaged resources", async () => {
    const resourcesPath = await temporaryDirectory()
    const root = path.join(resourcesPath, "sandbox-runtime")
    await fixture(root)
    const verified = await verifySandboxRuntimeRoot(root, target)
    expect(verified).toEqual(expect.objectContaining({ root: await realpath(root), target }))

    expect(
      await resolveSandboxRuntime({
        packaged: true,
        resourcesPath,
        moduleURL: pathToFileURL(path.resolve("out/main/index.js")).href,
        platform: "win32",
        architecture: "x64",
      }),
    ).toEqual({
      root: await realpath(root),
      workerPath: path.join(await realpath(root), "sandbox-worker.mjs"),
      documentProxyPath: path.join(await realpath(root), "document-runtime-proxy.mjs"),
      documentProxySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      target,
    })
  })

  test("uses only the Koala build in development", async () => {
    const workspace = await temporaryDirectory()
    const desktop = path.join(workspace, "packages", "desktop")
    const root = path.join(workspace, "packages", "opencode", "dist", "node", "sandbox-runtime")
    await fixture(root)

    expect(
      await resolveSandboxRuntime({
        packaged: false,
        resourcesPath: path.resolve("unused"),
        moduleURL: pathToFileURL(path.join(desktop, "out/main/index.js")).href,
        platform: "win32",
        architecture: "x64",
      }),
    ).toEqual({
      root: await realpath(root),
      workerPath: path.join(await realpath(root), "sandbox-worker.mjs"),
      documentProxyPath: path.join(await realpath(root), "document-runtime-proxy.mjs"),
      documentProxySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      target,
    })
  })

  test("rejects missing, stale, and wrong-target output", async () => {
    const workspace = await temporaryDirectory()
    const desktop = path.join(workspace, "packages", "desktop")
    const root = path.join(workspace, "packages", "opencode", "dist", "node", "sandbox-runtime")
    const input = {
      packaged: false,
      resourcesPath: path.resolve("unused"),
      moduleURL: pathToFileURL(path.join(desktop, "out/main/index.js")).href,
      platform: "win32" as const,
      architecture: "x64",
    }

    expect(await resolveSandboxRuntime(input)).toBeUndefined()
    await fixture(root)
    await writeFile(path.join(root, "stale-proxy.mjs"), "stale")
    expect(await resolveSandboxRuntime(input)).toBeUndefined()
    await rm(path.join(root, "stale-proxy.mjs"))
    const manifest = await Bun.file(path.join(root, "sandbox-runtime.manifest.json")).json()
    manifest.target = "aarch64-pc-windows-msvc"
    await writeFile(path.join(root, "sandbox-runtime.manifest.json"), JSON.stringify(manifest))
    expect(await resolveSandboxRuntime(input)).toBeUndefined()
  })

  test("rejects a missing proxy and a wrong-architecture helper", async () => {
    const workspace = await temporaryDirectory()
    const desktop = path.join(workspace, "packages", "desktop")
    const root = path.join(workspace, "packages", "opencode", "dist", "node", "sandbox-runtime")
    const input = {
      packaged: false,
      resourcesPath: path.resolve("unused"),
      moduleURL: pathToFileURL(path.join(desktop, "out/main/index.js")).href,
      platform: "win32" as const,
      architecture: "x64",
    }
    await fixture(root)
    await rm(path.join(root, "document-runtime-proxy.mjs"))
    expect(await resolveSandboxRuntime(input)).toBeUndefined()
    await rm(root, { recursive: true, force: true })
    await fixture(root, "wrong-architecture")
    expect(await resolveSandboxRuntime(input)).toBeUndefined()
  })

  test("rejects self-declared writable files and non-executable helpers", async () => {
    for (const [file, mode] of [
      ["document-runtime-proxy.mjs", 0o666],
      ["vendor/srt-win/x64/srt-win.exe", 0o644],
    ] as const) {
      const root = path.join(await temporaryDirectory(), "sandbox-runtime")
      await fixture(root)
      const manifestPath = path.join(root, "sandbox-runtime.manifest.json")
      const manifest = await Bun.file(manifestPath).json()
      manifest.files.find((entry: { readonly path: string }) => entry.path === file).mode = mode
      await writeFile(manifestPath, JSON.stringify(manifest))
      await expect(verifySandboxRuntimeRoot(root, target)).rejects.toThrow("file inventory mismatch")
    }
  })

  test("rejects a linked packaged sandbox root", async () => {
    const resourcesPath = await temporaryDirectory()
    const actual = path.join(resourcesPath, "actual")
    await fixture(actual)
    await symlink(actual, path.join(resourcesPath, "sandbox-runtime"), process.platform === "win32" ? "junction" : "dir")

    expect(
      await resolveSandboxRuntime({
        packaged: true,
        resourcesPath,
        moduleURL: pathToFileURL(path.resolve("out/main/index.js")).href,
        platform: "win32",
        architecture: "x64",
      }),
    ).toBeUndefined()
  })

  test("accepts only ELF64 little-endian helpers for the declared target", async () => {
    for (const value of ["x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu"] as const) {
      expect(() => verifyNativeHelperArchitecture(helperBinary(value), value)).not.toThrow()
    }

    for (const malformed of ["elf32", "big-endian", "wrong-architecture", "invalid"] as const) {
      expect(() =>
        verifyNativeHelperArchitecture(helperBinary("x86_64-unknown-linux-gnu", malformed), "x86_64-unknown-linux-gnu"),
      ).toThrow()
    }
  })

  test("accepts matching PE targets and rejects wrong or malformed PE helpers", async () => {
    for (const value of ["x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc"] as const) {
      expect(() => verifyNativeHelperArchitecture(helperBinary(value), value)).not.toThrow()
      expect(() => verifyNativeHelperArchitecture(helperBinary(value, "minimum-optional"), value)).not.toThrow()
      expect(() => verifyNativeHelperArchitecture(helperBinary(value, "undersized-optional"), value)).toThrow()
    }
    expect(() =>
      verifyNativeHelperArchitecture(
        helperBinary("x86_64-pc-windows-msvc", "wrong-architecture"),
        "x86_64-pc-windows-msvc",
      ),
    ).toThrow()
    for (const value of ["truncated-coff", "zero-optional", "truncated-optional", "pe32", "not-executable", "invalid"] as const) {
      expect(() =>
        verifyNativeHelperArchitecture(helperBinary("x86_64-pc-windows-msvc", value), "x86_64-pc-windows-msvc"),
      ).toThrow()
    }
  })
})

async function temporaryDirectory() {
  const root = await mkdtemp(path.join(os.tmpdir(), "desktop-sandbox-runtime-"))
  roots.push(root)
  return root
}

async function fixture(
  root: string,
  malformed?:
    | "wrong-architecture"
    | "elf32"
    | "big-endian"
    | "truncated-coff"
    | "zero-optional"
    | "truncated-optional"
    | "minimum-optional"
    | "undersized-optional"
    | "pe32"
    | "not-executable"
    | "invalid",
  fixtureTarget = target,
) {
  const helper = helperBinary(fixtureTarget, malformed)
  const architecture = fixtureTarget.startsWith("x86_64-") ? "x64" : "arm64"
  const helperPath = fixtureTarget.includes("windows")
    ? `vendor/srt-win/${architecture}/srt-win.exe`
    : `vendor/seccomp/${architecture}/apply-seccomp`
  const contents = new Map<string, Buffer>([
    ["LICENSE", Buffer.from("license")],
    ["document-runtime-proxy.mjs", Buffer.from("proxy")],
    ["sandbox-worker.mjs", Buffer.from("worker")],
    ["vendor/java-proxy-agent/srt-proxy-agent.jar", Buffer.from("jar")],
    [helperPath, helper],
  ])
  await Promise.all(
    Array.from(contents, async ([file, body]) => {
      const absolute = path.join(root, ...file.split("/"))
      await mkdir(path.dirname(absolute), { recursive: true })
      await writeFile(absolute, body, { mode: file === helperPath ? 0o755 : 0o644 })
      await chmod(absolute, file === helperPath ? 0o755 : 0o644)
    }),
  )
  await writeFile(
    path.join(root, "sandbox-runtime.manifest.json"),
    JSON.stringify({
      manifestVersion: 1,
      target: fixtureTarget,
      files: Array.from(contents, ([file, body]) => ({
        path: file,
        sha256: createHash("sha256").update(body).digest("hex"),
        bytes: body.byteLength,
        mode: file === helperPath ? 0o755 : 0o644,
      })),
    }),
  )
}

function helperBinary(
  fixtureTarget: string,
  malformed?:
    | "wrong-architecture"
    | "elf32"
    | "big-endian"
    | "truncated-coff"
    | "zero-optional"
    | "truncated-optional"
    | "minimum-optional"
    | "undersized-optional"
    | "pe32"
    | "not-executable"
    | "invalid",
) {
  const helper = Buffer.alloc(malformed === "truncated-coff" ? 140 : malformed === "truncated-optional" ? 200 : 512)
  if (malformed === "invalid") return helper
  const x64 = fixtureTarget.startsWith("x86_64-")
  if (fixtureTarget.includes("windows")) {
    helper.write("MZ", 0, "ascii")
    helper.writeUInt32LE(128, 0x3c)
    helper.write("PE\0\0", 128, "binary")
    helper.writeUInt16LE((x64 !== (malformed === "wrong-architecture")) ? 0x8664 : 0xaa64, 132)
    if (malformed === "truncated-coff") return helper
    const optionalHeaderBytes =
      malformed === "zero-optional"
        ? 0
        : malformed === "minimum-optional"
          ? 0x70
          : malformed === "undersized-optional"
            ? 0x6f
            : 0xf0
    helper.writeUInt16LE(optionalHeaderBytes, 148)
    helper.writeUInt16LE(malformed === "not-executable" ? 0 : 0x0002, 150)
    if (helper.length >= 154) helper.writeUInt16LE(malformed === "pe32" ? 0x10b : 0x20b, 152)
    return helper
  }
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(helper)
  helper[4] = malformed === "elf32" ? 1 : 2
  helper[5] = malformed === "big-endian" ? 2 : 1
  helper[6] = 1
  helper.writeUInt16LE((x64 !== (malformed === "wrong-architecture")) ? 62 : 183, 18)
  return helper
}
