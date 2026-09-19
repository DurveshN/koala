export * as SandboxPolicy from "./policy"

import { Schema } from "effect"
import { SandboxProtocol } from "./protocol"

export interface HostRoots {
  readonly cwd: string
  readonly readRoots: ReadonlyArray<string>
  readonly writeRoots: ReadonlyArray<string>
}

export interface Limits {
  readonly timeoutMs?: number
  readonly maxOutputBytes?: number
}

export const defaults = Object.freeze({
  env: Object.freeze({}),
  network: Object.freeze([]),
  timeoutMs: 30_000,
  maxOutputBytes: 1_048_576,
})

const decodeRequest = Schema.decodeUnknownSync(SandboxProtocol.ExecutionRequest)

export function buildRequest(roots: HostRoots, command: string, limits: Limits = {}): SandboxProtocol.ExecutionRequest {
  const request = decodeRequest({
    command,
    cwd: roots.cwd,
    readRoots: [...roots.readRoots],
    writeRoots: [...roots.writeRoots],
    env: { ...defaults.env },
    network: [...defaults.network],
    timeoutMs: limits.timeoutMs ?? defaults.timeoutMs,
    maxOutputBytes: limits.maxOutputBytes ?? defaults.maxOutputBytes,
  })

  Object.freeze(request.readRoots)
  Object.freeze(request.writeRoots)
  Object.freeze(request.env)
  Object.freeze(request.network)
  return Object.freeze(request)
}
