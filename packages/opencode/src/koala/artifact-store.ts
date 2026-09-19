import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import type { BigIntStats } from "node:fs"
import { chmod, link, lstat, mkdir, open, readdir, rm, unlink } from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import path from "node:path"
import { Artifact } from "@koala-ai/core/artifact/artifact"
import { ArtifactStore } from "@koala-ai/core/artifact/store"
import { SandboxProtocol } from "@koala-ai/core/sandbox/protocol"
import { ArtifactBlobTable, ArtifactLineageTable, ArtifactTable } from "@opencode-ai/core/artifact/sql"
import { Database } from "@opencode-ai/core/database/database"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { Global } from "@opencode-ai/core/global"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { count, eq, isNull, sql } from "drizzle-orm"
import { Cause, Context, Effect, Exit, Layer, Schema, Semaphore, Stream } from "effect"

const ChunkBytes = 64 * 1024
const ReadFlags = constants.O_RDONLY | (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0)

class MissingCandidate extends Error {}
class UnsafeCandidate extends Error {}
class CorruptBlob extends Error {}
class SizeLimit extends Error {
  constructor(
    readonly kind: "artifact-size" | "run-size",
    readonly maximum: number,
    readonly actual: number,
  ) {
    super(kind)
  }
}

type CopiedCandidate = {
  readonly digest: Artifact.Digest
  readonly size: Artifact.ByteSize
  readonly mime: Artifact.MimeType
  readonly temporaryPath: string
}

