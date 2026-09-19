import { describe, expect, test } from "bun:test"
import { Result, Schema } from "effect"
import { Artifact } from "../artifact/artifact"
import { SandboxTool } from "../sandbox/tool"
import { IndustrialAudit } from "./audit"
import { IndustrialCitation } from "./citation"
import { IndustrialInput } from "./input"
import { IndustrialResult } from "./result"
import { IndustrialTool } from "./tool"

const artifactID = "art_123e4567-e89b-42d3-a456-426614174000"
const digest = "0123456789abcdef".repeat(4)
const engine = { name: "sandbox-runtime", version: "1.0.0" }
const reference = {
  id: artifactID,
  name: "report.txt",
  mime: "text/plain",
  size: 6,
  digest,
}
const referenceAt = (index: number) => ({
  ...reference,
  id: `art_123e4567-e89b-42d3-a456-${index.toString(16).padStart(12, "0")}`,
})

describe("IndustrialTool", () => {
  test("contains exactly the approved 22 tool names", () => {
    expect(IndustrialTool.ApprovedNames).toEqual([
      "document_extract",
      "ocr_extract",
      "vision_analyze",
      "knowledge_ingest",
      "knowledge_search",
      "knowledge_open",
      "docx_read",
      "docx_create",
      "docx_update",
      "pptx_read",
      "pptx_create",
      "pptx_update",
      "spreadsheet_read",
      "spreadsheet_write",
      "spreadsheet_update",
      "pdf_read",
      "pdf_create",
      "pdf_update",
      "calculate",
      "sandbox_execute",
      "sandbox_test",
      "artifact_validate",
    ])
    expect(IndustrialTool.ApprovedNames).toHaveLength(22)
    expect(Object.keys(IndustrialTool.PermissionByName)).toEqual([...IndustrialTool.ApprovedNames])
    expect(IndustrialTool.ApprovedNames.map(IndustrialTool.permission)).toEqual([
      "document_read",
      "document_read",
      "vision_analyze",
      "knowledge_write",
      "knowledge_read",
      "knowledge_read",
      "document_read",
      "document_write",
      "document_write",
      "document_read",
      "document_write",
      "document_write",
      "document_read",
      "document_write",
      "document_write",
      "document_read",
      "document_write",
      "document_write",
      "calculate",
      "sandbox_execute",
      "sandbox_execute",
      "document_read",
    ])
  })
})

describe("IndustrialInput", () => {
  const decode = Schema.decodeUnknownSync(IndustrialInput.Source)

  test("accepts exactly one artifact or path source and summarizes without the path", () => {
    const sources = [decode({ artifactID }), decode({ path: "private/reports/report.pdf" })]
    expect(IndustrialInput.summarize(sources, 2)).toEqual({
      sourceCount: 2,
      artifactCount: 1,
      pathCount: 1,
      declaredOutputCount: 2,
    })
    expect(JSON.stringify(IndustrialInput.summarize(sources))).not.toContain("private")
  })

  test.each([
    {},
    { artifactID, path: "report.pdf" },
    { artifactID: "invalid" },
    { path: " report.pdf" },
    { path: "report\0.pdf" },
    { path: "https://private.example/report.pdf" },
  ])("rejects a non-exclusive or invalid source %#", (input) => {
    expect(() => decode(input)).toThrow()
  })

  test("enforces source and output summary limits", () => {
    const source = decode({ artifactID })
    expect(
      Schema.decodeUnknownSync(IndustrialInput.Sources)(
        Array.from({ length: IndustrialInput.MaxSources }, () => source),
      ),
    ).toHaveLength(IndustrialInput.MaxSources)
    expect(() =>
      Schema.decodeUnknownSync(IndustrialInput.Sources)(
        Array.from({ length: IndustrialInput.MaxSources + 1 }, () => source),
      ),
    ).toThrow()
    expect(() => IndustrialInput.summarize([], Artifact.MaxOutputsPerRun + 1)).toThrow()
  })
})

