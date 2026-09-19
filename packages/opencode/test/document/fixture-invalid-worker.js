process.once("message", () => {
  process.send({ protocolVersion: 1, type: "private-canary", detail: "do-not-return" })
})
