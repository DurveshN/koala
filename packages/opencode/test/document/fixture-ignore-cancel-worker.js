process.on("message", (request) => {
  if (request.type === "cancel") return
  process.send({ protocolVersion: 1, type: "started", jobID: request.jobID, operation: request.type })
})

setInterval(() => undefined, 1_000)
