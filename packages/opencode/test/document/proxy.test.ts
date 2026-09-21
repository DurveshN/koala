import { describe, expect, test } from "bun:test"
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime"
import { DocumentRuntimeLimits } from "@koala-ai/core/document-runtime/limits"
import { DocumentRuntimeProtocol } from "@koala-ai/core/document-runtime/protocol"
import { DocumentSandboxProtocol } from "@koala-ai/core/document-runtime/sandbox-protocol"
import {
  createNodeStreamTransport,
  type NodeStreamTransport,
  type TransportError,
} from "@koala-ai/document-runtime/transport"
import { spawn, type SpawnOptions } from "node:child_process"
import { createHash } from "node:crypto"
import { EventEmitter } from "node:events"
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, readdir, rm } from "node:fs/promises"
import os from "node:os"
import { PassThrough } from "node:stream"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { DocumentProxy, type ParentPort, type ProxyChild, type ProxyDependencies } from "@/document/proxy"
import { DocumentProxyOutput } from "@/document/proxy-output"
import { DocumentPendingRoot } from "@/document/pending-root"
import { DocumentSandboxPolicy, type PreparedPolicy } from "@/document/sandbox-policy"

const jobID = DocumentRuntimeProtocol.JobID.make("job_00000000-0000-4000-8000-000000000001")
const outputID = DocumentRuntimeProtocol.OutputID.make("output_00000000-0000-4000-8000-000000000001")
const digest = "a".repeat(64)