const layer = Layer.effect(
  ArtifactStore.Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const global = yield* Global.Service
    const flock = yield* EffectFlock.Service
    const root = path.join(global.data, "koala", "artifacts")
    const stagingRoot = path.join(root, "staging")
    const blobRoot = path.join(root, "blobs", "sha256")
    const temporaryRoot = path.join(blobRoot, ".staging")
    const decodeRunID = Schema.decodeUnknownEffect(SandboxProtocol.RunID)
    const decodeOutputPath = Schema.decodeUnknownEffect(Artifact.OutputPath)
    const decodeName = Schema.decodeUnknownEffect(Artifact.Name)
    const decodeMetadata = Schema.decodeUnknownEffect(Artifact.Metadata)
    const decodeValidation = Schema.decodeUnknownEffect(Artifact.Validation)
    const decodeID = Schema.decodeUnknownSync(Artifact.ID)
    const decodeDigest = Schema.decodeUnknownSync(Artifact.Digest)
    const decodeSize = Schema.decodeUnknownSync(Artifact.ByteSize)
    const decodeMime = Schema.decodeUnknownSync(Artifact.MimeType)
    const acceptedValidation = Schema.decodeUnknownSync(Artifact.Validation)({
      state: "accepted",
      validator: Artifact.ValidatorName,
      validatorVersion: Artifact.ValidatorVersion,
      findings: [],
    })
    const promotionLock = yield* Semaphore.make(1)
    const activeRuns = new Set<SandboxProtocol.RunID>()

    const reconcile = Effect.fn("ArtifactStore.reconcile")(() =>
      promotionLock.withPermit(
        flock
          .withLock(reconcileBlobs(db, blobRoot, stagingRoot, temporaryRoot, activeRuns), `artifact-promotion:${root}`)
          .pipe(Effect.mapError(() => new ArtifactStore.ReconciliationError())),
      ),
    )

    yield* reconcile().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("artifact blob reconciliation failed; a later startup will retry", {
          cause: Cause.pretty(cause),
        }),
      ),
    )

    const stage = Effect.fn("ArtifactStore.stage")(function* (unsafeRunID: SandboxProtocol.RunID) {
      const runID = yield* decodeRunID(unsafeRunID).pipe(
        Effect.mapError(() => new ArtifactStore.StagingError({ runID: unsafeRunID })),
      )
      const runRoot = path.join(stagingRoot, runID)
      const work = path.join(runRoot, "work")
      const artifacts = path.join(runRoot, "artifacts")

      yield* Effect.tryPromise({
        try: async () => {
          await ensurePrivateDirectory(global.data, "koala")
          await ensurePrivateDirectory(path.join(global.data, "koala"), "artifacts")
          await ensurePrivateDirectory(root, "staging")
          await ensurePrivateDirectory(root, "blobs")
          await ensurePrivateDirectory(path.join(root, "blobs"), "sha256")
          await ensurePrivateDirectory(blobRoot, ".staging")
          await mkdir(runRoot, { mode: 0o700 })
          try {
            await ensurePrivateDirectory(runRoot, "work")
            await ensurePrivateDirectory(runRoot, "artifacts")
          } catch (error) {
            await rm(runRoot, { recursive: true, force: true }).catch(() => undefined)
            throw error
          }
        },
        catch: () => new ArtifactStore.StagingError({ runID }),
      })

      activeRuns.add(runID)
      return { runID, root: runRoot, work, artifacts }
    })

    const promoteBatch = Effect.fn("ArtifactStore.promoteBatch")(function* (
      inputs: ReadonlyArray<ArtifactStore.PromoteInput>,
      options?: ArtifactStore.PromoteOptions,
    ) {
      if (inputs.length === 0) return []
      const candidates = yield* Effect.forEach(inputs, (input) =>
        Effect.gen(function* () {
          const outputPath = yield* decodeOutputPath(input.outputPath).pipe(
            Effect.mapError(() => new ArtifactStore.InvalidOutputPathError({ path: String(input.outputPath) })),
          )
          const runID = yield* decodeRunID(input.runID).pipe(
            Effect.mapError(() => new ArtifactStore.InvalidOutputPathError({ path: outputPath })),
          )
          if (input.provenance.sandboxRunID !== undefined && input.provenance.sandboxRunID !== runID) {
            return yield* new ArtifactStore.PromotionError({ runID, outputPath })
          }
          const name = yield* decodeName(path.posix.basename(outputPath)).pipe(
            Effect.mapError(() => invalidName(outputPath)),
          )
          const artifacts = path.join(stagingRoot, runID, "artifacts")
          const candidate = resolveCandidate(artifacts, outputPath)
          if (!candidate) return yield* new ArtifactStore.InvalidOutputPathError({ path: outputPath })
          return { input, outputPath, runID, name, artifacts, candidate }
        }),
      )
      const first = candidates[0]
      if (!first) return []
      const mismatched = candidates.find((candidate) => candidate.runID !== first.runID)
      if (mismatched) {
        return yield* new ArtifactStore.PromotionError({
          runID: mismatched.runID,
          outputPath: mismatched.outputPath,
        })
      }

      return yield* promotionLock.withPermit(
        flock.withLock(
          Effect.gen(function* () {
          const existing = yield* db
            .select({
              count: count(),
              bytes: sql<number>`coalesce(sum(${ArtifactBlobTable.size}), 0)`.mapWith(Number),
            })
            .from(ArtifactTable)
            .innerJoin(ArtifactBlobTable, eq(ArtifactTable.digest, ArtifactBlobTable.digest))
            .where(eq(ArtifactTable.sandbox_run_id, first.runID))
            .get()
            .pipe(
              Effect.mapError(
                () => new ArtifactStore.PromotionError({ runID: first.runID, outputPath: first.outputPath }),
              ),
            )
          if ((existing?.count ?? 0) + candidates.length > Artifact.MaxOutputsPerRun) {
            return yield* new ArtifactStore.LimitError({
              kind: "output-count",
              maximum: Artifact.MaxOutputsPerRun,
              actual: (existing?.count ?? 0) + candidates.length,
            })
          }
          const temporaryPaths = candidates.map(() => path.join(temporaryRoot, `.${process.pid}.${randomUUID()}.tmp`))

          return yield* Effect.acquireUseRelease(
            Effect.succeed(temporaryPaths),
            (paths) =>
              Effect.gen(function* () {
                const copied = yield* Effect.forEach(candidates, (item, index) =>
                  Effect.tryPromise({
                    try: () => copyCandidate(item.candidate, item.artifacts, paths[index] ?? "", existing?.bytes ?? 0),
                    catch: (error) => copyError(error, item.runID, item.outputPath),
                  }),
                )
                const totalBytes = copied.reduce((total, item) => total + item.size, existing?.bytes ?? 0)
                if (totalBytes > Artifact.MaxRunBytes) {
                  return yield* new ArtifactStore.LimitError({
                    kind: "run-size",
                    maximum: Artifact.MaxRunBytes,
                    actual: totalBytes,
                  })
                }
                const metadata = yield* Effect.forEach(candidates, (item, index) =>
                  decodeMetadata({
                    id: decodeID(`art_${randomUUID()}`),
                    name: item.name,
                    mime: copied[index]?.mime,
                    size: copied[index]?.size,
                    digest: copied[index]?.digest,
                    validation: acceptedValidation,
                    provenance: item.input.provenance,
                    lineage: item.input.lineage ?? [],
                    timeCreated: Date.now(),
                  }).pipe(
                    Effect.mapError(
                      () => new ArtifactStore.PromotionError({ runID: item.runID, outputPath: item.outputPath }),
                    ),
                  ),
                )
                const published = new Set<Artifact.Digest>()
                let commitBegan = false
                const transactionExit = yield* Effect.uninterruptible(
                  Effect.gen(function* () {
                  if (options?.signal?.aborted) {
                    return yield* new ArtifactStore.PromotionAbortedError({ runID: first.runID })
                  }
                  if (options?.commit) {
                    if (!options.commit.boundary.begin(options.commit.result(metadata))) {
                      return yield* new ArtifactStore.PromotionAbortedError({ runID: first.runID })
                    }
                    commitBegan = true
                  }
                  yield* Effect.yieldNow
                  const outcome = yield* Effect.gen(function* () {
                    yield* Effect.forEach(copied, (item, index) =>
                      publishBlob(item, blobRoot).pipe(
                        Effect.tap((created) => Effect.sync(() => created && published.add(item.digest))),
                        Effect.mapError((error) =>
                          error instanceof CorruptBlob
                            ? new ArtifactStore.CorruptionError({ digest: item.digest })
                            : new ArtifactStore.PromotionError({
                                runID: first.runID,
                                outputPath: candidates[index]?.outputPath ?? first.outputPath,
                              }),
                        ),
                      ),
                    )

                    return yield* db
                      .transaction((tx) =>
                        Effect.gen(function* () {
                        yield* tx
                          .insert(ArtifactBlobTable)
                          .values(
                            metadata.map((item) => ({
                              digest: item.digest,
                              size: item.size,
                              time_created: item.timeCreated,
                            })),
                          )
                          .onConflictDoNothing({ target: ArtifactBlobTable.digest })
                          .run()
                        yield* Effect.forEach(metadata, (item) =>
                          Effect.gen(function* () {
                            const blob = yield* tx
                              .select({ size: ArtifactBlobTable.size })
                              .from(ArtifactBlobTable)
                              .where(eq(ArtifactBlobTable.digest, item.digest))
                              .get()
                            if (blob?.size !== item.size) {
                              return yield* Effect.fail(new Error("Artifact blob metadata mismatch"))
                            }
                          }),
                        )
                        const current = yield* tx
                          .select({
                            count: count(),
                            bytes: sql<number>`coalesce(sum(${ArtifactBlobTable.size}), 0)`.mapWith(Number),
                          })
                          .from(ArtifactTable)
                          .innerJoin(ArtifactBlobTable, eq(ArtifactTable.digest, ArtifactBlobTable.digest))
                          .where(eq(ArtifactTable.sandbox_run_id, first.runID))
                          .get()
                        if ((current?.count ?? 0) + metadata.length > Artifact.MaxOutputsPerRun) {
                          return yield* new ArtifactStore.LimitError({
                            kind: "output-count",
                            maximum: Artifact.MaxOutputsPerRun,
                            actual: (current?.count ?? 0) + metadata.length,
                          })
                        }
                        const currentTotal = (current?.bytes ?? 0) + metadata.reduce((sum, item) => sum + item.size, 0)
                        if (currentTotal > Artifact.MaxRunBytes) {
                          return yield* new ArtifactStore.LimitError({
                            kind: "run-size",
                            maximum: Artifact.MaxRunBytes,
                            actual: currentTotal,
                          })
                        }
                        yield* tx.insert(ArtifactTable).values(metadata.map(artifactRow)).run()
                        const lineage = metadata.flatMap((item) =>
                          item.lineage.map((entry) => ({
                            artifact_id: item.id,
                            source_artifact_id: entry.sourceArtifactID,
                            relation: entry.relation,
                          })),
                        )
                        if (lineage.length > 0) yield* tx.insert(ArtifactLineageTable).values(lineage).run()
                        }),
                      )
                      .pipe(
                        Effect.as(metadata),
                        Effect.mapError((error) =>
                          error instanceof ArtifactStore.LimitError
                            ? error
                            : new ArtifactStore.PromotionError({ runID: first.runID, outputPath: first.outputPath }),
                        ),
                      )
                  }).pipe(Effect.exit)
                  if (Exit.isSuccess(outcome)) {
                    options?.commit?.boundary.complete()
                    return outcome
                  }
                  if (commitBegan) options?.commit?.boundary.rollback()
                  const cleanupExit = yield* removeUnreferencedBlobs(db, blobRoot, published).pipe(Effect.exit)
                  if (Exit.isFailure(cleanupExit)) {
                    yield* Effect.logWarning("artifact rollback cleanup failed; startup reconciliation will retry", {
                      digests: [...published],
                      cause: Cause.pretty(cleanupExit.cause),
                    })
                  }
                  return outcome
                  }),
                )
                if (Exit.isSuccess(transactionExit)) return transactionExit.value
                return yield* Effect.failCause(transactionExit.cause)
              }),
            (paths) =>
              Effect.forEach(paths, (temporaryPath) => Effect.promise(() => rm(temporaryPath, { force: true }))).pipe(
                Effect.ignore,
              ),
          )
          }),
          `artifact-promotion:${root}`,
        ).pipe(
          Effect.mapError((error) =>
            error instanceof EffectFlock.LockTimeoutError || error instanceof EffectFlock.LockCompromisedError
              ? new ArtifactStore.PromotionError({ runID: first.runID, outputPath: first.outputPath })
              : error,
          ),
        ),
      )
    })

    const promote = Effect.fn("ArtifactStore.promote")(function* (
      input: ArtifactStore.PromoteInput,
      options?: ArtifactStore.PromoteOptions,
    ) {
      const result = yield* promoteBatch([input], options)
      const metadata = result[0]
      if (metadata) return metadata
      return yield* new ArtifactStore.PromotionError({ runID: input.runID, outputPath: input.outputPath })
    })

    const metadata = Effect.fn("ArtifactStore.metadata")(function* (artifactID: Artifact.ID) {
      const row = yield* db
        .select({
          id: ArtifactTable.id,
          digest: ArtifactTable.digest,
          name: ArtifactTable.name,
          mime: ArtifactTable.mime,
          size: ArtifactBlobTable.size,
          validation: ArtifactTable.validation,
          sessionID: ArtifactTable.owner_session_id,
          messageID: ArtifactTable.owner_message_id,
          toolName: ArtifactTable.tool_name,
          toolCallID: ArtifactTable.tool_call_id,
          sandboxRunID: ArtifactTable.sandbox_run_id,
          sourceProjectPath: ArtifactTable.source_project_path,
          timeCreated: ArtifactTable.time_created,
        })
        .from(ArtifactTable)
        .innerJoin(ArtifactBlobTable, eq(ArtifactTable.digest, ArtifactBlobTable.digest))
        .where(eq(ArtifactTable.id, artifactID))
        .get()
        .pipe(Effect.mapError(() => new ArtifactStore.MetadataReadError({ artifactID })))
      if (!row) return yield* new ArtifactStore.ArtifactNotFoundError({ artifactID })
      const lineage = yield* db
        .select({ sourceArtifactID: ArtifactLineageTable.source_artifact_id, relation: ArtifactLineageTable.relation })
        .from(ArtifactLineageTable)
        .where(eq(ArtifactLineageTable.artifact_id, artifactID))
        .all()
        .pipe(Effect.mapError(() => new ArtifactStore.MetadataReadError({ artifactID })))

      return yield* decodeMetadata({
        id: row.id,
        digest: row.digest,
        name: row.name,
        mime: row.mime,
        size: row.size,
        validation: row.validation,
        provenance: {
          sessionID: row.sessionID,
          messageID: row.messageID,
          toolName: row.toolName,
          ...(row.toolCallID === null ? {} : { toolCallID: row.toolCallID }),
          ...(row.sandboxRunID === null ? {} : { sandboxRunID: row.sandboxRunID }),
          ...(row.sourceProjectPath === null ? {} : { sourceProjectPath: row.sourceProjectPath }),
        },
        lineage,
        timeCreated: row.timeCreated,
      }).pipe(Effect.mapError(() => new ArtifactStore.MetadataReadError({ artifactID })))
    })

    const content = (artifactID: Artifact.ID): Stream.Stream<Uint8Array, ArtifactStore.ContentError> =>
      Stream.scoped(
        Stream.fromEffect(
          Effect.acquireRelease(
            Effect.gen(function* () {
              const row = yield* db
                .select({
                  digest: ArtifactTable.digest,
                  size: ArtifactBlobTable.size,
                  validationState: ArtifactTable.validation_state,
                  validator: ArtifactTable.validator,
                  validatorVersion: ArtifactTable.validator_version,
                  validation: ArtifactTable.validation,
                })
                .from(ArtifactTable)
                .innerJoin(ArtifactBlobTable, eq(ArtifactTable.digest, ArtifactBlobTable.digest))
                .where(eq(ArtifactTable.id, artifactID))
                .get()
                .pipe(Effect.mapError(() => new ArtifactStore.ContentAccessError({ artifactID })))
              if (!row) return yield* new ArtifactStore.ArtifactNotFoundError({ artifactID })
              const validation = yield* decodeValidation(row.validation).pipe(
                Effect.mapError(() => new ArtifactStore.ContentAccessError({ artifactID })),
              )
              if (
                validation.state !== "accepted" ||
                validation.state !== row.validationState ||
                validation.validator !== row.validator ||
                validation.validatorVersion !== row.validatorVersion
              ) {
                return yield* new ArtifactStore.ContentAccessError({ artifactID })
              }
              const digest = decodeDigest(row.digest)
              const filepath = blobPath(blobRoot, digest)
              const info = yield* Effect.tryPromise({
                try: () => lstat(filepath, { bigint: true }),
                catch: () => new ArtifactStore.ContentAccessError({ artifactID }),
              })
              if (!info.isFile() || info.isSymbolicLink()) {
                return yield* new ArtifactStore.CorruptionError({ digest })
              }
              const handle = yield* Effect.tryPromise({
                try: () => open(filepath, ReadFlags),
                catch: () => new ArtifactStore.ContentAccessError({ artifactID }),
              })
              return yield* Effect.acquireUseRelease(
                Effect.succeed(handle),
                (opened) =>
                  Effect.gen(function* () {
                    const valid = yield* Effect.tryPromise({
                      try: () => verifyHandle(opened, digest, row.size),
                      catch: () => new ArtifactStore.CorruptionError({ digest }),
                    })
                    if (!valid) return yield* new ArtifactStore.CorruptionError({ digest })
                    return opened
                  }),
                (opened, exit) =>
                  Exit.isFailure(exit) ? Effect.promise(() => opened.close()).pipe(Effect.ignore) : Effect.void,
              )
            }),
            (handle) => Effect.promise(() => handle.close()).pipe(Effect.ignore),
          ),
        ),
      ).pipe(
        Stream.flatMap((handle) =>
          Stream.unfold(0, (position) =>
            Effect.tryPromise({
              try: async () => {
                const buffer = Buffer.allocUnsafe(ChunkBytes)
                const result = await handle.read(buffer, 0, buffer.byteLength, position)
                if (result.bytesRead === 0) return undefined
                return [buffer.subarray(0, result.bytesRead), position + result.bytesRead] as const
              },
              catch: () => new ArtifactStore.ContentAccessError({ artifactID }),
            }),
          ),
        ),
      )

    const abandon = Effect.fn("ArtifactStore.abandon")(function* (unsafeRunID: SandboxProtocol.RunID) {
      const runID = yield* decodeRunID(unsafeRunID).pipe(
        Effect.mapError(() => new ArtifactStore.AbandonmentError({ runID: unsafeRunID })),
      )
      yield* Effect.tryPromise({
        try: () => rm(path.join(stagingRoot, runID), { recursive: true, force: true }),
        catch: () => new ArtifactStore.AbandonmentError({ runID }),
      })
      activeRuns.delete(runID)
    })

    return ArtifactStore.Service.of({ stage, promote, promoteBatch, metadata, content, abandon, reconcile })
  }),
)

