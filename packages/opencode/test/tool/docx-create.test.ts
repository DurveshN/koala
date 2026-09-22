import { describe, expect } from "bun:test"
import { Artifact } from "@koala-ai/core/artifact/artifact"
import { ArtifactStore } from "@koala-ai/core/artifact/store"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { ToolAuditTable } from "@opencode-ai/core/tool-audit/sql"
import { generateDocx } from "@koala-ai/document-runtime"
import { Context, Effect, Layer, Schema, Stream } from "effect"
import { sql } from "drizzle-orm"
import { createHash, randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { Agent } from "@/agent/agent"
import { DocumentRuntime } from "@/document/runtime"
import { IndustrialAuditLive } from "@/koala/industrial-audit"
import { ArtifactStoreLive } from "@/koala/artifact-store"
import { IndustrialExecution } from "@/koala/industrial-execution"
import { MessageID, SessionID } from "@/session/schema"
import { DocxCreateTool } from "@/tool/docx-create"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { testInstanceStoreLayer, tmpdir } from "../fixture/fixture"
import { it } from "../lib/effect"

const agent: Agent.Info = { name: "build", mode: "primary", permission: [], options: {} }

type Definition = Omit<Tool.InferDef<typeof DocxCreateTool>, "id">

type Fixture = {
  readonly tool: Definition
  readonly db: Context.Service.Shape<typeof Database.Service>["db"]
  readonly sessionID: SessionID
  readonly messageID: MessageID
  readonly tmpPath: string
}

function makeArtifactStoreLayer(tmpPath: string) {
  const artifacts = new Map<string, Artifact.Metadata>()

  const impl: ArtifactStore.Interface = {
    stage: (runID) => Effect.succeed({ runID, root: tmpPath, work: tmpPath, artifacts: tmpPath }),
    promote: (input, options) =>
      Effect.gen(function* () {
        const result = yield* impl.promoteBatch([input], options)
        const first = result[0]
        if (!first) {
          return yield* new ArtifactStore.PromotionError({
            runID: input.runID,
            outputPath: input.outputPath,
          })
        }
        return first
      }),
    promoteBatch: (inputs, options) =>
      Effect.gen(function* () {
        if (inputs.length === 0) return []
        const metadata = yield* Effect.forEach(inputs, (input) =>
          Effect.gen(function* () {
            const candidatePath = path.join(tmpPath, String(input.outputPath))
            const bytes = yield* Effect.promise(() => readFile(candidatePath))
            const digest = createHash("sha256").update(bytes).digest("hex")
            const id = Schema.decodeUnknownSync(Artifact.ID)(`art_${randomUUID()}`)
            const meta = Schema.decodeUnknownSync(Artifact.Metadata)({
              id,
              name: path.posix.basename(String(input.outputPath)),
              mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              size: bytes.byteLength,
              digest,
              validation: {
                state: "accepted",
                validator: "koala-basic",
                validatorVersion: "1",
                findings: [],
              },
              provenance: input.provenance,
              lineage: input.lineage ?? [],
              timeCreated: Date.now(),
            })
            artifacts.set(id, meta)
            return meta
          }),
        )
        if (options?.commit) {
          options.commit.boundary.begin(options.commit.result(metadata))
          options.commit.boundary.complete()
        }
        return metadata
      }),
    metadata: (artifactID) => {
      const meta = artifacts.get(artifactID)
      return meta
        ? Effect.succeed(meta)
        : Effect.fail(new ArtifactStore.ArtifactNotFoundError({ artifactID }))
    },
    content: () => Stream.empty,
    abandon: () => Effect.void,
    reconcile: () => Effect.succeed({ examined: 0, removed: 0 }),
  }

  return Layer.succeed(ArtifactStore.Service, ArtifactStore.Service.of(impl))
}

function runtimeLayer(createDocx: () => Effect.Effect<DocumentRuntime.CreateDocxResult, DocumentRuntime.RuntimeError>) {
  return Layer.mock(DocumentRuntime.Service, { createDocx })
}

function withTool<A, E>(
  createDocx: () => Effect.Effect<DocumentRuntime.CreateDocxResult, DocumentRuntime.RuntimeError>,
  body: (fixture: Fixture) => Effect.Effect<A, E>,
) {
  return Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => {
      const storeLayer = makeArtifactStoreLayer(tmp.path)
      const services = LayerNode.compile(
        LayerNode.group([IndustrialAuditLive.node, IndustrialExecution.node, Database.node]),
        [
          [Database.node, Database.layerFromPath(path.join(tmp.path, "docx.db"))],
          [ArtifactStoreLive.node, storeLayer],
        ],
      )
      const layer = Layer.mergeAll(
        services,
        storeLayer,
        runtimeLayer(createDocx),
        testInstanceStoreLayer,
        Layer.mock(Agent.Service, { get: () => Effect.succeed(agent) }),
        Layer.mock(Truncate.Service, {
          output: (text) => Effect.succeed({ content: text, truncated: false as const }),
        }),
      )
      return Effect.gen(function* () {
        const { db } = yield* Database.Service
        const sessionID = SessionID.make("ses_docx")
        const messageID = MessageID.make("msg_docx")
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
            title: "docx test",
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
        const info = yield* DocxCreateTool
        return yield* body({
          tool: yield* info.init(),
          db,
          sessionID,
          messageID,
          tmpPath: tmp.path,
        })
      }).pipe(Effect.provide(layer))
    },
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )
}

