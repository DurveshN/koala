import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Artifact } from "./artifact"
import { ArtifactStore } from "./store"

const digest = "0123456789abcdef".repeat(4)

test("uses the approved first-slice promotion limits", () => {
  expect(Artifact.MaxOutputsPerRun).toBe(10)
  expect(Artifact.MaxArtifactBytes).toBe(100 * 1024 * 1024)
  expect(Artifact.MaxRunBytes).toBe(250 * 1024 * 1024)
})

describe("Artifact identifiers", () => {
  test("accepts opaque IDs and lowercase SHA-256 digests", () => {
    expect(String(Schema.decodeUnknownSync(Artifact.ID)("art_123e4567-e89b-42d3-a456-426614174000"))).toBe(
      "art_123e4567-e89b-42d3-a456-426614174000",
    )
    expect(String(Schema.decodeUnknownSync(Artifact.Digest)(digest))).toBe(digest)
  })

  test.each(["", "artifact-123", "art_123e4567-e89b-12d3-a456-426614174000", "A".repeat(64)])(
    "rejects invalid artifact ID %j",
    (id) => {
      expect(() => Schema.decodeUnknownSync(Artifact.ID)(id)).toThrow()
    },
  )

  test.each(["", "a".repeat(63), "A".repeat(64), `${"a".repeat(63)}g`])("rejects invalid digest %j", (value) => {
    expect(() => Schema.decodeUnknownSync(Artifact.Digest)(value)).toThrow()
  })
})

describe("Artifact output paths", () => {
  const decode = Schema.decodeUnknownSync(Artifact.OutputPath)

  test.each(["report.pdf", "reports/2026/final.csv", "unicode/koala.txt"])("accepts normalized path %s", (path) => {
    expect(String(decode(path))).toBe(path)
  })

  test.each([
    "",
    "/absolute.txt",
    "C:/absolute.txt",
    "C:\\absolute.txt",
    "../outside.txt",
    "folder/../outside.txt",
    "folder/./report.txt",
    "folder//report.txt",
    "folder/",
    "folder\\report.txt",
    "report.txt:secret",
    "CON",
    "reports/NUL.txt",
    "COM¹",
    "reports/LPT².log",
    "com³.txt",
    "report. ",
    "report\0.txt",
  ])("rejects unsafe or non-normalized path %j", (path) => {
    expect(() => decode(path)).toThrow()
  })

  test("enforces unique output declarations and the fixed count limit", () => {
    const decodePaths = Schema.decodeUnknownSync(Artifact.OutputPaths)
    expect(
      decodePaths(Array.from({ length: Artifact.MaxOutputsPerRun }, (_, index) => `output-${index}.txt`)),
    ).toHaveLength(Artifact.MaxOutputsPerRun)
    expect(() => decodePaths(["same.txt", "same.txt"])).toThrow("must be unique")
    expect(() => decodePaths(["Report.txt", "report.TXT"])).toThrow("ignoring case")
    expect(() =>
      decodePaths(Array.from({ length: Artifact.MaxOutputsPerRun + 1 }, (_, index) => `output-${index}.txt`)),
    ).toThrow()
  })
})

describe("Artifact metadata", () => {
  const metadata = {
    id: "art_123e4567-e89b-42d3-a456-426614174000",
    name: "report.pdf",
    mime: "application/pdf",
    size: Artifact.MaxArtifactBytes,
    digest,
    validation: {
      state: "accepted",
      validator: "basic",
      validatorVersion: "1",
      findings: [],
    },
    provenance: {
      sessionID: "session-123",
      messageID: "message-123",
      toolName: "sandbox_execute",
      toolCallID: "call-123",
      sandboxRunID: "run-123",
      sourceProjectPath: "reports/report.pdf",
    },
    lineage: [{ sourceArtifactID: "art_123e4567-e89b-42d3-a456-426614174001", relation: "derived-from" }],
    timeCreated: 1_758_236_400_000,
  } as const

  test("round trips complete browser-safe metadata", () => {
    const decode = Schema.decodeUnknownSync(Artifact.Metadata)
    const encode = Schema.encodeSync(Artifact.Metadata)
    expect(encode(decode(metadata))).toEqual(metadata)
  })

  test("accepts the exact artifact size boundary and rejects larger values", () => {
    const decode = Schema.decodeUnknownSync(Artifact.Reference)
    expect(Number(decode(metadata).size)).toBe(Artifact.MaxArtifactBytes)
    expect(() => decode({ ...metadata, size: Artifact.MaxArtifactBytes + 1 })).toThrow()
  })

  test.each([
    { name: "nested/report.pdf" },
    { name: " report.pdf" },
    { mime: "Application/PDF" },
    { mime: "not-a-mime" },
  ])("rejects invalid reference field $name$mime", (override) => {
    expect(() => Schema.decodeUnknownSync(Artifact.Reference)({ ...metadata, ...override })).toThrow()
  })

  test("bounds validation findings", () => {
    const finding = { code: "safe", message: "Accepted by the basic validator" }
    const decode = Schema.decodeUnknownSync(Artifact.Validation)
    expect(
      decode({
        ...metadata.validation,
        findings: Array.from({ length: Artifact.MaxValidationFindings }, () => finding),
      }).findings,
    ).toHaveLength(Artifact.MaxValidationFindings)
    expect(() =>
      decode({
        ...metadata.validation,
        findings: Array.from({ length: Artifact.MaxValidationFindings + 1 }, () => finding),
      }),
    ).toThrow()
    expect(() =>
      decode({
        ...metadata.validation,
        findings: [{ ...finding, message: "x".repeat(Artifact.MaxValidationFindingLength + 1) }],
      }),
    ).toThrow()
  })

  test("validates the reused sandbox run ID", () => {
    const decode = Schema.decodeUnknownSync(Artifact.Provenance)
    expect(String(decode(metadata.provenance).sandboxRunID)).toBe("run-123")
    expect(() => decode({ ...metadata.provenance, sandboxRunID: "bad/run" })).toThrow()
  })

  test("accepts opaque control-safe tool call provenance", () => {
    const decode = Schema.decodeUnknownSync(Artifact.Provenance)
    expect(decode({ ...metadata.provenance, toolCallID: "provider call/id:{opaque}=v1" }).toolCallID).toBe(
      "provider call/id:{opaque}=v1",
    )
    expect(() => decode({ ...metadata.provenance, toolCallID: "provider\ncall" })).toThrow()
  })
})

describe("ArtifactStore errors", () => {
  test("exposes typed limit and corruption details without host causes", () => {
    const limit = new ArtifactStore.LimitError({
      kind: "artifact-size",
      maximum: Artifact.MaxArtifactBytes,
      actual: Artifact.MaxArtifactBytes + 1,
    })
    const corruption = new ArtifactStore.CorruptionError({ digest: Schema.decodeUnknownSync(Artifact.Digest)(digest) })

    expect(limit).toMatchObject({ _tag: "ArtifactStoreLimitError", kind: "artifact-size" })
    expect(limit.message).toContain(String(Artifact.MaxArtifactBytes + 1))
    expect(corruption).toMatchObject({ _tag: "ArtifactStoreCorruptionError", digest })
    expect("cause" in limit).toBe(false)
    expect("cause" in corruption).toBe(false)
  })
})
