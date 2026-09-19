import type { DocumentRuntimeProtocol } from "@koala-ai/core/document-runtime/protocol"

export class RuntimeFailure extends Error {
  override readonly name = "RuntimeFailure"

  constructor(
    readonly code: DocumentRuntimeProtocol.FailureCode,
    readonly stage: DocumentRuntimeProtocol.FailureStage,
    readonly retryable = false,
  ) {
    super(code)
  }
}

export function runtimeFailure(error: unknown, fallback: RuntimeFailure) {
  return error instanceof RuntimeFailure ? error : fallback
}
