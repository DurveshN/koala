import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime"
import { DocumentRuntimeLimits } from "@koala-ai/core/document-runtime/limits"
import { DocumentRuntimeProtocol } from "@koala-ai/core/document-runtime/protocol"
import { DocumentSandboxProtocol } from "@koala-ai/core/document-runtime/sandbox-protocol"
import type { DocumentRuntimeTarget } from "@koala-ai/core/document-runtime/target"
import { loadAndVerifyManifest } from "@koala-ai/document-runtime/manifest"
import {
  createNodeStreamTransport,
  type NodeStreamTransport,
  type TransportError,
} from "@koala-ai/document-runtime/transport"
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process"
import path from "node:path"
import type { Readable, Writable } from "node:stream"
import { pathToFileURL } from "node:url"
import { DocumentProcess, type ObservedExit, type ProcessHandle } from "./process"
import { DocumentProxyOutput, type Receiver as OutputReceiver } from "./proxy-output"
import { DocumentPendingRoot } from "./pending-root"
import { DocumentTeardownReceipt } from "./teardown-receipt"
import {
  DocumentSandboxPolicy,
  type BootstrapCommand,
  type InspectableSandboxManager,
  type PrepareInput,
  type PreparedPolicy,
  type Result as PolicyResult,
  type WrappedCommand,
} from "./sandbox-policy"

// Windows teardown enumerates descendants through PowerShell CIM after taskkill, which needs a
// larger budget than the POSIX process-group sweep while staying inside the parent's 10 s watchdog.
const TeardownTimeoutMs = process.platform === "win32" ? 6_000 : 2_000
const RelayedStderrBytes = 16_384

export interface ProxySandboxManager extends InspectableSandboxManager {
  readonly initialize: (
    config: SandboxRuntimeConfig,
    ask?: (input: { readonly host: string; readonly port: number | undefined }) => Promise<boolean>,
    enableLogMonitor?: boolean,
  ) => Promise<void>
  readonly wrapWithSandboxArgv: (
    command: string,
    binShell?: BootstrapCommand["binShell"],
    customConfig?: Partial<SandboxRuntimeConfig>,
    abortSignal?: AbortSignal,
    cwd?: string,
    options?: { readonly commandId?: string; readonly commandText?: string },
  ) => Promise<WrappedCommand>
  readonly cleanupAfterCommand: () => void
  readonly reset: () => Promise<void>
}

export type ProxyChild = ChildProcess

export interface ParentPort {
  readonly connected: () => boolean
  readonly onMessage: (listener: (input: unknown) => void) => void
  readonly offMessage: (listener: (input: unknown) => void) => void
  readonly onDisconnect: (listener: () => void) => void
  readonly offDisconnect: (listener: () => void) => void
  readonly send: (value: unknown, callback: (error: Error | null) => void) => boolean
  readonly disconnect: () => void
}

export interface TimerDependencies {
  readonly set: (callback: () => void, delayMs: number) => unknown
  readonly clear: (timer: unknown) => void
}

export interface ProxyDependencies {
  readonly manager: ProxySandboxManager
  readonly parent: ParentPort
  readonly platform: NodeJS.Platform
  readonly architecture: string
  readonly executablePath: string
  readonly sandboxAssetsRoot: string
  readonly verifyRuntime: (
    root: string,
    target: DocumentRuntimeTarget.Target,
    manifestSha256: string,
  ) => Promise<{
    readonly root: string
    readonly manifestSha256: string
    readonly manifest: { readonly target: string }
  }>
  readonly preparePolicy: (input: PrepareInput) => Promise<PolicyResult<PreparedPolicy>>
  readonly verifyDependencies: typeof DocumentSandboxPolicy.verifyDependencies
  readonly verifyEffectivePolicy: typeof DocumentSandboxPolicy.verifyEffectivePolicy
  readonly applyHandoffEnvironment: typeof DocumentSandboxPolicy.applyHandoffEnvironment
  readonly spawnCommand: (executable: string, args: ReadonlyArray<string>, options: SpawnOptions) => ProxyChild
  readonly createTransport: (input: Readable, output: Writable) => NodeStreamTransport
  readonly createOutputReceiver: typeof DocumentProxyOutput.create
  readonly writeReceipt: typeof DocumentTeardownReceipt.write
  readonly sweepProcessTree: typeof DocumentProcess.terminateProcessTree
  readonly verifyWindowsTreeEmpty?: (pid: number) => Promise<boolean>
  readonly timers: TimerDependencies
  readonly cancellationGraceMs: number
  readonly teardownTimeoutMs: number
}

