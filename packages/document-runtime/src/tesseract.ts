import { DocumentRuntimeLimits } from "@koala-ai/core/document-runtime/limits"
import { spawn, type ChildProcess, type ChildProcessByStdio } from "node:child_process"
import { constants } from "node:fs"
import { access, lstat, mkdir, open, rm } from "node:fs/promises"
import path from "node:path"
import type { Readable } from "node:stream"
import { RuntimeFailure } from "./error"
import { makePrivateDirectory, validateInputFile, validateOutputFile, validatePrivateJobRoot } from "./path"

type SpawnedProcess = ChildProcessByStdio<null, Readable, Readable>
type SpawnOptions = {
  readonly cwd: string
  readonly detached: boolean
  readonly env: NodeJS.ProcessEnv
  readonly shell: false
  readonly stdio: ["ignore", "pipe", "pipe"]
  readonly windowsHide: true
}

const ProbeDeadlineMs = 5_000
const ProbeDiagnosticBytes = 8 * 1024

export class ProcessTerminationError extends Error {
  override readonly name = "ProcessTerminationError"
}

export type SpawnCommand = (executable: string, args: ReadonlyArray<string>, options: SpawnOptions) => SpawnedProcess
export type TaskkillCommand = (
  executable: string,
  args: ReadonlyArray<string>,
  options: {
    readonly env: NodeJS.ProcessEnv
    readonly shell: false
    readonly stdio: "ignore"
    readonly windowsHide: true
  },
) => ChildProcess

export type TesseractOptions = {
  readonly executablePath: string
  readonly tessdataPath: string
  readonly jobRoot: string
  readonly inputPath: string
  readonly outputPath: string
  readonly currentTemporaryBytes: number
  readonly limits: DocumentRuntimeLimits.Requested
  readonly signal: AbortSignal
  readonly spawnCommand?: SpawnCommand
  readonly platform?: NodeJS.Platform
  readonly systemRoot?: string
}

export type TesseractResult = {
  readonly tsvBytes: number
  readonly temporaryBytes: number
}

export type TesseractProbeOptions = {
  readonly executablePath: string
  readonly tessdataPath: string
  readonly jobRoot: string
  readonly expectedVersion: string
  readonly signal: AbortSignal
  readonly deadlineMs?: number
  readonly diagnosticBytes?: number
  readonly spawnCommand?: SpawnCommand
  readonly platform?: NodeJS.Platform
  readonly systemRoot?: string
}

