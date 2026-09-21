import { expect, test } from "bun:test"
import { DocumentRuntimeAttestation } from "@koala-ai/core/document-runtime/attestation"
import { DocumentRuntimeLimits } from "@koala-ai/core/document-runtime/limits"
import { DocumentRuntimeManifest } from "@koala-ai/core/document-runtime/manifest"
import { DocumentRuntimeProtocol } from "@koala-ai/core/document-runtime/protocol"
import { DocumentSandboxProtocol } from "@koala-ai/core/document-runtime/sandbox-protocol"
import { DocumentRuntimeTarget } from "@koala-ai/core/document-runtime/target"
import { loadAndVerifyProductionManifest, loadTrustedAttestation } from "@koala-ai/document-runtime"
import { Deferred, Effect, Fiber, Schema } from "effect"
import { fork } from "node:child_process"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import dgram from "node:dgram"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { DocumentJobRoot } from "@/document/job-root"
import { DocumentPendingRoot } from "@/document/pending-root"
import { DocumentProcess } from "@/document/process"
import { DocumentRuntime } from "@/document/runtime"
import { DocumentSandboxPolicy } from "@/document/sandbox-policy"
import { DocumentTeardownReceipt } from "@/document/teardown-receipt"

const enabled =
  process.env.KOALA_RUN_DOCUMENT_CONFINEMENT_NATIVE === "1" ||
  process.env.KOALA_REQUIRE_DOCUMENT_CONFINEMENT === "1"
const nativeTest = enabled ? test : test.skip
const hostileBootstrap = fileURLToPath(new URL("./confinement-hostile-bootstrap.js", import.meta.url))

