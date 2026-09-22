import { describe, expect } from "bun:test"
import { ToolAuditTable } from "@opencode-ai/core/tool-audit/sql"
import { Effect } from "effect"
import { KnowledgeStore } from "@/koala/knowledge-store"
import { KnowledgeSearchTool } from "@/tool/knowledge-search"
import { it } from "../lib/effect"
import { seedSourceArtifact, toolContext, withKnowledgeTool } from "./knowledge-fixture"

describe("tool.knowledge_search", () => {
  it.live("returns matching knowledge entries", () =>
    withKnowledgeTool(
      KnowledgeSearchTool,
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

          const requested: unknown[] = []
          const result = yield* fixture.tool.execute(
            { query: "lazy" },
            toolContext(fixture, "call-knowledge-search", (request) =>
              Effect.sync(() => requested.push(request)),
            ),
          )

          expect(requested).toEqual([{ permission: "knowledge_read", patterns: ["*"], always: ["*"], metadata: {} }])
          expect(result.metadata.result.status).toBe("success")
          if (result.metadata.result.status !== "success") return
          expect(result.metadata.result.data.results.length).toBeGreaterThan(0)
          expect(result.metadata.result.data.results[0].score).toBeGreaterThan(0)
          expect(result.metadata.result.data.results[0].text.toLowerCase()).toContain("lazy")

          const audit = yield* fixture.db.select().from(ToolAuditTable).get()
          expect(audit).toMatchObject({
            state: "completed",
            tool_name: "knowledge_search",
            permission_class: "knowledge_read",
            outcome_code: "success",
            engine_name: "local-knowledge-store",
            engine_version: "1",
          })
        }),
    ),
  )
})