export async function probeTesseract(options: TesseractProbeOptions): Promise<void> {
  const platform = options.platform ?? process.platform
  const deadlineMs = options.deadlineMs ?? ProbeDeadlineMs
  const diagnosticBytes = options.diagnosticBytes ?? ProbeDiagnosticBytes
  if (
    !path.isAbsolute(options.executablePath) ||
    !path.isAbsolute(options.tessdataPath) ||
    !path.isAbsolute(options.jobRoot) ||
    !options.expectedVersion ||
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs <= 0 ||
    !Number.isSafeInteger(diagnosticBytes) ||
    diagnosticBytes <= 0 ||
    options.signal.aborted
  ) {
    throw new RuntimeFailure("runtime-unavailable", "probe")
  }
  const root = await lstat(options.jobRoot).catch(() => undefined)
  if (!root?.isDirectory() || root.isSymbolicLink()) throw new RuntimeFailure("runtime-unavailable", "probe")
  await validateExecutable(options.executablePath, platform, "probe")

  const spawned = options.spawnCommand ?? spawnTesseract
  let child: SpawnedProcess
  try {
    child = spawned(options.executablePath, ["--version"], {
      cwd: options.jobRoot,
      detached: platform !== "win32",
      env: tesseractEnvironment(options.jobRoot, options.tessdataPath, platform, options.systemRoot),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
  } catch {
    throw new RuntimeFailure("runtime-unavailable", "probe")
  }

  let timedOut = false
  let terminationFailed = false
  const terminationFailure = Promise.withResolvers<void>()
  let terminating: Promise<void> | undefined
  const terminate = () => {
    terminating ??= terminateProcessTree(child, platform, options.systemRoot, 2_000).catch(() => {
      terminationFailed = true
      child.stdout.destroy()
      child.stderr.destroy()
      terminationFailure.resolve()
    })
    return terminating
  }
  const onAbort = () => void terminate()
  options.signal.addEventListener("abort", onAbort, { once: true })
  if (options.signal.aborted) void terminate()
  const deadline = setTimeout(() => {
    timedOut = true
    void terminate()
  }, deadlineMs)
  const result = await Promise.all([
    Promise.race([waitForExit(child), terminationFailure.promise.then(() => null)]),
    readProbeDiagnostic(child.stdout, diagnosticBytes, terminate),
    readProbeDiagnostic(child.stderr, diagnosticBytes, terminate),
  ]).finally(async () => {
    clearTimeout(deadline)
    options.signal.removeEventListener("abort", onAbort)
    if (terminating) await terminating
  })
  const [exitCode, stdout, stderr] = result

  if (
    options.signal.aborted ||
    timedOut ||
    terminationFailed ||
    stdout.overflow ||
    stderr.overflow ||
    exitCode !== 0 ||
    probeVersion(stdout.bytes) !== `tesseract ${options.expectedVersion}`
  ) {
    throw new RuntimeFailure("runtime-unavailable", "probe")
  }
}

export async function runTesseract(options: TesseractOptions): Promise<TesseractResult> {
  await validateOptions(options)
  await mkdir(path.dirname(options.outputPath), { recursive: true, mode: 0o700 })
  const environment = tesseractEnvironment(options.jobRoot, options.tessdataPath, options.platform, options.systemRoot)
  const args = [
    options.inputPath,
    "stdout",
    "--tessdata-dir",
    options.tessdataPath,
    "-l",
    "eng",
    "--dpi",
    String(DocumentRuntimeLimits.FixedDpi),
    "--oem",
    "1",
    "--psm",
    "1",
    "tsv",
  ]
  const output = await open(options.outputPath, "wx", 0o600).catch(() => {
    throw new RuntimeFailure("invalid-request", "input")
  })
  const spawned = options.spawnCommand ?? spawnTesseract
  let child: SpawnedProcess
  try {
    child = spawnChild(spawned, options.executablePath, args, {
      cwd: options.jobRoot,
      detached: (options.platform ?? process.platform) !== "win32",
      env: environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
  } catch (error) {
    await output.close()
    return failAndRemove(options.outputPath, error as RuntimeFailure)
  }

  let tsvBytes = 0
  let stderrBytes = 0
  let timedOut = false
  let streamFailed = false
  let terminationFailed = false
  const terminationFailure = Promise.withResolvers<void>()
  let overflow: "stderr" | "tsv" | "temporary" | undefined
  let terminating: Promise<void> | undefined
  const terminate = () => {
    terminating ??= terminateProcessTree(
      child,
      options.platform ?? process.platform,
      options.systemRoot,
      DocumentRuntimeLimits.MaxCancellationGraceMs,
    ).catch(() => {
      terminationFailed = true
      child.stdout.destroy()
      child.stderr.destroy()
      terminationFailure.resolve()
    })
    return terminating
  }
  const onAbort = () => void terminate()
  options.signal.addEventListener("abort", onAbort, { once: true })
  if (options.signal.aborted) void terminate()
  const deadline = setTimeout(() => {
    timedOut = true
    void terminate()
  }, options.limits.ocrDeadlineMsPerPage)
  const stdout = (async () => {
    try {
      for await (const value of child.stdout) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
        const next = tsvBytes + chunk.byteLength
        if (next > options.limits.tsvBytesPerPage) {
          overflow = "tsv"
          await terminate()
          return
        }
        if (options.currentTemporaryBytes + next > options.limits.temporaryBytes) {
          overflow = "temporary"
          await terminate()
          return
        }
        for (let offset = 0; offset < chunk.byteLength; ) {
          const result = await output.write(chunk, offset, chunk.byteLength - offset)
          offset += result.bytesWritten
        }
        tsvBytes = next
      }
    } catch {
      streamFailed = true
      await terminate()
    }
  })()
  const stderr = (async () => {
    try {
      for await (const chunk of child.stderr) {
        stderrBytes += Buffer.byteLength(chunk)
        if (stderrBytes <= options.limits.nativeStderrBytes) continue
        overflow = "stderr"
        await terminate()
        return
      }
    } catch {
      streamFailed = true
      await terminate()
    }
  })()

  const [exitCode] = await Promise.all([
    Promise.race([waitForExit(child), terminationFailure.promise.then(() => null)]),
    stdout,
    stderr,
  ]).finally(async () => {
    clearTimeout(deadline)
    options.signal.removeEventListener("abort", onAbort)
    if (terminating) await terminating
    await output.close().catch(() => undefined)
  })

  if (options.signal.aborted) return failAndRemove(options.outputPath, new RuntimeFailure("ocr-failed", "ocr"))
  if (timedOut) return failAndRemove(options.outputPath, new RuntimeFailure("ocr-deadline-exceeded", "ocr", true))
  if (overflow === "tsv") return failAndRemove(options.outputPath, new RuntimeFailure("tsv-limit-exceeded", "ocr"))
  if (overflow === "temporary") {
    return failAndRemove(options.outputPath, new RuntimeFailure("temporary-limit-exceeded", "ocr"))
  }
  if (overflow || streamFailed || terminationFailed || exitCode !== 0) {
    return failAndRemove(options.outputPath, new RuntimeFailure("ocr-failed", "ocr"))
  }

  await validateOutputFile(options.jobRoot, options.outputPath, tsvBytes).catch(() =>
    failAndRemove(options.outputPath, new RuntimeFailure("ocr-failed", "ocr")),
  )
  return { tsvBytes, temporaryBytes: options.currentTemporaryBytes + tsvBytes }
}

export function tesseractEnvironment(
  jobRoot: string,
  tessdataPath: string,
  platform: NodeJS.Platform = process.platform,
  systemRoot = process.env.SystemRoot,
) {
  const temporary = path.join(jobRoot, "tmp")
  return {
    DISABLE_SYSTEM_FONTS_LOAD: "1",
    LANG: "C",
    LC_ALL: "C",
    OMP_NUM_THREADS: "1",
    OMP_THREAD_LIMIT: "1",
    TESSDATA_PREFIX: tessdataPath,
    TMP: temporary,
    TMPDIR: temporary,
    TEMP: temporary,
    TZ: "UTC",
    ...(platform === "win32" && systemRoot ? { SystemRoot: systemRoot, WINDIR: systemRoot } : {}),
  }
}

export async function terminateProcessTree(
  child: ChildProcess,
  platform: NodeJS.Platform,
  systemRoot = process.env.SystemRoot,
  timeoutMs = 2_000,
  taskkillCommand: TaskkillCommand = spawnTaskkill,
) {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (!child.pid) throw new ProcessTerminationError("Native process has no PID and no observed exit")
  const deadline = Date.now() + Math.max(1, timeoutMs)
  if (platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGKILL")
    } catch {
      child.kill("SIGKILL")
    }
    if (!(await waitForExitWithin(child, remaining(deadline)))) {
      child.kill("SIGKILL")
      throw new ProcessTerminationError("Native process did not exit after SIGKILL")
    }
    return
  }

  if (!systemRoot || !path.isAbsolute(systemRoot)) {
    child.kill("SIGKILL")
    if (!(await waitForExitWithin(child, remaining(deadline)))) {
      throw new ProcessTerminationError("Native process did not exit after SIGKILL")
    }
    return
  }
  await new Promise<void>((resolve) => {
    let killer: ChildProcess
    try {
      killer = taskkillCommand(
        path.join(systemRoot, "System32", "taskkill.exe"),
        ["/pid", String(child.pid), "/T", "/F"],
        {
          env: { SystemRoot: systemRoot, WINDIR: systemRoot },
          shell: false,
          stdio: "ignore",
          windowsHide: true,
        },
      )
    } catch {
      child.kill("SIGKILL")
      resolve()
      return
    }
    let settled = false
    const complete = (fallback: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (fallback) child.kill("SIGKILL")
      resolve()
    }
    const timeout = setTimeout(() => {
      killer.kill("SIGKILL")
      complete(true)
    }, remaining(deadline))
    killer.once("close", (code) => complete(code !== 0))
    killer.once("error", () => {
      child.kill("SIGKILL")
      complete(false)
    })
  })
  if (!(await waitForExitWithin(child, remaining(deadline)))) {
    child.kill("SIGKILL")
    throw new ProcessTerminationError("Native process tree did not exit before the termination deadline")
  }
}

async function validateOptions(options: TesseractOptions) {
  if (
    !path.isAbsolute(options.executablePath) ||
    !path.isAbsolute(options.tessdataPath) ||
    !path.isAbsolute(options.jobRoot) ||
    !inside(options.jobRoot, options.inputPath) ||
    !inside(options.jobRoot, options.outputPath) ||
    !options.outputPath.toLowerCase().endsWith(".tsv")
  ) {
    throw new RuntimeFailure("invalid-request", "input")
  }
  const jobRoot = await validatePrivateJobRoot(options.jobRoot)
  await validateInputFile(jobRoot, options.inputPath)
  const outputDirectory = path.dirname(options.outputPath)
  if (path.resolve(outputDirectory) !== path.resolve(options.jobRoot)) {
    await makePrivateDirectory(jobRoot, path.relative(options.jobRoot, outputDirectory).replaceAll("\\", "/"))
  }
  const tessdata = await lstat(options.tessdataPath).catch(() => undefined)
  if (!tessdata?.isDirectory() || tessdata.isSymbolicLink()) {
    throw new RuntimeFailure("runtime-unavailable", "ocr")
  }
  await validateExecutable(options.executablePath, options.platform ?? process.platform, "ocr")
  const data = await Promise.all(
    ["eng.traineddata", "osd.traineddata"].map((file) =>
      lstat(path.join(options.tessdataPath, file)).catch(() => undefined),
    ),
  )
  if (data.some((info) => !info?.isFile() || info.isSymbolicLink())) {
    throw new RuntimeFailure("runtime-unavailable", "ocr")
  }
  await mkdir(path.join(options.jobRoot, "tmp"), { recursive: true, mode: 0o700 })
}

function spawnTesseract(executable: string, args: ReadonlyArray<string>, options: SpawnOptions) {
  return spawn(executable, args, options)
}

function spawnTaskkill(executable: string, args: ReadonlyArray<string>, options: Parameters<TaskkillCommand>[2]) {
  return spawn(executable, args, options)
}

function spawnChild(
  spawnCommand: SpawnCommand,
  executable: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions,
) {
  try {
    return spawnCommand(executable, args, options)
  } catch {
    throw new RuntimeFailure("runtime-unavailable", "ocr")
  }
}

function waitForExit(child: SpawnedProcess) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode)
  if (child.signalCode !== null) return Promise.resolve(null)
  return new Promise<number | null>((resolve) => {
    let finished = false
    const complete = (code: number | null) => {
      if (finished) return
      finished = true
      child.off("close", complete)
      child.off("error", failed)
      resolve(code)
    }
    const failed = () => complete(null)
    child.once("close", complete)
    child.once("error", failed)
    if (child.exitCode !== null || child.signalCode !== null) complete(child.exitCode)
  })
}

