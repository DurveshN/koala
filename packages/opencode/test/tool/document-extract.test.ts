import { describe, expect, it } from "bun:test"
import { ToolAuditTable } from "@opencode-ai/core/tool-audit/sql"
import { DocumentRuntime } from "@/document/runtime"
import { DocumentExtractTool } from "@/tool/document-extract"
import { Context, Effect } from "effect"
import { withDocumentTool, toolContext } from "./document-tool-fixture"

const runtime: Partial<Context.Service.Shape<typeof DocumentRuntime.Service>> = {
  readPdf: () =>
    Effect.succeed({
      pageCount: 1,
      title: "Test PDF",
      pages: [{ number: 1, rotation: 0, mediaBox: [0, 0, 100, 100], blocks: [{ text: "Extracted text" }] }],
    }),
}

describe("tool.document_extract", () => {
  it("normalizes a PDF source", async () => {
    await Effect.runPromise(
      Effect.scoped(
        withDocumentTool(DocumentExtractTool, runtime, (fixture) =>
          Effect.gen(function* () {
            const result = yield* fixture.tool.execute(
              { source: { artifactID: fixture.sourceID } },
              toolContext(fixture, "call-extract"),
            )

            expect(result.metadata.result).toMatchObject({
              status: "success",
              tool: "document_extract",
            })
            expect(result.metadata.result.data.normalized.pages).toHaveLength(1)
            expect(result.output.length).toBeGreaterThan(0)

            const audit = yield* fixture.db.select().from(ToolAuditTable).get()
            expect(audit).toMatchObject({
              state: "completed",
              tool_name: "document_extract",
              outcome_code: "success",
            })
          }),
        ),
      ),
    )
  })
})