describe("document confinement proxy lifecycle", () => {
  test("completes one real bounded-NDJSON fixture process", async () => {
    const fixture = fileURLToPath(new URL("./proxy-ndjson-worker.ts", import.meta.url))
    const harness = makeHarness({
      wrappedArgv: [process.execPath, fixture],
      applyHandoffEnvironment: (wrapped) => wrapped,
      spawnCommand: (executable, args, options) => spawn(executable, args, options),
      createTransport: createNodeStreamTransport,
    })
    const request = launch({ jobRoot: process.cwd() })
    const pending = DocumentProxy.startProxy(harness.dependencies)
    harness.parent.emit(request)
    await pending

    expect(types(harness)).toEqual(["accepted", "event", "event", "closed"])
    expect(harness.parent.messages[1]).toMatchObject({ type: "event", event: { type: "started" } })
    expect(harness.parent.messages[2]).toMatchObject({ type: "event", event: { type: "completed" } })
    expect(harness.manager.cleanupCalls).toBe(1)
    expect(harness.manager.resetCalls).toBe(1)
  })

  test("uses the real receiver for transfer, stable publication, and release", async () => {
    const roots = await realRoots()
    try {
      const harness = makeHarness({ createOutputReceiver: DocumentProxyOutput.create })
      const request = renderLaunch({
        parentRoot: roots.parent,
        parentIdentity: wireIdentity(roots.parentInfo),
        jobRoot: roots.job,
        jobRootIdentity: wireIdentity(roots.jobInfo),
        pendingRoot: roots.pending,
        pendingRootIdentity: wireIdentity(roots.pendingInfo),
      })
      const pending = DocumentProxy.startProxy(harness.dependencies)
      harness.parent.emit(request)
      await harness.parent.waitFor("accepted")
      harness.transport.emit(renderStarted())
      const body = Buffer.from("png")
      const sha256 = createHash("sha256").update(body).digest("hex")
      harness.transport.emit(outputStart(body.byteLength))
      harness.transport.emit(outputChunk(0, body))
      harness.transport.emit(outputEnd(1, body.byteLength, sha256))
      harness.transport.emit(
        pageReady({
          outputSha256: sha256,
          pngBytes: body.byteLength,
          temporaryBytes: body.byteLength,
        }),
      )
      await waitUntil(() =>
        harness.parent.messages.some((message) => message.type === "event" && message.event.type === "page-ready"),
      )
      const page = harness.parent.messages.find(
        (message) => message.type === "event" && message.event.type === "page-ready",
      )
      if (!page || page.type !== "event" || page.event.type !== "page-ready") throw new Error("missing page")
      expect(page.event.outputPath).not.toBe("pages/one.png")
      expect(await readFile(path.join(roots.pending, page.event.outputPath))).toEqual(body)
      expect(JSON.stringify(harness.parent.messages)).not.toContain(DocumentRuntimeProtocol.encodeCanonicalBase64(body))

      await rm(path.join(roots.pending, page.event.outputPath))
      harness.parent.emit(releaseCommand())
      await waitUntil(() =>
        harness.transport.sent.some(
          (message) =>
            typeof message === "object" && message !== null && "type" in message && message.type === "release-page",
        ),
      )
      harness.transport.emit(renderCompleted())
      await tick()
      harness.child.complete(0)
      await pending
      expect(types(harness)).toEqual(["accepted", "event", "event", "event", "closed"])
    } finally {
      if (process.platform !== "win32") await chmod(roots.parent, 0o700).catch(() => undefined)
      await rm(roots.parent, { recursive: true, force: true })
    }
  })

  test("cleans a real receiver partial file before reporting transfer failure", async () => {
    const roots = await realRoots()
    try {
      const harness = makeHarness({ createOutputReceiver: DocumentProxyOutput.create })
      const pending = DocumentProxy.startProxy(harness.dependencies)
      harness.parent.emit(
        renderLaunch({
          parentRoot: roots.parent,
          parentIdentity: wireIdentity(roots.parentInfo),
          jobRoot: roots.job,
          jobRootIdentity: wireIdentity(roots.jobInfo),
          pendingRoot: roots.pending,
          pendingRootIdentity: wireIdentity(roots.pendingInfo),
        }),
      )
      await harness.parent.waitFor("accepted")
      harness.transport.emit(renderStarted())
      harness.transport.emit(outputStart(2))
      harness.transport.emit(outputChunk(1, Buffer.from("x")))
      await pending

      expect(failureOf(harness)).toMatchObject({ code: "output-handoff-failed", stage: "worker" })
      expect(await readdir(roots.pending)).toEqual([])
      expect(harness.calls).toEqual(expect.arrayContaining(["sweep", "cleanup", "reset"]))
    } finally {
      if (process.platform !== "win32") await chmod(roots.parent, 0o700).catch(() => undefined)
      await rm(roots.parent, { recursive: true, force: true })
    }
  })

  test("maps a real receiver post-open root race to root-identity-failed", async () => {
    const roots = await realRoots()
    try {
      let checks = 0
      const harness = makeHarness({
        createOutputReceiver: (evidence, request) =>
          DocumentProxyOutput.create(evidence, request, {
            ...DocumentProxyOutput.defaultDependencies,
            verifyRoot: async (value) => {
              checks++
              if (checks >= 2) throw new DocumentPendingRoot.EvidenceError("simulated-root-replacement")
              return DocumentPendingRoot.verify(value)
            },
          }),
      })
      const pending = DocumentProxy.startProxy(harness.dependencies)
      harness.parent.emit(
        renderLaunch({
          parentRoot: roots.parent,
          parentIdentity: wireIdentity(roots.parentInfo),
          jobRoot: roots.job,
          jobRootIdentity: wireIdentity(roots.jobInfo),
          pendingRoot: roots.pending,
          pendingRootIdentity: wireIdentity(roots.pendingInfo),
        }),
      )
      await harness.parent.waitFor("accepted")
      harness.transport.emit(renderStarted())
      harness.transport.emit(outputStart(1))
      await pending

      expect(failureOf(harness)).toMatchObject({ code: "root-identity-failed", stage: "worker" })
      const entries = await readdir(roots.pending)
      expect(entries).toHaveLength(1)
      expect((await lstat(path.join(roots.pending, entries[0]!))).size).toBe(0)
    } finally {
      if (process.platform !== "win32") await chmod(roots.parent, 0o700).catch(() => undefined)
      await rm(roots.parent, { recursive: true, force: true })
    }
  })

  test("binds bounded pipes before acceptance, re-encodes ordered messages, and holds success through teardown", async () => {
    const harness = makeHarness()
    const pending = DocumentProxy.startProxy(harness.dependencies)
    harness.parent.emit(launch())

    await harness.parent.waitFor("accepted")
    expect(harness.transport.bound).toEqual({ message: true, disconnect: true })
    expect(harness.transport.sent).toEqual([launch().start])
    expect(harness.spawnCalls).toEqual([
      {
        executable: "/sandboxed/node",
        args: ["--fixed", "/runtime/worker/bootstrap.js"],
        options: {
          cwd: "/jobs/one",
          env: { DOCUMENT_JOB_ROOT: "/jobs/one" },
          shell: false,
          detached: true,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        },
      },
    ])

    harness.transport.emit(started())
    await harness.parent.waitFor("event")
    harness.transport.emit(completed())
    await tick()
    expect(harness.parent.messages.filter((message) => message.type === "event")).toHaveLength(1)

    harness.child.complete(0)
    await pending
    expect(harness.parent.messages.map((message) => message.type)).toEqual(["accepted", "event", "event", "closed"])
    expect(harness.calls).toEqual([
      "verify-runtime",
      "prepare-policy",
      "initialize",
      "verify-dependencies",
      "verify-policy",
      "wrap",
      "spawn",
      "sweep",
      "cleanup",
      "reset",
    ])
    expect(harness.transport.closed).toBe(1)
    expect(harness.parent.disconnects).toBe(1)
    expect(harness.parent.listenerCount()).toBe(0)
    expect(harness.child.listenerCount()).toBe(0)
  })

  test("accepts no second launch and emits one terminal failure and one closed", async () => {
    const harness = makeHarness()
    const pending = DocumentProxy.startProxy(harness.dependencies)
    harness.parent.emit(launch())
    await harness.parent.waitFor("accepted")
    harness.parent.emit(launch())
    await pending

    expect(types(harness)).toEqual(["accepted", "failure", "closed"])
    expect(failureOf(harness)).toMatchObject({ code: "protocol-mismatch", stage: "transport", jobID })
    expect(harness.terminations).toBe(1)
    expect(harness.manager.cleanupCalls).toBe(1)
    expect(harness.manager.resetCalls).toBe(1)
  })

  test.each([
    [{ nope: true }, "invalid-launch"],
    [{ ...launch(), protocolVersion: 2 }, "protocol-mismatch"],
    [{ ...launch(), extra: "not-allowed" }, "invalid-launch"],
  ] as const)("rejects a malformed first message with a closed null-job response", async (input, code) => {
    const harness = makeHarness()
    const pending = DocumentProxy.startProxy(harness.dependencies)
    harness.parent.emit(input)
    await pending

    expect(types(harness)).toEqual(["failure", "closed"])
    expect(failureOf(harness)).toMatchObject({ code, jobID: null })
    expect(closedOf(harness)).toMatchObject({
      treeContained: true,
      managerInitialized: false,
      cleanupCalls: 0,
      cleanupCompleted: false,
      resetCalls: 0,
      resetCompleted: false,
    })
    expect(harness.spawnCalls).toHaveLength(0)
  })

  test("accepts an outer message at exactly 64 KiB and rejects one byte more", async () => {
    const exactHarness = makeHarness()
    const exact = sizedLaunch(DocumentRuntimeLimits.MaxOuterIpcMessageBytes)
    const exactPending = DocumentProxy.startProxy(exactHarness.dependencies)
    exactHarness.parent.emit(exact)
    await exactHarness.parent.waitFor("accepted")
    exactHarness.transport.emit(started())
    exactHarness.transport.emit(completed())
    exactHarness.child.complete(0)
    await exactPending
    expect(types(exactHarness)).toEqual(["accepted", "event", "event", "closed"])

    const overflowHarness = makeHarness()
    const overflowPending = DocumentProxy.startProxy(overflowHarness.dependencies)
    overflowHarness.parent.emit(sizedLaunch(DocumentRuntimeLimits.MaxOuterIpcMessageBytes + 1))
    await overflowPending
    expect(failureOf(overflowHarness)).toMatchObject({
      code: "transport-overflow",
      stage: "transport",
      jobID: null,
    })
  })

  test("bounds a backpressured inner command queue without dropping the overflow", async () => {
    const harness = makeHarness()
    const pending = DocumentProxy.startProxy(harness.dependencies)
    harness.parent.emit(renderLaunch())
    await harness.parent.waitFor("accepted")
    harness.transport.block = true
    harness.transport.emit(renderStarted())
    harness.transport.emit(pageReady())
    await waitUntil(() =>
      harness.parent.messages.some((message) => message.type === "event" && message.event.type === "page-ready"),
    )
    harness.parent.emit(ocrCommand())
    await waitUntil(() => harness.transport.sent.length === 2)
    for (let index = 0; index < DocumentRuntimeLimits.MaxOuterPendingMessages; index++) {
      harness.parent.emit({ protocolVersion: 1, type: "cancel", jobID })
    }
    await tick()
    expect(failureMessages(harness)).toHaveLength(0)
    harness.parent.emit({ protocolVersion: 1, type: "cancel", jobID })
    await pending

    expect(failureOf(harness)).toMatchObject({ code: "transport-overflow", stage: "transport" })
    expect(harness.transport.closed).toBe(1)
  })

  test("forwards one cooperative cancellation then sweeps after cooperative exit", async () => {
    const timers = manualTimers()
    const harness = makeHarness({ timers })
    const pending = DocumentProxy.startProxy(harness.dependencies)
    harness.parent.emit(launch())
    await harness.parent.waitFor("accepted")
    harness.parent.emit({ protocolVersion: 1, type: "cancel", jobID })
    await waitUntil(() => harness.transport.sent.length === 2)
    expect(harness.transport.sent[1]).toEqual({ protocolVersion: 1, type: "cancel", jobID })
    harness.transport.emit(cancelled())
    expect(types(harness)).toEqual(["accepted"])
    harness.child.complete(0)
    await pending

    expect(types(harness)).toEqual(["accepted", "event", "closed"])
    expect(harness.parent.messages[1]).toMatchObject({ type: "event", event: { type: "cancelled" } })
    expect(harness.terminations).toBe(1)
    expect(timers.active).toBe(0)
  })

  test("hard-reaps after cooperative cancellation grace expires", async () => {
    const timers = manualTimers()
    const harness = makeHarness({ timers })
    const pending = DocumentProxy.startProxy(harness.dependencies)
    harness.parent.emit(launch())
    await harness.parent.waitFor("accepted")
    harness.parent.emit({ protocolVersion: 1, type: "cancel", jobID })
    await waitUntil(() => timers.active === 1)
    timers.fire()
    await pending

    expect(harness.terminations).toBe(1)
    expect(failureOf(harness)).toMatchObject({ code: "worker-crashed", stage: "worker" })
    expect(harness.transport.sent.filter((message) => isRecord(message) && message.type === "cancel")).toHaveLength(1)
    expect(timers.active).toBe(0)
  })

  test("aborts SRT wrapping when cancellation arrives before bootstrap spawn", async () => {
    const harness = makeHarness({ wrapWaitForAbort: true })
    const pending = DocumentProxy.startProxy(harness.dependencies)
    harness.parent.emit(launch())
    await waitUntil(() => harness.calls.includes("wrap"))
    harness.parent.emit({ protocolVersion: 1, type: "cancel", jobID })
    await pending

    expect(harness.wrapAborted).toBe(true)
    expect(harness.spawnCalls).toHaveLength(0)
    expect(types(harness)).toEqual(["failure", "closed"])
    expect(failureOf(harness)).toMatchObject({ code: "worker-crashed", stage: "worker" })
    expect(harness.manager.cleanupCalls).toBe(1)
    expect(harness.manager.resetCalls).toBe(1)
  })

  test.each(["verify-runtime", "prepare-policy", "initialize", "verify-dependencies", "verify-policy"] as const)(
    "latches cancellation while %s is pending and does not enter the next startup stage",
    async (stage) => {
      const gate = startupGate(stage)
      const harness = makeHarness({ startupGate: gate })
      const pending = DocumentProxy.startProxy(harness.dependencies)
      harness.parent.emit(launch())
      await gate.entered
      harness.parent.emit({ protocolVersion: 1, type: "cancel", jobID })
      gate.release()
      await pending

      expect(types(harness)).toEqual(["failure", "closed"])
      expect(failureOf(harness)).toMatchObject({ code: "worker-crashed", stage: "worker" })
      expect(harness.spawnCalls).toHaveLength(0)
      expect(harness.calls).not.toContain(nextStartupStage(stage))
    },
  )

  test("checks a cancellation latched after wrapping before spawn", async () => {
    const harness = makeHarness({ cancelDuringApply: true })
    const pending = DocumentProxy.startProxy(harness.dependencies)
    harness.parent.emit(launch())
    await pending

    expect(harness.spawnCalls).toHaveLength(0)
    expect(failureOf(harness)).toMatchObject({ code: "worker-crashed", stage: "worker" })
  })

  test("hard-reaps on parent disconnect and releases every registered listener", async () => {
    const harness = makeHarness()
    const pending = DocumentProxy.startProxy(harness.dependencies)
    harness.parent.emit(launch())
    await harness.parent.waitFor("accepted")
    harness.parent.drop()
    await pending

    expect(harness.terminations).toBe(1)
    expect(harness.parent.messages).toEqual([{ protocolVersion: 1, type: "accepted", jobID }])
    expect(harness.manager.cleanupCalls).toBe(1)
    expect(harness.manager.resetCalls).toBe(1)
    expect(harness.parent.listenerCount()).toBe(0)
    expect(harness.child.listenerCount()).toBe(0)
  })
})