export const node = makeGlobalNode({
  service: ArtifactStore.Service,
  layer,
  deps: [Database.node, Global.node, EffectFlock.node],
})

async function ensurePrivateDirectory(parent: string, name: string) {
  const directory = path.join(parent, name)
  try {
    await mkdir(directory, { mode: 0o700 })
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error
  }
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new UnsafeCandidate()
  await chmod(directory, 0o700)
}

function resolveCandidate(root: string, outputPath: Artifact.OutputPath) {
  const candidate = path.resolve(root, ...String(outputPath).split("/"))
  const relative = path.relative(root, candidate)
  if (relative.length === 0 || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    return undefined
  }
  return candidate
}

async function inspectCandidate(candidate: string, root: string) {
  const relative = path.relative(root, candidate)
  const parts = relative.split(path.sep)
  const rootInfo = await safeLstat(root)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new UnsafeCandidate()

  let current = root
  let candidateInfo = rootInfo
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part)
    const info = await safeLstat(current)
    const final = index === parts.length - 1
    if (info.isSymbolicLink()) throw new UnsafeCandidate()
    if (!final && !info.isDirectory()) throw new UnsafeCandidate()
    if (final && (!info.isFile() || info.nlink !== 1n)) throw new UnsafeCandidate()
    candidateInfo = info
  }
  return candidateInfo
}