function waitForExitWithin(child: ChildProcess, timeoutMs: number) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise<boolean>((resolve) => {
    let settled = false
    const complete = (exited: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      child.off("close", onExit)
      child.off("exit", onExit)
      resolve(exited)
    }
    const onExit = () => complete(true)
    const timeout = setTimeout(() => complete(false), timeoutMs)
    child.once("close", onExit)
    child.once("exit", onExit)
    if (child.exitCode !== null || child.signalCode !== null) complete(true)
  })
}

function remaining(deadline: number) {
  return Math.max(0, deadline - Date.now())
}

async function readProbeDiagnostic(stream: Readable, limit: number, terminate: () => Promise<void>) {
  const chunks: Buffer[] = []
  let bytes = 0
  try {
    for await (const value of stream) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
      if (bytes + chunk.byteLength > limit) {
        await terminate()
        return { bytes: Buffer.concat(chunks, bytes), overflow: true }
      }
      chunks.push(chunk)
      bytes += chunk.byteLength
    }
    return { bytes: Buffer.concat(chunks, bytes), overflow: false }
  } catch {
    await terminate()
    return { bytes: Buffer.alloc(0), overflow: true }
  }
}

function probeVersion(output: Buffer) {
  return output
    .toString("utf8")
    .split(/\r?\n/, 1)[0]
    ?.replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
}

async function validateExecutable(file: string, platform: NodeJS.Platform, stage: "ocr" | "probe") {
  const executable = await lstat(file).catch(() => undefined)
  if (!executable?.isFile() || executable.isSymbolicLink()) {
    throw new RuntimeFailure("runtime-unavailable", stage)
  }
  if (platform === "win32") return
  await access(file, constants.X_OK).catch(() => {
    throw new RuntimeFailure("runtime-unavailable", stage)
  })
}

async function failAndRemove(outputPath: string, failure: RuntimeFailure): Promise<never> {
  await rm(outputPath, { force: true }).catch(() => undefined)
  throw failure
}

function inside(root: string, file: string) {
  if (!path.isAbsolute(file)) return false
  const relation = path.relative(root, file)
  return relation !== "" && relation !== ".." && !relation.startsWith(`..${path.sep}`) && !path.isAbsolute(relation)
}