describe("document confinement proxy failure boundaries", () => {
  test.each([
    [
      "runtime verification",
      { verifyRuntime: async () => Promise.reject(new Error("runtime /secret canary")) },
      "sandbox-unavailable",
      false,
    ],
    [
      "policy preparation",
      { preparePolicy: async () => ({ status: "unavailable" as const, code: "invalid-path" as const }) },
      "sandbox-unavailable",
      false,
    ],
    ["initialization", { managerMode: "initialize" }, "sandbox-unavailable", true],
    ["dependency checks", { dependencyFailure: true }, "dependency-failed", true],
    ["effective policy inspection", { policyFailure: true }, "sandbox-unavailable", true],
    ["command wrapping", { managerMode: "wrap" }, "spawn-failed", true],
    ["spawn", { spawnFailure: true }, "spawn-failed", true],
    ["missing bounded pipe", { missingPipe: true }, "spawn-failed", true],
    ["transport construction", { transportFailure: true }, "spawn-failed", true],
  ] as const)("fails closed at %s without exposing causes", async (_name, options, code, initialized) => {
    const harness = makeHarness(options)
    const pending = DocumentProxy.startProxy(harness.dependencies)
    harness.parent.emit(launch())
    await pending

    expect(types(harness)).toEqual(["failure", "closed"])
    expect(failureOf(harness).code).toBe(code)
    const output = JSON.stringify(harness.parent.messages)
    expect(output).not.toContain("secret")
    expect(output).not.toContain("canary")
    expect(output).not.toContain("/runtime")
    expect(output).not.toContain("/jobs")
    expect(harness.manager.cleanupCalls).toBe(initialized ? 1 : 0)
    expect(harness.manager.resetCalls).toBe(initialized ? 1 : 0)
    expect(closedOf(harness)).toMatchObject(
      initialized
        ? { managerInitialized: true, cleanupCalls: 1, resetCalls: 1 }
        : { managerInitialized: false, cleanupCalls: 0, resetCalls: 0 },
    )
  })

  test.each([
    ["malformed output", { nope: "document-byte-canary" }],
    ["excess output field", { ...started(), stderr: "native-secret-canary" }],
    ["out-of-order output", completed()],
    [
      "wrong job",
      { ...started(), jobID: DocumentRuntimeProtocol.JobID.make("job_00000000-0000-4000-8000-000000000002") },
    ],
  ] as const)("rejects %s and emits only curated transport output", async (_name, event) => {
    const harness = makeHarness()
    const pending = DocumentProxy.startProxy(harness.dependencies)
    harness.parent.emit(launch())
    await harness.parent.waitFor("accepted")
    harness.transport.emit(event)
    await pending

    expect(types(harness)).toEqual(["accepted", "failure", "closed"])
    expect(failureOf(harness)).toMatchObject({ code: "protocol-mismatch", stage: "transport", jobID })
    expect(JSON.stringify(harness.parent.messages)).not.toContain("canary")
  })

  test("accepts exactly 64 KiB of stderr and rejects the next byte without relaying diagnostics", async () => {
    const harness = makeHarness()
    const pending = DocumentProxy.startProxy(harness.dependencies)
    harness.parent.emit(launch())
    await harness.parent.waitFor("accepted")
    harness.child.stderr.write(Buffer.alloc(DocumentRuntimeLimits.MaxInnerStderrBytes, 0x78))
    await tick()
    expect(types(harness)).toEqual(["accepted"])
    harness.child.stderr.write(Buffer.from("s"))
    await pending

    expect(failureOf(harness)).toMatchObject({ code: "transport-overflow", stage: "transport" })
    expect(JSON.stringify(harness.parent.messages)).not.toContain("xxx")
  })

  test("accepts an exact 16 KiB NDJSON line and rejects a line one byte larger", async () => {
    const exact = makeHarness({ createTransport: createNodeStreamTransport })
    const exactPending = DocumentProxy.startProxy(exact.dependencies)
    exact.parent.emit(launch())
    await exact.parent.waitFor("accepted")
    exact.child.stdout.write(frameAtSize(started(), DocumentRuntimeLimits.MaxNdjsonLineBytes))
    await exact.parent.waitFor("event")
    exact.child.stdout.write(Buffer.from(`${JSON.stringify(completed())}\n`))
    await tick()
    exact.child.complete(0)
    await exactPending
    expect(types(exact)).toEqual(["accepted", "event", "event", "closed"])

    const overflow = makeHarness({ createTransport: createNodeStreamTransport })
    const overflowPending = DocumentProxy.startProxy(overflow.dependencies)
    overflow.parent.emit(launch())
    await overflow.parent.waitFor("accepted")
    overflow.child.stdout.write(frameAtSize(started(), DocumentRuntimeLimits.MaxNdjsonLineBytes + 1))
    await overflowPending
    expect(failureOf(overflow)).toMatchObject({ code: "transport-overflow", stage: "transport" })
  })

  test("accepts the exact unterminated buffer bound and rejects the next byte", async () => {
    const harness = makeHarness({ createTransport: createNodeStreamTransport })
    const pending = DocumentProxy.startProxy(harness.dependencies)
    harness.parent.emit(launch())
    await harness.parent.waitFor("accepted")
    harness.child.stdout.write(Buffer.alloc(DocumentRuntimeLimits.MaxNdjsonUnterminatedBytes, 0x20))
    await tick()
    expect(failureMessages(harness)).toHaveLength(0)
    harness.child.stdout.write(Buffer.from("x"))
    await pending
    expect(failureOf(harness)).toMatchObject({ code: "transport-overflow", stage: "transport" })
  })

  test("allows only clean EOF after a provisional terminal event", async () => {
    const harness = makeHarness({ createTransport: createNodeStreamTransport })
    const pending = DocumentProxy.startProxy(harness.dependencies)
    harness.parent.emit(launch())
    await harness.parent.waitFor("accepted")
    harness.child.stdout.write(Buffer.from(`${JSON.stringify(started())}\n${JSON.stringify(completed())}\n`))
    await harness.parent.waitFor("event")
    harness.child.stdout.end()
    await tick()
    expect(failureMessages(harness)).toHaveLength(0)
    harness.child.complete(0)
    await pending
    expect(types(harness)).toEqual(["accepted", "event", "event", "closed"])
  })

  test.each(["malformed", "overflow", "unterminated", "error"] as const)(
    "replaces a provisional terminal event after %s stdout",
    async (mode) => {
      const harness = makeHarness({ createTransport: createNodeStreamTransport })
      const pending = DocumentProxy.startProxy(harness.dependencies)
      harness.parent.emit(launch())
      await harness.parent.waitFor("accepted")
      harness.child.stdout.write(Buffer.from(`${JSON.stringify(started())}\n${JSON.stringify(completed())}\n`))
      await harness.parent.waitFor("event")
      await tick()
      if (mode === "malformed") harness.child.stdout.write(Buffer.from("{document-byte-canary}\n"))
      if (mode === "overflow") {
        harness.child.stdout.write(frameAtSize(started(), DocumentRuntimeLimits.MaxNdjsonLineBytes + 1))
      }
      if (mode === "unterminated") harness.child.stdout.end("{document-byte-canary")
      if (mode === "error") harness.child.stdout.emit("error", new Error("stdout-path-canary"))
      await pending

      expect(failureOf(harness)).toMatchObject({ code: "transport-overflow", stage: "transport" })
      expect(JSON.stringify(harness.parent.messages)).not.toContain("canary")
    },
  )

  test("rejects dependency warnings through the Phase 3 strict checker", async () => {
    const harness = makeHarness({
      managerWarnings: ["seccomp unavailable at /private/helper-canary"],
      verifyDependencies: DocumentSandboxPolicy.verifyDependencies,
    })
    const pending = DocumentProxy.startProxy(harness.dependencies)
    harness.parent.emit(launch())
    await pending

    expect(failureOf(harness)).toMatchObject({ code: "dependency-failed", stage: "dependency" })
    expect(JSON.stringify(harness.parent.messages)).not.toContain("helper-canary")
  })

  test("maps child crashes to a curated failure after observed exit", async () => {
    const harness = makeHarness()
    const pending = DocumentProxy.startProxy(harness.dependencies)
    harness.parent.emit(launch())
    await harness.parent.waitFor("accepted")
    harness.child.complete(7)
    await pending

    expect(failureOf(harness)).toMatchObject({ code: "worker-crashed", stage: "worker" })
    expect(harness.terminations).toBe(1)
  })

  test.each([
    [7, null],
    [null, "SIGTERM"],
  ] as const)("replaces provisional success after a non-clean leader exit", async (code, signal) => {
    const harness = makeHarness()
    const pending = DocumentProxy.startProxy(harness.dependencies)
    harness.parent.emit(launch())
    await harness.parent.waitFor("accepted")
    harness.transport.emit(started())
    harness.transport.emit(completed())
    harness.child.complete(code, signal)
    await pending

    expect(failureOf(harness)).toMatchObject({ code: "worker-crashed", stage: "worker" })
    expect(harness.terminations).toBe(1)
  })

  test("treats a spawned process without a PID as confirmed absence and still resets SRT", async () => {
    const harness = makeHarness({ missingPid: true })
    const pending = DocumentProxy.startProxy(harness.dependencies)
    harness.parent.emit(launch())
    await pending

    expect(failureOf(harness)).toMatchObject({ code: "spawn-failed", stage: "spawn" })
    expect(harness.terminations).toBe(0)
    expect(harness.manager.cleanupCalls).toBe(1)
    expect(harness.manager.resetCalls).toBe(1)
  })

  test("routes stderr stream errors through guarded teardown and removes the listener", async () => {
    const harness = makeHarness()
    const pending = DocumentProxy.startProxy(harness.dependencies)
    harness.parent.emit(launch())
    await harness.parent.waitFor("accepted")
    harness.transport.emit(started())
    harness.transport.emit(completed())
    harness.child.stderr.emit("error", new Error("stderr-path-canary"))
    await pending

    expect(failureOf(harness)).toMatchObject({ code: "transport-overflow", stage: "transport" })
    expect(JSON.stringify(harness.parent.messages)).not.toContain("canary")
    expect(harness.child.stderr.listenerCount("error")).toBe(0)
  })

  test("rejects duplicate cancellation and sends only one inner cancel", async () => {
    const harness = makeHarness()
    const pending = DocumentProxy.startProxy(harness.dependencies)
    harness.parent.emit(launch())
    await harness.parent.waitFor("accepted")
    harness.parent.emit({ protocolVersion: 1, type: "cancel", jobID })
    await waitUntil(() => harness.transport.sent.length === 2)
    harness.parent.emit({ protocolVersion: 1, type: "cancel", jobID })
    await pending

    expect(failureOf(harness)).toMatchObject({ code: "protocol-mismatch" })
    expect(harness.transport.sent.filter((message) => isRecord(message) && message.type === "cancel")).toHaveLength(1)
  })
})

