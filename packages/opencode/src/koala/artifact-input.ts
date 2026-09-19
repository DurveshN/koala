import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import type { BigIntStats } from "node:fs"
import { chmod, lstat, open } from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import path from "node:path"
import { Artifact } from "@koala-ai/core/artifact/artifact"
import { ArtifactStore } from "@koala-ai/core/artifact/store"
import { IndustrialInput } from "@koala-ai/core/industrial/input"
import { IndustrialResult } from "@koala-ai/core/industrial/result"
import { SandboxProtocol } from "@koala-ai/core/sandbox/protocol"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { Context, Effect, Layer, Schema, Scope, Stream } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { assertExternalDirectoryEffect } from "@/tool/external-directory"
import type { Tool } from "@/tool/tool"
import { ArtifactStoreLive } from "./artifact-store"

const ChunkBytes = 64 * 1024
const ReadFlags = constants.O_RDONLY | (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0)

const HostErrorCodes = [
  "invalid-input",
  "permission-denied",
  "source-not-found",
  "source-access-denied",
  "source-not-owned",
  "source-changed",
  "source-invalid",
  "input-too-large",
  "artifact-storage-failed",
] as const satisfies ReadonlyArray<IndustrialResult.GeneralErrorCode>
export const HostErrorCode = Schema.Literals(HostErrorCodes)
export type HostErrorCode = typeof HostErrorCode.Type

export class HostError extends Schema.TaggedErrorClass<HostError>()("ArtifactInputHostError", {
  code: HostErrorCode,
}) {
  override get message() {
    return `Artifact input failed: ${this.code}`
  }
}

export interface ResolveInput {
  readonly source: IndustrialInput.Source
  readonly provenance: Artifact.Provenance
  readonly context: Tool.Context
}

export interface Resolved {
  readonly artifact: Artifact.Metadata
  readonly snapshotPath: string
}

export interface Interface {
  readonly resolve: (input: ResolveInput) => Effect.Effect<Resolved, HostError, Scope.Scope>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ArtifactInput") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const store = yield* ArtifactStore.Service
    const decodeSource = Schema.decodeUnknownEffect(IndustrialInput.Source)
    const decodeProvenance = Schema.decodeUnknownEffect(Artifact.Provenance)

    const resolve = Effect.fn("ArtifactInput.resolve")(function* (unsafeInput: ResolveInput) {
      const source = yield* decodeSource(unsafeInput.source).pipe(Effect.mapError(() => hostError("invalid-input")))
      const provenance = yield* decodeProvenance(unsafeInput.provenance).pipe(
        Effect.mapError(() => hostError("invalid-input")),
      )
      if (
        provenance.sessionID !== unsafeInput.context.sessionID ||
        provenance.messageID !== unsafeInput.context.messageID ||
        provenance.toolCallID !== unsafeInput.context.callID
      ) {
        return yield* hostError("invalid-input")
      }

      if (source.artifactID !== undefined) return yield* resolveArtifact(store, source.artifactID, unsafeInput.context)
      return yield* resolvePath(store, source.path, provenance, unsafeInput.context)
    })

    return Service.of({ resolve })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [ArtifactStoreLive.node] })

function resolveArtifact(store: ArtifactStore.Interface, artifactID: Artifact.ID, context: Tool.Context) {
  return Effect.gen(function* () {
    const metadata = yield* store
      .metadata(artifactID)
      .pipe(
        Effect.mapError((error) =>
          error instanceof ArtifactStore.ArtifactNotFoundError
            ? hostError("source-not-found")
            : hostError("artifact-storage-failed"),
        ),
      )
    if (metadata.provenance.sessionID !== context.sessionID) return yield* hostError("source-not-owned")

    const staging = yield* acquireStaging(store)
    const snapshotPath = path.join(staging.work, metadata.name)
    const content = store
      .content(artifactID)
      .pipe(
        Stream.mapError((error) =>
          error instanceof ArtifactStore.ArtifactNotFoundError
            ? hostError("source-not-found")
            : error instanceof ArtifactStore.CorruptionError
              ? hostError("source-invalid")
              : hostError("artifact-storage-failed"),
        ),
      )
    yield* writeSnapshot(content, snapshotPath, metadata.size, metadata.digest)
    return { artifact: immutableMetadata(metadata), snapshotPath }
  })
}