nativeTest(
  "proves target-native document confinement and emits evidence only after every hostile probe passes",
  async () => {
    const target = requiredTarget()
    const resourcesRoot = requiredAbsolute("KOALA_DOCUMENT_CONFINEMENT_RESOURCES_ROOT")
    const runtimeRoot = path.join(resourcesRoot, "document-runtime")
    const attestationPath = path.join(resourcesRoot, "document-runtime.attestation.json")
    const sandboxRoot = path.join(resourcesRoot, "sandbox-runtime")
    const proxyPath = path.join(sandboxRoot, "document-runtime-proxy.mjs")
    const reportPath = requiredAbsolute("KOALA_DOCUMENT_CONFINEMENT_NATIVE_REPORT")
    if (process.platform === "win32") {
      throw new Error(
        "Windows native confinement is unavailable until reviewed loader, Job Object, ACL-reset, and WFP evidence is wired into the proxy",
      )
    }

    const attestation = await loadTrustedAttestation(attestationPath)
    const runtime = await loadAndVerifyProductionManifest(runtimeRoot, target, attestation)
    const attestationBytes = await readFile(attestationPath)
    const sandboxManifestBytes = await readFile(path.join(sandboxRoot, "sandbox-runtime.manifest.json"))
    const sandboxManifest = JSON.parse(sandboxManifestBytes.toString("utf8")) as {
      readonly target: string
      readonly files: ReadonlyArray<{ readonly path: string; readonly sha256: string }>
    }
    const proxy = sandboxManifest.files.find((file) => file.path === "document-runtime-proxy.mjs")
    if (!proxy || proxy.sha256 !== sha256(await readFile(proxyPath))) throw new Error("Built document proxy digest mismatch")
    const inventoryPath = requiredAbsolute("KOALA_DOCUMENT_CONFINEMENT_INVENTORY")
    const inventoryBytes = await readFile(inventoryPath)
    const inventory = Schema.decodeUnknownSync(DocumentRuntimeAttestation.SignedFileInventoryReport)(
      JSON.parse(inventoryBytes.toString("utf8")),
      { onExcessProperty: "error" },
    )
    const release = Schema.decodeUnknownSync(DocumentRuntimeAttestation.ReleaseIdentity)({
      version: required("OPENCODE_VERSION"),
      sourceCommit: required("GITHUB_SHA"),
      buildID: required("KOALA_DOCUMENT_CONFINEMENT_BUILD_ID"),
    })
    const bindings = {
      reportVersion: 1 as const,
      target,
      runtimeManifestSha256: runtime.manifestSha256,
      runtimeAttestationSha256: sha256(attestationBytes),
      proxySha256: proxy.sha256,
      sandboxRuntimeManifestSha256: sha256(sandboxManifestBytes),
      policyVersion: 1 as const,
      release,
    }
    expect(inventory).toMatchObject(bindings)
    expect(
      inventory.files.find((file) => file.path === "sandbox-runtime/document-runtime-proxy.mjs")?.sha256.toString(),
    ).toBe(proxy.sha256)
    await mkdir(path.dirname(reportPath), { recursive: true, mode: 0o700 })
    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "koala-confinement-runtime-"))
    const externalRoot = await mkdtemp(path.join(os.tmpdir(), "koala-confinement-host-"))
    const tesseractMarker = path.join(externalRoot, "system-tesseract-used")
    const tesseractTrap = path.join(externalRoot, "tesseract")
    await writeFile(tesseractTrap, `#!/bin/sh\n: > '${tesseractMarker.replaceAll("'", `'"'"'`)}'\nexit 90\n`, {
      mode: 0o700,
    })
    const previousPath = process.env.PATH
    process.env.PATH = externalRoot
    const projectRoot = path.join(process.cwd(), `.koala-confinement-${randomUUID()}`)
    const homeRoot = path.join(os.homedir(), `.koala-confinement-${randomUUID()}`)
    await Promise.all([mkdir(projectRoot, { mode: 0o700 }), mkdir(homeRoot, { mode: 0o700 })])

    try {
      const fixtureManifestSha256 = await makeHostileRuntime(runtime.root, fixtureRoot)
      const canaries = await makeCanaries({ projectRoot, homeRoot, externalRoot, fixtureRoot, sandboxRoot })
      const listeners = await makeListeners(externalRoot)
      try {
        const first = await runHostileProxy({
          target,
          runtimeRoot: fixtureRoot,
          manifestSha256: fixtureManifestSha256,
          sandboxRoot,
          proxyPath,
          proxySha256: proxy.sha256,
          mode: "denials",
          probes: {
            ...canaries,
            tcpPort: listeners.tcpPort,
            udpPort: listeners.udpPort,
            unixSocket: listeners.unixSocket,
          },
        })
        expect(first.events.map((event) => event.type)).toEqual(["accepted", "event", "event", "closed"])
        expect(Object.keys(first.results ?? {})).toHaveLength(32)
        expect(Object.values(first.results ?? {}).every((value) => value)).toBe(true)
        expectSuccessfulClosure(first)
        expect(listeners.tcpConnections).toBe(0)
        expect(listeners.udpDatagrams).toBe(0)
        expect(listeners.unixConnections).toBe(0)
        await assertDeniedWritesAbsent(canaries)

        const second = await runHostileProxy({
          target,
          runtimeRoot: fixtureRoot,
          manifestSha256: fixtureManifestSha256,
          sandboxRoot,
          proxyPath,
          proxySha256: proxy.sha256,
          mode: "denials",
          probes: {
            ...canaries,
            tcpPort: listeners.tcpPort,
            udpPort: listeners.udpPort,
            unixSocket: listeners.unixSocket,
          },
        })
        expect(Object.keys(second.results ?? {})).toHaveLength(32)
        expect(Object.values(second.results ?? {}).every((value) => value)).toBe(true)
        expectSuccessfulClosure(second)
        expect(second.proxyPID).not.toBe(first.proxyPID)

        const descendants = await runHostileProxy({
          target,
          runtimeRoot: fixtureRoot,
          manifestSha256: fixtureManifestSha256,
          sandboxRoot,
          proxyPath,
          proxySha256: proxy.sha256,
          mode: "tree",
          probes: {
            ...canaries,
            tcpPort: listeners.tcpPort,
            udpPort: listeners.udpPort,
            unixSocket: listeners.unixSocket,
          },
        })
        expectFailedClosure(descendants, "worker-crashed", "worker")
        expect(descendants.descendantPids).toHaveLength(2)
        for (const pid of descendants.descendantPids) expect(processExists(pid)).toBe(false)

        const failures = [
          ["output-substitution", "output-handoff-failed", "worker"],
          ["crash", "worker-crashed", "worker"],
          ["disconnect", "worker-crashed", "worker"],
          ["held-open", "worker-crashed", "worker"],
        ] as const
        for (const [mode, code, stage] of failures) {
          const result = await runHostileProxy({
            target,
            runtimeRoot: fixtureRoot,
            manifestSha256: fixtureManifestSha256,
            sandboxRoot,
            proxyPath,
            proxySha256: proxy.sha256,
            mode,
            probes: {
              ...canaries,
              tcpPort: listeners.tcpPort,
              udpPort: listeners.udpPort,
              unixSocket: listeners.unixSocket,
            },
          })
          expectFailedClosure(result, code, stage)
          for (const pid of result.descendantPids) expect(processExists(pid)).toBe(false)
        }

        const interrupted = await runHostileProxy({
          target,
          runtimeRoot: fixtureRoot,
          manifestSha256: fixtureManifestSha256,
          sandboxRoot,
          proxyPath,
          proxySha256: proxy.sha256,
          mode: "interruption",
          probes: {
            ...canaries,
            tcpPort: listeners.tcpPort,
            udpPort: listeners.udpPort,
            unixSocket: listeners.unixSocket,
          },
        })
        expect(interrupted.events[0]?.type).toBe("accepted")
        expect(interrupted.events.some((event) => event.type === "closed")).toBe(false)
        expect(interrupted.exit).toEqual({ code: 0, signal: null })
        expect(interrupted.disconnected).toBe(true)
        expect(DocumentSandboxProtocol.teardownCompleted(interrupted.receipt)).toBe(true)
        expect(interrupted.receipt.terminalCategory).toBe("failure")
        const reconciled = await runHostileProxy({
          target,
          runtimeRoot: fixtureRoot,
          manifestSha256: fixtureManifestSha256,
          sandboxRoot,
          proxyPath,
          proxySha256: proxy.sha256,
          mode: "denials",
          probes: {
            ...canaries,
            tcpPort: listeners.tcpPort,
            udpPort: listeners.udpPort,
            unixSocket: listeners.unixSocket,
          },
        })
        expectSuccessfulClosure(reconciled)

        for (const phase of ["after-started", "after-descendants"] as const) {
          await runExternallyKilledProxy({
            target,
            runtimeRoot: fixtureRoot,
            manifestSha256: fixtureManifestSha256,
            sandboxRoot,
            proxyPath,
            proxySha256: proxy.sha256,
            phase,
          })
        }

        const actual = await runAuthenticRuntime(runtime, sandboxRoot, target, externalRoot)
        expect(actual.proxySha256).toBe(proxy.sha256)
        expect(actual.sandboxRuntimeManifestSha256).toBe(bindings.sandboxRuntimeManifestSha256)
        const report = Schema.decodeUnknownSync(DocumentRuntimeAttestation.NativeTestReport)({
          ...bindings,
          signedFileInventorySha256: sha256(inventoryBytes),
          status: "passed",
          checks: {
            allowedRuntimeAndJobOperations: "passed",
            deniedFilesystemReadsAndWrites: "passed",
            deniedDnsTcpUdpLoopbackBindAndSockets: "passed",
            childAndGrandchildReaping: "passed",
            cleanupAndResetCompletion: "passed",
            proxyNonreuse: "passed",
            replacementAndLinkAttacks: "passed",
            outputSubstitution: "passed",
            workerCrash: "passed",
            innerDisconnect: "passed",
            proxyCrashContained: "passed",
            heldOpenCleanup: "passed",
            parentDisconnectReconciled: "passed",
            systemTesseractUnused: "passed",
            jobPendingAndParentRootAbsence: "passed",
            authenticPdfRenderAndTesseractOcr: "passed",
          },
        })
        expect(await Bun.file(tesseractMarker).exists()).toBe(false)
        await writeFile(reportPath, `${JSON.stringify(report)}\n`, { flag: "wx", mode: 0o600 })
      } finally {
        await listeners.close()
      }
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
      await Promise.all([
        rm(fixtureRoot, { recursive: true, force: true }),
        rm(externalRoot, { recursive: true, force: true }),
        rm(projectRoot, { recursive: true, force: true }),
        rm(homeRoot, { recursive: true, force: true }),
      ])
    }
  },
  120_000,
)