describe("document confinement proxy teardown precedence", () => {
  test("command cleanup replaces provisional worker success", async () => {
    const harness = makeHarness({ managerMode: "cleanup" })
    const pending = successfulRun(harness)
    await pending

    expect(types(harness)).toEqual(["accepted", "event", "failure", "closed"])
    expect(failureOf(harness)).toMatchObject({ code: "command-cleanup-failed", stage: "command-cleanup" })
    expect(harness.manager.cleanupCalls).toBe(1)
    expect(harness.manager.resetCalls).toBe(1)
    expect(closedOf(harness)).toMatchObject({
      managerInitialized: true,
      cleanupCalls: 1,
      cleanupCompleted: false,
      resetCalls: 1,
      resetCompleted: true,
    })
  })

  test("reset failure has precedence over command cleanup failure", async () => {
    const harness = makeHarness({ managerMode: "cleanup-reset" })
    const pending = successfulRun(harness)
    await pending

    expect(failureOf(harness)).toMatchObject({ code: "reset-failed", stage: "reset" })
    expect(harness.manager.cleanupCalls).toBe(1)
    expect(harness.manager.resetCalls).toBe(1)
    expect(closedOf(harness)).toMatchObject({
      managerInitialized: true,
      cleanupCalls: 1,
      cleanupCompleted: false,
      resetCalls: 1,
      resetCompleted: false,
    })
  })

  test("unconfirmed hard termination has highest precedence and does not reset around a live child", async () => {
    const harness = makeHarness({ terminationFailure: true, managerMode: "cleanup-reset" })
    const pending = DocumentProxy.startProxy(harness.dependencies)
    harness.parent.emit(launch())
    await harness.parent.waitFor("accepted")
    harness.transport.emit({ nope: true })
    await pending

    expect(failureOf(harness)).toMatchObject({ code: "termination-failed", stage: "termination" })
    expect(harness.manager.cleanupCalls).toBe(0)
    expect(harness.manager.resetCalls).toBe(0)
  })

  test("requires a containment sweep after clean leader exit before SRT teardown", async () => {
    const harness = makeHarness({ terminationFailure: true })
    const pending = DocumentProxy.startProxy(harness.dependencies)
    harness.parent.emit(launch())
    await harness.parent.waitFor("accepted")
    harness.transport.emit(started())
    harness.transport.emit(completed())
    harness.child.complete(0)
    await pending

    expect(failureOf(harness)).toMatchObject({ code: "termination-failed", stage: "termination" })
    expect(harness.terminations).toBe(1)
    expect(harness.manager.cleanupCalls).toBe(0)
    expect(harness.manager.resetCalls).toBe(0)
  })

  test("withholds SRT teardown when Windows tree-empty evidence is missing", async () => {
    const harness = makeHarness({
      sweepProcessTree: async () => ({
        status: "evidence-required",
        code: "windows-tree-evidence-required",
      }),
    })
    const pending = DocumentProxy.startProxy(harness.dependencies)
    harness.parent.emit(launch())
    await harness.parent.waitFor("accepted")
    harness.transport.emit(started())
    harness.transport.emit(completed())
    harness.child.complete(0)
    await pending

    expect(failureOf(harness)).toMatchObject({ code: "termination-failed", stage: "termination" })
    expect(harness.manager.cleanupCalls).toBe(0)
    expect(harness.manager.resetCalls).toBe(0)
  })

  test("maps a throwing tree terminator to the highest-priority curated failure", async () => {
    const harness = makeHarness({ terminationThrows: true })
    const pending = DocumentProxy.startProxy(harness.dependencies)
    harness.parent.emit(launch())
    await harness.parent.waitFor("accepted")
    harness.transport.emit({ nope: true })
    await pending

    expect(failureOf(harness)).toMatchObject({ code: "termination-failed", stage: "termination" })
    expect(JSON.stringify(harness.parent.messages)).not.toContain("tree-kill-canary")
  })

  test("bounds the combined command cleanup and reset phase", async () => {
    const timers = manualTimers()
    const harness = makeHarness({ timers, resetPending: true })
    const pending = successfulRun(harness)
    await waitUntil(() => timers.active === 1)
    timers.fire()
    await pending

    expect(failureOf(harness)).toMatchObject({ code: "reset-failed", stage: "reset" })
    expect(harness.manager.cleanupCalls).toBe(1)
    expect(harness.manager.resetCalls).toBe(1)
    expect(timers.active).toBe(0)
  })

  test("emits closed once when child and teardown signals race", async () => {
    const harness = makeHarness()
    const pending = DocumentProxy.startProxy(harness.dependencies)
    harness.parent.emit(launch())
    await harness.parent.waitFor("accepted")
    harness.transport.emit(started())
    harness.transport.emit(completed())
    harness.child.complete(0)
    harness.child.emitter.emit("error", new Error("late raw canary"))
    await pending

    expect(harness.parent.messages.filter((message) => message.type === "closed")).toHaveLength(1)
    expect(harness.manager.cleanupCalls).toBe(1)
    expect(harness.manager.resetCalls).toBe(1)
  })
})