type ProxyFailure = typeof DocumentSandboxProtocol.FailureEvent.Type
type Launch = typeof DocumentSandboxProtocol.LaunchRequest.Type

const failurePriority: Record<DocumentSandboxProtocol.FailureCode, number> = {
  "invalid-launch": 10,
  "protocol-mismatch": 20,
  "sandbox-unavailable": 30,
  "dependency-failed": 40,
  "spawn-failed": 50,
  "transport-overflow": 60,
  "output-handoff-failed": 90,
  "root-identity-failed": 95,
  "worker-crashed": 70,
  "command-cleanup-failed": 100,
  "reset-failed": 200,
  "termination-failed": 300,
}

export function defaultDependencies(): ProxyDependencies {
  return {
    manager: SandboxManager,
    parent: processParentPort(),
    platform: process.platform,
    architecture: process.arch,
    executablePath: process.execPath,
    sandboxAssetsRoot: process.env.KOALA_DOCUMENT_RUNTIME_PROXY_ASSETS_ROOT ?? "",
    verifyRuntime: loadAndVerifyManifest,
    preparePolicy: (input) => DocumentSandboxPolicy.prepare(input),
    verifyDependencies: DocumentSandboxPolicy.verifyDependencies,
    verifyEffectivePolicy: DocumentSandboxPolicy.verifyEffectivePolicy,
    applyHandoffEnvironment: DocumentSandboxPolicy.applyHandoffEnvironment,
    spawnCommand: (executable, args, options) => spawn(executable, args, options),
    createTransport: createNodeStreamTransport,
    createOutputReceiver: DocumentProxyOutput.create,
    writeReceipt: DocumentTeardownReceipt.write,
    sweepProcessTree: DocumentProcess.terminateProcessTree,
    timers: {
      set: (callback, delayMs) => setTimeout(callback, delayMs),
      clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    },
    cancellationGraceMs: DocumentRuntimeLimits.MaxCancellationGraceMs,
    teardownTimeoutMs: TeardownTimeoutMs,
  }
}

