import type { DocumentRuntimeProtocol } from "@koala-ai/core/document-runtime/protocol"
import type { WorkerTransport } from "./worker"

// Temporary bridge for the direct coordinator. Phase 5 removes this module with the direct worker launch.
export function createLegacyIpcTransport(): WorkerTransport {
  return {
    onMessage: (listener) => process.on("message", listener),
    onDisconnect: (listener) => process.on("disconnect", listener),
    send: (event: DocumentRuntimeProtocol.WorkerEvent) =>
      new Promise<void>((resolve, reject) => {
        if (!process.send) return reject(new Error("legacy-ipc-unavailable"))
        process.send(event, (error) => (error ? reject(new Error("legacy-ipc-send-failed")) : resolve()))
      }),
    close: () => {
      if (process.connected) process.disconnect()
    },
  }
}