async function runHostileProxy(input: {
  readonly target: DocumentRuntimeTarget.Target
  readonly runtimeRoot: string
  readonly manifestSha256: string
  readonly sandboxRoot: string
  readonly proxyPath: string
  readonly proxySha256: string
  readonly mode: "denials" | "tree" | "output-substitution" | "crash" | "disconnect" | "held-open" | "interruption"
  readonly probes: Record<string, string | number>
}) {
  const job = await DocumentJobRoot.create()
  const jobID = DocumentRuntimeProtocol.JobID.make(`job_${randomUUID()}`)
  const receiptNonce = DocumentSandboxProtocol.ReceiptNonce.make(randomBytes(32).toString("hex"))
  const pendingRead = path.join(job.pending, "read-canary")
  const pendingWrite = path.join(job.pending, "write-attempt")
  let descendantPids: number[] = []
  try {
    await writeFile(pendingRead, "pending-canary", { flag: "wx", mode: 0o600 })
    await writeFile(
      path.join(job.path, "native-probes.json"),
      `${JSON.stringify({
        ...input.probes,
        pendingRead,
        pendingWrite,
        mode: input.mode,
        jobID,
        pendingRoot: job.pending,
      })}\n`,
      { flag: "wx", mode: 0o600 },
    )
    if (sha256(await readFile(input.proxyPath)) !== input.proxySha256) throw new Error("Document proxy changed before launch")
    const child = fork(input.proxyPath, [], {
      cwd: job.parent,
      detached: process.platform !== "win32",
      env: {
        ...DocumentSandboxPolicy.brokerEnvironment(input.sandboxRoot),
      },
      execArgv: [],
      serialization: "json",
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    })
    const events: DocumentSandboxProtocol.ProxyEvent[] = []
    const closed = Promise.withResolvers<void>()
    let disconnected = false
    child.on("message", (message) => {
      if (typeof message !== "object" || message === null || !("type" in message)) return
      const decoded = DocumentSandboxProtocol.decodeProxyEvent(message)
      events.push(decoded)
      if (decoded.type === "accepted" && (input.mode === "tree" || input.mode === "held-open")) {
        void waitForFile(path.join(job.path, "descendants.json"), 20_000).then(async () => {
          const pids = JSON.parse(await readFile(path.join(job.path, "descendants.json"), "utf8")) as {
            child: number
            grandchild: number
          }
          descendantPids = [pids.child, pids.grandchild]
          child.send({ protocolVersion: 1, type: "cancel", jobID })
        })
      }
      if (decoded.type === "accepted" && input.mode === "interruption") {
        child.disconnect()
      }
      if (decoded.type === "closed") closed.resolve()
    })
    const exited = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>()
    child.once("error", exited.reject)
    child.once("disconnect", () => {
      disconnected = true
    })
    child.once("exit", (code, signal) => exited.resolve({ code, signal }))
    const start =
      input.mode === "output-substitution"
        ? {
            protocolVersion: 1 as const,
            type: "render" as const,
            jobID,
            inputPath: DocumentRuntimeManifest.RelativePath.make("input/document.pdf"),
            inputBytes: 1,
            startPage: 1,
            pageCount: 1,
            limits: DocumentRuntimeLimits.requestedHard,
          }
        : { protocolVersion: 1 as const, type: "probe" as const, jobID, target: input.target, manifestSha256: input.manifestSha256 }
    if (input.mode === "output-substitution") {
      await mkdir(path.join(job.path, "input"), { recursive: true })
      await writeFile(path.join(job.path, "input", "document.pdf"), "x")
    }
    child.send({
      protocolVersion: 1,
      type: "launch",
      jobID,
      target: input.target,
      runtimeRoot: input.runtimeRoot,
      manifestSha256: input.manifestSha256,
      parentRoot: job.parent,
      parentIdentity: DocumentPendingRoot.identityToWire(job.parentIdentity),
      parentMode: job.parentMode ?? null,
      jobRoot: job.path,
      jobRootIdentity: DocumentPendingRoot.identityToWire(job.identity),
      pendingRoot: job.pending,
      pendingRootIdentity: DocumentPendingRoot.identityToWire(job.pendingIdentity),
      receiptNonce,
      start,
    })
    if (input.mode !== "interruption") {
      await Promise.race([closed.promise, rejectAfter(30_000, "Native proxy did not close")])
    }
    const exit = await Promise.race([exited.promise, rejectAfter(10_000, "Native proxy exit was not observed")])
    expect(exit).toEqual({ code: 0, signal: null })
    const closedEvent = events.find((event) => event.type === "closed")
    const receipt = await DocumentTeardownReceipt.read(
      {
        parentRoot: job.parent,
        parentIdentity: job.parentIdentity,
        parentMode: job.parentMode ?? null,
        pendingRoot: job.pending,
        pendingRootIdentity: job.pendingIdentity,
      },
      receiptNonce,
      closedEvent?.type === "closed" ? closedEvent.receiptSha256 ?? undefined : undefined,
    )
    const results = await readFile(path.join(job.path, "native-results.json"), "utf8").then(
      (value) => JSON.parse(value) as Record<string, boolean>,
      () => undefined,
    )
    expect(await Bun.file(pendingWrite).exists()).toBe(false)
    return { events, exit, disconnected, proxyPID: child.pid, receipt, results, descendantPids }
  } finally {
    await DocumentJobRoot.remove(job)
    expect(await Bun.file(job.parent).exists()).toBe(false)
  }
}

