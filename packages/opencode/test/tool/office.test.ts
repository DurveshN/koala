import { describe, expect } from "bun:test"
import { DocumentRuntime } from "@/document/runtime"
import { ArtifactInput } from "@/koala/artifact-input"
import { IndustrialExecution } from "@/koala/industrial-execution"
import { Artifact } from "@koala-ai/core/artifact/artifact"
import { IndustrialProjection } from "@koala-ai/core/industrial/projection"
import { Effect, Layer, Schema } from "effect"
import { Agent } from "@/agent/agent"
import { MessageID, SessionID } from "@/session/schema"
import { DocxReadTool, PptxReadTool, SpreadsheetReadTool } from "@/tool/office"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { tmpdir } from "../fixture/fixture"
import { it } from "../lib/effect"

const agent: Agent.Info = { name: "build", mode: "primary", permission: [], options: {} }

const artifactID = Schema.decodeUnknownSync(Artifact.ID)("art_123e4567-e89b-42d3-a456-426614174000")
const artifactName = Schema.decodeUnknownSync(Artifact.Name)("report.docx")
const artifactMime = Schema.decodeUnknownSync(Artifact.MimeType)(
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
)
const artifactDigest = Schema.decodeUnknownSync(Artifact.Digest)("0123456789abcdef".repeat(4))
const artifactSize = Schema.decodeUnknownSync(Artifact.ByteSize)(1024)

const artifactMetadata = Schema.decodeUnknownSync(Artifact.Metadata)({
  id: artifactID,
  name: artifactName,
  mime: artifactMime,
  size: artifactSize,
  digest: artifactDigest,
  validation: { state: "accepted", validator: "test", validatorVersion: "1", findings: [] },
  provenance: {
    sessionID: "ses_test",
    messageID: "msg_test",
    toolName: "docx_read",
    toolCallID: "call_test",
  },
  lineage: [],
  timeCreated: Date.now(),
})

type Fixture = {
  readonly tool: Tool.Def
  readonly readCalls: Array<{ inputPath: string; format: DocumentRuntime.ReadOfficeInput["format"] }>
}

type OfficeToolDef = typeof DocxReadTool | typeof PptxReadTool | typeof SpreadsheetReadTool

const context = (callID: string, ask: Tool.Context["ask"] = () => Effect.void): Tool.Context => ({
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID,
  agent: agent.name,
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask,
})

const industrialExecutionMock = IndustrialExecution.Service.of({
  execute: (request: any) =>
    Effect.gen(function* () {
      const signal = new AbortController().signal
      const commit = {
        begin: () => false,
        complete: () => {},
        rollback: () => {},
      }
      const result = yield* request.operation(signal, commit).pipe(Effect.orDie)
      const projection = IndustrialProjection.project(result as never)
      return { result: result as never, projection }
    }) as any,
})

const withTool = <A, E>(
  body: (fixture: Fixture) => Effect.Effect<A, E>,
  definition: typeof DocxReadTool | typeof PptxReadTool | typeof SpreadsheetReadTool = DocxReadTool,
  runtimeResult?: DocumentRuntime.ReadOfficeResult,
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => {
      const readCalls: Fixture["readCalls"] = []
      const layer = Layer.mergeAll(
        Layer.mock(Agent.Service, { get: () => Effect.succeed(agent) }),
        Layer.mock(Truncate.Service, {
          output: (text) => Effect.succeed({ content: text, truncated: false as const }),
        }),
        Layer.mock(ArtifactInput.Service, {
          resolve: () =>
            Effect.succeed({
              artifact: artifactMetadata,
              snapshotPath: tmp.path,
            }),
        }),
        Layer.mock(DocumentRuntime.Service, {
          readOffice: ({ inputPath, format }) => {
            readCalls.push({ inputPath, format })
            return Effect.succeed(
              runtimeResult ?? {
                title: "Test",
                author: "Author",
                sections: [{ type: "paragraph", heading: "Intro", body: "Hello world" }],
              },
            )
          },
        }),
        Layer.succeed(IndustrialExecution.Service, industrialExecutionMock),
      )
      return Effect.gen(function* () {
        const info = yield* definition
        return yield* body({ tool: yield* Tool.init(info as any), readCalls })
      }).pipe(Effect.provide(layer))
    },
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

describe("tool.office", () => {
  it.live("reads a docx file through the industrial boundary", () =>
    withTool((fixture) =>
      Effect.gen(function* () {
        const result = yield* fixture.tool.execute(
          { source: { artifactID } },
          context("call-docx"),
        )

        expect(result.output).toContain("tool=docx_read")
        expect(result.output).toContain("status=success")
        expect(result.metadata.result).toMatchObject({
          status: "success",
          tool: "docx_read",
          data: {
            title: "Test",
            author: "Author",
            sections: [{ type: "paragraph", heading: "Intro", body: "Hello world" }],
          },
        })
        expect(result.metadata.truncated).toBe(false)
        expect(fixture.readCalls).toEqual([{ inputPath: expect.any(String), format: "docx" }])
      }),
    ),
  )

  it.live("reads pptx and xlsx files with the correct format", () =>
    Effect.gen(function* () {
      const pptx = yield* withTool(
        (fixture) =>
          Effect.gen(function* () {
            yield* fixture.tool.execute({ source: { artifactID } }, context("call-pptx"))
            return fixture.readCalls
          }),
        PptxReadTool,
      )
      const xlsx = yield* withTool(
        (fixture) =>
          Effect.gen(function* () {
            yield* fixture.tool.execute({ source: { artifactID } }, context("call-xlsx"))
            return fixture.readCalls
          }),
        SpreadsheetReadTool,
      )

      expect(pptx).toEqual([{ inputPath: expect.any(String), format: "pptx" }])
      expect(xlsx).toEqual([{ inputPath: expect.any(String), format: "xlsx" }])
    }),
  )

  it.live("maps runtime failures to industrial errors", () =>
    Effect.gen(function* () {
      const readCalls: Fixture["readCalls"] = []
      const failingRuntime = Layer.mock(DocumentRuntime.Service, {
        readOffice: ({ inputPath, format }) => {
          readCalls.push({ inputPath, format })
          return Effect.fail(
            new DocumentRuntime.RuntimeError({
              code: "worker-failed",
              stage: "worker",
              retryable: false,
            }),
          )
        },
      })
      const layer = Layer.mergeAll(
        Layer.mock(Agent.Service, { get: () => Effect.succeed(agent) }),
        Layer.mock(Truncate.Service, {
          output: (text) => Effect.succeed({ content: text, truncated: false as const }),
        }),
        Layer.mock(ArtifactInput.Service, {
          resolve: () =>
            Effect.succeed({
              artifact: artifactMetadata,
              snapshotPath: "/snapshot",
            }),
        }),
        failingRuntime,
        Layer.succeed(IndustrialExecution.Service, industrialExecutionMock),
      )
      const result = yield* Effect.gen(function* () {
        const info = yield* DocxReadTool
        const tool = yield* Tool.init(info)
        return yield* tool.execute({ source: { artifactID } }, context("call-error"))
      }).pipe(Effect.provide(layer))

      expect(result.metadata.result.status).toBe("error")
      expect(result.output).toContain("status=error")
      expect(result.output).toContain("error_code=engine-failed")
    }),
  )
})