function toolContext(
  fixture: Pick<Fixture, "sessionID" | "messageID">,
  callID: string,
  ask: Tool.Context["ask"] = () => Effect.void,
  abort = AbortSignal.any([]),
): Tool.Context {
  return {
    sessionID: fixture.sessionID,
    messageID: fixture.messageID,
    callID,
    agent: agent.name,
    abort,
    messages: [],
    metadata: () => Effect.void,
    ask,
  }
}

async function generatedBytes() {
  const buffer = await generateDocx({
    title: "Generated DOCX",
    author: "Koala",
    sections: [
      { type: "heading", text: "Summary", level: 1 },
      { type: "paragraph", text: "Created by the docx_create tool." },
    ],
  })
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
}

describe("tool.docx_create", () => {
  it.live("creates a docx artifact and records a successful audit", () =>
    withTool(
      () => Effect.promise(() => generatedBytes().then((bytes) => ({ path: "/dev/null", bytes }))),
      (fixture) =>
        Effect.gen(function* () {
          const requested: unknown[] = []
          const result = yield* fixture.tool.execute(
            {
              contents: {
                title: "Generated DOCX",
                author: "Koala",
                sections: [{ type: "paragraph", text: "Created by the docx_create tool." }],
              },
            },
            toolContext(fixture, "call-docx-create", (request) =>
              Effect.sync(() => requested.push(request)),
            ),
          )

          expect(requested).toEqual([
            { permission: "document_write", patterns: ["*"], always: ["*"], metadata: {} },
          ])
          expect(result.metadata.result.status).toBe("success")
          if (result.metadata.result.status !== "success") return
          const artifact = result.metadata.result.data.artifact
          expect(String(artifact.mime)).toBe(
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          )
          expect(String(artifact.name)).toBe("document.docx")
          expect(result.output).toContain("tool=docx_create")
          expect(result.output).toContain("status=success")

          const audit = yield* fixture.db.select().from(ToolAuditTable).get()
          expect(audit).toMatchObject({
            state: "completed",
            tool_name: "docx_create",
            permission_class: "document_write",
            outcome_code: "success",
            engine_name: "docx-writer",
            engine_version: "1",
            source_artifact_ids: [],
            output_artifact_ids: [artifact.id],
          })
        }),
    ),
  )

  it.live("returns an engine failure when the generated bytes are not valid OOXML", () =>
    withTool(
      () => Effect.succeed({ path: "/dev/null", bytes: new Uint8Array([1, 2, 3]) }),
      (fixture) =>
        Effect.gen(function* () {
          const result = yield* fixture.tool.execute(
            {
              contents: {
                sections: [{ type: "paragraph", text: "Ignored." }],
              },
            },
            toolContext(fixture, "call-docx-create-invalid"),
          )

          expect(result.metadata.result.status).toBe("error")
          expect(result.metadata.result.error?.code).toBe("engine-failed")
          const audit = yield* fixture.db.select().from(ToolAuditTable).get()
          expect(audit).toMatchObject({
            state: "completed",
            tool_name: "docx_create",
            permission_class: "document_write",
            outcome_code: "error",
            error_code: "engine-failed",
          })
        }),
    ),
  )
})
