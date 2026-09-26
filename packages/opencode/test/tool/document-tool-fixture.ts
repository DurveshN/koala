import { Artifact } from "@koala-ai/core/artifact/artifact"
import { ArtifactStore } from "@koala-ai/core/artifact/store"
import { SandboxProtocol } from "@koala-ai/core/sandbox/protocol"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { sql } from "drizzle-orm"
import { Context, Effect, Layer, Schema, Stream } from "effect"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Agent } from "@/agent/agent"
import { ArtifactInput } from "@/koala/artifact-input"
import { ArtifactStoreLive } from "@/koala/artifact-store"
import { IndustrialAuditLive } from "@/koala/industrial-audit"
import { IndustrialExecution } from "@/koala/industrial-execution"
import { SessionID, MessageID } from "@/session/schema"
import { DocumentRuntime } from "@/document/runtime"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { tmpdir, testInstanceStoreLayer } from "../fixture/fixture"

const agent: Agent.Info = { name: "build", mode: "primary", permission: [], options: {} }

export function makeArtifactID() {
  return Schema.decodeUnknownSync(Artifact.ID)(`art_${randomUUID()}`)
}

export function makeDigest() {
  return randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "")
}

export function makeSourceMetadata(
  id: Artifact.ID,
  name: string,
  mime: string,
  sessionID: SessionID,
  messageID: MessageID,
): Artifact.Metadata {
  return Schema.decodeUnknownSync(Artifact.Metadata)({
    id,
    name,
    mime,
    size: 100,
    digest: makeDigest(),
    validation: { state: "accepted", validator: "koala-basic", validatorVersion: "1", findings: [] },
    provenance: { sessionID, messageID, toolName: "test" },
    lineage: [],
    timeCreated: Date.now(),
  })
}

export interface Fixture {
  readonly tool: Tool.DefWithoutID<any, any>
  readonly db: Context.Service.Shape<typeof Database.Service>["db"]
  readonly sessionID: SessionID
  readonly messageID: MessageID
  readonly sourceID: Artifact.ID
  readonly sourceMeta: Artifact.Metadata
  readonly tmpPath: string
}

type RuntimeShape = Partial<Context.Service.Shape<typeof DocumentRuntime.Service>>

export function withDocumentTool<A, E, R>(
  definition: Effect.Effect<Tool.Info<any, any>, never, R>,
  runtime: RuntimeShape | ((tmpPath: string) => RuntimeShape),
  body: (fixture: Fixture) => Effect.Effect<A, E>,
  extraLayers: ReadonlyArray<Layer.Layer<any, never>> = [],
) {
  return Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => {
      const sessionID = SessionID.make("ses_doc")
      const messageID = MessageID.make("msg_doc")
      const sourceID = makeArtifactID()
      const sourceMeta = makeSourceMetadata(sourceID, "source.pdf", "application/pdf", sessionID, messageID)

      const storeImpl = ArtifactStore.Service.of({
        stage: (runID) =>
          Effect.succeed({
            runID,
            root: tmp.path,
            work: tmp.path,
            artifacts: tmp.path,
          }),
        promote: () => Effect.fail(new ArtifactStore.PromotionError({ runID: Schema.decodeUnknownSync(SandboxProtocol.RunID)("run_promote"), outputPath: Schema.decodeUnknownSync(Artifact.OutputPath)("out") })),
        promoteBatch: () => Effect.succeed([]),
        metadata: (artifactID) =>
          artifactID === sourceID
            ? Effect.succeed(sourceMeta)
            : Effect.fail(new ArtifactStore.ArtifactNotFoundError({ artifactID })),
        content: () => Stream.empty,
        abandon: () => Effect.void,
        reconcile: () => Effect.succeed({ examined: 0, removed: 0 }),
      })
      const storeLayer = Layer.succeed(ArtifactStore.Service, storeImpl)

      const inputLayer = Layer.mock(ArtifactInput.Service, {
        resolve: () =>
          Effect.succeed({
            artifact: sourceMeta,
            snapshotPath: path.join(tmp.path, "snapshot"),
          }),
      })

      const runtimeLayer = Layer.mock(DocumentRuntime.Service, typeof runtime === "function" ? runtime(tmp.path) : runtime)

      const services = LayerNode.compile(
        LayerNode.group([IndustrialAuditLive.node, IndustrialExecution.node, Database.node]),
        [
          [Database.node, Database.layerFromPath(path.join(tmp.path, "doc.db"))],
          [ArtifactStoreLive.node, storeLayer],
        ],
      )

      const layer = Layer.mergeAll(
        services,
        storeLayer,
        testInstanceStoreLayer,
        inputLayer,
        runtimeLayer,
        Layer.mock(Agent.Service, { get: () => Effect.succeed(agent) }),
        Layer.mock(Truncate.Service, {
          output: (text) => Effect.succeed({ content: text, truncated: false as const }),
        }),
        ...extraLayers,
      )

      return Effect.gen(function* () {
        const { db } = yield* Database.Service
        const now = Date.now()
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
            title: "doc test",
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
        const info = yield* definition
        const tool = yield* info.init()
        return yield* body({
          tool,
          db,
          sessionID,
          messageID,
          sourceID,
          sourceMeta,
          tmpPath: tmp.path,
        })
      }).pipe(Effect.provide(layer))
    },
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )
}

export function toolContext(
  fixture: Pick<Fixture, "sessionID" | "messageID">,
  callID: string,
  ask: Tool.Context["ask"] = () => Effect.void,
  abort = AbortSignal.any([]),
): Tool.Context {
  return {
    sessionID: fixture.sessionID,
    messageID: fixture.messageID,
    callID,
    agent: "test",
    abort,
    messages: [],
    metadata: () => Effect.void,
    ask,
  }
}
