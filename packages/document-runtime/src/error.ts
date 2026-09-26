import type { DocumentRuntimeProtocol } from "@koala-ai/core/document-runtime/protocol"

export class RuntimeFailure extends Error {
  override readonly name = "RuntimeFailure"
  readonly code: DocumentRuntimeProtocol.FailureCode
  readonly stage: DocumentRuntimeProtocol.FailureStage
  readonly retryable: boolean

  constructor(
    code: DocumentRuntimeProtocol.FailureCode,
    stage: DocumentRuntimeProtocol.FailureStage,
    retryable = false,
  ) {
    super(code)
    this.code = code
    this.stage = stage
    this.retryable = retryable
  }
}

export function runtimeFailure(error: unknown, fallback: RuntimeFailure) {
  return error instanceof RuntimeFailure ? error : fallback
}
