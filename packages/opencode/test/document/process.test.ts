import { describe, expect, test } from "bun:test"
import type { ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"
import { DocumentProcess, type ProcessHandle, type TerminationDependencies } from "@/document/process"

describe("document process observation", () => {
  test("returns an already observed exit without adding listeners", async () => {
    const child = processHandle({ exitCode: 0 })
    expect(await DocumentProcess.waitForObservedExit(child, 25)).toEqual({
      status: "exited",
      exit: { code: 0, signal: null },
    })
    expect(child.emitter.listenerCount("exit")).toBe(0)
  })

  test("observes an exit and removes its timeout listener", async () => {
    const child = processHandle()
    const waiting = DocumentProcess.waitForObservedExit(child, 100)
    child.exitCode = 7
    child.emitter.emit("exit", 7, null)
    expect(await waiting).toEqual({ status: "exited", exit: { code: 7, signal: null } })
    expect(child.emitter.listenerCount("exit")).toBe(0)
  })

  test("reports an unobserved exit after the fixed bound", async () => {
    const child = processHandle()
    expect(await DocumentProcess.waitForObservedExit(child, 10)).toEqual({
      status: "unavailable",
      code: "exit-not-observed",
    })
    expect(child.emitter.listenerCount("exit")).toBe(0)
  })
})

describe("document process tree termination", () => {
  test("sweeps a POSIX process group even after the leader exit was observed", async () => {
    const child = processHandle({ pid: 4321, exitCode: 0 })
    const groups: number[] = []
    expect(
      await DocumentProcess.terminateProcessTree(child, {
        platform: "linux",
        timeoutMs: 100,
        dependencies: terminationDependencies({
          signalProcessGroup: (pid) => groups.push(pid),
          probeProcessGroup: () => {
            throw Object.assign(new Error("missing"), { code: "ESRCH" })
          },
          spawnTreeKiller: () => processHandle(),
        }),
      }),
    ).toEqual({ status: "exited", exit: { code: 0, signal: null } })
    expect(groups).toEqual([4321])
  })

  test("accepts ESRCH as confirmed POSIX group absence after an observed leader exit", async () => {
    const child = processHandle({ pid: 4321, exitCode: 0 })
    expect(
      await DocumentProcess.terminateProcessTree(child, {
        platform: "linux",
        timeoutMs: 100,
        dependencies: terminationDependencies({
          signalProcessGroup: () => {
            throw Object.assign(new Error("missing"), { code: "ESRCH" })
          },
          probeProcessGroup: () => {
            throw Object.assign(new Error("missing"), { code: "ESRCH" })
          },
          spawnTreeKiller: () => processHandle(),
        }),
      }),
    ).toEqual({ status: "exited", exit: { code: 0, signal: null } })
  })

  test("polls surviving descendants until delayed ESRCH confirms process-group absence", async () => {
    const child = processHandle({ pid: 4321, exitCode: 0 })
    const probes: Array<"alive" | "permission-denied" | "absent"> = ["alive", "permission-denied", "alive", "absent"]
    let now = 0
    const signals: string[] = []
    expect(
      await DocumentProcess.terminateProcessTree(child, {
        platform: "linux",
        timeoutMs: 40,
        dependencies: terminationDependencies({
          signalProcessGroup: (_pid, signal) => signals.push(signal),
          probeProcessGroup: () => {
            const probe = probes.shift() ?? "absent"
            if (probe === "permission-denied") throw Object.assign(new Error("denied"), { code: "EPERM" })
            if (probe === "absent") throw Object.assign(new Error("missing"), { code: "ESRCH" })
          },
          now: () => now,
          sleep: async (milliseconds) => {
            now += milliseconds
          },
        }),
      }),
    ).toEqual({ status: "exited", exit: { code: 0, signal: null } })
    expect(signals).toEqual(["SIGTERM", "SIGKILL"])
  })

  test("escalates to SIGKILL and times out while descendants remain alive, including EPERM-equivalent probes", async () => {
    const child = processHandle({ pid: 4321, exitCode: 0 })
    let now = 0
    const signals: string[] = []
    expect(
      await DocumentProcess.terminateProcessTree(child, {
        platform: "linux",
        timeoutMs: 20,
        dependencies: terminationDependencies({
          signalProcessGroup: (_pid, signal) => signals.push(signal),
          probeProcessGroup: () => {
            throw Object.assign(new Error("denied"), { code: "EPERM" })
          },
          now: () => now,
          sleep: async (milliseconds) => {
            now += milliseconds
          },
        }),
      }),
    ).toEqual({ status: "unavailable", code: "tree-containment-unconfirmed" })
    expect(signals).toEqual(["SIGTERM", "SIGKILL"])
  })

  test("kills a POSIX process group and requires observed exit", async () => {
    const child = processHandle({ pid: 4321 })
    const groups: number[] = []
    const result = await DocumentProcess.terminateProcessTree(child, {
      platform: "linux",
      timeoutMs: 100,
      dependencies: terminationDependencies({
        signalProcessGroup: (pid) => {
          groups.push(pid)
          queueMicrotask(() => {
            child.signalCode = "SIGKILL"
            child.emitter.emit("exit", null, "SIGKILL")
          })
        },
        probeProcessGroup: () => {
          throw Object.assign(new Error("missing"), { code: "ESRCH" })
        },
        spawnTreeKiller: () => processHandle(),
      }),
    })
    expect(groups).toEqual([4321])
    expect(result).toEqual({ status: "exited", exit: { code: null, signal: "SIGKILL" } })
  })

  test("uses an absolute taskkill path, fixed argv, minimal environment, and observed child exit", async () => {
    const child = processHandle({ pid: 9876 })
    const calls: Array<{ executable: string; args: ReadonlyArray<string>; options: object }> = []
    const result = await DocumentProcess.terminateProcessTree(child, {
      platform: "win32",
      systemRoot: "C:\\Windows",
      timeoutMs: 100,
      verifyWindowsTreeEmpty: async () => true,
      dependencies: terminationDependencies({
        spawnTreeKiller: (executable, args, options) => {
          calls.push({ executable, args, options })
          const killer = processHandle({ pid: 1234 })
          queueMicrotask(() => {
            killer.exitCode = 0
            killer.emitter.emit("exit", 0, null)
            child.signalCode = "SIGKILL"
            child.emitter.emit("exit", null, "SIGKILL")
          })
          return killer
        },
      }),
    })
    expect(calls).toEqual([
      {
        executable: "C:\\Windows\\System32\\taskkill.exe",
        args: ["/pid", "9876", "/T", "/F"],
        options: {
          env: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows" },
          shell: false,
          stdio: "ignore",
          windowsHide: true,
        },
      },
    ])
    expect(result).toEqual({ status: "exited", exit: { code: null, signal: "SIGKILL" } })
  })

  test("invokes the Windows tree sweep after the leader exit was already observed", async () => {
    const child = processHandle({ pid: 9876, exitCode: 0 })
    let sweeps = 0
    let evidenceChecks = 0
    const result = await DocumentProcess.terminateProcessTree(child, {
      platform: "win32",
      systemRoot: "C:\\Windows",
      timeoutMs: 100,
      verifyWindowsTreeEmpty: async () => {
        evidenceChecks++
        return true
      },
      dependencies: terminationDependencies({
        spawnTreeKiller: () => {
          sweeps++
          const killer = processHandle({ pid: 1234 })
          queueMicrotask(() => {
            killer.exitCode = 0
            killer.emitter.emit("exit", 0, null)
          })
          return killer
        },
      }),
    })

    expect(sweeps).toBe(1)
    expect(evidenceChecks).toBe(1)
    expect(result).toEqual({ status: "exited", exit: { code: 0, signal: null } })
  })

  test.each([
    [undefined, { status: "evidence-required", code: "windows-tree-evidence-required" }],
    [async () => false, { status: "unavailable", code: "tree-containment-unconfirmed" }],
  ] as const)("rejects missing or negative Windows tree-empty evidence", async (verifyWindowsTreeEmpty, expected) => {
    const child = processHandle({ pid: 9876, exitCode: 0 })
    const killer = processHandle({ pid: 1234, exitCode: 0 })
    expect(
      await DocumentProcess.terminateProcessTree(child, {
        platform: "win32",
        systemRoot: "C:\\Windows",
        timeoutMs: 100,
        dependencies: terminationDependencies({ spawnTreeKiller: () => killer }),
        verifyWindowsTreeEmpty,
      }),
    ).toEqual(expected)
  })

  test("does not claim success when the tree killer or child exit cannot be confirmed", async () => {
    const child = processHandle({ pid: 9876 })
    const killer = processHandle({ pid: 1234 })
    let helperKills = 0
    killer.kill = (() => {
      helperKills++
      return true
    }) as ChildProcess["kill"]
    expect(
      await DocumentProcess.terminateProcessTree(child, {
        platform: "win32",
        systemRoot: "C:\\Windows",
        timeoutMs: 10,
        dependencies: terminationDependencies({
          spawnTreeKiller: () => killer,
        }),
      }),
    ).toEqual({ status: "unavailable", code: "helper-exit-not-observed" })
    expect(helperKills).toBe(1)
    expect(killer.emitter.listenerCount("error")).toBe(0)
    expect(killer.emitter.listenerCount("exit")).toBe(0)

    expect(
      await DocumentProcess.terminateProcessTree(processHandle(), {
        platform: "linux",
        timeoutMs: 10,
        dependencies: terminationDependencies(),
      }),
    ).toEqual({ status: "unavailable", code: "missing-pid" })
  })

  test("handles an asynchronous taskkill spawn error and bounds fallback exit observation", async () => {
    const child = processHandle({ pid: 9876 })
    const killer = processHandle()
    let fallbackKills = 0
    let helperKills = 0
    child.kill = (() => {
      fallbackKills++
      queueMicrotask(() => {
        child.signalCode = "SIGKILL"
        child.emitter.emit("exit", null, "SIGKILL")
      })
      return true
    }) as ChildProcess["kill"]
    killer.kill = (() => {
      helperKills++
      queueMicrotask(() => {
        killer.signalCode = "SIGKILL"
        killer.emitter.emit("exit", null, "SIGKILL")
      })
      return true
    }) as ChildProcess["kill"]
    const pending = DocumentProcess.terminateProcessTree(child, {
      platform: "win32",
      systemRoot: "C:\\Windows",
      timeoutMs: 100,
      dependencies: terminationDependencies({
        spawnTreeKiller: () => {
          queueMicrotask(() => killer.emitter.emit("error", new Error("spawn failed")))
          return killer
        },
      }),
    })

    expect(await pending).toEqual({ status: "unavailable", code: "tree-termination-failed" })
    expect(fallbackKills).toBe(1)
    expect(helperKills).toBe(1)
    expect(killer.emitter.listenerCount("error")).toBe(0)
    expect(killer.emitter.listenerCount("exit")).toBe(0)
    expect(child.emitter.listenerCount("exit")).toBe(0)
  })

  test("installs fallback listeners before taskkill kill emits an error", async () => {
    const child = processHandle({ pid: 9876 })
    const killer = processHandle({ pid: 1234 })
    child.kill = (() => {
      child.signalCode = "SIGKILL"
      child.emitter.emit("exit", null, "SIGKILL")
      return true
    }) as ChildProcess["kill"]
    killer.kill = (() => {
      killer.emitter.emit("error", new Error("kill failed"))
      return false
    }) as ChildProcess["kill"]

    expect(
      await DocumentProcess.terminateProcessTree(child, {
        platform: "win32",
        systemRoot: "C:\\Windows",
        timeoutMs: 40,
        dependencies: terminationDependencies({
          spawnTreeKiller: () => killer,
        }),
      }),
    ).toEqual({ status: "unavailable", code: "helper-exit-not-observed" })
    expect(killer.emitter.listenerCount("error")).toBe(0)
    expect(killer.emitter.listenerCount("exit")).toBe(0)
    expect(child.emitter.listenerCount("exit")).toBe(0)
  })

  test("removes fallback listeners when taskkill kill throws and no exit is observed", async () => {
    const child = processHandle({ pid: 9876 })
    const killer = processHandle({ pid: 1234 })
    killer.kill = (() => {
      throw new Error("kill failed")
    }) as ChildProcess["kill"]

    expect(
      await DocumentProcess.terminateProcessTree(child, {
        platform: "win32",
        systemRoot: "C:\\Windows",
        timeoutMs: 20,
        dependencies: terminationDependencies({
          spawnTreeKiller: () => killer,
        }),
      }),
    ).toEqual({ status: "unavailable", code: "helper-exit-not-observed" })
    expect(killer.emitter.listenerCount("error")).toBe(0)
    expect(killer.emitter.listenerCount("exit")).toBe(0)
    expect(child.emitter.listenerCount("exit")).toBe(0)
  })

  test("does not claim tree termination when POSIX group signaling fails", async () => {
    const child = processHandle({ pid: 4321 })
    child.kill = (() => {
      queueMicrotask(() => {
        child.signalCode = "SIGKILL"
        child.emitter.emit("exit", null, "SIGKILL")
      })
      return true
    }) as ChildProcess["kill"]
    expect(
      await DocumentProcess.terminateProcessTree(child, {
        platform: "linux",
        timeoutMs: 100,
        dependencies: terminationDependencies({
          signalProcessGroup: () => {
            throw new Error("missing process group")
          },
          probeProcessGroup: () => {
            throw new Error("cannot inspect process group")
          },
          spawnTreeKiller: () => processHandle(),
        }),
      }),
    ).toEqual({ status: "unavailable", code: "tree-termination-failed" })
  })
})

function processHandle(initial: { readonly pid?: number; readonly exitCode?: number | null } = {}) {
  const emitter = new EventEmitter()
  const value = {
    pid: initial.pid,
    exitCode: initial.exitCode ?? null,
    signalCode: null as NodeJS.Signals | null,
    once: emitter.once.bind(emitter) as ChildProcess["once"],
    off: emitter.off.bind(emitter) as ChildProcess["off"],
    kill: (() => true) as ChildProcess["kill"],
    emitter,
  }
  return value satisfies ProcessHandle & { readonly emitter: EventEmitter }
}

function terminationDependencies(overrides: Partial<TerminationDependencies> = {}): TerminationDependencies {
  return {
    signalProcessGroup: () => undefined,
    probeProcessGroup: () => {
      throw Object.assign(new Error("missing"), { code: "ESRCH" })
    },
    spawnTreeKiller: () => processHandle(),
    ...overrides,
  }
}