type HarnessOptions = Partial<ProxyDependencies> & {
  readonly managerMode?: "initialize" | "wrap" | "cleanup" | "reset" | "cleanup-reset"
  readonly dependencyFailure?: boolean
  readonly policyFailure?: boolean
  readonly spawnFailure?: boolean
  readonly missingPipe?: boolean
  readonly terminationFailure?: boolean
  readonly terminationThrows?: boolean
  readonly transportFailure?: boolean
  readonly managerWarnings?: ReadonlyArray<string>
  readonly resetPending?: boolean
  readonly wrapWaitForAbort?: boolean
  readonly wrappedArgv?: ReadonlyArray<string>
  readonly startupGate?: ReturnType<typeof startupGate>
  readonly cancelDuringApply?: boolean
  readonly missingPid?: boolean
}

function makeHarness(options: HarnessOptions = {}) {
  const calls: string[] = []
  const parent = new FakeParent()
  const child = fakeChild(options.missingPipe, options.missingPid)
  const transport = new FakeTransport()
  const spawnCalls: Array<{ executable: string; args: ReadonlyArray<string>; options: SpawnOptions }> = []
  let activeConfig: SandboxRuntimeConfig | undefined
  let wrapAborted = false
  const manager = {
    cleanupCalls: 0,
    resetCalls: 0,
    isSupportedPlatform: () => true,
    checkDependenciesAsync: async () => ({ errors: [], warnings: options.managerWarnings ?? [] }),
    initialize: async (config: SandboxRuntimeConfig) => {
      calls.push("initialize")
      await options.startupGate?.wait("initialize")
      activeConfig = config
      if (options.managerMode === "initialize") throw new Error("private env canary")
    },
    wrapWithSandboxArgv: async (
      _command: string,
      _binShell?: string | { readonly exe: string; readonly args: ReadonlyArray<string> },
      _config?: Partial<SandboxRuntimeConfig>,
      signal?: AbortSignal,
    ) => {
      calls.push("wrap")
      if (options.managerMode === "wrap") throw new Error("private path canary")
      if (options.wrapWaitForAbort) {
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              wrapAborted = true
              reject(new Error("wrap aborted"))
            },
            { once: true },
          )
        })
      }
      return {
        argv: [...(options.wrappedArgv ?? ["/sandboxed/node", "--fixed", "/runtime/worker/bootstrap.js"])],
        env: { inherited: "discard" },
      }
    },
    cleanupAfterCommand: () => {
      calls.push("cleanup")
      manager.cleanupCalls++
      if (options.managerMode === "cleanup" || options.managerMode === "cleanup-reset") {
        throw new Error("native cleanup /secret canary")
      }
    },
    reset: async () => {
      calls.push("reset")
      manager.resetCalls++
      if (options.resetPending) await new Promise<void>(() => undefined)
      if (options.managerMode === "reset" || options.managerMode === "cleanup-reset") {
        throw new Error("native reset /secret canary")
      }
    },
    getConfig: () => activeConfig,
    getFsReadConfig: () => ({ denyOnly: [], allowWithinDeny: [] }),
    getFsWriteConfig: () => ({ allowOnly: [], denyWithinAllow: [] }),
    getNetworkRestrictionConfig: () => ({ allowedHosts: [], deniedHosts: [] }),
    getAllowUnixSockets: () => [],
    getAllowLocalBinding: () => false,
    getAllowMachLookup: () => [],
  }
  let terminations = 0
  const dependencies: ProxyDependencies = {
    manager,
    parent,
    platform: "linux",
    architecture: "x64",
    executablePath: "/host/node",
    sandboxAssetsRoot: "/sandbox",
    verifyRuntime: async (root, target) => {
      calls.push("verify-runtime")
      await options.startupGate?.wait("verify-runtime")
      return { root, manifestSha256: digest, manifest: { target } }
    },
    preparePolicy: async (input) => {
      calls.push("prepare-policy")
      await options.startupGate?.wait("prepare-policy")
      return { status: "available", value: preparedPolicy(input) }
    },
    verifyDependencies: async () => {
      calls.push("verify-dependencies")
      await options.startupGate?.wait("verify-dependencies")
      return options.dependencyFailure
        ? { status: "unavailable", code: "sandbox-dependency-unavailable" }
        : { status: "available", value: undefined }
    },
    verifyEffectivePolicy: async () => {
      calls.push("verify-policy")
      await options.startupGate?.wait("verify-policy")
      return options.policyFailure
        ? { status: "unavailable", code: "sandbox-policy-mismatch" }
        : { status: "available", value: undefined }
    },
    applyHandoffEnvironment: (wrapped) => {
      if (options.cancelDuringApply) parent.emit({ protocolVersion: 1, type: "cancel", jobID })
      return { argv: [...wrapped.argv], env: { DOCUMENT_JOB_ROOT: "/jobs/one" } }
    },
    spawnCommand: (executable, args, spawnOptions) => {
      calls.push("spawn")
      if (options.spawnFailure) throw new Error("spawn /private/path canary")
      spawnCalls.push({ executable, args, options: spawnOptions })
      return child.process
    },
    createTransport: () => {
      if (options.transportFailure) throw new Error("transport /private/path canary")
      return transport
    },
    createOutputReceiver: () => ({
      handle: async (message) =>
        message.type === "output-start" || message.type === "output-chunk" || message.type === "output-end"
          ? undefined
          : message,
      release: async () => true,
      cleanup: async () => undefined,
    }),
    writeReceipt: async (_evidence, payload) => ({ ...payload, receiptSha256: digest }),
    sweepProcessTree: async () => {
      terminations++
      calls.push("sweep")
      if (options.terminationThrows) throw new Error("tree-kill-canary")
      if (options.terminationFailure) return { status: "unavailable", code: "exit-not-observed" }
      child.complete(null, "SIGKILL")
      return { status: "exited", exit: { code: null, signal: "SIGKILL" } }
    },
    timers: options.timers ?? realTimers(),
    cancellationGraceMs: 20,
    teardownTimeoutMs: 20,
    ...options,
  }
  return {
    dependencies,
    parent,
    child,
    transport,
    manager,
    calls,
    spawnCalls,
    get terminations() {
      return terminations
    },
    get timers() {
      return dependencies.timers as ReturnType<typeof manualTimers>
    },
    get wrapAborted() {
      return wrapAborted
    },
  }
}

