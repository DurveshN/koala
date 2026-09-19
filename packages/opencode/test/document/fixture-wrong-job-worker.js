process.once("message", (request) => {
  process.send({
    protocolVersion: 1,
    type: "started",
    jobID: "job_123e4567-e89b-42d3-a456-426614174000",
    operation: request.type,
  })
})
