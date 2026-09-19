import { describe, expect } from "bun:test"
import { chmod, link, mkdir, readFile, readdir, rm, stat, symlink, truncate, writeFile } from "node:fs/promises"
import path from "node:path"
import { Artifact } from "@koala-ai/core/artifact/artifact"
import { ArtifactStore } from "@koala-ai/core/artifact/store"
import { SandboxProtocol } from "@koala-ai/core/sandbox/protocol"
import { ArtifactBlobTable, ArtifactLineageTable, ArtifactTable } from "@opencode-ai/core/artifact/sql"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { count, sql } from "drizzle-orm"
import { Effect, Exit, Schema, Stream } from "effect"
import { ArtifactStoreLive } from "../../src/koala/artifact-store"
import { tmpdir } from "../fixture/fixture"
import { it } from "../lib/effect"

type Fixture = {
  readonly data: string
  readonly sessionID: string
  readonly messageID: string
}

const outputPath = Schema.decodeUnknownSync(Artifact.OutputPath)
const runID = Schema.decodeUnknownSync(SandboxProtocol.RunID)

const withStore = <A, E>(body: (fixture: Fixture) => Effect.Effect<A, E, ArtifactStore.Service | Database.Service>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => {
      const testLayer = LayerNode.compile(LayerNode.group([ArtifactStoreLive.node, Database.node]), [
        [Global.node, Global.layerWith({ data: tmp.path, state: tmp.path })],
        [Database.node, Database.layerFromPath(path.join(tmp.path, "artifact-store.db"))],
      ])
      return Effect.gen(function* () {
        const { db } = yield* Database.Service
        const now = Date.now()
        const sessionID = SessionSchema.ID.create()
        const messageID = SessionV1.MessageID.ascending()
        yield* db
          .insert(ProjectTable)
          .values({
            id: ProjectV2.ID.global,
            worktree: AbsolutePath.make(tmp.path),
            time_created: now,
            time_updated: now,
            sandboxes: [],
          })
          .run()
        yield* db
          .insert(SessionTable)
          .values({
            id: sessionID,
            project_id: ProjectV2.ID.global,
            slug: sessionID,
            directory: AbsolutePath.make(tmp.path),
            title: "artifact store test",
            version: "test",
            time_created: now,
            time_updated: now,
          })
          .run()
        yield* db.run(sql`
          INSERT INTO message (id, session_id, time_created, time_updated, data)
          VALUES (
            ${messageID}, ${sessionID}, ${now}, ${now},
            ${JSON.stringify({
              role: "user",
              time: { created: now },
              agent: "test",
              model: { providerID: "test", modelID: "test" },
            })}
          )
        `)
        return yield* body({ data: tmp.path, sessionID, messageID })
      }).pipe(Effect.provide(testLayer))
    },
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

function provenance(fixture: Fixture, id: SandboxProtocol.RunID) {
  return Schema.decodeUnknownSync(Artifact.Provenance)({
    sessionID: fixture.sessionID,
    messageID: fixture.messageID,
    toolName: "sandbox_execute",
    toolCallID: "tool-call",
    sandboxRunID: id,
  })
}

function promote(
  store: ArtifactStore.Interface,
  fixture: Fixture,
  id: SandboxProtocol.RunID,
  candidate: Artifact.OutputPath,
  lineage: ReadonlyArray<Artifact.Lineage> = [],
) {
  return store.promote({
    runID: id,
    outputPath: candidate,
    provenance: provenance(fixture, id),
    lineage,
  })
}

function content(store: ArtifactStore.Interface, artifactID: Artifact.ID) {
  return store.content(artifactID).pipe(
    Stream.runCollect,
    Effect.map((chunks) => Buffer.concat(Array.from(chunks, (chunk) => Buffer.from(chunk)))),
  )
}

function blobPath(data: string, digest: Artifact.Digest) {
  return path.join(data, "koala", "artifacts", "blobs", "sha256", String(digest).slice(0, 2), digest)
}

function temporaryRoot(data: string) {
  return path.join(data, "koala", "artifacts", "blobs", "sha256", ".staging")
}

describe("ArtifactStore", () => {
  it.live("creates private run staging and abandons it idempotently", () =>
    withStore((fixture) =>
      Effect.gen(function* () {
        const store = yield* ArtifactStore.Service
        const id = runID("stage-run")
        const staging = yield* store.stage(id)

        expect(staging.root).toBe(path.join(fixture.data, "koala", "artifacts", "staging", id))
        expect((yield* Effect.promise(() => stat(staging.root))).isDirectory()).toBe(true)
        expect((yield* Effect.promise(() => stat(staging.work))).isDirectory()).toBe(true)
        expect((yield* Effect.promise(() => stat(staging.artifacts))).isDirectory()).toBe(true)
        if (process.platform !== "win32") {
          expect((yield* Effect.promise(() => stat(staging.root))).mode & 0o777).toBe(0o700)
          expect((yield* Effect.promise(() => stat(staging.work))).mode & 0o777).toBe(0o700)
          expect((yield* Effect.promise(() => stat(staging.artifacts))).mode & 0o777).toBe(0o700)
        }

        yield* store.abandon(id)
        yield* store.abandon(id)
        expect(yield* Effect.promise(() => Bun.file(staging.root).exists())).toBe(false)
      }),
    ),
  )

  it.live("promotes text and round-trips metadata and streamed content", () =>
    withStore((fixture) =>
      Effect.gen(function* () {
        const store = yield* ArtifactStore.Service
        const id = runID("text-run")
        const staging = yield* store.stage(id)
        yield* Effect.promise(() => writeFile(path.join(staging.artifacts, "report.txt"), "hello artifact\n"))

        const promoted = yield* promote(store, fixture, id, outputPath("report.txt"))

        expect(promoted.id).toMatch(/^art_[0-9a-f-]{36}$/)
        expect(promoted).toMatchObject({ name: "report.txt", mime: "text/plain", size: 15 })
        expect(promoted.validation).toEqual({
          state: "accepted",
          validator: Artifact.ValidatorName,
          validatorVersion: Artifact.ValidatorVersion,
          findings: [],
        })
        expect(promoted.provenance).toEqual(provenance(fixture, id))
        expect(yield* store.metadata(promoted.id)).toEqual(promoted)
        expect((yield* content(store, promoted.id)).toString()).toBe("hello artifact\n")
        expect(yield* Effect.promise(() => readFile(blobPath(fixture.data, promoted.digest), "utf8"))).toBe(
          "hello artifact\n",
        )
        if (process.platform !== "win32") {
          expect((yield* Effect.promise(() => stat(blobPath(fixture.data, promoted.digest)))).mode & 0o777).toBe(0o400)
        }
      }),
    ),
  )

  it.live("detects supported signatures, strict UTF-8 text, and generic binary", () =>
    withStore((fixture) =>
      Effect.gen(function* () {
        const store = yield* ArtifactStore.Service
        const id = runID("mime-run")
        const staging = yield* store.stage(id)
        const samples = [
          ["image.png", Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "image/png"],
          ["image.jpg", Uint8Array.from([0xff, 0xd8, 0xff, 0x00]), "image/jpeg"],
          ["image.gif", new TextEncoder().encode("GIF89a"), "image/gif"],
          ["image.webp", new TextEncoder().encode("RIFF0000WEBP"), "image/webp"],
          ["document.pdf", new TextEncoder().encode("%PDF-1.7"), "application/pdf"],
          ["archive.zip", Uint8Array.from([0x50, 0x4b, 0x03, 0x04]), "application/zip"],
          ["unicode.txt", new TextEncoder().encode("\u0928\u092e\u0938\u094d\u0924\u0947"), "text/plain"],
          ["binary.bin", Uint8Array.from([0xff, 0x00, 0xfe]), "application/octet-stream"],
        ] as const

        for (const [name, bytes] of samples) {
          yield* Effect.promise(() => writeFile(path.join(staging.artifacts, name), bytes))
        }
        const result = yield* Effect.forEach(samples, ([name]) => promote(store, fixture, id, outputPath(name)), {
          concurrency: 1,
        })
        expect(result.map((metadata) => String(metadata.mime))).toEqual(samples.map((sample) => sample[2]))
      }),
    ),
  )

  it.live("rejects traversal, missing files, directories, symlink components, and hard links", () =>
    withStore((fixture) =>
      Effect.gen(function* () {
        const store = yield* ArtifactStore.Service
        const id = runID("unsafe-run")
        const staging = yield* store.stage(id)
        const traversal = "../outside.txt" as Artifact.OutputPath
        expect(yield* promote(store, fixture, id, traversal).pipe(Effect.flip)).toBeInstanceOf(
          ArtifactStore.InvalidOutputPathError,
        )
        const invalidName = outputPath(`${"a".repeat(Artifact.MaxNameLength + 1)}.txt`)
        expect(yield* promote(store, fixture, id, invalidName).pipe(Effect.flip)).toBeInstanceOf(
          ArtifactStore.ValidationError,
        )
        expect(yield* promote(store, fixture, id, outputPath("missing.txt")).pipe(Effect.flip)).toBeInstanceOf(
          ArtifactStore.CandidateNotFoundError,
        )

        yield* Effect.promise(() => mkdir(path.join(staging.artifacts, "directory")))
        expect(yield* promote(store, fixture, id, outputPath("directory")).pipe(Effect.flip)).toBeInstanceOf(
          ArtifactStore.ValidationError,
        )

        const outside = path.join(fixture.data, "outside")
        yield* Effect.promise(async () => {
          await mkdir(outside)
          await writeFile(path.join(outside, "escaped.txt"), "escaped")
          await symlink(
            outside,
            path.join(staging.artifacts, "linked"),
            process.platform === "win32" ? "junction" : "dir",
          )
        })
        expect(yield* promote(store, fixture, id, outputPath("linked/escaped.txt")).pipe(Effect.flip)).toBeInstanceOf(
          ArtifactStore.ValidationError,
        )

        yield* Effect.promise(async () => {
          await writeFile(path.join(staging.artifacts, "original.txt"), "linked")
          await link(path.join(staging.artifacts, "original.txt"), path.join(staging.artifacts, "alias.txt"))
        })
        expect(yield* promote(store, fixture, id, outputPath("alias.txt")).pipe(Effect.flip)).toBeInstanceOf(
          ArtifactStore.ValidationError,
        )
      }),
    ),
  )

  it.live("enforces per-artifact and cumulative byte limits before publication", () =>
    withStore((fixture) =>
      Effect.gen(function* () {
        const store = yield* ArtifactStore.Service
        const id = runID("limit-run")
        const staging = yield* store.stage(id)
        const oversized = path.join(staging.artifacts, "oversized.bin")
        yield* Effect.promise(async () => {
          await writeFile(oversized, "")
          await truncate(oversized, Artifact.MaxArtifactBytes + 1)
          await writeFile(path.join(staging.artifacts, "small.txt"), "x")
        })

        expect(yield* promote(store, fixture, id, outputPath("oversized.bin")).pipe(Effect.flip)).toMatchObject({
          _tag: "ArtifactStoreLimitError",
          kind: "artifact-size",
          maximum: Artifact.MaxArtifactBytes,
        })
        const { db } = yield* Database.Service
        const validation = {
          state: "accepted" as const,
          validator: Artifact.ValidatorName,
          validatorVersion: Artifact.ValidatorVersion,
          findings: [],
        }
        const firstDigest = Schema.decodeUnknownSync(Artifact.Digest)("b".repeat(64))
        const secondDigest = Schema.decodeUnknownSync(Artifact.Digest)("c".repeat(64))
        yield* db.insert(ArtifactBlobTable).values([
          { digest: firstDigest, size: Artifact.MaxArtifactBytes, time_created: 1 },
          { digest: secondDigest, size: Artifact.MaxRunBytes - Artifact.MaxArtifactBytes * 2, time_created: 1 },
        ])
        yield* db.insert(ArtifactTable).values([
          {
            id: "art_00000000-0000-4000-8000-000000000001",
            digest: firstDigest,
            name: "first.bin",
            mime: "application/octet-stream",
            validation_state: validation.state,
            validator: validation.validator,
            validator_version: validation.validatorVersion,
            validation,
            owner_session_id: fixture.sessionID,
            owner_message_id: fixture.messageID,
            tool_name: "sandbox_execute",
            sandbox_run_id: id,
            time_created: 1,
          },
          {
            id: "art_00000000-0000-4000-8000-000000000002",
            digest: firstDigest,
            name: "second.bin",
            mime: "application/octet-stream",
            validation_state: validation.state,
            validator: validation.validator,
            validator_version: validation.validatorVersion,
            validation,
            owner_session_id: fixture.sessionID,
            owner_message_id: fixture.messageID,
            tool_name: "sandbox_execute",
            sandbox_run_id: id,
            time_created: 1,
          },
          {
            id: "art_00000000-0000-4000-8000-000000000003",
            digest: secondDigest,
            name: "third.bin",
            mime: "application/octet-stream",
            validation_state: validation.state,
            validator: validation.validator,
            validator_version: validation.validatorVersion,
            validation,
            owner_session_id: fixture.sessionID,
            owner_message_id: fixture.messageID,
            tool_name: "sandbox_execute",
            sandbox_run_id: id,
            time_created: 1,
          },
        ])
        expect(yield* promote(store, fixture, id, outputPath("small.txt")).pipe(Effect.flip)).toMatchObject({
          _tag: "ArtifactStoreLimitError",
          kind: "run-size",
          actual: Artifact.MaxRunBytes + 1,
        })
        expect((yield* db.select({ value: count() }).from(ArtifactTable).get())?.value).toBe(3)
      }),
    ),
  )

  it.live("serializes concurrent promotions at the per-run output count limit", () =>
    withStore((fixture) =>
      Effect.gen(function* () {
        const store = yield* ArtifactStore.Service
        const id = runID("count-run")
        const staging = yield* store.stage(id)
        const names = Array.from({ length: Artifact.MaxOutputsPerRun + 1 }, (_, index) => `output-${index}.txt`)
        yield* Effect.forEach(
          names,
          (name) => Effect.promise(() => writeFile(path.join(staging.artifacts, name), name)),
          {
            concurrency: 1,
          },
        )
        const results = yield* Effect.forEach(
          names,
          (name) => promote(store, fixture, id, outputPath(name)).pipe(Effect.exit),
          { concurrency: "unbounded" },
        )
        expect(results.filter(Exit.isSuccess)).toHaveLength(Artifact.MaxOutputsPerRun)
        expect(results.filter(Exit.isFailure)).toHaveLength(1)
        const { db } = yield* Database.Service
        expect((yield* db.select({ value: count() }).from(ArtifactTable).get())?.value).toBe(Artifact.MaxOutputsPerRun)
      }),
    ),
  )

  it.live("deduplicates blobs while preserving logical metadata and lineage", () =>
    withStore((fixture) =>
      Effect.gen(function* () {
        const store = yield* ArtifactStore.Service
        const firstRun = runID("dedupe-first")
        const secondRun = runID("dedupe-second")
        const firstStaging = yield* store.stage(firstRun)
        const secondStaging = yield* store.stage(secondRun)
        yield* Effect.promise(() => writeFile(path.join(firstStaging.artifacts, "source.txt"), "same bytes"))
        yield* Effect.promise(() => writeFile(path.join(secondStaging.artifacts, "derived.txt"), "same bytes"))

        const source = yield* promote(store, fixture, firstRun, outputPath("source.txt"))
        const derived = yield* promote(store, fixture, secondRun, outputPath("derived.txt"), [
          Schema.decodeUnknownSync(Artifact.Lineage)({ sourceArtifactID: source.id, relation: "derived-from" }),
        ])

        expect(derived.id).not.toBe(source.id)
        expect(derived.digest).toBe(source.digest)
        expect((yield* store.metadata(derived.id)).lineage).toEqual([
          { sourceArtifactID: source.id, relation: "derived-from" },
        ])
        expect((yield* content(store, derived.id)).toString()).toBe("same bytes")
        const { db } = yield* Database.Service
        expect((yield* db.select({ value: count() }).from(ArtifactBlobTable).get())?.value).toBe(1)
        expect((yield* db.select({ value: count() }).from(ArtifactTable).get())?.value).toBe(2)
        expect((yield* db.select({ value: count() }).from(ArtifactLineageTable).get())?.value).toBe(1)

        const rollbackRun = runID("lineage-rollback")
        const rollbackStaging = yield* store.stage(rollbackRun)
        yield* Effect.promise(() => writeFile(path.join(rollbackStaging.artifacts, "orphan.txt"), "orphan bytes"))
        const missing = Schema.decodeUnknownSync(Artifact.ID)("art_123e4567-e89b-42d3-a456-426614174000")
        expect(
          yield* promote(store, fixture, rollbackRun, outputPath("orphan.txt"), [
            Schema.decodeUnknownSync(Artifact.Lineage)({ sourceArtifactID: missing, relation: "derived-from" }),
          ]).pipe(Effect.flip),
        ).toBeInstanceOf(ArtifactStore.PromotionError)
        expect((yield* db.select({ value: count() }).from(ArtifactBlobTable).get())?.value).toBe(1)
        expect((yield* db.select({ value: count() }).from(ArtifactTable).get())?.value).toBe(2)
        expect((yield* db.select({ value: count() }).from(ArtifactLineageTable).get())?.value).toBe(1)
        expect(yield* Effect.promise(() => readdir(temporaryRoot(fixture.data)))).toEqual([])
      }),
    ),
  )

  it.live("deduplicates concurrent promotions of identical content", () =>
    withStore((fixture) =>
      Effect.gen(function* () {
        const store = yield* ArtifactStore.Service
        const firstRun = runID("concurrent-first")
        const secondRun = runID("concurrent-second")
        const firstStaging = yield* store.stage(firstRun)
        const secondStaging = yield* store.stage(secondRun)
        yield* Effect.promise(() => writeFile(path.join(firstStaging.artifacts, "first.bin"), "concurrent"))
        yield* Effect.promise(() => writeFile(path.join(secondStaging.artifacts, "second.bin"), "concurrent"))

        const promoted = yield* Effect.all(
          [
            promote(store, fixture, firstRun, outputPath("first.bin")),
            promote(store, fixture, secondRun, outputPath("second.bin")),
          ],
          { concurrency: "unbounded" },
        )
        expect(promoted[0].digest).toBe(promoted[1].digest)
        expect(promoted[0].id).not.toBe(promoted[1].id)
        const { db } = yield* Database.Service
        expect((yield* db.select({ value: count() }).from(ArtifactBlobTable).get())?.value).toBe(1)
      }),
    ),
  )

  it.live("rejects a corrupt existing digest instead of deduplicating it", () =>
    withStore((fixture) =>
      Effect.gen(function* () {
        const store = yield* ArtifactStore.Service
        const firstRun = runID("corrupt-first")
        const secondRun = runID("corrupt-second")
        const firstStaging = yield* store.stage(firstRun)
        const secondStaging = yield* store.stage(secondRun)
        yield* Effect.promise(() => writeFile(path.join(firstStaging.artifacts, "first.txt"), "expected"))
        yield* Effect.promise(() => writeFile(path.join(secondStaging.artifacts, "second.txt"), "expected"))
        const first = yield* promote(store, fixture, firstRun, outputPath("first.txt"))
        yield* Effect.promise(async () => {
          await chmod(blobPath(fixture.data, first.digest), 0o600)
          await writeFile(blobPath(fixture.data, first.digest), "corrupt")
        })

        expect(yield* promote(store, fixture, secondRun, outputPath("second.txt")).pipe(Effect.flip)).toBeInstanceOf(
          ArtifactStore.CorruptionError,
        )
        expect(yield* store.content(first.id).pipe(Stream.runCollect, Effect.flip)).toBeInstanceOf(
          ArtifactStore.CorruptionError,
        )
        yield* Effect.promise(() => rm(blobPath(fixture.data, first.digest)))
        expect(yield* Effect.promise(() => Bun.file(blobPath(fixture.data, first.digest)).exists())).toBe(false)
        expect(yield* Effect.promise(() => readdir(temporaryRoot(fixture.data)))).toEqual([])
      }),
    ),
  )

  it.live("rejects incomplete or scalar-inconsistent persisted validation before content access", () =>
    withStore((fixture) =>
      Effect.gen(function* () {
        const store = yield* ArtifactStore.Service
        const id = runID("validation-run")
        const staging = yield* store.stage(id)
        yield* Effect.promise(() => writeFile(path.join(staging.artifacts, "report.txt"), "validated"))
        const promoted = yield* promote(store, fixture, id, outputPath("report.txt"))
        const { db } = yield* Database.Service
        yield* db.run(sql`PRAGMA ignore_check_constraints = ON`)
        yield* db.run(sql`UPDATE koala_artifact SET validation = '{"state":"accepted"}' WHERE id = ${promoted.id}`)
        expect(yield* content(store, promoted.id).pipe(Effect.flip)).toBeInstanceOf(ArtifactStore.ContentAccessError)

        yield* db.run(sql`
          UPDATE koala_artifact
          SET validation = ${JSON.stringify(promoted.validation)}, validator = 'different-validator'
          WHERE id = ${promoted.id}
        `)
        expect(yield* content(store, promoted.id).pipe(Effect.flip)).toBeInstanceOf(ArtifactStore.ContentAccessError)
      }),
    ),
  )

  it.live("removes the destination temporary file when metadata decoding fails", () =>
    withStore((fixture) =>
      Effect.gen(function* () {
        const store = yield* ArtifactStore.Service
        const id = runID("metadata-failure-run")
        const staging = yield* store.stage(id)
        yield* Effect.promise(() => writeFile(path.join(staging.artifacts, "report.txt"), "temporary"))

        expect(
          yield* store
            .promote({
              runID: id,
              outputPath: outputPath("report.txt"),
              provenance: { ...provenance(fixture, id), toolName: "" } as Artifact.Provenance,
            })
            .pipe(Effect.flip),
        ).toBeInstanceOf(ArtifactStore.PromotionError)
        expect(yield* Effect.promise(() => readdir(temporaryRoot(fixture.data)))).toEqual([])
      }),
    ),
  )
})