async function safeLstat(filepath: string) {
  try {
    return await lstat(filepath, { bigint: true })
  } catch (error) {
    if (hasCode(error, "ENOENT")) throw new MissingCandidate()
    throw error
  }
}

async function copyCandidate(candidate: string, root: string, temporaryPath: string, committedBytes: number) {
  const inspected = await inspectCandidate(candidate, root)
  const source = await open(candidate, ReadFlags)
  try {
    const before = await source.stat({ bigint: true })
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || !sameIdentity(inspected, before)) {
      throw new UnsafeCandidate()
    }
    const declaredSize = Number(before.size)
    if (declaredSize > Artifact.MaxArtifactBytes) {
      throw new SizeLimit("artifact-size", Artifact.MaxArtifactBytes, declaredSize)
    }
    if (committedBytes + declaredSize > Artifact.MaxRunBytes) {
      throw new SizeLimit("run-size", Artifact.MaxRunBytes, committedBytes + declaredSize)
    }

    await ensurePrivateDirectory(path.dirname(path.dirname(temporaryPath)), path.basename(path.dirname(temporaryPath)))
    const destination = await open(temporaryPath, "wx", 0o600)
    try {
      const hash = createHash("sha256")
      const sample = Buffer.allocUnsafe(Artifact.MimeSampleBytes)
      const buffer = Buffer.allocUnsafe(ChunkBytes)
      let sampleBytes = 0
      let total = 0

      while (true) {
        const result = await source.read(buffer, 0, buffer.byteLength, total)
        if (result.bytesRead === 0) break
        const chunk = buffer.subarray(0, result.bytesRead)
        total += result.bytesRead
        if (total > Artifact.MaxArtifactBytes) {
          throw new SizeLimit("artifact-size", Artifact.MaxArtifactBytes, total)
        }
        if (committedBytes + total > Artifact.MaxRunBytes) {
          throw new SizeLimit("run-size", Artifact.MaxRunBytes, committedBytes + total)
        }
        hash.update(chunk)
        if (sampleBytes < sample.byteLength) {
          const length = Math.min(chunk.byteLength, sample.byteLength - sampleBytes)
          chunk.copy(sample, sampleBytes, 0, length)
          sampleBytes += length
        }
        await writeAll(destination, chunk)
      }

      const after = await source.stat({ bigint: true })
      if (!sameFile(before, after) || BigInt(total) !== before.size) throw new UnsafeCandidate()
      await destination.sync()
      await destination.close()
      await chmod(temporaryPath, 0o400)

      return {
        digest: decodeArtifactDigest(hash.digest("hex")),
        size: decodeArtifactSize(total),
        mime: detectMime(sample.subarray(0, sampleBytes)),
        temporaryPath,
      } satisfies CopiedCandidate
    } catch (error) {
      await destination.close().catch(() => undefined)
      throw error
    }
  } finally {
    await source.close().catch(() => undefined)
  }
}

