import { describe, expect, test } from "bun:test"
import { DocumentGenerate } from "@koala-ai/core/document/generate"
import { DocumentRuntimeManifest } from "@koala-ai/core/document-runtime/manifest"
import { DocumentRuntimeProtocol } from "@koala-ai/core/document-runtime/protocol"
import { Schema } from "effect"

describe("DocumentRuntime create-docx protocol", () => {
  test("encodes and decodes a create-docx request", () => {
    const request = Schema.decodeUnknownSync(DocumentRuntimeProtocol.CreateDocxRequest)({
      protocolVersion: 1,
      type: "create-docx",
      jobID: DocumentRuntimeProtocol.JobID.make(`job_${crypto.randomUUID()}`),
      inputPath: DocumentRuntimeManifest.RelativePath.make("input/content.json"),
      inputBytes: 1234,
    })
    const encoded = Schema.encodeSync(DocumentRuntimeProtocol.WorkerRequest)(request)
    expect(encoded.type).toBe("create-docx")
    if (encoded.type !== "create-docx") throw new Error("expected create-docx")
    const decoded = DocumentRuntimeProtocol.decodeWorkerRequest(encoded)
    expect(decoded.type).toBe("create-docx")
    if (decoded.type !== "create-docx") throw new Error("expected create-docx")
    expect(decoded.inputBytes).toBe(1234)
  })

  test("advances the order through started, docx-ready, and completed", () => {
    const jobID = DocumentRuntimeProtocol.JobID.make(`job_${crypto.randomUUID()}`)
    const request = Schema.decodeUnknownSync(DocumentRuntimeProtocol.CreateDocxRequest)({
      protocolVersion: 1,
      type: "create-docx",
      jobID,
      inputPath: DocumentRuntimeManifest.RelativePath.make("input/content.json"),
      inputBytes: 1,
    })
    function unwrap(result: DocumentRuntimeProtocol.OrderResult): DocumentRuntimeProtocol.OrderState {
      if (!result.ok) throw new Error(`expected ok result: ${result.code}`)
      return result.state
    }

    let order = DocumentRuntimeProtocol.beginOrder(request)
    expect(order.operation).toBe("create-docx")
    expect(order.phase).toBe("awaiting-started")

    const started = Schema.decodeUnknownSync(DocumentRuntimeProtocol.StartedEvent)({
      protocolVersion: 1,
      type: "started",
      jobID,
      operation: "create-docx",
    })
    order = unwrap(DocumentRuntimeProtocol.advanceOrder(order, started))
    expect(order.phase).toBe("awaiting-docx")

    const outputID = DocumentRuntimeProtocol.OutputID.make(`output_${crypto.randomUUID()}`)
    const ready = Schema.decodeUnknownSync(DocumentRuntimeProtocol.DocxReadyEvent)({
      protocolVersion: 1,
      type: "docx-ready",
      jobID,
      outputPath: DocumentRuntimeManifest.RelativePath.make("generate/output.docx"),
      outputID,
      outputSha256: DocumentRuntimeManifest.Digest.make("0".repeat(64)),
      outputBytes: 100,
    })
    order = unwrap(DocumentRuntimeProtocol.advanceOrder(order, ready))
    expect(order.phase).toBe("awaiting-completed")

    const completed = Schema.decodeUnknownSync(DocumentRuntimeProtocol.CompletedEvent)({
      protocolVersion: 1,
      type: "completed",
      jobID,
      operation: "create-docx",
      pagesProcessed: 0,
      temporaryBytes: 0,
    })
    const finalOrder = unwrap(DocumentRuntimeProtocol.advanceOrder(order, completed))
    expect(finalOrder.phase).toBe("terminal")
  })

  test("round-trips the create-docx content schema", () => {
    const input = Schema.decodeUnknownSync(DocumentGenerate.DocxCreate.Input)({
      contents: {
        title: "Generated DOCX",
        author: "Koala",
        sections: [
          { type: "heading", text: "Summary", level: 1 },
          { type: "paragraph", text: "Generated content." },
        ],
      },
    })
    expect(input.contents.title).toBe("Generated DOCX")
    expect(input.contents.sections).toHaveLength(2)
  })
})
