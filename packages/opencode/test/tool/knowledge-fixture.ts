import { Artifact } from "@koala-ai/core/artifact/artifact"
import { ArtifactStore } from "@koala-ai/core/artifact/store"
import { ArtifactBlobTable, ArtifactTable } from "@opencode-ai/core/artifact/sql"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SandboxProtocol } from "@koala-ai/core/sandbox/protocol"
import { Agent } from "@/agent/agent"
import { ArtifactInput } from "@/koala/artifact-input"
import { ArtifactStoreLive } from "@/koala/artifact-store"
import { IndustrialAuditLive } from "@/koala/industrial-audit"
import { IndustrialExecution } from "@/koala/industrial-execution"
import { KnowledgeStore } from "@/koala/knowledge-store"
import { MessageID, SessionID } from "@/session/schema"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { sql } from "drizzle-orm"
import { Context, Effect, Layer, Schema, Stream } from "effect"
import { testInstanceStoreLayer, tmpdir } from "../fixture/fixture"

const agent: Agent.Info = { name: "build", mode: "primary", permission: [], options: {} }

export function makeArtifactID() {
  return Schema.decodeUnknownSync(Artifact.ID)(`art_${randomUUID()}`)
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
    digest: randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, ""),
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

export function seedSourceArtifact(fixture: Fixture, text: string) {
  return Effect.gen(function* () {
    const now = fixture.sourceMeta.timeCreated
    yield* fixture.db
      .insert(ArtifactBlobTable)
      .values({ digest: fixture.sourceMeta.digest, size: Buffer.byteLength(text), time_created: now })
      .run()
    yield* fixture.db
      .insert(ArtifactTable)
      .values({
        id: fixture.sourceID,
        digest: fixture.sourceMeta.digest,
        name: fixture.sourceMeta.name,
        mime: fixture.sourceMeta.mime,
        validation_state: fixture.sourceMeta.validation.state,
        validator: fixture.sourceMeta.validation.validator,
        validator_version: fixture.sourceMeta.validation.validatorVersion,
        validation: fixture.sourceMeta.validation,
        owner_session_id: fixture.sessionID,
        owner_message_id: fixture.messageID,
        tool_name: fixture.sourceMeta.provenance.toolName,
        time_created: now,
      })
      .run()
    yield* Effect.promise(() => Bun.write(path.join(fixture.tmpPath, "snapshot"), text))
  })
}

export function withKnowledgeTool<A, E>(
  definition: Effect.Effect<Tool.Info<any, any>, never, any>,
  body: (fixture: Fixture) => Effect.Effect<A, E, KnowledgeStore.Service>,
  extraLayers: ReadonlyArray<Layer.Layer<any, never>> = [],
) {
  return Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => {
      const sessionID = SessionID.make("ses_knowledge")
      const messageID = MessageID.make("msg_knowledge")
      const sourceID = makeArtifactID()
      const sourceMeta = makeSourceMetadata(sourceID, "source.txt", "text/plain", sessionID, messageID)

      const storeImpl = ArtifactStore.Service.of({
        stage: (runID) =>
          Effect.succeed({
            runID,
            root: tmp.path,
            work: tmp.path,
            artifacts: tmp.path,
          }),
        promote: () =>
          Effect.fail(
            new ArtifactStore.PromotionError({
              runID: Schema.decodeUnknownSync(SandboxProtocol.RunID)("run_promote"),
              outputPath: Schema.decodeUnknownSync(Artifact.OutputPath)("out"),
            }),
          ),
        promoteBatch: () => Effect.succeed([]),
        metadata: (artifactID) =>
          artifactID === sourceID ? Effect.succeed(sourceMeta) : Effect.fail(new ArtifactStore.ArtifactNotFoundError({ artifactID })),
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

      const services = LayerNode.compile(
        LayerNode.group([IndustrialAuditLive.node, IndustrialExecution.node, Database.node, KnowledgeStore.node, ArtifactStoreLive.node]),
        [
          [Database.node, Database.layerFromPath(path.join(tmp.path, "knowledge.db"))],
          [ArtifactStoreLive.node, storeLayer],
        ],
      )

      const layer = Layer.mergeAll(
        services,
        testInstanceStoreLayer,
        inputLayer,
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
            title: "knowledge test",
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
        return yield* body({
          tool: yield* info.init(),
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
