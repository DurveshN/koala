import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { fork, spawn } from "node:child_process"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const root = path.resolve(import.meta.dir, "../..")
let temporary: string
let output: string
let proxy: string
const children = new Set<ReturnType<typeof fork>>()

beforeAll(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), "opencode-document-build-"))
  output = path.join(temporary, "node", "sandbox-runtime")
  proxy = path.join(output, "document-runtime-proxy.mjs")
  await mkdir(path.join(output, "worker"), { recursive: true })
  await writeFile(path.join(output, "stale-proxy.mjs"), "stale")
  await writeFile(path.join(output, "worker", "bootstrap.js"), "stale")
  const child = Bun.spawn(["bun", "run", "script/build-node.ts"], {
    cwd: root,
    env: { ...process.env, OPENCODE_NODE_BUILD_DIR: path.join(temporary, "node") },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  if (code !== 0) throw new Error(`Isolated OpenCode build failed: ${stderr}`)
}, 120_000)

afterAll(async () => {
  for (const child of children) child.kill("SIGKILL")
  await rm(temporary, { recursive: true, force: true })
})

describe.serial("document proxy build", () => {
  test("emits one clean target-specific sandbox runtime tree", async () => {
    const manifest = (await Bun.file(path.join(output, "sandbox-runtime.manifest.json")).json()) as {
      readonly manifestVersion: number
      readonly target: string
      readonly files: ReadonlyArray<{
        readonly path: string
        readonly sha256: string
        readonly bytes: number
        readonly mode: number
      }>
    }
    const expectedHelper = manifest.target.includes("windows")
      ? `vendor/srt-win/${manifest.target.startsWith("x86_64-") ? "x64" : "arm64"}/srt-win.exe`
      : manifest.target.includes("linux")
        ? `vendor/seccomp/${manifest.target.startsWith("x86_64-") ? "x64" : "arm64"}/apply-seccomp`
        : undefined
    const expected = [
      "LICENSE",
      "document-runtime-proxy.mjs",
      "sandbox-worker.mjs",
      "vendor/java-proxy-agent/srt-proxy-agent.jar",
      ...(expectedHelper ? [expectedHelper] : []),
    ].sort()

    expect(manifest.manifestVersion).toBe(1)
    expect(await Bun.file(path.join(output, "stale-proxy.mjs")).exists()).toBe(false)
    expect(await Bun.file(path.join(output, "worker", "bootstrap.js")).exists()).toBe(false)
    expect(manifest.files.map((file) => file.path).sort()).toEqual(expected)
    expect(await listFiles(output)).toEqual([...expected, "sandbox-runtime.manifest.json"].sort())
    for (const file of manifest.files) {
      const value = Bun.file(path.join(output, ...file.path.split("/")))
      expect(await value.exists()).toBe(true)
      expect(value.size).toBe(file.bytes)
      expect(new Bun.CryptoHasher("sha256").update(await value.arrayBuffer()).digest("hex")).toBe(file.sha256)
      expect(file.mode).toBe(file.path.endsWith(".exe") || file.path.endsWith("/apply-seccomp") ? 0o755 : 0o644)
    }
  })

  test("contains no document parser imports or source fallback", async () => {
    const source = await Bun.file(proxy).text()
    const buildSource = await Bun.file(path.join(root, "script", "build-node.ts")).text()
    const imports = new Bun.Transpiler().scanImports(source).map((entry) => entry.path)
    expect(imports.some((entry) => /pdfjs|canvas|tesseract|office|parser/i.test(entry))).toBe(false)
    expect(imports.some((entry) => entry.endsWith(".ts") || entry.includes("/src/"))).toBe(false)
    expect(source).not.toContain("src/document/proxy.ts")
    expect(source).not.toContain("worker/worker.ts")
    expect(source).not.toContain("worker/bootstrap.ts")
    for (const fallback of [
      "npm root -g",
      "/usr/lib/node_modules",
      "/usr/local/lib/node_modules",
      "/opt/homebrew/lib/node_modules",
      ".npm-global",
    ]) {
      expect(source).not.toContain(fallback)
    }
    expect(buildSource).toContain('entrypoints: ["./src/document/proxy.ts"]')
    expect(buildSource.indexOf("await fs.rm(sandboxOutdir")).toBeLessThan(
      buildSource.indexOf("const sandbox = await Bun.build"),
    )
  })

  test("passes Node syntax validation", async () => {
    const child = spawn("node", ["--check", proxy], { stdio: "pipe" })
    const stderr: Buffer[] = []
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))
    expect(await new Promise<number | null>((resolve) => child.once("exit", resolve))).toBe(0)
    expect(Buffer.concat(stderr).toString("utf8")).toBe("")
  })

  test("rejects malformed IPC and closes cleanly", async () => {
    const child = fork(proxy, [], {
      execPath: "node",
      env: { KOALA_DOCUMENT_RUNTIME_PROXY_ASSETS_ROOT: output },
      execArgv: [],
      serialization: "json",
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    })
    children.add(child)
    const messages: unknown[] = []
    child.on("message", (message) => messages.push(message))
    child.send({ protocolVersion: 1, type: "not-a-launch" })
    const exit = await new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>((resolve) =>
      child.once("exit", (code, signal) => resolve({ code, signal })),
    )
    children.delete(child)
    expect(exit).toEqual({ code: 0, signal: null })
    expect(messages).toEqual([
      {
        protocolVersion: 1,
        type: "failure",
        jobID: null,
        code: "invalid-launch",
        stage: "launch",
        retryable: false,
      },
      { protocolVersion: 1, type: "closed", jobID: null },
    ])
  })
})

async function listFiles(directory: string, relative = ""): Promise<string[]> {
  const entries = await readdir(path.join(directory, ...relative.split("/").filter(Boolean)), { withFileTypes: true })
  return (
    await Promise.all(
      entries.map(async (entry) => {
        const item = relative ? `${relative}/${entry.name}` : entry.name
        return entry.isDirectory() ? listFiles(directory, item) : [item]
      }),
    )
  )
    .flat()
    .sort()
}