export function startProxy(dependencies: ProxyDependencies = defaultDependencies()) {
  let phase: "awaiting-launch" | "starting" | "active" | "finishing" | "closed" = "awaiting-launch"
  let launch: Launch | undefined
  let policy: PreparedPolicy | undefined
  let order: DocumentRuntimeProtocol.OrderState | undefined
  let child: ProxyChild | undefined
  let transport: NodeStreamTransport | undefined
  let outputReceiver: OutputReceiver | undefined
  let terminal: DocumentRuntimeProtocol.WorkerEvent | undefined
  let selectedFailure: ProxyFailure | undefined
  let initialized = false
  let cleanupCalls: 0 | 1 = 0
  let cleanupCompleted = false
  let resetCalls: 0 | 1 = 0
  let resetCompleted = false
  let treeContained = true
  let receiptSha256: DocumentSandboxProtocol.TeardownReceipt["receiptSha256"] | null = null
  let accepted = false
  let leaderExit: ObservedExit | undefined
  let spawnAbsenceConfirmed = false
  let hardTerminationStarted = false
  let childClosed = false
  let cancellationSent = false
  let wrapAbort: AbortController | undefined
  let processing = false
  let shutdownPromise: Promise<void> | undefined
  let cancellationTimer: unknown
  let streamsClosing = false
  let outerPending = 0
  let outerTail = Promise.resolve()
  let innerTail = Promise.resolve()
  const parentQueue: unknown[] = []
  const parentSendWaiters = new Set<(error: Error | null) => void>()
  let resolveDone: () => void
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })

  const makeFailure = (
    code: DocumentSandboxProtocol.FailureCode,
    stage: DocumentSandboxProtocol.FailureStage,
  ): ProxyFailure => ({
    protocolVersion: 1,
    type: "failure",
    jobID: launch?.jobID ?? null,
    code,
    stage,
    retryable: false,
  })
  const fail = (code: DocumentSandboxProtocol.FailureCode, stage: DocumentSandboxProtocol.FailureStage) => {
    const next = makeFailure(code, stage)
    if (!selectedFailure || failurePriority[next.code] > failurePriority[selectedFailure.code]) selectedFailure = next
  }
  // The parent relays the proxy's stderr to the application log; failure codes alone hide the cause.
  const report = (reason: string, error?: unknown) => {
    const detail = error instanceof Error ? error.message : error === undefined ? "" : String(error)
    process.stderr.write(
      `document proxy: ${reason}${detail ? ` : ${detail.replace(/\s+/g, " ").slice(0, 1024)}` : ""}\n`,
    )
  }
  const directSend = (value: DocumentSandboxProtocol.ProxyEvent) =>
    new Promise<void>((resolve, reject) => {
      if (!dependencies.parent.connected()) return reject(new Error("parent-disconnected"))
      let encoded: DocumentSandboxProtocol.ProxyEvent
      let bytes: number
      try {
        encoded = DocumentSandboxProtocol.decodeProxyEvent(JSON.parse(JSON.stringify(value)))
        bytes = Buffer.byteLength(JSON.stringify(encoded))
      } catch {
        return reject(new Error("invalid-proxy-event"))
      }
      if (bytes > DocumentRuntimeLimits.MaxOuterIpcMessageBytes) return reject(new Error("outer-message-overflow"))
      let settled = false
      const complete = (error: Error | null) => {
        if (settled) return
        settled = true
        parentSendWaiters.delete(complete)
        if (error) reject(new Error("parent-send-failed"))
        else resolve()
      }
      parentSendWaiters.add(complete)
      try {
        dependencies.parent.send(encoded, complete)
      } catch {
        complete(new Error("parent-send-failed"))
      }
    })
  const send = (value: DocumentSandboxProtocol.ProxyEvent) => {
    if (outerPending >= DocumentRuntimeLimits.MaxOuterPendingMessages) {
      return Promise.reject(new Error("outer-queue-overflow"))
    }
    outerPending++
    const result = outerTail.then(() => directSend(value))
    outerTail = result.catch(() => undefined)
    return result.finally(() => {
      outerPending--
    })
  }
  const sendEvent = (event: DocumentRuntimeProtocol.WorkerEvent) =>
    send({ protocolVersion: 1, type: "event", jobID: event.jobID, event })

  const onStderr = (chunk: unknown) => {
    if (phase === "closed" || streamsClosing) return
    if (!(chunk instanceof Uint8Array)) {
      fail("worker-crashed", "worker")
      void shutdown()
      return
    }
    stderrBytes += chunk.byteLength
    if (stderrBytes <= DocumentRuntimeLimits.MaxInnerStderrBytes) {
      // Relay a bounded prefix of the worker's stderr so bootstrap failures reach the log.
      if (stderrBytes <= RelayedStderrBytes) process.stderr.write(chunk)
      return
    }
    fail("transport-overflow", "transport")
    void shutdown()
  }
  const onStderrError = () => {
    if (phase === "closed" || streamsClosing) return
    fail("transport-overflow", "transport")
    void shutdown()
  }
  let stderrBytes = 0
  const onChildError = () => {
    if (!child?.pid) {
      spawnAbsenceConfirmed = true
      fail("spawn-failed", "spawn")
    } else {
      fail(accepted ? "worker-crashed" : "spawn-failed", accepted ? "worker" : "spawn")
    }
    void shutdown()
  }
  const onChildExit = (code: number | null, signal: NodeJS.Signals | null) => {
    leaderExit = { code, signal }
    if ((code !== 0 || signal !== null) && !hardTerminationStarted) {
      report(`worker exited unexpectedly (code ${code}, signal ${signal})`)
      fail("worker-crashed", "worker")
    }
    if (childClosed) void shutdown()
  }
  const onChildClose = () => {
    childClosed = true
    if (!leaderExit && child && (child.exitCode !== null || child.signalCode !== null)) {
      leaderExit = { code: child.exitCode, signal: child.signalCode }
      if ((leaderExit.code !== 0 || leaderExit.signal !== null) && !hardTerminationStarted) {
        fail("worker-crashed", "worker")
      }
    }
    void innerTail.then(() => {
      if (!terminal && !selectedFailure) fail("worker-crashed", "worker")
      void shutdown()
    })
  }
  const onInnerDisconnect = (error?: TransportError) => {
    if (phase === "closed" || streamsClosing) return
    if (!error && terminal) return
    fail(error ? "transport-overflow" : "worker-crashed", error ? "transport" : "worker")
    void shutdown()
  }
  const handleInnerMessage = async (input: unknown) => {
    if (phase !== "active" || !launch || !order || terminal) {
      fail("protocol-mismatch", "transport")
      await shutdown()
      return
    }
    let message: DocumentRuntimeProtocol.WorkerOutput
    let event: DocumentRuntimeProtocol.WorkerEvent | undefined
    try {
      message = DocumentRuntimeProtocol.decodeWorkerOutput(input)
      message = DocumentRuntimeProtocol.decodeWorkerOutput(JSON.parse(JSON.stringify(message)))
      event = await outputReceiver?.handle(message)
    } catch (error) {
      fail(
        error instanceof DocumentPendingRoot.EvidenceError
          ? "root-identity-failed"
          : isOutputInput(input)
            ? "output-handoff-failed"
            : "protocol-mismatch",
        isOutputInput(input) ? "worker" : "transport",
      )
      await shutdown()
      return
    }
    if (!event) return
    const next = DocumentRuntimeProtocol.advanceOrder(order, event)
    if (!next.ok) {
      fail("protocol-mismatch", "transport")
      await shutdown()
      return
    }
    order = next.state
    if (next.state.phase === "terminal") {
      terminal = event
      if (childClosed) void shutdown()
      return
    }
    try {
      await sendEvent(event)
    } catch {
      fail("transport-overflow", "transport")
      await shutdown()
    }
  }
  const onInnerMessage = (input: unknown) => {
    const result = innerTail.then(() => handleInnerMessage(input))
    innerTail = result.catch(() => undefined)
    return result
  }

  const cleanupChildListeners = () => {
    if (!child) return
    child.off("error", onChildError)
    child.off("exit", onChildExit)
    child.off("close", onChildClose)
    child.stderr?.off("data", onStderr)
    child.stderr?.off("error", onStderrError)
  }
  const cleanupParent = () => {
    dependencies.parent.offMessage(onParentMessage)
    dependencies.parent.offDisconnect(onParentDisconnect)
    parentQueue.length = 0
    for (const complete of [...parentSendWaiters]) complete(new Error("parent-disconnected"))
  }
  const finishPort = async () => {
    await outerTail
    if (!dependencies.parent.connected()) return
    if (selectedFailure) await directSend(selectedFailure).catch(() => undefined)
    else if (terminal && launch) {
      await directSend({ protocolVersion: 1, type: "event", jobID: launch.jobID, event: terminal }).catch(
        () => undefined,
      )
    } else {
      const fallback = makeFailure("worker-crashed", "worker")
      selectedFailure = fallback
      await directSend(fallback).catch(() => undefined)
    }
    if (dependencies.parent.connected()) {
      await directSend({
        protocolVersion: 1,
        type: "closed",
        jobID: launch?.jobID ?? null,
        receiptNonce: launch?.receiptNonce ?? null,
        receiptSha256,
        terminalCategory: launch ? terminalCategory() : null,
        treeContained,
        managerInitialized: initialized,
        cleanupCalls,
        cleanupCompleted,
        resetCalls,
        resetCompleted,
      }).catch(() => undefined)
    }
  }
  const teardownManager = async () => {
    if (!initialized) return
    let cleanupFailed = false
    let resetFailed = false
    let resetStarted = false
    const completed = await within(
      async () => {
        try {
          cleanupCalls = 1
          dependencies.manager.cleanupAfterCommand()
          cleanupCompleted = true
        } catch (error) {
          report("sandbox command cleanup failed", error)
          cleanupFailed = true
        }
        resetStarted = true
        try {
          resetCalls = 1
          await dependencies.manager.reset()
          resetCompleted = true
        } catch (error) {
          report("sandbox reset failed", error)
          resetFailed = true
        }
      },
      dependencies.teardownTimeoutMs,
      dependencies.timers,
    )
    if (!completed) report("sandbox teardown exceeded its budget")
    if (cleanupFailed) fail("command-cleanup-failed", "command-cleanup")
    if (resetFailed || (!completed && resetStarted)) fail("reset-failed", "reset")
    else if (!completed) fail("command-cleanup-failed", "command-cleanup")
  }
  const performShutdown = async () => {
    phase = "finishing"
    if (cancellationTimer !== undefined) dependencies.timers.clear(cancellationTimer)
    cancellationTimer = undefined
    parentQueue.length = 0

    treeContained = !child || spawnAbsenceConfirmed
    if (child && !spawnAbsenceConfirmed) {
      hardTerminationStarted = leaderExit === undefined
      const systemRoot = policy?.handoffEnvironment.SystemRoot
      const result = await dependencies
        .sweepProcessTree(child, {
          platform: dependencies.platform,
          systemRoot,
          timeoutMs: dependencies.teardownTimeoutMs,
          verifyWindowsTreeEmpty: dependencies.verifyWindowsTreeEmpty,
        })
        .catch((error: unknown) => {
          report("process tree sweep threw", error)
          return undefined
        })
      if (!result || result.status !== "exited") {
        if (result) report(`process tree sweep failed: ${result.code}`)
        fail("termination-failed", "termination")
      } else treeContained = true
    }
    if (treeContained) await teardownManager()
    if (selectedFailure || terminal?.type !== "completed") {
      try {
        await outputReceiver?.cleanup()
      } catch (error) {
        fail(
          error instanceof DocumentPendingRoot.EvidenceError ? "root-identity-failed" : "output-handoff-failed",
          "worker",
        )
      }
    }
    if (launch && treeContained) {
      try {
        const receipt = await dependencies.writeReceipt(
          {
            parentRoot: launch.parentRoot,
            parentIdentity: DocumentPendingRoot.identityFromWire(launch.parentIdentity),
            parentMode: launch.parentMode,
            pendingRoot: launch.pendingRoot,
            pendingRootIdentity: DocumentPendingRoot.identityFromWire(launch.pendingRootIdentity),
          },
          {
            protocolVersion: 1,
            type: "teardown-receipt",
            jobID: launch.jobID,
            receiptNonce: launch.receiptNonce,
            terminalCategory: terminalCategory(),
            treeContained,
            managerInitialized: initialized,
            cleanupCalls,
            cleanupCompleted,
            resetCalls,
            resetCompleted,
          },
        )
        receiptSha256 = receipt.receiptSha256
      } catch {
        fail("root-identity-failed", "worker")
      }
    }
    streamsClosing = true
    try {
      transport?.close()
    } catch {
      fail("transport-overflow", "transport")
    }
    cleanupChildListeners()
    await finishPort()
    cleanupParent()
    phase = "closed"
    if (dependencies.parent.connected()) {
      try {
        dependencies.parent.disconnect()
      } catch {}
    }
    resolveDone()
  }
  function shutdown() {
    if (phase !== "closed") phase = "finishing"
    shutdownPromise ??= Promise.resolve().then(performShutdown)
    return shutdownPromise
  }
  const terminalCategory = (): DocumentSandboxProtocol.TeardownReceiptPayload["terminalCategory"] => {
    if (selectedFailure || !terminal) return "failure"
    if (terminal.type === "cancelled") return "cancelled"
    return terminal.type === "completed" ? "completed" : "failure"
  }
  const stopStarting = () => {
    if (phase === "starting" && !cancellationSent && !selectedFailure) return false
    if (cancellationSent && !selectedFailure) fail("worker-crashed", "worker")
    void shutdown()
    return true
  }

  const cancel = async (message: Extract<DocumentSandboxProtocol.ParentRequest, { readonly type: "cancel" }>) => {
    if (!launch || !order || message.jobID !== launch.jobID || cancellationSent || phase !== "active") {
      fail("protocol-mismatch", "transport")
      return shutdown()
    }
    const request = DocumentRuntimeProtocol.decodeWorkerRequest({
      protocolVersion: 1,
      type: "cancel",
      jobID: launch.jobID,
    })
    const next = DocumentRuntimeProtocol.advanceOrder(order, request)
    if (!next.ok) {
      fail("protocol-mismatch", "transport")
      return shutdown()
    }
    cancellationSent = true
    order = next.state
    cancellationTimer = dependencies.timers.set(() => {
      void shutdown()
    }, dependencies.cancellationGraceMs)
    try {
      await transport?.send(request)
    } catch {
      fail("transport-overflow", "transport")
      await shutdown()
    }
  }

  const command = async (message: Extract<DocumentSandboxProtocol.ParentRequest, { readonly type: "command" }>) => {
    if (!order || phase !== "active" || cancellationSent || terminal) {
      fail("protocol-mismatch", "transport")
      return shutdown()
    }
    const request = DocumentRuntimeProtocol.decodeContinuationRequest(message.command)
    const next = DocumentRuntimeProtocol.advanceOrder(order, request)
    if (!next.ok) {
      fail("protocol-mismatch", "transport")
      return shutdown()
    }
    if (request.type === "release-page" && !(await outputReceiver?.release(request))) {
      fail("output-handoff-failed", "worker")
      return shutdown()
    }
    try {
      await transport?.send(request)
      order = next.state
    } catch {
      fail("transport-overflow", "transport")
      await shutdown()
    }
  }

  const launchChild = async (message: Launch) => {
    launch = message
    phase = "starting"
    order = DocumentRuntimeProtocol.beginOrder(message.start)
    if (stopStarting()) return shutdownPromise
    const verified = await dependencies
      .verifyRuntime(message.runtimeRoot, message.target, message.manifestSha256)
      .catch((error: unknown) => {
        report("runtime verification failed", error)
        return undefined
      })
    if (stopStarting()) return shutdownPromise
    if (
      !verified ||
      verified.root !== message.runtimeRoot ||
      verified.manifestSha256 !== message.manifestSha256 ||
      verified.manifest.target !== message.target
    ) {
      if (verified) report("runtime verification mismatch")
      fail("sandbox-unavailable", "sandbox")
      return shutdown()
    }

    if (stopStarting()) return shutdownPromise
    const preparePolicy = (minimalGrants: boolean) =>
      dependencies
        .preparePolicy({
          target: message.target,
          runtimeRoot: message.runtimeRoot,
          parentRoot: message.parentRoot,
          parentIdentity: DocumentPendingRoot.identityFromWire(message.parentIdentity),
          parentMode: message.parentMode ?? undefined,
          jobRoot: message.jobRoot,
          jobRootIdentity: DocumentPendingRoot.identityFromWire(message.jobRootIdentity),
          pendingRoot: message.pendingRoot,
          pendingRootIdentity: DocumentPendingRoot.identityFromWire(message.pendingRootIdentity),
          sandboxAssetsRoot: dependencies.sandboxAssetsRoot,
          executablePath: dependencies.executablePath,
          manifestSha256: message.manifestSha256,
          platform: dependencies.platform,
          architecture: dependencies.architecture,
          ...(minimalGrants ? { minimalGrants } : {}),
        })
        .catch((error: unknown) => {
          report("policy preparation threw", error)
          return undefined
        })
    const echoesLaunch = (candidate: PreparedPolicy) =>
      candidate.target === message.target &&
      candidate.runtimeRoot === message.runtimeRoot &&
      candidate.parentRoot === message.parentRoot &&
      sameIdentity(candidate.parentIdentity, DocumentPendingRoot.identityFromWire(message.parentIdentity)) &&
      candidate.parentMode === (message.parentMode ?? undefined) &&
      candidate.jobRoot === message.jobRoot &&
      sameIdentity(candidate.jobRootIdentity, DocumentPendingRoot.identityFromWire(message.jobRootIdentity)) &&
      candidate.pendingRoot === message.pendingRoot &&
      sameIdentity(candidate.pendingRootIdentity, DocumentPendingRoot.identityFromWire(message.pendingRootIdentity)) &&
      candidate.sandboxAssets.root === dependencies.sandboxAssetsRoot &&
      candidate.executablePath === dependencies.executablePath &&
      candidate.runtimeAssets.bootstrap ===
        pathForPlatform(dependencies.platform).join(message.runtimeRoot, "worker", "bootstrap.js")
    const prepared = await preparePolicy(false)
    if (stopStarting()) return shutdownPromise
    if (!prepared || prepared.status !== "available") {
      if (prepared) report(`policy preparation failed: ${prepared.code}`)
      fail("sandbox-unavailable", "sandbox")
      return shutdown()
    }
    policy = prepared.value
    if (!echoesLaunch(policy)) {
      report("prepared policy does not echo the launch request")
      fail("sandbox-unavailable", "sandbox")
      return shutdown()
    }
    outputReceiver = dependencies.createOutputReceiver(
      {
        parentRoot: message.parentRoot,
        parentIdentity: DocumentPendingRoot.identityFromWire(message.parentIdentity),
        parentMode: message.parentMode,
        pendingRoot: message.pendingRoot,
        pendingRootIdentity: DocumentPendingRoot.identityFromWire(message.pendingRootIdentity),
      },
      message.start,
    )

    if (stopStarting()) return shutdownPromise
    initialized = true
    try {
      await dependencies.manager.initialize(policy.config, undefined, false)
    } catch (error) {
      report("sandbox initialization failed", error)
      // A single unwritable DACL rolls back the whole Windows grant batch (for example when Koala is
      // installed outside Program Files); upstream clears its state, so retry with the job roots only.
      const fallback = dependencies.platform === "win32" ? await preparePolicy(true) : undefined
      if (stopStarting()) return shutdownPromise
      if (!fallback || fallback.status !== "available" || !echoesLaunch(fallback.value)) {
        fail("sandbox-unavailable", "sandbox")
        return shutdown()
      }
      try {
        await dependencies.manager.initialize(fallback.value.config, undefined, false)
        policy = fallback.value
        report("sandbox initialized with minimal Windows grants")
      } catch (retryError) {
        report("sandbox initialization retry failed", retryError)
        fail("sandbox-unavailable", "sandbox")
        return shutdown()
      }
    }
    if (stopStarting()) return shutdownPromise
    const dependencyResult = await dependencies
      .verifyDependencies(dependencies.manager)
      .catch((error: unknown) => {
        report("dependency check threw", error)
        return undefined
      })
    if (stopStarting()) return shutdownPromise
    if (!dependencyResult || dependencyResult.status !== "available") {
      if (dependencyResult) report(`dependency check failed: ${dependencyResult.code}`)
      fail("dependency-failed", "dependency")
      return shutdown()
    }
    if (stopStarting()) return shutdownPromise
    const effective = await dependencies
      .verifyEffectivePolicy(dependencies.manager, policy.config, policy.target)
      .catch((error: unknown) => {
        report("effective policy check threw", error)
        return undefined
      })
    if (stopStarting()) return shutdownPromise
    if (!effective || effective.status !== "available") {
      if (effective) report(`effective policy check failed: ${effective.code}`)
      fail("sandbox-unavailable", "sandbox")
      return shutdown()
    }

    if (stopStarting()) return shutdownPromise
    let wrapped: WrappedCommand
    wrapAbort = new AbortController()
    try {
      wrapped = dependencies.applyHandoffEnvironment(
        await dependencies.manager.wrapWithSandboxArgv(
          policy.command.command,
          policy.command.binShell,
          undefined,
          wrapAbort.signal,
          policy.jobRoot,
          { commandId: message.jobID, commandText: "document-runtime-bootstrap" },
        ),
        policy.handoffEnvironment,
        policy.brokerEnvironment,
        dependencies.platform,
      )
    } catch (error) {
      report("sandbox command wrapping failed", error)
      if (!selectedFailure) {
        fail(cancellationSent ? "worker-crashed" : "spawn-failed", cancellationSent ? "worker" : "spawn")
      }
      return shutdown()
    } finally {
      wrapAbort = undefined
    }
    if (stopStarting()) return shutdownPromise
    const executable = wrapped.argv[0]
    if (!executable) {
      fail("spawn-failed", "spawn")
      return shutdown()
    }
    try {
      child = dependencies.spawnCommand(executable, wrapped.argv.slice(1), {
        cwd: policy.jobRoot,
        env: wrapped.env,
        shell: false,
        detached: dependencies.platform !== "win32",
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      })
    } catch {
      fail("spawn-failed", "spawn")
      return shutdown()
    }
    if (!child.stdin || !child.stdout || !child.stderr) {
      fail("spawn-failed", "spawn")
      return shutdown()
    }
    try {
      child.once("error", onChildError)
      child.once("exit", onChildExit)
      child.once("close", onChildClose)
      child.stderr.on("data", onStderr)
      child.stderr.on("error", onStderrError)
      transport = dependencies.createTransport(child.stdout, child.stdin)
      transport.onMessage(onInnerMessage)
      transport.onDisconnect(onInnerDisconnect)
    } catch {
      fail("spawn-failed", "spawn")
      return shutdown()
    }
    phase = "active"
    try {
      if (!child.pid) {
        fail("spawn-failed", "spawn")
        return shutdown()
      }
      await send({ protocolVersion: 1, type: "accepted", jobID: message.jobID, innerProcessID: child.pid })
      accepted = true
      await transport.send(DocumentRuntimeProtocol.decodeInitialRequest(message.start))
    } catch {
      fail("transport-overflow", "transport")
      return shutdown()
    }
  }

  const handleParent = async (input: unknown) => {
    let message: DocumentSandboxProtocol.ParentRequest
    try {
      const encoded = JSON.stringify(input)
      if (encoded === undefined || Buffer.byteLength(encoded) > DocumentRuntimeLimits.MaxOuterIpcMessageBytes) {
        fail("transport-overflow", "transport")
        return shutdown()
      }
      message = DocumentSandboxProtocol.decodeParentRequest(JSON.parse(encoded))
    } catch {
      fail(
        protocolMismatch(input)
          ? "protocol-mismatch"
          : phase === "awaiting-launch"
            ? "invalid-launch"
            : "protocol-mismatch",
        phase === "awaiting-launch" ? "launch" : "transport",
      )
      return shutdown()
    }
    if (phase === "awaiting-launch" && message.type === "launch") return launchChild(message)
    if (message.type === "command") return command(message)
    if (message.type === "cancel") return cancel(message)
    fail("protocol-mismatch", "transport")
    return shutdown()
  }
  const drainParent = async () => {
    if (processing) return
    processing = true
    while (parentQueue.length > 0 && phase !== "finishing" && phase !== "closed") {
      await handleParent(parentQueue.shift())
    }
    processing = false
  }
  function onParentMessage(input: unknown) {
    if (phase === "finishing" || phase === "closed") return
    if (phase === "starting") {
      let message: DocumentSandboxProtocol.ParentRequest
      try {
        const encoded = JSON.stringify(input)
        if (encoded === undefined || Buffer.byteLength(encoded) > DocumentRuntimeLimits.MaxOuterIpcMessageBytes) {
          fail("transport-overflow", "transport")
          wrapAbort?.abort()
          return
        }
        message = DocumentSandboxProtocol.decodeParentRequest(JSON.parse(encoded))
      } catch {
        fail(protocolMismatch(input) ? "protocol-mismatch" : "invalid-launch", "transport")
        wrapAbort?.abort()
        return
      }
      if (message.type === "cancel") {
        if (message.jobID !== launch?.jobID || cancellationSent) fail("protocol-mismatch", "transport")
        else cancellationSent = true
        wrapAbort?.abort()
        return
      }
      fail("protocol-mismatch", "transport")
      wrapAbort?.abort()
      return
    }
    if (parentQueue.length >= DocumentRuntimeLimits.MaxOuterPendingMessages) {
      fail("transport-overflow", "transport")
      void shutdown()
      return
    }
    parentQueue.push(input)
    void drainParent()
  }
  function onParentDisconnect() {
    for (const complete of [...parentSendWaiters]) complete(new Error("parent-disconnected"))
    fail("transport-overflow", "transport")
    if (phase === "starting") {
      wrapAbort?.abort()
      return
    }
    void shutdown()
  }

  dependencies.parent.onMessage(onParentMessage)
  dependencies.parent.onDisconnect(onParentDisconnect)
  return done
}