function preparedPolicy(input: Parameters<typeof DocumentSandboxPolicy.prepare>[0]): PreparedPolicy {
  const target = "x86_64-unknown-linux-gnu" as const
  const sandboxAssets = DocumentSandboxPolicy.resolveSandboxAssets("/sandbox", target)
  const hostHelpers = {
    shell: { path: "/bin/sh", identity: "shell" },
    bwrap: { path: "/usr/bin/bwrap", identity: "bwrap" },
    socat: { path: "/usr/bin/socat", identity: "socat" },
    ripgrep: { path: "/usr/bin/rg", identity: "ripgrep" },
  }
  return {
    target,
    runtimeRoot: input.runtimeRoot,
    parentRoot: input.parentRoot,
    parentIdentity: input.parentIdentity,
    parentMode: input.parentMode,
    jobRoot: input.jobRoot,
    jobRootIdentity: input.jobRootIdentity,
    pendingRoot: input.pendingRoot,
    pendingRootIdentity: input.pendingRootIdentity,
    sandboxAssets,
    runtimeAssets: DocumentSandboxPolicy.resolveRuntimeAssets(input.runtimeRoot, target),
    executablePath: "/host/node",
    hostHelpers,
    config: DocumentSandboxPolicy.buildConfig({
      target,
      runtimeRoot: input.runtimeRoot,
      jobRoot: input.jobRoot,
      pendingRoot: input.pendingRoot,
      executablePath: "/host/node",
      sandboxAssets,
      hostHelpers,
      environment: { HOME: "/home/broker" },
    }),
    command: { command: "fixed-bootstrap", binShell: "/bin/sh" },
    brokerEnvironment: { PATH: "/usr/bin:/bin" },
    handoffEnvironment: { DOCUMENT_JOB_ROOT: input.jobRoot },
  }
}