function resolvePath(
  store: ArtifactStore.Interface,
  sourcePath: IndustrialInput.Path,
  provenance: Artifact.Provenance,
  context: Tool.Context,
) {
  return Effect.gen(function* () {
    const instance = yield* InstanceState.context
    const resolved = path.isAbsolute(sourcePath)
      ? path.resolve(sourcePath)
      : path.resolve(instance.directory, sourcePath)
    const target = process.platform === "win32" ? path.normalize(resolved) : resolved

    yield* assertExternalDirectoryEffect(context, target).pipe(Effect.catchDefect(() => hostError("permission-denied")))
    yield* context
      .ask({
        permission: "read",
        patterns: [path.relative(instance.worktree, target)],
        always: ["*"],
        metadata: {},
      })
      .pipe(Effect.catchDefect(() => hostError("permission-denied")))

    const inspected = yield* Effect.tryPromise({
      try: () => inspectSource(target),
      catch: mapHostFailure,
    })
    const outputPath = yield* Schema.decodeUnknownEffect(Artifact.OutputPath)(path.basename(target)).pipe(
      Effect.mapError(() => hostError("source-invalid")),
    )
    const staging = yield* acquireStaging(store)
    const snapshotPath = path.join(staging.artifacts, outputPath)

    yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => open(target, ReadFlags),
        catch: mapOpenFailure,
      }),
      (source) =>
        Effect.tryPromise({
          try: () => copySource(source, inspected, snapshotPath),
          catch: mapHostFailure,
        }),
      (source) => Effect.promise(() => source.close()).pipe(Effect.ignore),
    )
    yield* Effect.tryPromise({
      try: () => chmod(snapshotPath, 0o400),
      catch: () => hostError("artifact-storage-failed"),
    })

    const sourceProjectPath = projectPath(instance.worktree, target)
    const artifact = yield* store
      .promote({
        runID: staging.runID,
        outputPath,
        provenance: {
          ...provenance,
          ...(sourceProjectPath === undefined ? {} : { sourceProjectPath }),
        },
      })
      .pipe(Effect.mapError(mapPromotionError))
    return { artifact: immutableMetadata(artifact), snapshotPath }
  })
}

function acquireStaging(store: ArtifactStore.Interface) {
  const runID = Schema.decodeUnknownSync(SandboxProtocol.RunID)(`artifact-input-${randomUUID()}`)
  return Effect.acquireRelease(
    store.stage(runID).pipe(Effect.mapError(() => hostError("artifact-storage-failed"))),
    (staging) => store.abandon(staging.runID).pipe(Effect.ignore),
  )
}

function writeSnapshot(
  content: Stream.Stream<Uint8Array, HostError>,
  snapshotPath: string,
  expectedSize: Artifact.ByteSize,
  expectedDigest: Artifact.Digest,
) {
  const hash = createHash("sha256")
  return Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => open(snapshotPath, "wx", 0o600),
      catch: () => hostError("artifact-storage-failed"),
    }),
    (destination) =>
      Stream.runFoldEffect(
        content,
        () => 0,
        (total, chunk) =>
          Effect.tryPromise({
            try: () => writeAll(destination, chunk),
            catch: () => hostError("artifact-storage-failed"),
          }).pipe(
            Effect.tap(() => Effect.sync(() => hash.update(chunk))),
            Effect.as(total + chunk.byteLength),
          ),
      ).pipe(
        Effect.flatMap((total) =>
          total === expectedSize && hash.digest("hex") === expectedDigest ? Effect.void : hostError("source-changed"),
        ),
        Effect.andThen(
          Effect.tryPromise({
            try: () => destination.sync(),
            catch: () => hostError("artifact-storage-failed"),
          }),
        ),
      ),
    (destination) => Effect.promise(() => destination.close()).pipe(Effect.ignore),
  ).pipe(
    Effect.andThen(
      Effect.tryPromise({
        try: () => chmod(snapshotPath, 0o400),
        catch: () => hostError("artifact-storage-failed"),
      }),
    ),
  )
}

async function inspectSource(target: string) {
  const root = path.parse(target).root
  const parts = path.relative(root, target).split(path.sep).filter(Boolean)
  let current = root
  let candidate: BigIntStats | undefined

  for (const [index, part] of parts.entries()) {
    current = path.join(current, part)
    const info = await safeLstat(current)
    const final = index === parts.length - 1
    if (info.isSymbolicLink()) throw new UnsafeSource()
    if (!final && !info.isDirectory()) throw new UnsafeSource()
    if (final && (!info.isFile() || info.nlink !== 1n)) throw new UnsafeSource()
    candidate = info
  }
  if (!candidate) throw new UnsafeSource()
  return candidate
}

