import { describe, expect, it } from "bun:test"
import { ToolAuditTable } from "@opencode-ai/core/tool-audit/sql"
import { DocumentRuntime } from "@/document/runtime"
import { OcrExtractTool } from "@/tool/ocr-extract"
import { Context, Effect } from "effect"
import { withDocumentTool, toolContext } from "./document-tool-fixture"

const tsv = new TextEncoder().encode(
  "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n" +
    "5\t1\t1\t1\t1\t1\t10\t10\t50\t20\t95\tHello\n" +
    "5\t1\t1\t1\t1\t2\t70\t10\t60\t20\t92\tworld",
)

const runtime: Partial<Context.Service.Shape<typeof DocumentRuntime.Service>> = {
  ocr: () =>
    Effect.succeed({
      page: 1,
      dimensions: { width: 200, height: 100 },
      tsv,
      tsvBytes: tsv.byteLength,
    }),
}

describe("tool.ocr_extract", () => {
  it("returns lines parsed from OCR output", async () => {
    await Effect.runPromise(
      Effect.scoped(
        withDocumentTool(OcrExtractTool, runtime, (fixture) =>
          Effect.gen(function* () {
            const result = yield* fixture.tool.execute(
              { source: { artifactID: fixture.sourceID }, page: 1 },
              toolContext(fixture, "call-ocr"),
            )

            expect(result.metadata.result).toMatchObject({
              status: "success",
              tool: "ocr_extract",
              engine: { name: "tesseract", version: "5.5.3" },
            })
            expect(result.metadata.result.data.pages).toHaveLength(1)
            expect(result.metadata.result.data.pages[0].lines).toHaveLength(1)
            expect(result.metadata.result.data.pages[0].lines[0].text).toBe("Hello world")
            expect(result.output.length).toBeGreaterThan(0)

            const audit = yield* fixture.db.select().from(ToolAuditTable).get()
            expect(audit).toMatchObject({
              state: "completed",
              tool_name: "ocr_extract",
              outcome_code: "success",
            })
          }),
        ),
      ),
    )
  })
})
