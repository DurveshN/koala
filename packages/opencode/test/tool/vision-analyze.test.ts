import { describe, expect, it } from "bun:test"
import { ToolAuditTable } from "@opencode-ai/core/tool-audit/sql"
import { ModelProfile } from "@koala-ai/core/model/profile"
import { DocumentRuntime } from "@/document/runtime"
import { ModelEndpointClient } from "@/koala/model-endpoint-client"
import { ModelProfileStore } from "@/koala/model-profile-store"
import { VisionAnalyzeTool } from "@/tool/vision-analyze"
import { Auth } from "@/auth"
import { Context, Effect, Layer, Schema } from "effect"
import { writeFileSync } from "node:fs"
import path from "node:path"
import { withDocumentTool, toolContext } from "./document-tool-fixture"

const makeProvider = (baseURL: string) =>
  Schema.decodeUnknownSync(ModelProfile.Provider)({
    id: "test-provider",
    displayName: "Test Provider",
    baseURL,
    models: [
      {
        id: "vision-model",
        displayName: "Vision Model",
        capabilities: {
          textInput: "yes",
          imageInput: "yes",
          toolCalling: "no",
          streaming: "no",
          structuredOutput: "no",
          reasoning: "no",
        },
        contextWindow: 4096,
        maxOutput: 1024,
        roles: ["vision"],
        enabled: true,
        priority: 1,
      },
    ],
  })

const tinyPngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

const runtime = (tmpPath: string): Partial<Context.Service.Shape<typeof DocumentRuntime.Service>> => {
  const pagePath = path.join(tmpPath, "page.png")
  writeFileSync(pagePath, Buffer.from(tinyPngBase64, "base64"))
  return {
    renderAndOcr: (_input, callback) =>
      Effect.gen(function* () {
        yield* callback({
          page: 1,
          pagePath,
          tsvPath: pagePath,
          dimensions: { width: 10, height: 10 },
          pngBytes: 100,
          tsvBytes: 0,
        })
        return { pagesProcessed: 1 }
      }),
  }
}

describe("tool.vision_analyze", () => {
  it("routes to vision model and returns observations", async () => {
    const provider = makeProvider("http://localhost:8080")
    const modelID = provider.models[0].id
    const profileLayer = Layer.mock(ModelProfileStore.Service, {
      list: () => Effect.succeed([provider]),
    })
    const authLayer = Layer.mock(Auth.Service, {
      get: () => Effect.succeed(undefined),
    })

    const endpointLayer = Layer.mock(ModelEndpointClient.Service, {
      bind: ({ providerID, baseURL }) =>
        Effect.succeed({
          providerID,
          baseURL,
          fetch: async () =>
            new Response(
              JSON.stringify({
                choices: [
                  {
                    message: {
                      content: JSON.stringify({ observations: [{ description: "A red circle" }] }),
                    },
                  },
                ],
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
        } as ModelEndpointClient.BoundClient),
    })

    await Effect.runPromise(
      Effect.scoped(
        withDocumentTool(
          VisionAnalyzeTool,
          runtime,
          (fixture) =>
            Effect.gen(function* () {
              const result = yield* fixture.tool.execute(
                { source: { artifactID: fixture.sourceID } },
                toolContext(fixture, "call-vision"),
              )

              expect(result.metadata.result).toMatchObject({
                status: "success",
                tool: "vision_analyze",
                data: { observations: [{ description: "A red circle" }] },
              })
              expect(result.output.length).toBeGreaterThan(0)

              const audit = yield* fixture.db.select().from(ToolAuditTable).get()
              expect(audit).toMatchObject({
                state: "completed",
                tool_name: "vision_analyze",
                outcome_code: "success",
              })
            }),
          [profileLayer, endpointLayer, authLayer],
        ),
      ),
    )
  })
})