async function safeLstat(target: string) {
  try {
    return await lstat(target, { bigint: true })
  } catch (error) {
    if (hasCode(error, "ENOENT")) throw new MissingSource()
    if (hasCode(error, "EACCES") || hasCode(error, "EPERM")) throw new SourceAccessDenied()
    throw new SourceAccessDenied()
  }
}

async function copySource(source: FileHandle, inspected: BigIntStats, destinationPath: string) {
  const before = await source.stat({ bigint: true }).catch(() => {
    throw new SourceAccessDenied()
  })
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || !sameIdentity(inspected, before)) {
    throw new UnsafeSource()
  }
  if (before.size > BigInt(Artifact.MaxArtifactBytes)) throw new InputTooLarge()

  const destination = await open(destinationPath, "wx", 0o600).catch(() => {
    throw new StorageFailure()
  })
  try {
    const buffer = Buffer.allocUnsafe(ChunkBytes)
    let total = 0
    while (true) {
      const result = await source.read(buffer, 0, buffer.byteLength, total).catch(() => {
        throw new SourceAccessDenied()
      })
      if (result.bytesRead === 0) break
      total += result.bytesRead
      if (total > Artifact.MaxArtifactBytes) throw new InputTooLarge()
      await writeAll(destination, buffer.subarray(0, result.bytesRead)).catch(() => {
        throw new StorageFailure()
      })
    }
    const after = await source.stat({ bigint: true }).catch(() => {
      throw new SourceAccessDenied()
    })
    if (!sameFile(before, after) || BigInt(total) !== before.size) throw new ChangedSource()
    await destination.sync().catch(() => {
      throw new StorageFailure()
    })
  } finally {
    await destination.close().catch(() => undefined)
  }
}

async function writeAll(handle: FileHandle, bytes: Uint8Array) {
  let offset = 0
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset)
    if (result.bytesWritten === 0) throw new StorageFailure()
    offset += result.bytesWritten
  }
}

function projectPath(worktree: string, target: string): Artifact.SourceProjectPath | undefined {
  if (worktree === path.parse(worktree).root) return undefined
  const relative = path.relative(worktree, target)
  if (relative.length === 0 || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    return undefined
  }
  const normalized = relative.split(path.sep).join("/")
  return Schema.is(Artifact.SourceProjectPath)(normalized) ? normalized : undefined
}

function immutableMetadata(metadata: Artifact.Metadata): Artifact.Metadata {
  return Object.freeze({
    ...metadata,
    validation: Object.freeze({
      ...metadata.validation,
      findings: Object.freeze(metadata.validation.findings.map((finding) => Object.freeze({ ...finding }))),
    }),
    provenance: Object.freeze({ ...metadata.provenance }),
    lineage: Object.freeze(metadata.lineage.map((lineage) => Object.freeze({ ...lineage }))),
  })
}

function mapPromotionError(error: ArtifactStore.PromoteError) {
  if (error instanceof ArtifactStore.LimitError) return hostError("input-too-large")
  if (error instanceof ArtifactStore.CandidateNotFoundError) return hostError("source-changed")
  if (error instanceof ArtifactStore.ValidationError) return hostError("source-invalid")
  return hostError("artifact-storage-failed")
}

function mapHostFailure(error: unknown) {
  if (error instanceof MissingSource) return hostError("source-not-found")
  if (error instanceof SourceAccessDenied) return hostError("source-access-denied")
  if (error instanceof ChangedSource) return hostError("source-changed")
  if (error instanceof UnsafeSource) return hostError("source-invalid")
  if (error instanceof InputTooLarge) return hostError("input-too-large")
  if (hasCode(error, "ENOENT")) return hostError("source-not-found")
  if (hasCode(error, "EACCES") || hasCode(error, "EPERM")) return hostError("source-access-denied")
  if (hasCode(error, "ELOOP")) return hostError("source-invalid")
  return hostError("artifact-storage-failed")
}

function mapOpenFailure(error: unknown) {
  if (hasCode(error, "ENOENT")) return hostError("source-changed")
  return mapHostFailure(error)
}

function hostError(code: HostErrorCode) {
  return new HostError({ code })
}

function sameIdentity(left: BigIntStats, right: BigIntStats) {
  return left.dev === right.dev && left.ino === right.ino
}

function sameFile(left: BigIntStats, right: BigIntStats) {
  return (
    sameIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  )
}

function hasCode(error: unknown, code: string) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code
}

class MissingSource extends Error {}
class SourceAccessDenied extends Error {}
class UnsafeSource extends Error {}
class ChangedSource extends Error {}
class InputTooLarge extends Error {}
class StorageFailure extends Error {}

export * as ArtifactInput from "./artifact-input"
