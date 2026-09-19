import { describe, expect } from "bun:test"
import { link, mkdir, readFile, stat, symlink, truncate, writeFile } from "node:fs/promises"
import path from "node:path"
import { Artifact } from "@koala-ai/core/artifact/artifact"
import { ArtifactStore } from "@koala-ai/core/artifact/store"
import { IndustrialInput } from "@koala-ai/core/industrial/input"
import { SandboxProtocol } from "@koala-ai/core/sandbox/protocol"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { sql } from "drizzle-orm"
import { Effect, Layer, Schema, Scope, Stream } from "effect"
import { ArtifactInput } from "@/koala/artifact-input"
import { ArtifactStoreLive } from "@/koala/artifact-store"
import { MessageID, SessionID } from "@/session/schema"
import { Tool } from "@/tool/tool"
import { provideInstance, testInstanceStoreLayer, tmpdir } from "../fixture/fixture"
import { it } from "../lib/effect"

type Fixture = {
  readonly data: string
  readonly directory: string
  readonly firstSessionID: SessionID
  readonly firstMessageID: MessageID
  readonly secondSessionID: SessionID
  readonly secondMessageID: MessageID
}

const decodeSource = Schema.decodeUnknownSync(IndustrialInput.Source)
const decodeOutputPath = Schema.decodeUnknownSync(Artifact.OutputPath)
const decodeRunID = Schema.decodeUnknownSync(SandboxProtocol.RunID)

const withInput = <A, E>(
  body: (
    fixture: Fixture,
  ) => Effect.Effect<A, E, ArtifactInput.Service | ArtifactStore.Service | Database.Service | Scope.Scope>,
) =>
  Effect.acquireUseRelease(
    Effect.promise(async () => ({ directory: await tmpdir({ git: true }), data: await tmpdir() })),
    (tmp) => {
      const services = LayerNode.compile(LayerNode.group([ArtifactInput.node, ArtifactStoreLive.node, Database.node]), [
        [Global.node, Global.layerWith({ data: tmp.data.path, state: tmp.data.path })],
        [Database.node, Database.layerFromPath(path.join(tmp.data.path, "artifact-input.db"))],
      ])
      return Effect.gen(function* () {
        const { db } = yield* Database.Service
        const firstSessionID = SessionID.make("ses_artifact_input_first")
        const firstMessageID = MessageID.make("msg_artifact_input_first")
        const secondSessionID = SessionID.make("ses_artifact_input_second")
        const secondMessageID = MessageID.make("msg_artifact_input_second")
        const sessions = [
          [firstSessionID, firstMessageID],
          [secondSessionID, secondMessageID],
        ] as const
        const now = Date.now()
        yield* db
          .insert(ProjectTable)
          .values({
            id: ProjectV2.ID.global,
            worktree: AbsolutePath.make(tmp.directory.path),
            time_created: now,
            time_updated: now,
            sandboxes: [],
          })
          .run()
        yield* db.insert(SessionTable).values(
          sessions.map(([sessionID]) => ({
            id: sessionID,
            project_id: ProjectV2.ID.global,
            slug: sessionID,
            directory: AbsolutePath.make(tmp.directory.path),
            title: "artifact input test",
            version: "test",
            time_created: now,
            time_updated: now,
          })),
        )
        yield* Effect.forEach(
          sessions,
          ([sessionID, messageID]) =>
            db.run(sql`
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
            `),
          { concurrency: 1 },
        )
        return yield* body({
          data: tmp.data.path,
          directory: tmp.directory.path,
          firstSessionID,
          firstMessageID,
          secondSessionID,
          secondMessageID,
        })
      }).pipe(provideInstance(tmp.directory.path), Effect.provide(Layer.merge(services, testInstanceStoreLayer)))
    },
    (tmp) =>
      Effect.promise(async () => {
        await tmp.directory[Symbol.asyncDispose]()
        await tmp.data[Symbol.asyncDispose]()
      }),
  )

function context(sessionID: SessionID, messageID: MessageID) {
  const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
  const value: Tool.Context = {
    sessionID,
    messageID,
    callID: "call-artifact-input",
    agent: "test",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => Effect.void,
    ask: (request) =>
      Effect.sync(() => {
        requests.push(request)
      }),
  }
  return { requests, value }
}

function provenance(ctx: Tool.Context) {
  return Schema.decodeUnknownSync(Artifact.Provenance)({
    sessionID: ctx.sessionID,
    messageID: ctx.messageID,
    toolName: "pdf_read",
    toolCallID: ctx.callID,
  })
}

function storedContent(store: ArtifactStore.Interface, artifactID: Artifact.ID) {
  return store.content(artifactID).pipe(
    Stream.runCollect,
    Effect.map((chunks) => Buffer.concat(Array.from(chunks, (chunk) => Buffer.from(chunk)))),
  )
}