class FakeParent implements ParentPort {
  readonly messages: DocumentSandboxProtocol.ProxyEvent[] = []
  disconnects = 0
  private readonly emitter = new EventEmitter()
  private live = true

  connected = () => this.live
  onMessage = (listener: (input: unknown) => void) => void this.emitter.on("message", listener)
  offMessage = (listener: (input: unknown) => void) => void this.emitter.off("message", listener)
  onDisconnect = (listener: () => void) => void this.emitter.on("disconnect", listener)
  offDisconnect = (listener: () => void) => void this.emitter.off("disconnect", listener)
  send = (value: unknown, callback: (error: Error | null) => void) => {
    this.messages.push(DocumentSandboxProtocol.decodeProxyEvent(value))
    queueMicrotask(() => callback(null))
    return true
  }
  disconnect = () => {
    this.disconnects++
    this.live = false
  }
  emit(input: unknown) {
    this.emitter.emit("message", input)
  }
  drop() {
    this.live = false
    this.emitter.emit("disconnect")
  }
  listenerCount() {
    return this.emitter.listenerCount("message") + this.emitter.listenerCount("disconnect")
  }
  async waitFor(type: DocumentSandboxProtocol.ProxyEvent["type"]) {
    await waitUntil(() => this.messages.some((message) => message.type === type))
  }
}

class FakeTransport implements NodeStreamTransport {
  readonly sent: unknown[] = []
  readonly bound = { message: false, disconnect: false }
  closed = 0
  block = false
  private messageListener: ((input: unknown) => void) | undefined
  private disconnectListener: ((error?: TransportError) => void) | undefined
  private readonly pending: Array<{ readonly resolve: () => void; readonly reject: (error: Error) => void }> = []

  onMessage(listener: (input: unknown) => void) {
    this.bound.message = true
    this.messageListener = listener
  }
  onDisconnect(listener: (error?: TransportError) => void) {
    this.bound.disconnect = true
    this.disconnectListener = listener
  }
  async send(value: unknown) {
    this.sent.push(JSON.parse(JSON.stringify(value)))
    if (this.block) {
      await new Promise<void>((resolve, reject) => this.pending.push({ resolve, reject }))
    }
  }
  close() {
    this.closed++
    for (const pending of this.pending.splice(0)) pending.reject(new Error("closed"))
    this.messageListener = undefined
    this.disconnectListener = undefined
  }
  emit(input: unknown) {
    this.messageListener?.(input)
  }
  release() {
    for (const pending of this.pending.splice(0)) pending.resolve()
  }
}

function fakeChild(missingPipe = false, missingPid = false) {
  const emitter = new EventEmitter()
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const raw = Object.assign(emitter, {
    pid: missingPid ? undefined : 1234,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stdin: missingPipe ? null : stdin,
    stdout,
    stderr,
    kill: () => true,
  })
  const processValue = raw as unknown as ProxyChild
  let completed = false
  return {
    process: processValue,
    emitter,
    stderr,
    stdout,
    complete(code: number | null, signal: NodeJS.Signals | null = null) {
      if (completed) return
      completed = true
      raw.exitCode = code
      raw.signalCode = signal
      emitter.emit("exit", code, signal)
      emitter.emit("close", code, signal)
    },
    listenerCount() {
      return (
        emitter.listenerCount("error") +
        emitter.listenerCount("exit") +
        emitter.listenerCount("close") +
        stderr.listenerCount("data") +
        stderr.listenerCount("error")
      )
    },
  }
}

function launch(overrides: Record<string, unknown> = {}) {
  const jobRoot = typeof overrides.jobRoot === "string" ? overrides.jobRoot : "/jobs/one"
  return DocumentSandboxProtocol.decodeParentRequest({
    protocolVersion: 1,
    type: "launch",
    jobID,
    target: "x86_64-unknown-linux-gnu",
    runtimeRoot: "/runtime",
    manifestSha256: digest,
    parentRoot: pathForTest(jobRoot).dirname(jobRoot),
    parentIdentity: { dev: "1", ino: "1" },
    parentMode: process.platform === "win32" ? null : 0o500,
    jobRoot,
    jobRootIdentity: { dev: "1", ino: "2" },
    pendingRoot: pathForTest(jobRoot).join(pathForTest(jobRoot).dirname(jobRoot), "pending"),
    pendingRootIdentity: { dev: "1", ino: "3" },
    receiptNonce: "b".repeat(64),
    start: {
      protocolVersion: 1,
      type: "probe",
      jobID,
      target: "x86_64-unknown-linux-gnu",
      manifestSha256: digest,
    },
    ...overrides,
  }) as Extract<DocumentSandboxProtocol.ParentRequest, { readonly type: "launch" }>
}

function pathForTest(value: string) {
  return /^[A-Za-z]:\\/.test(value) ? path.win32 : path.posix
}

function sizedLaunch(bytes: number) {
  const base = launch({ runtimeRoot: "/" })
  const size = Buffer.byteLength(JSON.stringify(base))
  const value = launch({ runtimeRoot: `/${"r".repeat(bytes - size)}` })
  expect(Buffer.byteLength(JSON.stringify(value))).toBe(bytes)
  return value
}

function started() {
  return DocumentRuntimeProtocol.decodeWorkerEvent({
    protocolVersion: 1,
    type: "started",
    jobID,
    operation: "probe",
  })
}