describe("IndustrialCitation", () => {
  const decode = Schema.decodeUnknownSync(IndustrialCitation.Locator)

  test.each([
    { type: "artifact", artifactID },
    { type: "page", artifactID, page: 1 },
    { type: "region", artifactID, page: 2, left: 0.1, top: 0.2, right: 0.8, bottom: 0.9 },
    {
      type: "docx",
      artifactID,
      part: "document",
      path: [
        { node: "section", index: 0 },
        { node: "paragraph", index: 3 },
      ],
      elementID: "para-42",
    },
    { type: "slide", artifactID, slide: 3, shapeID: "shape-7" },
    { type: "sheet", artifactID, sheet: "Inspection", range: "B2:F20" },
    { type: "text", artifactID, start: 10, end: 25 },
  ] as const)("round trips the $type locator", (locator) => {
    expect(Schema.encodeSync(IndustrialCitation.Locator)(decode(locator))).toEqual(locator)
  })

  test.each([
    { type: "page", artifactID, page: 0 },
    { type: "region", artifactID, page: 1, left: 0.8, top: 0, right: 0.2, bottom: 1 },
    { type: "sheet", artifactID, sheet: "unsafe/path", range: "A1" },
    { type: "sheet", artifactID, sheet: "Safe", range: "A0" },
    { type: "text", artifactID, start: 5, end: 4 },
  ])("rejects invalid locator %#", (locator) => {
    expect(() => decode(locator)).toThrow()
  })

  test("bounds citations and DOCX structural depth", () => {
    const locator = decode({ type: "artifact", artifactID })
    expect(
      Schema.decodeUnknownSync(IndustrialCitation.Citations)(
        Array.from({ length: IndustrialCitation.MaxCitations }, () => locator),
      ),
    ).toHaveLength(IndustrialCitation.MaxCitations)
    expect(() =>
      Schema.decodeUnknownSync(IndustrialCitation.Citations)(
        Array.from({ length: IndustrialCitation.MaxCitations + 1 }, () => locator),
      ),
    ).toThrow()
    expect(() =>
      decode({
        type: "docx",
        artifactID,
        part: "document",
        path: Array.from({ length: IndustrialCitation.MaxDocxStructuralDepth + 1 }, (_, index) => ({
          node: "paragraph",
          index,
        })),
      }),
    ).toThrow()
  })
})

describe("IndustrialResult", () => {
  const ResultSchema = IndustrialResult.make("calculate", Schema.Struct({ value: Schema.String }))
  const decode = Schema.decodeUnknownSync(ResultSchema)
  const common = {
    tool: "calculate",
    contractVersion: 1,
    engine,
    sources: [],
    outputs: [],
    citations: [],
    producerTruncated: false,
    summary: "Calculation completed",
  }

  test.each([
    { ...common, status: "success", cancelled: false, timedOut: false, data: { value: "42" } },
    {
      ...common,
      status: "error",
      cancelled: false,
      timedOut: false,
      error: { code: "invalid-input", retryable: false },
    },
    {
      ...common,
      status: "error",
      cancelled: true,
      timedOut: false,
      error: { code: "cancelled", retryable: true },
    },
    {
      ...common,
      status: "error",
      cancelled: false,
      timedOut: true,
      error: { code: "deadline-exceeded", retryable: true },
    },
  ] as const)("accepts the checked terminal variant %#", (result) => {
    expect(() => decode(result)).not.toThrow()
  })

  test.each([
    { ...common, status: "success", cancelled: true, timedOut: false, data: { value: "42" } },
    {
      ...common,
      status: "error",
      cancelled: true,
      timedOut: true,
      error: { code: "cancelled", retryable: true },
    },
    {
      ...common,
      status: "error",
      cancelled: false,
      timedOut: true,
      error: { code: "engine-failed", retryable: true },
    },
    {
      ...common,
      status: "error",
      cancelled: false,
      timedOut: false,
      data: { value: "leak" },
      error: { code: "engine-failed", retryable: true },
    },
  ])("rejects inconsistent success, error, cancellation, or timeout state %#", (result) => {
    expect(() => decode(result)).toThrow()
  })

  test("bounds source and output collections", () => {
    expect(() =>
      decode({
        ...common,
        status: "success",
        cancelled: false,
        timedOut: false,
        data: { value: "42" },
        sources: Array.from({ length: IndustrialInput.MaxSources + 1 }, (_, index) => referenceAt(index)),
      }),
    ).toThrow()
    expect(() =>
      decode({
        ...common,
        status: "success",
        cancelled: false,
        timedOut: false,
        data: { value: "42" },
        outputs: Array.from({ length: Artifact.MaxOutputsPerRun + 1 }, (_, index) => referenceAt(index)),
      }),
    ).toThrow()
  })
})