function seedArtifact(store: ArtifactStore.Interface, fixture: Fixture) {
  return Effect.gen(function* () {
    const runID = decodeRunID(`artifact-input-seed-${crypto.randomUUID()}`)
    const staging = yield* store.stage(runID)
    yield* Effect.promise(() => writeFile(path.join(staging.artifacts, "source.txt"), "stored source"))
    const artifact = yield* store.promote({
      runID,
      outputPath: decodeOutputPath("source.txt"),
      provenance: Schema.decodeUnknownSync(Artifact.Provenance)({
        sessionID: fixture.firstSessionID,
        messageID: fixture.firstMessageID,
        toolName: "sandbox_execute",
        sandboxRunID: runID,
      }),
    })
    yield* store.abandon(runID)
    return artifact
  })
}

describe("ArtifactInput", () => {
  it.live("resolves a same-session artifact into a private read-only scoped snapshot", () =>
    withInput((fixture) =>
      Effect.gen(function* () {
        const input = yield* ArtifactInput.Service
        const store = yield* ArtifactStore.Service
        const artifact = yield* seedArtifact(store, fixture)
        const ctx = context(fixture.firstSessionID, fixture.firstMessageID)

        const resolved = yield* Effect.scoped(
          input
            .resolve({
              source: decodeSource({ artifactID: artifact.id }),
              provenance: provenance(ctx.value),
              context: ctx.value,
            })
            .pipe(
              Effect.tap((result) =>
                Effect.gen(function* () {
                  expect(result.snapshotPath).not.toBe(path.join(fixture.directory, artifact.name))
                  expect(result.snapshotPath.startsWith(path.join(fixture.data, "koala", "artifacts", "staging"))).toBe(
                    true,
                  )
                  expect(yield* Effect.promise(() => readFile(result.snapshotPath, "utf8"))).toBe("stored source")
                  if (process.platform !== "win32") {
                    expect((yield* Effect.promise(() => stat(result.snapshotPath))).mode & 0o777).toBe(0o400)
                  }
                  expect(Object.isFrozen(result.artifact)).toBe(true)
                  expect(Object.isFrozen(result.artifact.provenance)).toBe(true)
                }),
              ),
            ),
        )

        expect(resolved.artifact).toEqual(artifact)
        expect(ctx.requests).toEqual([])
        expect(yield* Effect.promise(() => Bun.file(resolved.snapshotPath).exists())).toBe(false)
      }),
    ),
  )

  it.live("rejects an artifact owned by another session without leaking a host path", () =>
    withInput((fixture) =>
      Effect.gen(function* () {
        const input = yield* ArtifactInput.Service
        const artifact = yield* seedArtifact(yield* ArtifactStore.Service, fixture)
        const ctx = context(fixture.secondSessionID, fixture.secondMessageID)
        const error = yield* input
          .resolve({
            source: decodeSource({ artifactID: artifact.id }),
            provenance: provenance(ctx.value),
            context: ctx.value,
          })
          .pipe(Effect.flip)

        expect(error).toMatchObject({ _tag: "ArtifactInputHostError", code: "source-not-owned" })
        expect(error.message).toBe("Artifact input failed: source-not-owned")
        expect(error).not.toHaveProperty("cause")
        expect(error.message).not.toContain(fixture.directory)
      }),
    ),
  )

  it.live("authorizes and promotes a relative project path with safe provenance and immutable bytes", () =>
    withInput((fixture) =>
      Effect.gen(function* () {
        const input = yield* ArtifactInput.Service
        const store = yield* ArtifactStore.Service
        yield* Effect.promise(async () => {
          await mkdir(path.join(fixture.directory, "reports"))
          await writeFile(path.join(fixture.directory, "reports", "inspection.txt"), "inspection v1")
        })
        const ctx = context(fixture.firstSessionID, fixture.firstMessageID)

        const resolved = yield* Effect.scoped(
          input
            .resolve({
              source: decodeSource({ path: "reports/inspection.txt" }),
              provenance: provenance(ctx.value),
              context: ctx.value,
            })
            .pipe(
              Effect.tap((result) =>
                Effect.gen(function* () {
                  yield* Effect.promise(() =>
                    writeFile(path.join(fixture.directory, "reports", "inspection.txt"), "inspection v2"),
                  )
                  expect(yield* Effect.promise(() => readFile(result.snapshotPath, "utf8"))).toBe("inspection v1")
                }),
              ),
            ),
        )

        expect(ctx.requests.map((request) => request.permission)).toEqual(["read"])
        expect(resolved.artifact.provenance).toEqual(
          Schema.decodeUnknownSync(Artifact.Provenance)({
            ...provenance(ctx.value),
            sourceProjectPath: "reports/inspection.txt",
          }),
        )
        expect((yield* storedContent(store, resolved.artifact.id)).toString()).toBe("inspection v1")
        expect(Object.isFrozen(resolved.artifact)).toBe(true)
        expect(yield* Effect.promise(() => Bun.file(resolved.snapshotPath).exists())).toBe(false)
      }),
    ),
  )

  it.live("requests external-directory before read and omits external path provenance", () =>
    withInput((fixture) =>
      Effect.gen(function* () {
        const input = yield* ArtifactInput.Service
        const external = path.join(fixture.data, "external.txt")
        yield* Effect.promise(() => writeFile(external, "external source"))
        const ctx = context(fixture.firstSessionID, fixture.firstMessageID)

        const resolved = yield* Effect.scoped(
          input.resolve({
            source: decodeSource({ path: external }),
            provenance: provenance(ctx.value),
            context: ctx.value,
          }),
        )

        expect(ctx.requests.map((request) => request.permission)).toEqual(["external_directory", "read"])
        expect(resolved.artifact.provenance).toEqual(provenance(ctx.value))
        expect(JSON.stringify(resolved.artifact)).not.toContain(external)
        expect(resolved.snapshotPath).not.toBe(external)
      }),
    ),
  )

  it.live("asks for read before reporting a redacted missing-source error", () =>
    withInput((fixture) =>
      Effect.gen(function* () {
        const input = yield* ArtifactInput.Service
        const ctx = context(fixture.firstSessionID, fixture.firstMessageID)
        const missing = path.join("private", "missing.txt")
        const error = yield* input
          .resolve({ source: decodeSource({ path: missing }), provenance: provenance(ctx.value), context: ctx.value })
          .pipe(Effect.flip)

        expect(ctx.requests.map((request) => request.permission)).toEqual(["read"])
        expect(error).toMatchObject({ code: "source-not-found" })
        expect(error.message).not.toContain(missing)
        expect(error).not.toHaveProperty("cause")
      }),
    ),
  )

  it.live("rejects directories, links, junctions, and hard-linked files", () =>
    withInput((fixture) =>
      Effect.gen(function* () {
        const input = yield* ArtifactInput.Service
        const ctx = context(fixture.firstSessionID, fixture.firstMessageID)
        const directory = path.join(fixture.directory, "unsafe")
        yield* Effect.promise(async () => {
          await mkdir(directory)
          await writeFile(path.join(directory, "original.txt"), "linked")
          await link(path.join(directory, "original.txt"), path.join(directory, "hardlink.txt"))
        })

        const directoryError = yield* input
          .resolve({ source: decodeSource({ path: "unsafe" }), provenance: provenance(ctx.value), context: ctx.value })
          .pipe(Effect.flip)
        const hardlinkError = yield* input
          .resolve({
            source: decodeSource({ path: "unsafe/hardlink.txt" }),
            provenance: provenance(ctx.value),
            context: ctx.value,
          })
          .pipe(Effect.flip)
        expect(directoryError).toMatchObject({ code: "source-invalid" })
        expect(hardlinkError).toMatchObject({ code: "source-invalid" })

        if (process.platform === "win32") {
          const outside = path.join(fixture.data, "junction-target")
          yield* Effect.promise(async () => {
            await mkdir(outside)
            await writeFile(path.join(outside, "escaped.txt"), "escaped")
            await symlink(outside, path.join(directory, "junction"), "junction")
          })
          const junctionError = yield* input
            .resolve({
              source: decodeSource({ path: "unsafe/junction/escaped.txt" }),
              provenance: provenance(ctx.value),
              context: ctx.value,
            })
            .pipe(Effect.flip)
          expect(junctionError).toMatchObject({ code: "source-invalid" })
          return
        }

        yield* Effect.promise(() => symlink("original.txt", path.join(directory, "symlink.txt")))
        const symlinkError = yield* input
          .resolve({
            source: decodeSource({ path: "unsafe/symlink.txt" }),
            provenance: provenance(ctx.value),
            context: ctx.value,
          })
          .pipe(Effect.flip)
        expect(symlinkError).toMatchObject({ code: "source-invalid" })
      }),
    ),
  )

  it.live("rejects an oversized source before copying it", () =>
    withInput((fixture) =>
      Effect.gen(function* () {
        const input = yield* ArtifactInput.Service
        const oversized = path.join(fixture.directory, "oversized.bin")
        yield* Effect.promise(async () => {
          await writeFile(oversized, "")
          await truncate(oversized, Artifact.MaxArtifactBytes + 1)
        })
        const ctx = context(fixture.firstSessionID, fixture.firstMessageID)
        const error = yield* input
          .resolve({
            source: decodeSource({ path: "oversized.bin" }),
            provenance: provenance(ctx.value),
            context: ctx.value,
          })
          .pipe(Effect.flip)

        expect(error).toMatchObject({ code: "input-too-large" })
      }),
    ),
  )
})