async function runExternallyKilledProxy(input: {
  readonly target: DocumentRuntimeTarget.Target
  readonly runtimeRoot: string
  readonly manifestSha256: string
  readonly sandboxRoot: string
  readonly proxyPath: string
  readonly proxySha256: string
  readonly phase: "after-started" | "after-descendants"
}) {
  const job = await DocumentJobRoot.create()
  const jobID = DocumentRuntimeProtocol.JobID.make(`job_${randomUUID()}`)
  const receiptNonce = DocumentSandboxProtocol.ReceiptNonce.make(randomBytes(32).toString("hex"))
  const pids: number[] = []
  try {
    await writeFile(
      path.join(job.path, "native-probes.json"),
      `${JSON.stringify({ mode: input.phase === "after-descendants" ? "held-open" : "interruption", jobID })}\n`,
      { flag: "wx", mode: 0o600 },
    )
    if (sha256(await readFile(input.proxyPath)) !== input.proxySha256) throw new Error("Document proxy changed before crash test")
    const child = fork(input.proxyPath, [], {
      cwd: job.parent,
      detached: process.platform !== "win32",
      env: DocumentSandboxPolicy.brokerEnvironment(input.sandboxRoot),
      execArgv: [],
      serialization: "json",
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    })
    const started = Promise.withResolvers<void>()
    let innerProcessID: number | undefined
    child.on("message", (message) => {
      const decoded = DocumentSandboxProtocol.decodeProxyEvent(message)
      if (decoded.type === "accepted") innerProcessID = decoded.innerProcessID
      if (decoded.type === "event" && decoded.event.type === "started") started.resolve()
    })
    const exited = Promise.withResolvers<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>()
    child.once("error", exited.reject)
    child.once("exit", (code, signal) => exited.resolve({ code, signal }))
    child.send({
      protocolVersion: 1,
      type: "launch",
      jobID,
      target: input.target,
      runtimeRoot: input.runtimeRoot,
      manifestSha256: input.manifestSha256,
      parentRoot: job.parent,
      parentIdentity: DocumentPendingRoot.identityToWire(job.parentIdentity),
      parentMode: job.parentMode ?? null,
      jobRoot: job.path,
      jobRootIdentity: DocumentPendingRoot.identityToWire(job.identity),
      pendingRoot: job.pending,
      pendingRootIdentity: DocumentPendingRoot.identityToWire(job.pendingIdentity),
      receiptNonce,
      start: { protocolVersion: 1, type: "probe", jobID, target: input.target, manifestSha256: input.manifestSha256 },
    })
    await Promise.race([started.promise, rejectAfter(20_000, "Crash fixture did not start")])
    await waitForFile(path.join(job.path, "worker-pid.json"), 5_000)
    const worker = JSON.parse(await readFile(path.join(job.path, "worker-pid.json"), "utf8")) as { worker: number }
    pids.push(worker.worker)
    if (input.phase === "after-descendants") {
      await waitForFile(path.join(job.path, "descendants.json"), 5_000)
      const descendants = JSON.parse(await readFile(path.join(job.path, "descendants.json"), "utf8")) as {
        child: number
        grandchild: number
      }
      pids.push(descendants.child, descendants.grandchild)
    }
    child.kill("SIGKILL")
    const exit = await Promise.race([exited.promise, rejectAfter(10_000, "Killed proxy exit was not observed")])
    if (!innerProcessID) throw new Error("Built proxy did not publish its inner process ID")
    expect(await DocumentProcess.terminateProcessGroup(innerProcessID, 2_000)).toBe(true)
    expect(exit.signal ?? exit.code).not.toBe(0)
    await Bun.sleep(250)
    const contained = pids.every((pid) => !processExists(pid))
    const receipt = path.join(job.pending, DocumentTeardownReceipt.relativePath(receiptNonce))
    expect(await Bun.file(receipt).exists()).toBe(false)
    expect(contained).toBe(true)
  } finally {
    for (const pid of pids.filter(processExists)) {
      try {
        process.kill(pid, "SIGKILL")
      } catch {}
    }
    await DocumentJobRoot.remove(job)
    expect(await Bun.file(job.parent).exists()).toBe(false)
  }
}

