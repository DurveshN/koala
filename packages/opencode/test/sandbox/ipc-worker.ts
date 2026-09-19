import { SandboxProtocol } from "@koala-ai/core/sandbox/protocol"
import { Schema } from "effect"

const decode = Schema.decodeUnknownSync(SandboxProtocol.WorkerRequest)
const encode = Schema.encodeSync(SandboxProtocol.WorkerResponse)
let active: SandboxProtocol.RunID | undefined

process.on("message", (input: unknown) => {
  const message = decode(input)
  if (message.type === "availability") {
    process.send?.(encode({ protocolVersion: 1, type: "availability", availability: { status: "available" } }))
    process.disconnect?.()
    return
  }
  if (message.type === "execute") {
    active = message.runID
    return
  }
  if (message.type === "cancel" && message.runID === active) {
    process.send?.(
      encode({
        protocolVersion: 1,
        type: "result",
        runID: message.runID,
        result: {
          exitCode: null,
          stdout: "",
          stderr: "",
          timedOut: false,
          cancelled: true,
          outputTruncated: false,
          violations: [],
        },
      }),
    )
    process.disconnect?.()
  }
})
