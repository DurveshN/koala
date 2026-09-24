import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process"
import path from "node:path"

export interface ProcessHandle {
  readonly pid?: number
  readonly exitCode: number | null
  readonly signalCode: NodeJS.Signals | null
  readonly once: ChildProcess["once"]
  readonly off: ChildProcess["off"]
  readonly kill: ChildProcess["kill"]
}

export interface ObservedExit {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
}

export type ExitResult =
  | { readonly status: "exited"; readonly exit: ObservedExit }
  | {
      readonly status: "unavailable"
      readonly code:
        | "invalid-timeout"
        | "missing-pid"
        | "tree-termination-failed"
        | "tree-containment-unconfirmed"
        | "helper-exit-not-observed"
        | "exit-not-observed"
    }

export type SpawnTreeKiller = (executable: string, args: ReadonlyArray<string>, options: SpawnOptions) => ProcessHandle

export interface TerminationDependencies {
  readonly signalProcessGroup: (pid: number, signal: "SIGTERM" | "SIGKILL") => void
  readonly probeProcessGroup: (pid: number) => void
  readonly spawnTreeKiller: SpawnTreeKiller
  readonly listWindowsProcesses?: (systemRoot: string) => Promise<ReadonlyArray<readonly [number, number]>>
  readonly now?: () => number
  readonly sleep?: (milliseconds: number) => Promise<void>
}

const defaultDependencies: TerminationDependencies = {
  signalProcessGroup: (pid, signal) => process.kill(-pid, signal),
  probeProcessGroup: (pid) => process.kill(-pid, 0),
  spawnTreeKiller: (executable, args, options) => spawn(executable, args, options),
  listWindowsProcesses,
}

export async function terminateProcessTree(
  child: ProcessHandle,
  options: {
    readonly platform?: NodeJS.Platform
    readonly systemRoot?: string
    readonly timeoutMs: number
    readonly dependencies?: TerminationDependencies
    readonly verifyWindowsTreeEmpty?: (pid: number) => Promise<boolean>
  },
): Promise<ExitResult> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
    return { status: "unavailable", code: "invalid-timeout" }
  }
  const observed = observedExit(child)
  if (!child.pid) return { status: "unavailable", code: "missing-pid" }

  const dependencies = options.dependencies ?? defaultDependencies
  const now = dependencies.now ?? Date.now
  const sleep =
    dependencies.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  const deadline = now() + options.timeoutMs
  if ((options.platform ?? process.platform) !== "win32") {
    return sweepPosixProcessGroup(child, child.pid, observed, deadline, dependencies, now, sleep)
  }

  if (!options.systemRoot || !validSystemRoot(options.systemRoot)) {
    tryKill(child)
    return { status: "unavailable", code: "tree-termination-failed" }
  }

  const systemRoot = options.systemRoot

  const verify =
    options.verifyWindowsTreeEmpty ??
    ((pid: number) =>
      windowsDescendantsAbsent(pid, systemRoot, dependencies.listWindowsProcesses ?? listWindowsProcesses))

  // A leader that already exited normally is not re-killed; only its descendants are verified.
  if (!observed) {
    let killer: ProcessHandle
    try {
      killer = dependencies.spawnTreeKiller(
        path.win32.join(systemRoot, "System32", "taskkill.exe"),
        ["/pid", String(child.pid), "/T", "/F"],
        {
          env: { SystemRoot: systemRoot, WINDIR: systemRoot },
          shell: false,
          stdio: "ignore",
          windowsHide: true,
        },
      )
    } catch {
      tryKill(child)
      await observeBefore(child, deadline)
      return { status: "unavailable", code: "tree-termination-failed" }
    }

    const killerExit = await waitForTreeKiller(killer, Math.max(1, Math.floor(options.timeoutMs / 2)))
    if (killerExit.status !== "exited") {
      const helperWait = waitForTreeKiller(killer, remaining(deadline))
      const childWait = waitForObservedExit(child, remaining(deadline))
      const helperSignaled = tryKill(killer)
      tryKill(child)
      const [helperObserved] = await Promise.all([helperWait, childWait])
      if (!helperSignaled || helperObserved.status !== "exited") {
        return { status: "unavailable", code: "helper-exit-not-observed" }
      }
      return { status: "unavailable", code: "tree-termination-failed" }
    }

    // taskkill exits 128 when the leader raced to exit and 1 when it cannot open descendants that
    // run as srt-sandbox; the observed exit plus the descendant sweep below is the containment proof.
    if (killerExit.exit.code !== 0 || killerExit.exit.signal !== null) tryKill(child)
  }

  const result = await observeBefore(child, deadline)
  if (result.status !== "exited") {
    tryKill(child)
    return result
  }

  while (true) {
    const empty = await settleBefore(verify(child.pid), remaining(deadline)).catch(() => undefined)
    if (empty === true) return result
    if (now() >= deadline) return { status: "unavailable", code: "tree-containment-unconfirmed" }
    await sleep(Math.min(100, remaining(deadline)))
  }
}

