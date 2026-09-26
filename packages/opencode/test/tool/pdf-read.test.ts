import { describe, expect, it } from "bun:test"
import { ToolAuditTable } from "@opencode-ai/core/tool-audit/sql"
import { DocumentRuntime } from "@/document/runtime"
import { PdfReadTool } from "@/tool/pdf-read"
import { Context, Effect } from "effect"
import { withDocumentTool, toolContext } from "./document-tool-fixture"

const runtime: Partial<Context.Service.Shape<typeof DocumentRuntime.Service>> = {
  readPdf: () =>
    Effect.succeed({
      pageCount: 2,
      title: "Test PDF",
      pages: [
        { number: 1, rotation: 0, mediaBox: [0, 0, 100, 100], blocks: [{ text: "Page one" }] },
        { number: 2, rotation: 0, mediaBox: [0, 0, 100, 100], blocks: [{ text: "Page two" }] },
      ],
    }),
}

describe("tool.pdf_read", () => {
  it("returns normalized pages and completes an audit", async () => {
    await Effect.runPromise(
      Effect.scoped(
        withDocumentTool(PdfReadTool, runtime, (fixture) =>
          Effect.gen(function* () {
            const result = yield* fixture.tool.execute(
              { source: { artifactID: fixture.sourceID } },
              toolContext(fixture, "call-pdf-read"),
            )

            expect(result.metadata.result).toMatchObject({
              status: "success",
              tool: "pdf_read",
              engine: { name: "pdfjs", version: "1" },
            })
            expect(result.metadata.result.data.normalized.pages).toHaveLength(2)
            expect(result.metadata.result.data.normalized.metadata.title).toBe("Test PDF")
            expect(result.output.length).toBeGreaterThan(0)
            expect(result.metadata.truncated).toBe(false)

            const audit = yield* fixture.db.select().from(ToolAuditTable).get()
            expect(audit).toMatchObject({
              state: "completed",
              tool_name: "pdf_read",
              outcome_code: "success",
            })
          }),
        ),
      ),
    )
  })

  it("limits pages to requested range", async () => {
    await Effect.runPromise(
      Effect.scoped(
        withDocumentTool(
          PdfReadTool,
          runtime,
          (fixture) =>
            Effect.gen(function* () {
              const result = yield* fixture.tool.execute(
                { source: { artifactID: fixture.sourceID }, pages: { startPage: 2, pageCount: 1 } },
                toolContext(fixture, "call-pdf-read-range"),
              )

              expect(result.metadata.result.data.normalized.pages).toHaveLength(1)
              expect(result.metadata.result.data.normalized.pages[0].pageNumber).toBe(2)
            }),
        ),
      ),
    )
  })
})