async function runAuthenticRuntime(
  runtime: Awaited<ReturnType<typeof loadAndVerifyProductionManifest>>,
  sandboxRoot: string,
  target: DocumentRuntimeTarget.Target,
  root: string,
) {
  const sandboxManifest = await readFile(path.join(sandboxRoot, "sandbox-runtime.manifest.json"))
  const sandbox = JSON.parse(sandboxManifest.toString("utf8")) as {
    readonly target: string
    readonly files: ReadonlyArray<{ readonly path: string; readonly sha256: string }>
  }
  const proxy = sandbox.files.find((file) => file.path === "document-runtime-proxy.mjs")
  expect(sandbox.target).toBe(target)
  expect(proxy?.sha256).toBe(
    createHash("sha256")
      .update(await readFile(path.join(sandboxRoot, "document-runtime-proxy.mjs")))
      .digest("hex"),
  )
  if (!proxy) throw new Error("Document proxy is absent from sandbox manifest")
  const pdf = path.join(root, "authentic.pdf")
  await writeFile(pdf, smokePdf())
  const before = new Set((await Array.fromAsync(new Bun.Glob("opencode-document-*").scan(os.tmpdir()))))
  await Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* DocumentRuntime.Service
      yield* service.probe()
      yield* service.renderAndOcr({ inputPath: pdf, startPage: 1, pageCount: 1 }, (page) =>
        Effect.tryPromise(async () => {
          expect((await readFile(page.tsvPath, "utf8")).toUpperCase()).toContain("HELLO")
          expect((await readFile(page.pagePath)).byteLength).toBe(page.pngBytes)
        }),
      )
      const entered = yield* Deferred.make<void>()
      const fiber = yield* service
        .renderAndOcr({ inputPath: pdf, startPage: 1, pageCount: 1 }, () =>
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(entered).pipe(Effect.timeout("30 seconds"))
      yield* Fiber.interrupt(fiber)
    }).pipe(
      Effect.provide(
        DocumentRuntime.layer({
          runtimePath: runtime.root,
          manifestSha256: runtime.manifestSha256,
          proxyPath: path.join(sandboxRoot, "document-runtime-proxy.mjs"),
          proxyAssetsRoot: sandboxRoot,
          requireReleaseReady: true,
        }),
      ),
    ),
  )
  const after = new Set((await Array.fromAsync(new Bun.Glob("opencode-document-*").scan(os.tmpdir()))))
  expect(after).toEqual(before)
  return {
    proxySha256: proxy.sha256,
    sandboxRuntimeManifestSha256: createHash("sha256").update(sandboxManifest).digest("hex"),
  }
}

