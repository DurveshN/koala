export * as DocumentRuntimeTarget from "./target.ts"

import { Schema } from "effect"

export const Targets = [
  "x86_64-apple-darwin",
  "aarch64-apple-darwin",
  "x86_64-pc-windows-msvc",
  "aarch64-pc-windows-msvc",
  "x86_64-unknown-linux-gnu",
  "aarch64-unknown-linux-gnu",
] as const

export const Target = Schema.Literals(Targets)
export type Target = typeof Target.Type

export const Architecture = Schema.Literals(["x86_64", "aarch64"])
export type Architecture = typeof Architecture.Type

export const HostPlatform = Schema.Literals(["darwin", "win32", "linux"])
export type HostPlatform = typeof HostPlatform.Type

export const HostArchitecture = Schema.Literals(["x64", "arm64"])
export type HostArchitecture = typeof HostArchitecture.Type

export const ArchitectureByTarget = {
  "x86_64-apple-darwin": "x86_64",
  "aarch64-apple-darwin": "aarch64",
  "x86_64-pc-windows-msvc": "x86_64",
  "aarch64-pc-windows-msvc": "aarch64",
  "x86_64-unknown-linux-gnu": "x86_64",
  "aarch64-unknown-linux-gnu": "aarch64",
} as const satisfies Record<Target, Architecture>

export const TargetByHost = {
  darwin: {
    x64: "x86_64-apple-darwin",
    arm64: "aarch64-apple-darwin",
  },
  win32: {
    x64: "x86_64-pc-windows-msvc",
    arm64: "aarch64-pc-windows-msvc",
  },
  linux: {
    x64: "x86_64-unknown-linux-gnu",
    arm64: "aarch64-unknown-linux-gnu",
  },
} as const satisfies Record<HostPlatform, Record<HostArchitecture, Target>>

export function fromHost(platform: HostPlatform, architecture: HostArchitecture): Target {
  return TargetByHost[platform][architecture]
}

export function architecture(target: Target): Architecture {
  return ArchitectureByTarget[target]
}