function within(action: () => void | Promise<void>, timeoutMs: number, timers: TimerDependencies) {
  return new Promise<boolean>((resolve) => {
    let settled = false
    let timer: unknown
    const complete = (value: boolean) => {
      if (settled) return
      settled = true
      timers.clear(timer)
      resolve(value)
    }
    timer = timers.set(() => complete(false), timeoutMs)
    void Promise.resolve()
      .then(action)
      .then(
        () => complete(true),
        () => complete(false),
      )
  })
}

function protocolMismatch(input: unknown) {
  return (
    typeof input === "object" &&
    input !== null &&
    "protocolVersion" in input &&
    (input as { readonly protocolVersion?: unknown }).protocolVersion !== 1
  )
}

function isOutputInput(input: unknown) {
  return (
    typeof input === "object" &&
    input !== null &&
    "type" in input &&
    (input.type === "output-start" || input.type === "output-chunk" || input.type === "output-end")
  )
}

function pathForPlatform(platform: NodeJS.Platform) {
  return platform === "win32" ? path.win32 : path.posix
}

function sameIdentity(
  left: { readonly dev: bigint; readonly ino: bigint },
  right: { readonly dev: bigint; readonly ino: bigint },
) {
  return left.dev === right.dev && left.ino === right.ino
}

function processParentPort(): ParentPort {
  return {
    connected: () => process.connected,
    onMessage: (listener) => process.on("message", listener),
    offMessage: (listener) => process.off("message", listener),
    onDisconnect: (listener) => process.on("disconnect", listener),
    offDisconnect: (listener) => process.off("disconnect", listener),
    send: (value, callback) => process.send?.(value, callback) ?? false,
    disconnect: () => process.disconnect?.(),
  }
}

const entrypoint = process.argv[1]
if (entrypoint && pathToFileURL(path.resolve(entrypoint)).href === import.meta.url) void startProxy()

export * as DocumentProxy from "./proxy"