describe("IndustrialAudit", () => {
  const base = {
    id: "aud_123e4567-e89b-42d3-a456-426614174000",
    tool: "sandbox_execute",
    permission: "sandbox_execute",
    sessionID: "session-123",
    messageID: "message-123",
    toolCallID: "call-123",
    startedAt: 1_758_236_400_000,
    engine,
    contractVersion: 1,
    inputDigest: digest,
    inputSummary: { sourceCount: 0, artifactCount: 0, pathCount: 0, declaredOutputCount: 1 },
    sourceArtifactIDs: [],
  }
  const terminal = {
    finishedAt: 1_758_236_401_000,
    durationMs: 1_000,
    producerTruncated: false,
    projectionTruncated: false,
    sourceArtifactIDs: [],
    outputArtifactIDs: [],
  }

  test("accepts redacted running and completed records", () => {
    const running = Schema.decodeUnknownSync(IndustrialAudit.Running)({
      ...base,
      state: "running",
      command: "credential-canary",
      path: "C:\\private\\report.pdf",
      url: "https://private.example",
    })
    expect(JSON.stringify(Schema.encodeSync(IndustrialAudit.Running)(running))).not.toContain("private")
    expect(JSON.stringify(running)).not.toContain("canary")
    expect(() =>
      Schema.decodeUnknownSync(IndustrialAudit.Completed)({
        ...base,
        ...terminal,
        state: "completed",
        outcome: "success",
        cancelled: false,
        timedOut: false,
      }),
    ).not.toThrow()
  })

  test("requires a durable audit and tool-call identity", () => {
    expect(() =>
      Schema.decodeUnknownSync(IndustrialAudit.Running)({ ...base, id: "audit-123", state: "running" }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(IndustrialAudit.Running)({ ...base, toolCallID: undefined, state: "running" }),
    ).toThrow()
  })

  test("accepts bounded control-safe opaque tool-call IDs", () => {
    expect(
      String(
        Schema.decodeUnknownSync(IndustrialAudit.Running)({
          ...base,
          toolCallID: "provider call/id:{opaque}=v1",
          state: "running",
        }).toolCallID,
      ),
    ).toBe("provider call/id:{opaque}=v1")
    expect(() =>
      Schema.decodeUnknownSync(IndustrialAudit.Running)({ ...base, toolCallID: "call\nsecret", state: "running" }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(IndustrialAudit.Running)({
        ...base,
        toolCallID: "x".repeat(IndustrialAudit.MaxToolCallIDLength + 1),
        state: "running",
      }),
    ).toThrow()
  })

  test("enforces timestamps and audit artifact collection limits", () => {
    expect(() =>
      Schema.decodeUnknownSync(IndustrialAudit.Completed)({
        ...base,
        ...terminal,
        state: "completed",
        outcome: "success",
        cancelled: false,
        timedOut: false,
        durationMs: 999,
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(IndustrialAudit.Running)({
        ...base,
        state: "running",
        sourceArtifactIDs: Array.from({ length: IndustrialInput.MaxSources + 1 }, (_, index) => referenceAt(index).id),
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(IndustrialAudit.Completed)({
        ...base,
        ...terminal,
        state: "completed",
        outcome: "success",
        cancelled: false,
        timedOut: false,
        outputArtifactIDs: Array.from({ length: Artifact.MaxOutputsPerRun + 1 }, (_, index) => referenceAt(index).id),
      }),
    ).toThrow()
  })

  test("requires the permission mapped to the tool", () => {
    const input = { ...base, permission: "document_read" }
    const { id: _id, ...begin } = input
    expect(Result.isFailure(Schema.decodeUnknownResult(IndustrialAudit.BeginInput)(begin))).toBe(true)
  })

  test.each([
    { outcome: "success", cancelled: false, timedOut: false, errorCode: "engine-failed" },
    { outcome: "error", cancelled: false, timedOut: false },
    { outcome: "cancelled", cancelled: false, timedOut: false, errorCode: "cancelled" },
    { outcome: "timeout", cancelled: false, timedOut: true, errorCode: "cancelled" },
  ])("rejects inconsistent audit terminal state %#", (override) => {
    expect(() =>
      Schema.decodeUnknownSync(IndustrialAudit.Completed)({
        ...base,
        ...terminal,
        state: "completed",
        ...override,
      }),
    ).toThrow()
  })
})

describe("SandboxTool", () => {
  const decodeInput = Schema.decodeUnknownSync(SandboxTool.Input)
  const decodeData = Schema.decodeUnknownSync(SandboxTool.Data)

  test("accepts bounded input and emits a command-free summary", () => {
    const input = decodeInput({ command: "python inspect.py", timeout: 30_000, outputs: ["report.txt"] })
    expect(SandboxTool.summarize(input)).toEqual({
      sourceCount: 0,
      artifactCount: 0,
      pathCount: 0,
      declaredOutputCount: 1,
    })
    expect(JSON.stringify(SandboxTool.summarize(input))).not.toContain("python")
  })

  test.each([
    { command: "" },
    { command: " echo unsafe-spacing" },
    { command: "echo ok", timeout: 0 },
    { command: "echo ok", timeout: SandboxTool.MaxTimeoutMs + 1 },
    { command: "x".repeat(SandboxTool.MaxCommandBytes + 1) },
    { command: "echo ok", outputs: ["../unsafe"] },
  ])("rejects invalid sandbox input %#", (input) => {
    expect(() => decodeInput(input)).toThrow()
  })

  test("bounds capture bytes and violations", () => {
    expect(() =>
      decodeData({
        exitCode: 0,
        stdout: "x".repeat(SandboxTool.MaxCapturedOutputBytes),
        stderr: "x",
        violations: [],
      }),
    ).toThrow()
    expect(() =>
      decodeData({
        exitCode: 0,
        stdout: "",
        stderr: "",
        violations: Array.from({ length: SandboxTool.MaxViolations + 1 }, () => ({
          kind: "network",
          operation: "connect",
        })),
      }),
    ).toThrow()
  })
})