export async function windowsDescendantsAbsent(
  pid: number,
  systemRoot: string,
  list: (systemRoot: string) => Promise<ReadonlyArray<readonly [number, number]>> = listWindowsProcesses,
) {
  const processes = await list(systemRoot)
  const tree = new Set([pid])
  // Descendants keep the parent id of an exited ancestor, so one pass over the snapshot closes the tree.
  for (let grow = true; grow; ) {
    grow = false
    for (const [child, parent] of processes) {
      if (tree.has(parent) && !tree.has(child)) {
        tree.add(child)
        grow = true
      }
    }
  }
  return tree.size === 1
}

async function listWindowsProcesses(systemRoot: string): Promise<ReadonlyArray<readonly [number, number]>> {
  const lister = spawn(
    path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId),$($_.ParentProcessId)\" }",
    ],
    {
      env: { SystemRoot: systemRoot, WINDIR: systemRoot },
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    },
  )
  const chunks: Buffer[] = []
  lister.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk))
  const code = await new Promise<number | null>((resolve, reject) => {
    lister.once("error", reject)
    lister.once("close", resolve)
  })
  if (code !== 0) throw new Error("process enumeration failed")
  return Buffer.concat(chunks)
    .toString("utf8")
    .split(/\r?\n/)
    .flatMap((line) => {
      const match = /^(\d+),(\d+)$/.exec(line.trim())
      return match ? [[Number(match[1]), Number(match[2])] as const] : []
    })
}

