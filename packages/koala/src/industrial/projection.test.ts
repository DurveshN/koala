import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { IndustrialCitation } from "./citation"
import { IndustrialProjection } from "./projection"
import { IndustrialResult } from "./result"

const artifactID = "art_123e4567-e89b-42d3-a456-426614174000"
const digest = "0123456789abcdef".repeat(4)

describe("IndustrialProjection", () => {
  const ResultSchema = IndustrialResult.make(
    "document_extract",
    Schema.Struct({
      arbitrary: Schema.Unknown,
      bytes: Schema.instanceOf(Uint8Array),
      url: Schema.String,
      hostPath: Schema.String,
    }),
  )
  const decode = Schema.decodeUnknownSync(ResultSchema)

  test("is deterministic and omits arbitrary data, bytes, URIs, and host paths", () => {
    const result = decode({
      tool: "document_extract",
      contractVersion: 1,
      engine: { name: "document-engine", version: "1.0.0" },
      status: "success",
      cancelled: false,
      timedOut: false,
      producerTruncated: false,
      summary: [
        "Document extraction completed from https://private.example/report and C:\\Users/private\\report.pdf",
        "source /home/private\\report.pdf",
        "remote s3://private-bucket/report.pdf mailto:private@example.com custom+ssh:user@private.example/repo",
        "shares \\\\private-server\\secret/share.pdf //private-server/secret/share.pdf",
        "devices \\\\?\\C:\\private\\device.pdf \\\\.\\pipe\\private-pipe",
        "punctuation [/srv/private/report.pdf],{/opt/private/data};=/var/private/end",
        "operators |/etc/private/passwd >/srv/private/output",
        "root-relative (\\Windows/System32/secret.dll),[\\Users\\private/report.txt];\\??\\C:/private/nt.txt",
        "mixed-device \\\\?\\UNC\\private-device/share\\report.pdf",
      ].join("\n"),
      sources: [
        {
          id: artifactID,
          name: "mailto:private@example.com",
          mime: "text/plain",
          size: 6,
          digest,
        },
      ],
      outputs: [],
      citations: [{ type: "page", artifactID, page: 2 }],
      data: {
        arbitrary: { secret: "credential-canary" },
        bytes: new Uint8Array([99, 97, 110, 97, 114, 121]),
        url: "https://private.example/secret",
        hostPath: "C:\\Users\\private\\report.pdf",
      },
    })

    const first = IndustrialProjection.project(result)
    const second = IndustrialProjection.project(result)
    expect(first).toEqual(second)
    expect(first.truncated).toBe(false)
    expect(first.text).toContain(`citation[0]=artifact:${artifactID};page:2`)
    expect(first.text).not.toContain("credential-canary")
    expect(first.text).not.toContain("private.example")
    expect(first.text).not.toContain("private-bucket")
    expect(first.text).not.toContain("private-server")
    expect(first.text).not.toContain("private-pipe")
    expect(first.text).not.toContain("/srv/private")
    expect(first.text).not.toContain("/opt/private")
    expect(first.text).not.toContain("/var/private")
    expect(first.text).not.toContain("System32")
    expect(first.text).not.toContain("private-device")
    expect(first.text).not.toContain("nt.txt")
    expect(first.text).not.toContain("mailto:")
    expect(first.text).not.toContain("custom+ssh:")
    expect(first.text).not.toContain("Users")
    expect(first.text).not.toContain("/home/private")
    expect(first.text.match(/\[absolute-path\]/g)?.length).toBeGreaterThanOrEqual(13)
    expect(first.text.match(/\[uri\]/g)).toHaveLength(4)
    expect(first.text).not.toContain("99,97")
  })

  test("enforces the 2,000-line limit deterministically", () => {
    const result = decode({
      tool: "document_extract",
      contractVersion: 1,
      engine: { name: "document-engine", version: "1.0.0" },
      status: "success",
      cancelled: false,
      timedOut: false,
      producerTruncated: false,
      summary: Array.from({ length: IndustrialProjection.MaxLines }, () => "x").join("\n"),
      sources: [],
      outputs: [],
      citations: [],
      data: { arbitrary: null, bytes: new Uint8Array(), url: "", hostPath: "" },
    })

    const projection = IndustrialProjection.project(result)
    expect(projection.truncated).toBe(true)
    expect(projection.lines).toBeLessThanOrEqual(IndustrialProjection.MaxLines)
    expect(projection.bytes).toBeLessThanOrEqual(IndustrialProjection.MaxBytes)
    expect(projection.text.endsWith(IndustrialProjection.TruncationMarker)).toBe(true)
  })

  test("enforces the 50-KiB limit without splitting UTF-8 data", () => {
    const result = decode({
      tool: "document_extract",
      contractVersion: 1,
      engine: { name: "document-engine", version: "1.0.0" },
      status: "success",
      cancelled: false,
      timedOut: false,
      producerTruncated: true,
      summary: "Document extraction completed",
      sources: [],
      outputs: [],
      citations: Array.from({ length: IndustrialCitation.MaxCitations }, (_, index) => ({
        type: "docx",
        artifactID,
        part: "document",
        path: Array.from({ length: 32 }, (_, pathIndex) => ({ node: "paragraph", index: pathIndex })),
        elementID: `element-${index.toString().padStart(4, "0")}-${digest}`,
      })),
      data: {
        arbitrary: null,
        bytes: new Uint8Array(),
        url: "",
        hostPath: "",
      },
    })

    const projection = IndustrialProjection.project(result)
    expect(projection.truncated).toBe(true)
    expect(projection.lines).toBeLessThanOrEqual(IndustrialProjection.MaxLines)
    expect(projection.bytes).toBeLessThanOrEqual(IndustrialProjection.MaxBytes)
    expect(new TextEncoder().encode(projection.text).byteLength).toBe(projection.bytes)
    expect(projection.text.split("\n")).toHaveLength(projection.lines)
    expect(projection.text.endsWith(IndustrialProjection.TruncationMarker)).toBe(true)
  })

  test("rejects projection metadata outside either fixed limit", () => {
    const decode = Schema.decodeUnknownSync(IndustrialProjection.Output)
    expect(() => decode({ text: "", truncated: true, lines: IndustrialProjection.MaxLines + 1, bytes: 0 })).toThrow()
    expect(() => decode({ text: "", truncated: true, lines: 0, bytes: IndustrialProjection.MaxBytes + 1 })).toThrow()
  })
})
