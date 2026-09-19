process.on("message", () => {
  process.send?.({ protocolVersion: 1, type: "debug", stack: "private-stack-canary" })
})
