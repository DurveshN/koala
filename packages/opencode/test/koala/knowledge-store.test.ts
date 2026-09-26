import { describe, expect } from "bun:test"
import { Artifact } from "@koala-ai/core/artifact/artifact"
import { ArtifactBlobTable, ArtifactTable } from "@opencode-ai/core/artifact/sql"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { createHash, randomUUID } from "node:crypto"
import path from "node:path"
import { sql } from "drizzle-orm"
import { Context, Effect, Schema } from "effect"
import { KnowledgeStore } from "@/koala/knowledge-store"
import { MessageID, SessionID } from "@/session/schema"
import { tmpdir } from "../fixture/fixture"
import { it } from "../lib/effect"

type DB = Context.Service.Shape<typeof Database.Service>["db"]

type Fixture = {
  readonly db: DB
  readonly sessionID: SessionID
  readonly messageID: MessageID
}

const withStore = <A, E>(body: (fixture: Fixture) => Effect.Effect<A, E, KnowledgeStore.Service | Database.Service>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => {
      const testLayer = LayerNode.compile(LayerNode.group([KnowledgeStore.node, Database.node]), [
        [Database.node, Database.layerFromPath(path.join(tmp.path, "knowledge-store.db"))],
      ])
      return Effect.gen(function* () {
        const { db } = yield* Database.Service
        const now = Date.now()
        const sessionID = SessionID.make("ses_knowledge")
        const messageID = MessageID.make("msg_knowledge")
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
        return yield* body({ db, sessionID, messageID })
      }).pipe(Effect.provide(testLayer))
    },
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

function makeArtifactID() {
  return Schema.decodeUnknownSync(Artifact.ID)(`art_${randomUUID()}`)
}

function seedArtifact(db: DB, sessionID: string, messageID: string, artifactID: Artifact.ID, text: string) {
  const digest = createHash("sha256").update(text).digest("hex")
  const validation = {
    state: "accepted" as const,
    validator: Artifact.ValidatorName,
    validatorVersion: Artifact.ValidatorVersion,
    findings: [],
  }
  const now = Date.now()
  return Effect.gen(function* () {
    yield* db
      .insert(ArtifactBlobTable)
      .values({ digest, size: Buffer.byteLength(text), time_created: now })
      .run()
    yield* db
      .insert(ArtifactTable)
      .values({
        id: artifactID,
        digest,
        name: "doc.txt",
        mime: "text/plain",
        validation_state: validation.state,
        validator: validation.validator,
        validator_version: validation.validatorVersion,
        validation,
        owner_session_id: sessionID,
        owner_message_id: messageID,
        tool_name: "test",
        time_created: now,
      })
      .run()
  })
}

describe("KnowledgeStore", () => {
  it.live("ingests a document and searches for matching chunks", () =>
    withStore((fixture) =>
      Effect.gen(function* () {
        const store = yield* KnowledgeStore.Service
        const artifactID = makeArtifactID()
        const text = "The quick brown fox jumps over the lazy dog.\nAlpha particles are interesting."
        yield* seedArtifact(fixture.db, fixture.sessionID, fixture.messageID, artifactID, text)
        const entries = yield* store.ingest({
          sessionID: fixture.sessionID,
          artifactID,
          artifactName: "doc.txt",
          text,
          indexProfileID: "default",
          extractorVersion: "1",
          chunkerVersion: "1",
        })

        expect(entries).toBeGreaterThan(0)

        const results = yield* store.search({ sessionID: fixture.sessionID, query: "alpha" })
        expect(results.length).toBeGreaterThan(0)
        expect(results[0].score).toBeGreaterThan(0)
        expect(results[0].text.toLowerCase()).toContain("alpha")

        const opened = yield* store.open({ sessionID: fixture.sessionID, entryID: results[0].entryID })
        expect(opened).toBeDefined()
        expect(opened?.text).toBe(results[0].text)
      }),
    ),
  )

  it.live("searches across multiple documents and returns only matching chunks", () =>
    withStore((fixture) =>
      Effect.gen(function* () {
        const store = yield* KnowledgeStore.Service
        const firstID = makeArtifactID()
        const secondID = makeArtifactID()
        const firstText = "Banana bread is delicious and easy to bake."
        const secondText = "Car engines require regular maintenance."
        yield* seedArtifact(fixture.db, fixture.sessionID, fixture.messageID, firstID, firstText)
        yield* seedArtifact(fixture.db, fixture.sessionID, fixture.messageID, secondID, secondText)

        yield* store.ingest({
          sessionID: fixture.sessionID,
          artifactID: firstID,
          artifactName: "first.txt",
          text: firstText,
          indexProfileID: "default",
          extractorVersion: "1",
          chunkerVersion: "1",
        })
        yield* store.ingest({
          sessionID: fixture.sessionID,
          artifactID: secondID,
          artifactName: "second.txt",
          text: secondText,
          indexProfileID: "default",
          extractorVersion: "1",
          chunkerVersion: "1",
        })

        const results = yield* store.search({ sessionID: fixture.sessionID, query: "banana" })
        expect(results.length).toBeGreaterThan(0)
        expect(results.every((result) => result.locator.artifactID === firstID)).toBe(true)
      }),
    ),
  )

  it.live("replaces prior entries when re-ingesting the same artifact", () =>
    withStore((fixture) =>
      Effect.gen(function* () {
        const store = yield* KnowledgeStore.Service
        const artifactID = makeArtifactID()
        const firstText = "Delta waves appear during deep sleep."
        const secondText = "Echo location helps bats navigate."
        yield* seedArtifact(fixture.db, fixture.sessionID, fixture.messageID, artifactID, firstText)

        const firstCount = yield* store.ingest({
          sessionID: fixture.sessionID,
          artifactID,
          artifactName: "doc.txt",
          text: firstText,
          indexProfileID: "default",
          extractorVersion: "1",
          chunkerVersion: "1",
        })
        expect(firstCount).toBeGreaterThan(0)

        yield* store.ingest({
          sessionID: fixture.sessionID,
          artifactID,
          artifactName: "doc.txt",
          text: secondText,
          indexProfileID: "default",
          extractorVersion: "1",
          chunkerVersion: "1",
        })

        const deltaResults = yield* store.search({ sessionID: fixture.sessionID, query: "delta" })
        expect(deltaResults.length).toBe(0)

        const echoResults = yield* store.search({ sessionID: fixture.sessionID, query: "echo" })
        expect(echoResults.length).toBeGreaterThan(0)
      }),
    ),
  )
})