async function makeHostileRuntime(source: string, destination: string) {
  await cp(source, destination, { recursive: true })
  const bootstrap = await readFile(hostileBootstrap)
  await writeFile(path.join(destination, "worker", "bootstrap.js"), bootstrap, { mode: 0o644 })
  const manifestPath = path.join(destination, "manifest.json")
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as DocumentRuntimeManifest.Manifest
  const files = manifest.files.map((file) =>
    file.path === "worker/bootstrap.js"
      ? {
          ...file,
          bytes: bootstrap.byteLength,
          sha256: DocumentRuntimeManifest.Digest.make(createHash("sha256").update(bootstrap).digest("hex")),
        }
      : file,
  )
  const body = `${JSON.stringify({ ...manifest, releaseReady: false, files })}\n`
  await writeFile(manifestPath, body)
  return createHash("sha256").update(body).digest("hex")
}

async function makeCanaries(input: {
  readonly projectRoot: string
  readonly homeRoot: string
  readonly externalRoot: string
  readonly fixtureRoot: string
  readonly sandboxRoot: string
}) {
  const sibling = path.join(input.externalRoot, "sibling-job")
  await mkdir(sibling, { mode: 0o700 })
  const values = {
    projectRead: path.join(input.projectRoot, "read-canary"),
    projectWrite: path.join(input.projectRoot, "write-attempt"),
    homeRead: path.join(input.homeRoot, "read-canary"),
    homeWrite: path.join(input.homeRoot, "write-attempt"),
    credentialRead: path.join(input.homeRoot, "credentials-canary"),
    credentialWrite: path.join(input.homeRoot, "credentials-write-attempt"),
    siblingRead: path.join(sibling, "read-canary"),
    siblingWrite: path.join(sibling, "write-attempt"),
    runtimeRead: path.join(input.fixtureRoot, "manifest.json"),
    runtimeWrite: path.join(input.fixtureRoot, "runtime-write-attempt"),
    runtimeReplacement: path.join(input.fixtureRoot, "manifest.replaced.json"),
    resourcesRead: path.join(input.sandboxRoot, "sandbox-worker.mjs"),
    resourcesWrite: path.join(input.sandboxRoot, "resources-write-attempt"),
    systemTempRead: path.join(input.externalRoot, "system-temp-read"),
    systemTempWrite: path.join(input.externalRoot, "system-temp-write"),
  }
  await Promise.all(
    [
      values.projectRead,
      values.homeRead,
      values.credentialRead,
      values.siblingRead,
      values.systemTempRead,
    ].map((file) => writeFile(file, "native-confinement-canary", { flag: "wx", mode: 0o600 })),
  )
  return values
}