async function writeAll(handle: FileHandle, buffer: Uint8Array) {
  let offset = 0
  while (offset < buffer.byteLength) {
    const result = await handle.write(buffer, offset, buffer.byteLength - offset)
    if (result.bytesWritten === 0) throw new Error("Artifact temporary write made no progress")
    offset += result.bytesWritten
  }
}

function sameFile(left: BigIntStats, right: BigIntStats) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  )
}

function detectMime(sample: Uint8Array): Artifact.MimeType {
  if (startsWith(sample, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return decodeMimeType("image/png")
  if (startsWith(sample, [0xff, 0xd8, 0xff])) return decodeMimeType("image/jpeg")
  if (ascii(sample, 0, 6) === "GIF87a" || ascii(sample, 0, 6) === "GIF89a") return decodeMimeType("image/gif")
  if (ascii(sample, 0, 4) === "RIFF" && ascii(sample, 8, 4) === "WEBP") return decodeMimeType("image/webp")
  if (ascii(sample, 0, 5) === "%PDF-") return decodeMimeType("application/pdf")
  if (
    startsWith(sample, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWith(sample, [0x50, 0x4b, 0x05, 0x06]) ||
    startsWith(sample, [0x50, 0x4b, 0x07, 0x08])
  ) {
    return decodeMimeType("application/zip")
  }
  if (isText(sample)) return decodeMimeType("text/plain")
  return decodeMimeType("application/octet-stream")
}

function isText(sample: Uint8Array) {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(sample)
    return !Array.from(text).some((character) => {
      const code = character.codePointAt(0) ?? 0
      return (
        (code < 0x20 && character !== "\t" && character !== "\n" && character !== "\r" && character !== "\f") ||
        code === 0x7f
      )
    })
  } catch {
    return false
  }
}

function startsWith(input: Uint8Array, signature: ReadonlyArray<number>) {
  return input.byteLength >= signature.length && signature.every((byte, index) => input[index] === byte)
}

function ascii(input: Uint8Array, offset: number, length: number) {
  if (input.byteLength < offset + length) return ""
  return String.fromCharCode(...input.subarray(offset, offset + length))
}

function blobPath(root: string, digest: Artifact.Digest) {
  return path.join(root, String(digest).slice(0, 2), digest)
}

function publishBlob(copied: CopiedCandidate, root: string) {
  return Effect.tryPromise({
    try: async () => {
      const directory = path.join(root, String(copied.digest).slice(0, 2))
      await ensurePrivateDirectory(root, String(copied.digest).slice(0, 2))
      try {
        await link(copied.temporaryPath, path.join(directory, copied.digest))
        await unlink(copied.temporaryPath)
        return true
      } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error
      }
      await verifyBlob(path.join(directory, copied.digest), copied.digest, copied.size)
      await unlink(copied.temporaryPath)
      return false
    },
    catch: (error) => (error instanceof CorruptBlob ? error : new UnsafeCandidate()),
  })
}

function removeUnreferencedBlobs(
  db: Context.Service.Shape<typeof Database.Service>["db"],
  root: string,
  digests: ReadonlySet<Artifact.Digest>,
) {
  return Effect.forEach(digests, (digest) =>
    Effect.gen(function* () {
      const referenced = yield* db
        .select({ value: count() })
        .from(ArtifactTable)
        .where(eq(ArtifactTable.digest, digest))
        .get()
      if ((referenced?.value ?? 0) === 0) yield* Effect.promise(() => rm(blobPath(root, digest), { force: true }))
    }),
  ).pipe(Effect.asVoid)
}

function reconcileBlobs(
  db: Context.Service.Shape<typeof Database.Service>["db"],
  root: string,
  stagingRoot: string,
  temporaryRoot: string,
  activeRuns: ReadonlySet<SandboxProtocol.RunID>,
) {
  return Effect.gen(function* () {
    const cutoff = Date.now() - ArtifactStore.ReconciliationAgeMs
    const discovered = yield* Effect.tryPromise(() =>
      Promise.all([
        listBlobDigests(root),
        listAgedEntries(temporaryRoot, cutoff),
        listAgedEntries(stagingRoot, cutoff, activeRuns),
      ]),
    )
    const physical = discovered[0]
    const stored = yield* db
      .select({ digest: ArtifactBlobTable.digest })
      .from(ArtifactBlobTable)
      .leftJoin(ArtifactTable, eq(ArtifactTable.digest, ArtifactBlobTable.digest))
      .where(isNull(ArtifactTable.id))
      .all()
    const candidates = new Set<Artifact.Digest>([
      ...physical,
      ...stored.flatMap((row) => (Schema.is(Artifact.Digest)(row.digest) ? [row.digest] : [])),
    ])
    const removed = yield* Effect.forEach(candidates, (digest) =>
      Effect.gen(function* () {
        const referenced = yield* db
          .select({ value: count() })
          .from(ArtifactTable)
          .where(eq(ArtifactTable.digest, digest))
          .get()
        if ((referenced?.value ?? 0) > 0) return false
        yield* Effect.promise(() => rm(blobPath(root, digest), { force: true }))
        yield* db.delete(ArtifactBlobTable).where(eq(ArtifactBlobTable.digest, digest)).run()
        return true
      }),
    )
    const stale = [...discovered[1], ...discovered[2]]
    yield* Effect.forEach(stale, (entry) => Effect.promise(() => rm(entry, { recursive: true, force: true })))
    return {
      examined: candidates.size + stale.length,
      removed: removed.filter(Boolean).length + stale.length,
    }
  })
}

async function listBlobDigests(root: string) {
  const directories = await readdir(root, { withFileTypes: true }).catch((error) => {
    if (hasCode(error, "ENOENT")) return []
    throw error
  })
  const values = await Promise.all(
    directories
      .filter((entry) => entry.isDirectory() && /^[0-9a-f]{2}$/.test(entry.name))
      .map(async (entry) => {
        const files = await readdir(path.join(root, entry.name), { withFileTypes: true })
        return files.flatMap((file) =>
          file.isFile() && file.name.startsWith(entry.name) && Schema.is(Artifact.Digest)(file.name)
            ? [file.name]
            : [],
        )
      }),
  )
  return values.flat()
}

async function listAgedEntries(root: string, cutoff: number, excluded: ReadonlySet<string> = new Set()) {
  const entries = await readdir(root, { withFileTypes: true }).catch((error) => {
    if (hasCode(error, "ENOENT")) return []
    throw error
  })
  const ages = await Promise.all(
    entries
      .filter((entry) => !excluded.has(entry.name))
      .map(async (entry) => ({
        path: path.join(root, entry.name),
        modified: await newestMtime(path.join(root, entry.name)),
      })),
  )
  return ages.filter((entry) => entry.modified <= cutoff).map((entry) => entry.path)
}

async function newestMtime(target: string): Promise<number> {
  const info = await lstat(target)
  if (!info.isDirectory() || info.isSymbolicLink()) return info.mtimeMs
  const children = await readdir(target)
  const modified = await Promise.all(children.map((child) => newestMtime(path.join(target, child))))
  return Math.max(info.mtimeMs, ...modified)
}

async function verifyBlob(filepath: string, digest: Artifact.Digest, size: number) {
  const info = await lstat(filepath, { bigint: true }).catch(() => {
    throw new CorruptBlob()
  })
  if (!info.isFile() || info.isSymbolicLink()) throw new CorruptBlob()
  const handle = await open(filepath, ReadFlags).catch(() => {
    throw new CorruptBlob()
  })
  try {
    if (!(await verifyHandle(handle, digest, size))) throw new CorruptBlob()
  } finally {
    await handle.close().catch(() => undefined)
  }
}

function sameIdentity(left: BigIntStats, right: BigIntStats) {
  return left.dev === right.dev && left.ino === right.ino
}

async function verifyHandle(handle: FileHandle, digest: Artifact.Digest, size: number) {
  const before = await handle.stat({ bigint: true })
  if (!before.isFile() || before.isSymbolicLink() || before.size !== BigInt(size)) return false
  const hash = createHash("sha256")
  const buffer = Buffer.allocUnsafe(ChunkBytes)
  let position = 0
  while (true) {
    const result = await handle.read(buffer, 0, buffer.byteLength, position)
    if (result.bytesRead === 0) break
    position += result.bytesRead
    hash.update(buffer.subarray(0, result.bytesRead))
  }
  const after = await handle.stat({ bigint: true })
  return position === size && sameFile(before, after) && hash.digest("hex") === digest
}

function hasCode(error: unknown, code: string) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code
}

