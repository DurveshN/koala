import { describe, expect, it } from "bun:test"
import { ToolAuditTable } from "@opencode-ai/core/tool-audit/sql"
import { DocumentValidation } from "@koala-ai/core/document/validation"
import { generateDocx } from "@koala-ai/document-runtime"
import { ArtifactValidateTool } from "@/tool/artifact-validate"
import { Effect } from "effect"
import { writeFileSync } from "node:fs"
import path from "node:path"
import { withDocumentTool, toolContext } from "./document-tool-fixture"

describe("tool.artifact_validate", () => {
  it("validates a DOCX artifact as valid", async () => {
    const bytes = await generateDocx({
      title: "Test Doc",
      author: "Koala",
      sections: [{ type: "paragraph", text: "Hello, world." }],
    })

    await Effect.runPromise(
      Effect.scoped(
        withDocumentTool(
          ArtifactValidateTool,
            {},
          (fixture) =>
            Effect.gen(function* () {
              writeFileSync(path.join(fixture.tmpPath, "snapshot"), bytes)

              const result = yield* fixture.tool.execute(
                { source: { artifactID: fixture.sourceID } },
                toolContext(fixture, "call-validate"),
              )

              expect(result.metadata.result).toMatchObject({
                status: "success",
                tool: "artifact_validate",
                data: { valid: true },
              })
              expect(result.metadata.result.data.findings.length).toBeGreaterThan(0)

              const audit = yield* fixture.db.select().from(ToolAuditTable).get()
              expect(audit).toMatchObject({
                state: "completed",
                tool_name: "artifact_validate",
                outcome_code: "success",
              })
            }),
        ),
      ),
    )
  })

  it("rejects non-DOCX content as engine-failed", async () => {
    await Effect.runPromise(
      Effect.scoped(
        withDocumentTool(
          ArtifactValidateTool,
          {},
          (fixture) =>
            Effect.gen(function* () {
              writeFileSync(path.join(fixture.tmpPath, "snapshot"), Buffer.from("not a docx"))

              const result = yield* fixture.tool.execute(
                { source: { artifactID: fixture.sourceID } },
                toolContext(fixture, "call-validate-fail"),
              )

              expect(result.metadata.result).toMatchObject({
                status: "error",
                tool: "artifact_validate",
              })

              const audit = yield* fixture.db.select().from(ToolAuditTable).get()
              expect(audit).toMatchObject({
                state: "completed",
                tool_name: "artifact_validate",
                outcome_code: "error",
              })
            }),
        ),
      ),
    )
  })
})
