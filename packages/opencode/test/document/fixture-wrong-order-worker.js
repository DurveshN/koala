process.once("message", (request) => {
  process.send({
    protocolVersion: 1,
    type: "completed",
    jobID: request.jobID,
    operation: request.type,
    pagesProcessed: 0,
    temporaryBytes: 0,
  })
})
