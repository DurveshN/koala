import type { Readable } from "node:stream"

export interface Tracker {
  readonly drain: Promise<boolean>
  readonly cleanup: () => void
}

export function track(
  stdout: Readable | null | undefined,
  stderr: Readable | null | undefined,
  onData: (chunk: unknown) => void,
): Tracker {
  const drained = Promise.withResolvers<boolean>()
  const output = { end: false, close: false, error: !stdout }
  const error = { end: false, close: false, error: !stderr }
  let settled = false
  const check = () => {
    if (settled) return
    if (output.error || error.error) {
      settled = true
      drained.resolve(false)
      return
    }
    if (!output.end || !output.close || !error.end || !error.close) return
    settled = true
    drained.resolve(true)
  }
  const stdoutEnd = () => {
    output.end = true
    check()
  }
  const stdoutClose = () => {
    output.close = true
    check()
  }
  const stdoutError = () => {
    output.error = true
    check()
  }
  const stderrEnd = () => {
    error.end = true
    check()
  }
  const stderrClose = () => {
    error.close = true
    check()
  }
  const stderrError = () => {
    error.error = true
    check()
  }

  stdout?.on("data", onData)
  stderr?.on("data", onData)
  stdout?.once("end", stdoutEnd)
  stdout?.once("close", stdoutClose)
  stdout?.once("error", stdoutError)
  stderr?.once("end", stderrEnd)
  stderr?.once("close", stderrClose)
  stderr?.once("error", stderrError)
  check()

  return {
    drain: drained.promise,
    cleanup: () => {
      stdout?.off("data", onData)
      stderr?.off("data", onData)
      stdout?.off("end", stdoutEnd)
      stdout?.off("close", stdoutClose)
      stdout?.off("error", stdoutError)
      stderr?.off("end", stderrEnd)
      stderr?.off("close", stderrClose)
      stderr?.off("error", stderrError)
    },
  }
}

export * as DocumentDiagnostics from "./diagnostics"