function decodeArtifactDigest(value: string) {
  return Schema.decodeUnknownSync(Artifact.Digest)(value)
}

function decodeArtifactSize(value: number) {
  return Schema.decodeUnknownSync(Artifact.ByteSize)(value)
}

function decodeMimeType(value: string) {
  return Schema.decodeUnknownSync(Artifact.MimeType)(value)
}

function validationError(outputPath: Artifact.OutputPath, code: string) {
  return new ArtifactStore.ValidationError({
    outputPath,
    validation: Schema.decodeUnknownSync(Artifact.Validation)({
      state: "rejected",
      validator: Artifact.ValidatorName,
      validatorVersion: Artifact.ValidatorVersion,
      findings: [{ code, message: "Artifact candidate is not a stable standalone regular file" }],
    }),
  })
}

function invalidName(outputPath: Artifact.OutputPath) {
  return new ArtifactStore.ValidationError({
    outputPath,
    validation: Schema.decodeUnknownSync(Artifact.Validation)({
      state: "rejected",
      validator: Artifact.ValidatorName,
      validatorVersion: Artifact.ValidatorVersion,
      findings: [{ code: "invalid-name", message: "Artifact file name is not supported" }],
    }),
  })
}

function copyError(error: unknown, runID: SandboxProtocol.RunID, outputPath: Artifact.OutputPath) {
  if (error instanceof MissingCandidate) return new ArtifactStore.CandidateNotFoundError({ runID, outputPath })
  if (error instanceof SizeLimit) {
    return new ArtifactStore.LimitError({ kind: error.kind, maximum: error.maximum, actual: error.actual })
  }
  if (error instanceof UnsafeCandidate) return validationError(outputPath, "unsafe-file")
  return new ArtifactStore.PromotionError({ runID, outputPath })
}

function artifactRow(metadata: Artifact.Metadata) {
  return {
    id: metadata.id,
    digest: metadata.digest,
    name: metadata.name,
    mime: metadata.mime,
    validation_state: metadata.validation.state,
    validator: metadata.validation.validator,
    validator_version: metadata.validation.validatorVersion,
    validation: metadata.validation,
    owner_session_id: metadata.provenance.sessionID,
    owner_message_id: metadata.provenance.messageID,
    tool_name: metadata.provenance.toolName,
    tool_call_id: metadata.provenance.toolCallID,
    sandbox_run_id: metadata.provenance.sandboxRunID,
    source_project_path: metadata.provenance.sourceProjectPath,
    time_created: metadata.timeCreated,
  }
}

export * as ArtifactStoreLive from "./artifact-store"