function completed() {
  return DocumentRuntimeProtocol.decodeWorkerEvent({
    protocolVersion: 1,
    type: "completed",
    jobID,
    operation: "probe",
    pagesProcessed: 0,
    temporaryBytes: 0,
  })
}

function renderLaunch(overrides: Record<string, unknown> = {}) {
  return launch({
    start: {
      protocolVersion: 1,
      type: "render",
      jobID,
      inputPath: "input/document.pdf",
      inputBytes: 1,
      startPage: 1,
      pageCount: 1,
      limits: DocumentRuntimeLimits.requestedHard,
    },
    ...overrides,
  })
}

function renderStarted() {
  return DocumentRuntimeProtocol.decodeWorkerEvent({
    protocolVersion: 1,
    type: "started",
    jobID,
    operation: "render",
  })
}

function pageReady(overrides: Record<string, unknown> = {}) {
  return DocumentRuntimeProtocol.decodeWorkerEvent({
    protocolVersion: 1,
    type: "page-ready",
    jobID,
    page: 1,
    pageID: "page_00000000-0000-4000-8000-000000000001",
    outputPath: "pages/one.png",
    outputID,
    outputSha256: digest,
    dimensions: { width: 1, height: 1 },
    pngBytes: 1,
    temporaryBytes: 1,
    ...overrides,
  })
}

function outputStart(declaredBytes: number) {
  return DocumentRuntimeProtocol.decodeWorkerOutput({
    protocolVersion: 1,
    type: "output-start",
    jobID,
    outputID,
    kind: "page-png",
    page: 1,
    pageID: "page_00000000-0000-4000-8000-000000000001",
    sourcePath: "pages/one.png",
    declaredBytes,
  })
}

function outputChunk(sequence: number, body: Uint8Array) {
  return DocumentRuntimeProtocol.decodeWorkerOutput({
    protocolVersion: 1,
    type: "output-chunk",
    jobID,
    outputID,
    sequence,
    data: DocumentRuntimeProtocol.encodeCanonicalBase64(body),
  })
}

function outputEnd(chunks: number, actualBytes: number, sha256: string) {
  return DocumentRuntimeProtocol.decodeWorkerOutput({
    protocolVersion: 1,
    type: "output-end",
    jobID,
    outputID,
    chunks,
    actualBytes,
    sha256,
  })
}

function releaseCommand() {
  return DocumentSandboxProtocol.decodeParentRequest({
    protocolVersion: 1,
    type: "command",
    jobID,
    command: {
      protocolVersion: 1,
      type: "release-page",
      jobID,
      page: 1,
      pageID: "page_00000000-0000-4000-8000-000000000001",
    },
  })
}

function renderCompleted() {
  return DocumentRuntimeProtocol.decodeWorkerEvent({
    protocolVersion: 1,
    type: "completed",
    jobID,
    operation: "render",
    pagesProcessed: 1,
    temporaryBytes: 0,
  })
}

function ocrCommand() {
  return DocumentSandboxProtocol.decodeParentRequest({
    protocolVersion: 1,
    type: "command",
    jobID,
    command: {
      protocolVersion: 1,
      type: "ocr",
      jobID,
      page: 1,
      pageID: "page_00000000-0000-4000-8000-000000000001",
      source: { kind: "rendered-page" },
      limits: DocumentRuntimeLimits.requestedHard,
    },
  })
}

function cancelled() {
  return DocumentRuntimeProtocol.decodeWorkerEvent({ protocolVersion: 1, type: "cancelled", jobID })
}

function types(harness: ReturnType<typeof makeHarness>) {
  return harness.parent.messages.map((message) => message.type)
}

function failureOf(harness: ReturnType<typeof makeHarness>) {
  const failure = harness.parent.messages.find((message) => message.type === "failure")
  if (!failure || failure.type !== "failure") throw new Error("missing failure")
  return failure
}

function failureMessages(harness: ReturnType<typeof makeHarness>) {
  return harness.parent.messages.filter((message) => message.type === "failure")
}

function closedOf(harness: ReturnType<typeof makeHarness>) {
  const closed = harness.parent.messages.find((message) => message.type === "closed")
  if (!closed || closed.type !== "closed") throw new Error("missing closure")
  return closed
}

function frameAtSize(value: unknown, bytes: number) {
  const json = JSON.stringify(value)
  const padding = bytes - Buffer.byteLength(json) - 1
  if (padding < 0) throw new Error("frame does not fit")
  return Buffer.from(`${json}${" ".repeat(padding)}\n`)
}

async function successfulRun(harness: ReturnType<typeof makeHarness>) {
  const pending = DocumentProxy.startProxy(harness.dependencies)
  harness.parent.emit(launch())
  await harness.parent.waitFor("accepted")
  harness.transport.emit(started())
  await harness.parent.waitFor("event")
  harness.transport.emit(completed())
  harness.child.complete(0)
  return pending
}

function realTimers() {
  return {
    set: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
    clear: (timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  }
}

function manualTimers() {
  const callbacks = new Map<number, () => void>()
  let next = 0
  return {
    get active() {
      return callbacks.size
    },
    set(callback: () => void) {
      const id = next++
      callbacks.set(id, callback)
      return id
    },
    clear(timer: unknown) {
      callbacks.delete(timer as number)
    },
    fire() {
      for (const callback of [...callbacks.values()]) callback()
    },
  }
}

type StartupStage = "verify-runtime" | "prepare-policy" | "initialize" | "verify-dependencies" | "verify-policy"

function startupGate(stage: StartupStage) {
  const entered = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  return {
    entered: entered.promise,
    release: released.resolve,
    async wait(current: StartupStage) {
      if (current !== stage) return
      entered.resolve()
      await released.promise
    },
  }
}

function nextStartupStage(stage: StartupStage) {
  const stages: ReadonlyArray<string> = [
    "verify-runtime",
    "prepare-policy",
    "initialize",
    "verify-dependencies",
    "verify-policy",
    "wrap",
  ]
  return stages[stages.indexOf(stage) + 1]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 1_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition not reached")
    await tick()
  }
}

async function realRoots() {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "document-proxy-roots-")))
  const job = path.join(parent, "job")
  const pending = path.join(parent, "pending")
  await Promise.all([mkdir(job), mkdir(pending)])
  if (process.platform !== "win32") await chmod(parent, 0o500)
  const [parentInfo, jobInfo, pendingInfo] = await Promise.all(
    [parent, job, pending].map((value) => lstat(value, { bigint: true })),
  )
  return { parent, job, pending, parentInfo, jobInfo, pendingInfo }
}

function wireIdentity(identity: { readonly dev: bigint; readonly ino: bigint }) {
  return { dev: identity.dev.toString(), ino: identity.ino.toString() }
}

function tick() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0))
}
