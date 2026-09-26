import { describe, expect } from "bun:test"
import { ToolAuditTable } from "@opencode-ai/core/tool-audit/sql"
import { Effect } from "effect"
import { KnowledgeStore } from "@/koala/knowledge-store"
import { KnowledgeOpenTool } from "@/tool/knowledge-open"
import { it } from "../lib/effect"
import { seedSourceArtifact, toolContext, withKnowledgeTool } from "./knowledge-fixture"

describe("tool.knowledge_open", () => {
  it.live("opens an entry by id", () =>
    withKnowledgeTool(
      KnowledgeOpenTool,
      (fixture) =>
        Effect.gen(function* () {
          const text = "The quick brown fox jumps over the lazy dog."
          yield* seedSourceArtifact(fixture, text)
          const store = yield* KnowledgeStore.Service
          yield* store.ingest({
            sessionID: fixture.sessionID,
            artifactID: fixture.sourceID,
            artifactName: fixture.sourceMeta.name,
            text,
            indexProfileID: "default",
            extractorVersion: "1",
            chunkerVersion: "1",
          })

          const searchResults = yield* store.search({ sessionID: fixture.sessionID, query: "fox" })
          expect(searchResults.length).toBeGreaterThan(0)
          const entryID = searchResults[0].entryID

          const result = yield* fixture.tool.execute(
            { entryID },
            toolContext(fixture, "call-knowledge-open"),
          )

          expect(result.metadata.result.status).toBe("success")
          if (result.metadata.result.status !== "success") return
          expect(result.metadata.result.data.entryID).toBe(entryID)
          expect(result.metadata.result.data.text.toLowerCase()).toContain("fox")

          const audit = yield* fixture.db.select().from(ToolAuditTable).get()
          expect(audit).toMatchObject({
            state: "completed",
            tool_name: "knowledge_open",
            permission_class: "knowledge_read",
            outcome_code: "success",
            engine_name: "local-knowledge-store",
            engine_version: "1",
          })
        }),
    ),
  )

  it.live("returns a not-found error for a missing entry", () =>
    withKnowledgeTool(
      KnowledgeOpenTool,
      (fixture) =>
        Effect.gen(function* () {
          const result = yield* fixture.tool.execute(
            { entryID: "kwe_00000000-0000-4000-8000-000000000000" as any },
            toolContext(fixture, "call-knowledge-open-missing"),
          )

          expect(result.metadata.result.status).toBe("error")
          if (result.metadata.result.status !== "error") return
          expect(result.metadata.result.error.code).toBe("source-not-found")
        }),
    ),
  )
})