async function assertDeniedWritesAbsent(canaries: Awaited<ReturnType<typeof makeCanaries>>) {
  for (const [name, file] of Object.entries(canaries)) {
    if (!name.endsWith("Write") && !name.endsWith("WriteDenied") && !name.endsWith("WriteAttempt")) continue
    expect(await Bun.file(file).exists()).toBe(false)
  }
  for (const file of [
    canaries.projectWrite,
    canaries.homeWrite,
    canaries.credentialWrite,
    canaries.siblingWrite,
    canaries.runtimeWrite,
    canaries.runtimeReplacement,
    canaries.resourcesWrite,
    canaries.systemTempWrite,
  ]) {
    expect(await Bun.file(file).exists()).toBe(false)
  }
}

function expectSuccessfulClosure(result: Awaited<ReturnType<typeof runHostileProxy>>) {
  expect(result.events.map((event) => event.type)).toEqual(["accepted", "event", "event", "closed"])
  const terminal = result.events.find(
    (event) => event.type === "event" && ["completed", "cancelled", "failure"].includes(event.event.type),
  )
  expect(terminal).toMatchObject({ type: "event", event: { type: "completed" } })
  const closed = result.events.find((event) => event.type === "closed")
  if (!closed || closed.type !== "closed") throw new Error("Missing proxy closure")
  expect(DocumentSandboxProtocol.teardownCompleted(closed)).toBe(true)
  expect(DocumentTeardownReceipt.matchesClosed(result.receipt, closed)).toBe(true)
  expect(result.exit).toEqual({ code: 0, signal: null })
  expect(result.disconnected).toBe(true)
}

