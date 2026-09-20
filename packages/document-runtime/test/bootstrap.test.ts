import { describe, expect, test } from "bun:test"
import { pathToFileURL } from "node:url"
import { bootstrapEnvironment, runBootstrap } from "../src/bootstrap"

describe("document worker bootstrap", () => {
  test("validates every handoff value before changing the environment", async () => {
    const environment = {
      DOCUMENT_RUNTIME_ROOT: "/runtime/../replacement",
      DOCUMENT_JOB_ROOT: "/jobs/one",
      DOCUMENT_RUNTIME_TARGET: "x86_64-unknown-linux-gnu",
      DOCUMENT_RUNTIME_MANIFEST_SHA256: "a".repeat(64),
      SECRET_TOKEN: "private",
    }
    const original = { ...environment }
    await expect(
      runBootstrap(environment, "linux", async () => ({ startWorkerProcess: () => undefined })),
    ).rejects.toThrow("invalid-path")
    expect(environment).toEqual(original)
  })

  test("clears inherited values and installs the exact deterministic Linux environment before import", async () => {
    const environment: NodeJS.ProcessEnv = {
      DOCUMENT_RUNTIME_ROOT: "/opt/koala/runtime",
      DOCUMENT_JOB_ROOT: "/private/jobs/one",
      DOCUMENT_RUNTIME_TARGET: "aarch64-unknown-linux-gnu",
      DOCUMENT_RUNTIME_MANIFEST_SHA256: "a".repeat(64),
      PATH: "/untrusted/bin",
      HOME: "/home/private",
      NODE_OPTIONS: "--require=private",
      LD_PRELOAD: "private.so",
      HTTPS_PROXY: "https://private.invalid",
      AWS_SECRET_ACCESS_KEY: "private",
      SystemRoot: "C:\\Windows",
    }
    let imported = false
    await runBootstrap(environment, "linux", async (url) => {
      imported = true
      expect(url).toBe(pathToFileURL("/opt/koala/runtime/worker/worker.js").href)
      expect(environment).toEqual(linuxEnvironment())
      return {
        startWorkerProcess: (workerEnvironment) => expect(workerEnvironment).toBe(environment),
      }
    })
    expect(imported).toBe(true)
    expect(environment).toEqual(linuxEnvironment())
  })

  test("reconstructs Windows with one validated system root and no ambient shell values", () => {
    const environment = bootstrapEnvironment(
      {
        DOCUMENT_RUNTIME_ROOT: "C:\\Program Files\\Koala\\document-runtime",
        DOCUMENT_JOB_ROOT: "D:\\Koala Jobs\\one",
        DOCUMENT_RUNTIME_TARGET: "x86_64-pc-windows-msvc",
        DOCUMENT_RUNTIME_MANIFEST_SHA256: "b".repeat(64),
        SystemRoot: "C:\\Windows",
        WINDIR: "C:\\WINDOWS",
        COMSPEC: "C:\\Windows\\System32\\cmd.exe",
      },
      "win32",
    )
    expect(environment).toEqual({
      DISABLE_SYSTEM_FONTS_LOAD: "1",
      DOCUMENT_JOB_ROOT: "D:\\Koala Jobs\\one",
      DOCUMENT_RUNTIME_MANIFEST_SHA256: "b".repeat(64),
      DOCUMENT_RUNTIME_ROOT: "C:\\Program Files\\Koala\\document-runtime",
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

  test("rejects target substitution, uppercase digests, and inconsistent Windows roots", () => {
    expect(() =>
      bootstrapEnvironment(
        {
          DOCUMENT_RUNTIME_ROOT: "/runtime",
          DOCUMENT_JOB_ROOT: "/jobs/one",
          DOCUMENT_RUNTIME_TARGET: "x86_64-pc-windows-msvc",
          DOCUMENT_RUNTIME_MANIFEST_SHA256: "a".repeat(64),
        },
        "linux",
      ),
    ).toThrow("invalid-target")
    expect(() =>
      bootstrapEnvironment({
        ...windowsHandoff(),
        DOCUMENT_RUNTIME_MANIFEST_SHA256: "A".repeat(64),
      }, "win32"),
    ).toThrow("invalid-manifest-digest")
    expect(() => bootstrapEnvironment({ ...windowsHandoff(), WINDIR: "D:\\Windows" }, "win32")).toThrow(
      "invalid-system-root",
    )
  })
})

function linuxEnvironment() {
  return {
    DISABLE_SYSTEM_FONTS_LOAD: "1",
    DOCUMENT_JOB_ROOT: "/private/jobs/one",
    DOCUMENT_RUNTIME_MANIFEST_SHA256: "a".repeat(64),
    DOCUMENT_RUNTIME_ROOT: "/opt/koala/runtime",
    DOCUMENT_RUNTIME_TARGET: "aarch64-unknown-linux-gnu",
    ELECTRON_RUN_AS_NODE: "1",
    LANG: "C",
    LC_ALL: "C",
    TEMP: "/private/jobs/one/tmp",
    TMP: "/private/jobs/one/tmp",
    TMPDIR: "/private/jobs/one/tmp",
    TZ: "UTC",
  }
}

function windowsHandoff() {
  return {
    DOCUMENT_RUNTIME_ROOT: "C:\\Koala\\runtime",
    DOCUMENT_JOB_ROOT: "D:\\Koala\\jobs\\one",
    DOCUMENT_RUNTIME_TARGET: "x86_64-pc-windows-msvc",
    DOCUMENT_RUNTIME_MANIFEST_SHA256: "a".repeat(64),
    SystemRoot: "C:\\Windows",
    WINDIR: "C:\\Windows",
  }
}