export async function terminateProcessGroup(pid: number, timeoutMs: number) {
  if (!Number.isSafeInteger(pid) || pid < 1 || timeoutMs < 1) return false
  if (process.platform === "win32") {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0)
      } catch (error) {
        return processMissing(error)
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10))
    }
    return false
  }
  const deadline = Date.now() + timeoutMs
  try {
    process.kill(-pid, "SIGTERM")
  } catch (error) {
    if (processMissing(error)) return true
    return false
  }
  while (Date.now() < deadline) {
    try {
      process.kill(-pid, 0)
    } catch (error) {
      if (processMissing(error)) return true
      if (!permissionDenied(error)) return false
    }
    if (deadline - Date.now() < 250) {
      try {
        process.kill(-pid, "SIGKILL")
      } catch (error) {
        if (processMissing(error)) return true
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
  return false
}

async function sweepPosixProcessGroup(
  child: ProcessHandle,
  pid: number,
  initialExit: ObservedExit | undefined,
  deadline: number,
  dependencies: TerminationDependencies,
  now: () => number,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<ExitResult> {
  const killAt = now() + Math.max(1, Math.floor((deadline - now()) / 2))
  signalGroup(dependencies, pid, "SIGTERM")
  let killed = false
  while (true) {
    let group: "alive" | "absent" = "alive"
    try {
      dependencies.probeProcessGroup(pid)
    } catch (error) {
      if (processMissing(error)) group = "absent"
      else if (!permissionDenied(error)) return { status: "unavailable", code: "tree-termination-failed" }
    }
    const exit = observedExit(child) ?? initialExit
    if (group === "absent" && exit) return { status: "exited", exit }
    const current = now()
    if (!killed && current >= killAt) {
      signalGroup(dependencies, pid, "SIGKILL")
      killed = true
      continue
    }
    if (current >= deadline) {
      return {
        status: "unavailable",
        code: group === "absent" ? "exit-not-observed" : "tree-containment-unconfirmed",
      }
    }
    await sleep(Math.min(10, Math.max(1, deadline - current)))
  }
}

function signalGroup(dependencies: TerminationDependencies, pid: number, signal: "SIGTERM" | "SIGKILL") {
  try {
    dependencies.signalProcessGroup(pid, signal)
  } catch (error) {
    if (!processMissing(error)) return false
  }
  return true
}

function settleBefore<A>(promise: Promise<A>, timeoutMs: number) {
  return new Promise<A | undefined>((resolve) => {
    let settled = false
    const complete = (value: A | undefined) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => complete(undefined), Math.max(1, timeoutMs))
    void promise.then(complete, () => complete(undefined))
  })
}

export function waitForObservedExit(child: ProcessHandle, timeoutMs: number): Promise<ExitResult> {
  const observed = observedExit(child)
  if (observed) return Promise.resolve({ status: "exited", exit: observed })
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    return Promise.resolve({ status: "unavailable", code: "invalid-timeout" })
  }

  return new Promise((resolve) => {
    let settled = false
    const complete = (result: ExitResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.off("exit", onExit)
      resolve(result)
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
      complete({ status: "exited", exit: { code, signal } })
    const timer = setTimeout(() => complete({ status: "unavailable", code: "exit-not-observed" }), timeoutMs)
    child.once("exit", onExit)
    const raced = observedExit(child)
    if (raced) complete({ status: "exited", exit: raced })
  })
}

function waitForTreeKiller(child: ProcessHandle, timeoutMs: number): Promise<ExitResult> {
  const observed = observedExit(child)
  if (observed) return Promise.resolve({ status: "exited", exit: observed })
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    return Promise.resolve({ status: "unavailable", code: "invalid-timeout" })
  }

  return new Promise((resolve) => {
    let settled = false
    const complete = (result: ExitResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.off("error", onError)
      child.off("exit", onExit)
      resolve(result)
    }
    const onError = () => complete({ status: "unavailable", code: "tree-termination-failed" })
    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
      complete({ status: "exited", exit: { code, signal } })
    const timer = setTimeout(() => complete({ status: "unavailable", code: "exit-not-observed" }), timeoutMs)
    child.once("error", onError)
    child.once("exit", onExit)
    const raced = observedExit(child)
    if (raced) complete({ status: "exited", exit: raced })
  })
}

async function observeBefore(child: ProcessHandle, deadline: number): Promise<ExitResult> {
  const result = await waitForObservedExit(child, remaining(deadline))
  return result.status === "exited" ? result : { status: "unavailable", code: "exit-not-observed" }
}

function observedExit(child: ProcessHandle): ObservedExit | undefined {
  if (child.exitCode === null && child.signalCode === null) return
  return { code: child.exitCode, signal: child.signalCode }
}

function validSystemRoot(value: string) {
  return (
    !value.includes("\0") &&
    path.win32.isAbsolute(value) &&
    path.win32.normalize(value) === value &&
    /^[A-Za-z]:\\/.test(value) &&
    !value.slice(2).includes(":")
  )
}

function tryKill(child: ProcessHandle) {
  try {
    return child.kill("SIGKILL")
  } catch {
    return false
  }
}

function processMissing(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH"
}

function permissionDenied(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM"
}

function remaining(deadline: number) {
  return Math.max(1, deadline - Date.now())
}

export * as DocumentProcess from "./process"
