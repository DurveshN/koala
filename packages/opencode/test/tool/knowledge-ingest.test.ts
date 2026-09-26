import { describe, expect } from "bun:test"
import { ToolAuditTable } from "@opencode-ai/core/tool-audit/sql"
import { Effect } from "effect"
import { KnowledgeIngestTool } from "@/tool/knowledge-ingest"
import { it } from "../lib/effect"
import { seedSourceArtifact, toolContext, withKnowledgeTool } from "./knowledge-fixture"

describe("tool.knowledge_ingest", () => {
  it.live("ingests an artifact and records a successful audit", () =>
    withKnowledgeTool(
      KnowledgeIngestTool,
      (fixture) =>
        Effect.gen(function* () {
          const text = "The quick brown fox jumps over the lazy dog."
          yield* seedSourceArtifact(fixture, text)

          const requested: unknown[] = []
          const result = yield* fixture.tool.execute(
            { source: fixture.sourceID },
            toolContext(fixture, "call-knowledge-ingest", (request) =>
              Effect.sync(() => requested.push(request)),
            ),
          )

          expect(requested).toEqual([{ permission: "knowledge_write", patterns: ["*"], always: ["*"], metadata: {} }])
          expect(result.metadata.result.status).toBe("success")
          if (result.metadata.result.status !== "success") return
          expect(result.metadata.result.data.entries).toBeGreaterThan(0)
          expect(result.output).toContain("Ingested")

          const audit = yield* fixture.db.select().from(ToolAuditTable).get()
          expect(audit).toMatchObject({
            state: "completed",
            tool_name: "knowledge_ingest",
            permission_class: "knowledge_write",
            outcome_code: "success",
            engine_name: "local-knowledge-store",
            engine_version: "1",
          })
        }),
    ),
  )
})
