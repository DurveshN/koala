import { DocumentRuntimeProtocol } from "@koala-ai/core/document-runtime/protocol"
import { createNodeStreamTransport } from "@koala-ai/document-runtime/transport"

const transport = createNodeStreamTransport(process.stdin, process.stdout)

transport.onMessage((input) => {
  const request = DocumentRuntimeProtocol.decodeInitialRequest(input)
  if (request.type !== "probe") throw new Error("unexpected-request")
  void transport
    .send({ protocolVersion: 1, type: "started", jobID: request.jobID, operation: "probe" })
    .then(() =>
      transport.send({
        protocolVersion: 1,
        type: "completed",
        jobID: request.jobID,
        operation: "probe",
        pagesProcessed: 0,
        temporaryBytes: 0,
      }),
    )
    .then(() => transport.close())
})

transport.onDisconnect(() => {
  process.exitCode = 0
})