function expectFailedClosure(
  result: Awaited<ReturnType<typeof runHostileProxy>>,
  code: DocumentSandboxProtocol.FailureCode,
  stage: DocumentSandboxProtocol.FailureStage,
) {
  expect(result.events[0]?.type).toBe("accepted")
  const failures = result.events.filter((event) => event.type === "failure")
  expect(failures).toHaveLength(1)
  expect(result.events.filter((event) => event.type === "closed")).toHaveLength(1)
  expect(result.events.at(-1)?.type).toBe("closed")
  const closed = result.events.at(-1)
  if (!closed || closed.type !== "closed") throw new Error("Missing proxy closure")
  expect(DocumentSandboxProtocol.teardownCompleted(closed)).toBe(true)
  expect(DocumentTeardownReceipt.matchesClosed(result.receipt, closed)).toBe(true)
  expect(result.exit).toEqual({ code: 0, signal: null })
  expect(result.disconnected).toBe(true)
  expect(failures[0]).toMatchObject({ code, stage })
  expect(failures[0]?.code).not.toBe("command-cleanup-failed")
  expect(failures[0]?.code).not.toBe("reset-failed")
  expect(failures[0]?.code).not.toBe("termination-failed")
}

async function makeListeners(root: string) {
  let tcpConnections = 0
  let udpDatagrams = 0
  let unixConnections = 0
  const tcp = net.createServer(() => tcpConnections++)
  await new Promise<void>((resolve, reject) => {
    tcp.once("error", reject)
    tcp.listen(0, "127.0.0.1", resolve)
  })
  const tcpAddress = tcp.address()
  if (!tcpAddress || typeof tcpAddress === "string") throw new Error("TCP probe listener did not bind")
  const udp = dgram.createSocket("udp4")
  udp.on("message", () => udpDatagrams++)
  await new Promise<void>((resolve, reject) => {
    udp.once("error", reject)
    udp.bind(0, "127.0.0.1", resolve)
  })
  const udpAddress = udp.address()
  const unixSocket = process.platform === "win32" ? "" : path.join(root, "host.sock")
  const unix = process.platform === "win32" ? undefined : net.createServer(() => unixConnections++)
  if (unix) {
    await new Promise<void>((resolve, reject) => {
      unix.once("error", reject)
      unix.listen(unixSocket, resolve)
    })
  }
  return {
    tcpPort: tcpAddress.port,
    udpPort: udpAddress.port,
    unixSocket,
    get tcpConnections() {
      return tcpConnections
    },
    get udpDatagrams() {
      return udpDatagrams
    },
    get unixConnections() {
      return unixConnections
    },
    async close() {
      await Promise.all([
        new Promise<void>((resolve) => tcp.close(() => resolve())),
        new Promise<void>((resolve) => udp.close(() => resolve())),
        ...(unix ? [new Promise<void>((resolve) => unix.close(() => resolve()))] : []),
      ])
      if (unixSocket) await rm(unixSocket, { force: true })
    },
  }
}

function requiredTarget() {
  const value = process.env.RUST_TARGET
  if (!value) throw new Error("RUST_TARGET is required for native document confinement")
  const host =
    process.platform === "darwin" || process.platform === "linux" || process.platform === "win32"
      ? process.arch === "x64" || process.arch === "arm64"
        ? DocumentRuntimeTarget.fromHost(process.platform, process.arch)
        : undefined
      : undefined
  if (value !== host) throw new Error(`Native document confinement target mismatch: host=${host ?? "unsupported"} target=${value}`)
  return value as DocumentRuntimeTarget.Target
}

function requiredAbsolute(name: string) {
  const value = process.env[name]
  if (!value || !path.isAbsolute(value)) throw new Error(`${name} must be an absolute path`)
  return path.normalize(value)
}

function required(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex")
}

function processExists(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !(typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH")
  }
}

async function waitForFile(file: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (!(await Bun.file(file).exists())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for native confinement fixture")
    await Bun.sleep(10)
  }
}

function rejectAfter(milliseconds: number, message: string) {
  return new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), milliseconds))
}

function smokePdf() {
  const content = "BT /F1 28 Tf 72 700 Td (HELLO) Tj ET"
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [4 0 R] >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ]
  const chunks = ["%PDF-1.7\n%\xE2\xE3\xCF\xD3\n"]
  const offsets = objects.map((object, index) => {
    const offset = Buffer.byteLength(chunks.join(""), "binary")
    chunks.push(`${index + 1} 0 obj\n${object}\nendobj\n`)
    return offset
  })
  const xref = Buffer.byteLength(chunks.join(""), "binary")
  chunks.push("xref\n0 6\n0000000000 65535 f \n")
  chunks.push(offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join(""))
  chunks.push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
  return Buffer.from(chunks.join(""), "binary")
}
