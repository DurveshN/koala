import { afterAll, describe, expect, test } from "bun:test"
import { getApplySeccompBinaryPath } from "@anthropic-ai/sandbox-runtime/dist/sandbox/generate-seccomp-filter.js"
import { getJavaProxyAgentJarPath } from "@anthropic-ai/sandbox-runtime/dist/sandbox/java-proxy-agent.js"
import { resolveSrtWin } from "@anthropic-ai/sandbox-runtime/dist/sandbox/windows-sandbox-utils.js"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const roots: string[] = []

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

describe("pinned SRT explicit assets", () => {
  test("does not search ambient locations when an asset path is absent", async () => {
    const missing = path.join(await temporaryDirectory(), "missing")
    expect(() => getApplySeccompBinaryPath(missing)).toThrow("seccomp.applyPath is missing")
    expect(() => getJavaProxyAgentJarPath(missing)).toThrow("javaAgentJarPath is missing")
    expect(() => resolveSrtWin({ path: missing })).toThrow("missing, invalid, or changed")
    expect(getApplySeccompBinaryPath()).toBeNull()
    expect(getJavaProxyAgentJarPath()).toBeNull()
  })

  test("rejects explicit assets changed after their first resolution", async () => {
    const root = await temporaryDirectory()
    const seccomp = path.join(root, "apply-seccomp")
    const java = path.join(root, "agent.jar")
    const windows = path.join(root, "srt-win.exe")
    await Promise.all([writeFile(seccomp, "first"), writeFile(java, "first"), writeFile(windows, "first")])
    expect(getApplySeccompBinaryPath(seccomp)).toBe(seccomp)
    expect(getJavaProxyAgentJarPath(java)).toBe(java)
    expect(resolveSrtWin({ path: windows }).exe).toBe(windows)

    await Promise.all([writeFile(seccomp, "other"), writeFile(java, "other"), writeFile(windows, "other")])
    expect(() => getApplySeccompBinaryPath(seccomp)).toThrow("changed after resolution")
    expect(() => getJavaProxyAgentJarPath(java)).toThrow("changed after resolution")
    expect(() => resolveSrtWin({ path: windows })).toThrow("missing, invalid, or changed")
  })
})

async function temporaryDirectory() {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-srt-assets-"))
  roots.push(root)
  return root
}
