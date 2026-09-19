import { afterEach, describe, expect, mock, test } from "bun:test"
import { DocumentRuntimeLimits } from "@koala-ai/core/document-runtime/limits"
import { createCanvas } from "@napi-rs/canvas"
import { ChildProcess, spawn } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  probeTesseract,
  ProcessTerminationError,
  runTesseract,
  terminateProcessTree,
  type SpawnCommand,
} from "../src/tesseract"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("Tesseract adapter", () => {
  test("probes the explicit binary with a fixed environment and exact manifest version", async () => {
    const fixture = await setup()
    let invocation:
      | { executable: string; args: ReadonlyArray<string>; env: NodeJS.ProcessEnv; shell: false }
      | undefined
    const spawnCommand: SpawnCommand = (executable, args, options) => {
      invocation = { executable, args, env: options.env, shell: options.shell }
      return spawn(
        process.execPath,
        [path.join(import.meta.dir, "fixture", "fake-tesseract.ts"), "probe-success", ...args],
        options,
      )
    }
    await probeTesseract({
      executablePath: fixture.executablePath,
      tessdataPath: fixture.tessdataPath,
      jobRoot: fixture.jobRoot,
      expectedVersion: "5.5.3",
      signal: new AbortController().signal,
      spawnCommand,
    })
    expect(invocation).toEqual(
      expect.objectContaining({ executable: process.execPath, args: ["--version"], shell: false }),
    )
    expect(invocation?.env.PATH).toBeUndefined()
    expect(invocation?.env.NODE_OPTIONS).toBeUndefined()
    expect(invocation?.env.TESSDATA_PREFIX).toBe(fixture.tessdataPath)
  })

  test.each([
    ["probe-failure", 5_000],
    ["probe-malformed", 5_000],
    ["probe-overflow", 5_000],
    ["probe-hang", 50],
  ] as const)("rejects bounded %s version probes without exposing output", async (scenario, deadlineMs) => {
    const fixture = await setup()
    const spawnCommand: SpawnCommand = (_executable, args, options) =>
      spawn(process.execPath, [path.join(import.meta.dir, "fixture", "fake-tesseract.ts"), scenario, ...args], options)
    const error = await probeTesseract({
      executablePath: fixture.executablePath,
      tessdataPath: fixture.tessdataPath,
      jobRoot: fixture.jobRoot,
      expectedVersion: "5.5.3",
      signal: new AbortController().signal,
      deadlineMs,
      spawnCommand,
    }).catch((error: unknown) => error)
    expect(error).toEqual(expect.objectContaining({ code: "runtime-unavailable", stage: "probe" }))
    expect(JSON.stringify(error)).not.toContain("private-version-error")
    if (scenario === "probe-hang") {
      await Bun.sleep(700)
      expect(await Bun.file(path.join(fixture.jobRoot, "probe.marker")).exists()).toBe(false)
    }
  })

  test("rejects missing and non-executable probe binaries", async () => {
    const fixture = await setup(path.join(os.tmpdir(), "missing-tesseract"))
    await expect(
      probeTesseract({
        executablePath: fixture.executablePath,
        tessdataPath: fixture.tessdataPath,
        jobRoot: fixture.jobRoot,
        expectedVersion: "5.5.3",
        signal: new AbortController().signal,
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "runtime-unavailable", stage: "probe" }))

    if (process.platform === "win32") return
    await writeFile(fixture.executablePath, "fixture", { mode: 0o644 })
    await chmod(fixture.executablePath, 0o644)
    await expect(
      probeTesseract({
        executablePath: fixture.executablePath,
        tessdataPath: fixture.tessdataPath,
        jobRoot: fixture.jobRoot,
        expectedVersion: "5.5.3",
        signal: new AbortController().signal,
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "runtime-unavailable", stage: "probe" }))
  })

  test("maps a spawn-reported non-executable binary to an unavailable probe", async () => {
    const fixture = await setup()
    const spawnCommand: SpawnCommand = () => {
      throw Object.assign(new Error("private EACCES detail"), { code: "EACCES" })
    }
    const error = await probeTesseract({
      executablePath: fixture.executablePath,
      tessdataPath: fixture.tessdataPath,
      jobRoot: fixture.jobRoot,
      expectedVersion: "5.5.3",
      signal: new AbortController().signal,
      spawnCommand,
    }).catch((error: unknown) => error)
    expect(error).toEqual(expect.objectContaining({ code: "runtime-unavailable", stage: "probe" }))
    expect(JSON.stringify(error)).not.toContain("private EACCES detail")
  })

  test("cancels the complete version-probe process tree", async () => {
    const fixture = await setup()
    const abort = new AbortController()
    const spawnCommand: SpawnCommand = (_executable, args, options) =>
      spawn(process.execPath, [path.join(import.meta.dir, "fixture", "fake-tesseract.ts"), "probe-hang", ...args], options)
    const running = probeTesseract({
      executablePath: fixture.executablePath,
      tessdataPath: fixture.tessdataPath,
      jobRoot: fixture.jobRoot,
      expectedVersion: "5.5.3",
      signal: abort.signal,
      spawnCommand,
    })
    setTimeout(() => abort.abort(), 50)
    await expect(running).rejects.toEqual(expect.objectContaining({ code: "runtime-unavailable", stage: "probe" }))
    await Bun.sleep(700)
    expect(await Bun.file(path.join(fixture.jobRoot, "probe.marker")).exists()).toBe(false)
  })

  test("observes a probe abort that races process creation and listener registration", async () => {
    const fixture = await setup()
    const abort = new AbortController()
    const spawnCommand: SpawnCommand = (_executable, args, options) => {
      const child = spawn(
        process.execPath,
        [path.join(import.meta.dir, "fixture", "fake-tesseract.ts"), "probe-hang", ...args],
        options,
      )
      abort.abort()
      return child
    }
    await expect(
      probeTesseract({
        executablePath: fixture.executablePath,
        tessdataPath: fixture.tessdataPath,
        jobRoot: fixture.jobRoot,
        expectedVersion: "5.5.3",
        signal: abort.signal,
        spawnCommand,
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "runtime-unavailable" }))
  })

  test("uses an argument array, shell false, fixed environment, and bounded TSV stdout", async () => {
    const fixture = await setup()
    let invocation:
      | { executable: string; args: ReadonlyArray<string>; env: NodeJS.ProcessEnv; shell: false }
      | undefined
    const spawnCommand: SpawnCommand = (executable, args, options) => {
      invocation = { executable, args, env: options.env, shell: options.shell }
      return spawn(
        process.execPath,
        [path.join(import.meta.dir, "fixture", "fake-tesseract.ts"), "success", ...args],
        options,
      )
    }
    const result = await runTesseract({ ...fixture, signal: new AbortController().signal, spawnCommand })
    expect(result.tsvBytes).toBeGreaterThan(0)
    expect(await readFile(fixture.outputPath, "utf8")).toContain("HELLO")
    expect(invocation).toEqual(
      expect.objectContaining({
        executable: process.execPath,
        shell: false,
        args: expect.arrayContaining([
          "stdout",
          "--tessdata-dir",
          fixture.tessdataPath,
          "-l",
          "eng",
          "--dpi",
          "300",
          "--psm",
          "1",
          "tsv",
        ]),
      }),
    )
    expect(invocation?.env.PATH).toBeUndefined()
    expect(invocation?.env.NODE_OPTIONS).toBeUndefined()
    expect(invocation?.env.NAPI_RS_NATIVE_LIBRARY_PATH).toBeUndefined()
    expect(invocation?.env.OMP_THREAD_LIMIT).toBe("1")
  })

  test.each([
    ["failure", "ocr-failed"],
    ["stderr-overflow", "ocr-failed"],
    ["tsv-overflow", "tsv-limit-exceeded"],
    ["timeout-tree", "ocr-deadline-exceeded"],
  ] as const)("maps the %s process without exposing native output", async (scenario, code) => {
    const fixture = await setup()
    const spawnCommand: SpawnCommand = (_executable, args, options) =>
      spawn(process.execPath, [path.join(import.meta.dir, "fixture", "fake-tesseract.ts"), scenario, ...args], options)
    const limits = {
      ...DocumentRuntimeLimits.requestedHard,
      nativeStderrBytes: 1_024,
      tsvBytesPerPage: 1_024,
      ocrDeadlineMsPerPage: scenario === "timeout-tree" ? 50 : 5_000,
    }
    const error = await runTesseract({ ...fixture, limits, signal: new AbortController().signal, spawnCommand }).catch(
      (error: unknown) => error,
    )
    expect(error).toEqual(expect.objectContaining({ code }))
    expect(JSON.stringify(error)).not.toContain("private-native-error")
    if (scenario === "timeout-tree") {
      await Bun.sleep(700)
      expect(await Bun.file(path.join(fixture.jobRoot, "output.marker")).exists()).toBe(false)
    }
  })

  test("cancels the complete process tree", async () => {
    const fixture = await setup()
    const abort = new AbortController()
    const spawnCommand: SpawnCommand = (_executable, args, options) =>
      spawn(
        process.execPath,
        [path.join(import.meta.dir, "fixture", "fake-tesseract.ts"), "timeout-tree", ...args],
        options,
      )
    const running = runTesseract({ ...fixture, signal: abort.signal, spawnCommand })
    setTimeout(() => abort.abort(), 50)
    await expect(running).rejects.toEqual(expect.objectContaining({ code: "ocr-failed" }))
    await Bun.sleep(700)
    expect(await Bun.file(path.join(fixture.jobRoot, "output.marker")).exists()).toBe(false)
  })

  test("observes an OCR abort that races process creation and listener registration", async () => {
    const fixture = await setup()
    const abort = new AbortController()
    const spawnCommand: SpawnCommand = (_executable, args, options) => {
      const child = spawn(
        process.execPath,
        [path.join(import.meta.dir, "fixture", "fake-tesseract.ts"), "timeout-tree", ...args],
        options,
      )
      abort.abort()
      return child
    }
    await expect(runTesseract({ ...fixture, signal: abort.signal, spawnCommand })).rejects.toEqual(
      expect.objectContaining({ code: "ocr-failed" }),
    )
  })

  test.each(["nonzero", "timeout"] as const)("bounds taskkill and falls back on %s", async (scenario) => {
    const child = new ChildProcess()
    Object.defineProperty(child, "pid", { value: 12345 })
    const kill = mock(() => {
      setTimeout(() => child.emit("close", null, "SIGKILL"), 0)
      return true
    })
    child.kill = kill
    const killer = new ChildProcess()
    killer.kill = mock(() => true)
    const running = terminateProcessTree(child, "win32", "C:\\Windows", 10, () => {
      if (scenario === "nonzero") setTimeout(() => killer.emit("close", 1), 0)
      return killer
    })
    await running
    expect(kill).toHaveBeenCalledWith("SIGKILL")
    if (scenario === "timeout") expect(killer.kill).toHaveBeenCalledWith("SIGKILL")
  })

  test("fails within the reap deadline when process exit cannot be observed", async () => {
    const child = new ChildProcess()
    Object.defineProperty(child, "pid", { value: 12345 })
    child.kill = mock(() => true)
    const started = Date.now()
    await expect(terminateProcessTree(child, "win32", "relative", 10)).rejects.toBeInstanceOf(ProcessTerminationError)
    expect(Date.now() - started).toBeLessThan(500)
  })

  test("runs a real explicitly configured Tesseract smoke when available", async () => {
    const executablePath = process.env.DOCUMENT_RUNTIME_TEST_TESSERACT
    const tessdataPath = process.env.DOCUMENT_RUNTIME_TEST_TESSDATA
    if (!executablePath || !tessdataPath) return
    const fixture = await setup(executablePath, tessdataPath)
    const canvas = createCanvas(1_200, 400)
    const context = canvas.getContext("2d")
    context.fillStyle = "white"
    context.fillRect(0, 0, 1_200, 400)
    context.fillStyle = "black"
    context.font = "120px sans-serif"
    context.fillText("HELLO", 80, 240)
    await writeFile(fixture.inputPath, await canvas.encode("png"))
    await runTesseract({ ...fixture, signal: new AbortController().signal })
    expect((await readFile(fixture.outputPath, "utf8")).toUpperCase()).toContain("HELLO")
  })
})

async function setup(executablePath = process.execPath, suppliedTessdata?: string) {
  const jobRoot = await mkdtemp(path.join(os.tmpdir(), "document-ocr-"))
  roots.push(jobRoot)
  const tessdataPath = suppliedTessdata ?? path.join(jobRoot, "tessdata")
  await mkdir(tessdataPath, { recursive: true, mode: 0o700 })
  if (!suppliedTessdata) {
    await writeFile(path.join(tessdataPath, "eng.traineddata"), "fixture")
    await writeFile(path.join(tessdataPath, "osd.traineddata"), "fixture")
  }
  const inputPath = path.join(jobRoot, "input.png")
  await writeFile(inputPath, "fixture")
  return {
    executablePath,
    tessdataPath,
    jobRoot,
    inputPath,
    outputPath: path.join(jobRoot, "output.tsv"),
    currentTemporaryBytes: 0,
    limits: DocumentRuntimeLimits.requestedHard,
  }
}
