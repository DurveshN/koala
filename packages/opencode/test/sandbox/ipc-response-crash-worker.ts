import { SandboxProtocol } from "@koala-ai/core/sandbox/protocol"
import { Schema } from "effect"

const encode = Schema.encodeSync(SandboxProtocol.WorkerResponse)

process.on("message", () => {
  process.send?.(encode({ protocolVersion: 1, type: "availability", availability: { status: "available" } }), () =>
    process.exit(7),
  )
})
