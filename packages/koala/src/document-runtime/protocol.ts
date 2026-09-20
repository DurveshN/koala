export * as DocumentRuntimeProtocol from "./protocol"

import { Schema } from "effect"
import { DocumentRuntimeLimits } from "./limits"
import { DocumentRuntimeManifest } from "./manifest"
import { DocumentRuntimeTarget } from "./target"

export const ProtocolVersion = Schema.Literal(1)
export type ProtocolVersion = typeof ProtocolVersion.Type

export const JobID = Schema.String.check(
  Schema.isPattern(/^job_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
).pipe(Schema.brand("DocumentRuntimeProtocol.JobID"))
export type JobID = typeof JobID.Type

export const PageID = Schema.String.check(
  Schema.isPattern(/^page_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
).pipe(Schema.brand("DocumentRuntimeProtocol.PageID"))
export type PageID = typeof PageID.Type

export const ResultID = Schema.String.check(
  Schema.isPattern(/^ocr_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
).pipe(Schema.brand("DocumentRuntimeProtocol.ResultID"))
export type ResultID = typeof ResultID.Type

const PdfInputBytes = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(DocumentRuntimeLimits.MaxPdfInputBytes),
)
const ImageInputBytes = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(DocumentRuntimeLimits.MaxImageInputBytes),
)
const PngBytes = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(DocumentRuntimeLimits.MaxPngBytesPerPage),
)
const TsvBytes = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(DocumentRuntimeLimits.MaxTsvBytesPerPage),
)
const TemporaryBytes = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(DocumentRuntimeLimits.MaxTemporaryBytes),
)

const CommonRequest = {
  protocolVersion: ProtocolVersion,
  jobID: JobID,
}

export const ProbeRequest = Schema.Struct({
  ...CommonRequest,
  type: Schema.Literal("probe"),
  target: DocumentRuntimeTarget.Target,
  manifestSha256: DocumentRuntimeManifest.Digest,
})

export const RenderRequest = Schema.Struct({
  ...CommonRequest,
  type: Schema.Literal("render"),
  inputPath: DocumentRuntimeManifest.RelativePath,
  inputBytes: PdfInputBytes,
  startPage: DocumentRuntimeLimits.PageNumber,
  pageCount: DocumentRuntimeLimits.PageCount,
  limits: DocumentRuntimeLimits.Requested,
}).check(
  Schema.makeFilter((request) =>
    request.inputBytes <= request.limits.pdfInputBytes ? undefined : "PDF input exceeds the requested limit",
  ),
  Schema.makeFilter((request) =>
    request.pageCount <= request.limits.pages ? undefined : "Page count exceeds the requested limit",
  ),
)

export const ImageSource = Schema.Struct({
  kind: Schema.Literal("image"),
  inputPath: DocumentRuntimeManifest.RelativePath,
  inputBytes: ImageInputBytes,
  dimensions: DocumentRuntimeLimits.RasterDimensions,
})

export const RenderedPageSource = Schema.Struct({
  kind: Schema.Literal("rendered-page"),
})

const CommonOcrRequest = {
  ...CommonRequest,
  type: Schema.Literal("ocr"),
  page: DocumentRuntimeLimits.PageNumber,
  pageID: PageID,
  limits: DocumentRuntimeLimits.Requested,
}

export const OcrRequest = Schema.Struct({
  ...CommonOcrRequest,
  source: Schema.Union([ImageSource, RenderedPageSource]),
}).check(
  Schema.makeFilter((request) =>
    request.source.kind !== "image" || request.source.inputBytes <= request.limits.imageInputBytes
      ? undefined
      : "Image input exceeds the requested limit",
  ),
  Schema.makeFilter((request) =>
    request.source.kind !== "image" ||
    (request.source.dimensions.width <= request.limits.rasterSidePixels &&
      request.source.dimensions.height <= request.limits.rasterSidePixels &&
      request.source.dimensions.width * request.source.dimensions.height <= request.limits.rasterAreaPixels)
      ? undefined
      : "Image dimensions exceed the requested raster limit",
  ),
)

export const ImageOcrRequest = Schema.Struct({
  ...CommonOcrRequest,
  source: ImageSource,
}).check(
  Schema.makeFilter((request) =>
    request.source.inputBytes <= request.limits.imageInputBytes
      ? undefined
      : "Image input exceeds the requested limit",
  ),
  Schema.makeFilter((request) =>
    request.source.dimensions.width <= request.limits.rasterSidePixels &&
      request.source.dimensions.height <= request.limits.rasterSidePixels &&
      request.source.dimensions.width * request.source.dimensions.height <= request.limits.rasterAreaPixels
      ? undefined
      : "Image dimensions exceed the requested raster limit",
  ),
)

export const RenderedPageOcrRequest = Schema.Struct({
  ...CommonOcrRequest,
  source: RenderedPageSource,
})

export const ReleasePageRequest = Schema.Struct({
  ...CommonRequest,
  type: Schema.Literal("release-page"),
  page: DocumentRuntimeLimits.PageNumber,
  pageID: PageID,
})

export const CancelRequest = Schema.Struct({
  ...CommonRequest,
  type: Schema.Literal("cancel"),
})

export const InitialRequest = Schema.Union([ProbeRequest, RenderRequest, ImageOcrRequest]).annotate({
  discriminator: "type",
  identifier: "DocumentRuntimeProtocol.InitialRequest",
})
export type InitialRequest = typeof InitialRequest.Type

export type StartRequest = typeof ProbeRequest.Type | typeof RenderRequest.Type | typeof OcrRequest.Type

export const ContinuationRequest = Schema.Union([RenderedPageOcrRequest, ReleasePageRequest]).annotate({
  discriminator: "type",
  identifier: "DocumentRuntimeProtocol.ContinuationRequest",
})
export type ContinuationRequest = typeof ContinuationRequest.Type

export const WorkerRequest = Schema.Union([
  ProbeRequest,
  RenderRequest,
  OcrRequest,
  ReleasePageRequest,
  CancelRequest,
]).annotate({ discriminator: "type", identifier: "DocumentRuntimeProtocol.WorkerRequest" })
export type WorkerRequest = typeof WorkerRequest.Type

const strictDecodeOptions = { onExcessProperty: "error" } as const
const decodeInitial = Schema.decodeUnknownSync(InitialRequest, strictDecodeOptions)
const decodeContinuation = Schema.decodeUnknownSync(ContinuationRequest, strictDecodeOptions)
const decodeRequest = Schema.decodeUnknownSync(WorkerRequest, strictDecodeOptions)

export const decodeInitialRequest = (input: unknown) => decodeInitial(input)
export const decodeContinuationRequest = (input: unknown) => decodeContinuation(input)
export const decodeWorkerRequest = (input: unknown) => decodeRequest(input)

export const Operation = Schema.Literals(["probe", "render", "ocr"])
export type Operation = typeof Operation.Type

const CommonEvent = {
  protocolVersion: ProtocolVersion,
  jobID: JobID,
}

export const StartedEvent = Schema.Struct({
  ...CommonEvent,
  type: Schema.Literal("started"),
  operation: Operation,
})

export const PageReadyEvent = Schema.Struct({
  ...CommonEvent,
  type: Schema.Literal("page-ready"),
  page: DocumentRuntimeLimits.PageNumber,
  pageID: PageID,
  outputPath: DocumentRuntimeManifest.RelativePath,
  dimensions: DocumentRuntimeLimits.RasterDimensions,
  pngBytes: PngBytes,
  temporaryBytes: TemporaryBytes,
})

export const OcrResultEvent = Schema.Struct({
  ...CommonEvent,
  type: Schema.Literal("ocr-result"),
  page: DocumentRuntimeLimits.PageNumber,
  pageID: PageID,
  resultID: ResultID,
  outputPath: DocumentRuntimeManifest.RelativePath,
  tsvBytes: TsvBytes,
  temporaryBytes: TemporaryBytes,
})

export const CompletedEvent = Schema.Struct({
  ...CommonEvent,
  type: Schema.Literal("completed"),
  operation: Operation,
  pagesProcessed: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(DocumentRuntimeLimits.MaxPages),
  ),
  temporaryBytes: TemporaryBytes,
})

export const CancelledEvent = Schema.Struct({
  ...CommonEvent,
  type: Schema.Literal("cancelled"),
})

export const FailureCode = Schema.Literals([
  "invalid-request",
  "protocol-mismatch",
  "job-mismatch",
  "invalid-order",
  "runtime-unavailable",
  "input-too-large",
  "page-out-of-range",
  "page-limit-exceeded",
  "raster-limit-exceeded",
  "png-limit-exceeded",
  "tsv-limit-exceeded",
  "temporary-limit-exceeded",
  "render-deadline-exceeded",
  "ocr-deadline-exceeded",
  "job-deadline-exceeded",
  "render-failed",
  "ocr-failed",
  "worker-failed",
])
export type FailureCode = typeof FailureCode.Type

export const FailureStage = Schema.Literals(["probe", "input", "render", "ocr", "cleanup", "worker"])
export type FailureStage = typeof FailureStage.Type

export const FailureEvent = Schema.Struct({
  ...CommonEvent,
  type: Schema.Literal("failure"),
  code: FailureCode,
  stage: FailureStage,
  retryable: Schema.Boolean,
})

export const WorkerEvent = Schema.Union([
  StartedEvent,
  PageReadyEvent,
  OcrResultEvent,
  CompletedEvent,
  CancelledEvent,
  FailureEvent,
]).annotate({ discriminator: "type", identifier: "DocumentRuntimeProtocol.WorkerEvent" })
export type WorkerEvent = typeof WorkerEvent.Type
const decodeEvent = Schema.decodeUnknownSync(WorkerEvent, strictDecodeOptions)
export const decodeWorkerEvent = (input: unknown) => decodeEvent(input)
export type OrderPhase =
  | "awaiting-started"
  | "awaiting-page"
  | "page-ready"
  | "awaiting-ocr-result"
  | "ocr-ready"
  | "awaiting-completed"
  | "cancelling"
  | "terminal"

export interface OrderState {
  readonly jobID: JobID
  readonly operation: Operation
  readonly phase: OrderPhase
  readonly limits?: DocumentRuntimeLimits.Requested
  readonly nextPage?: number
  readonly lastPage?: number
  readonly pageCount?: number
  readonly currentPage?: number
  readonly currentPageID?: PageID
}

export type OrderResult =
  | { readonly ok: true; readonly state: OrderState }
  | { readonly ok: false; readonly code: "job-mismatch" | "invalid-order" | "limit-exceeded" }

export function beginOrder(request: StartRequest): OrderState {
  if (request.type === "render") {
    return {
      jobID: request.jobID,
      operation: request.type,
      phase: "awaiting-started",
      limits: request.limits,
      nextPage: request.startPage,
      lastPage: request.startPage + request.pageCount - 1,
      pageCount: request.pageCount,
    }
  }
  if (request.type === "ocr") {
    return {
      jobID: request.jobID,
      operation: request.type,
      phase: "awaiting-started",
      limits: request.limits,
      currentPage: request.page,
      currentPageID: request.pageID,
    }
  }
  return { jobID: request.jobID, operation: request.type, phase: "awaiting-started" }
}

export function advanceOrder(state: OrderState, message: WorkerRequest | WorkerEvent): OrderResult {
  if (message.jobID !== state.jobID) return { ok: false, code: "job-mismatch" }
  if (state.phase === "terminal") return { ok: false, code: "invalid-order" }
  if (message.type === "failure") return success({ ...state, phase: "terminal" })
  if (message.type === "cancel") return success({ ...state, phase: "cancelling" })
  if (message.type === "cancelled") {
    return state.phase === "cancelling"
      ? success({ ...state, phase: "terminal" })
      : { ok: false, code: "invalid-order" }
  }
  if (message.type === "started") {
    if (state.phase !== "awaiting-started" || message.operation !== state.operation) {
      return { ok: false, code: "invalid-order" }
    }
    if (state.operation === "render") return success({ ...state, phase: "awaiting-page" })
    if (state.operation === "ocr") return success({ ...state, phase: "awaiting-ocr-result" })
    return success({ ...state, phase: "awaiting-completed" })
  }
  if (message.type === "page-ready") {
    if (state.phase !== "awaiting-page" || message.page !== state.nextPage) {
      return { ok: false, code: "invalid-order" }
    }
    if (!withinPageLimits(state.limits, message)) return { ok: false, code: "limit-exceeded" }
    return success({
      ...state,
      phase: "page-ready",
      currentPage: message.page,
      currentPageID: message.pageID,
    })
  }
  if (message.type === "ocr") {
    if (
      state.phase !== "page-ready" ||
      message.source.kind !== "rendered-page" ||
      message.page !== state.currentPage ||
      message.pageID !== state.currentPageID ||
      !sameLimits(state.limits, message.limits)
    ) {
      return { ok: false, code: "invalid-order" }
    }
    return success({ ...state, phase: "awaiting-ocr-result" })
  }
  if (message.type === "ocr-result") {
    if (
      state.phase !== "awaiting-ocr-result" ||
      message.page !== state.currentPage ||
      message.pageID !== state.currentPageID
    ) {
      return { ok: false, code: "invalid-order" }
    }
    if (!withinOcrLimits(state.limits, message)) return { ok: false, code: "limit-exceeded" }
    return success({ ...state, phase: state.operation === "ocr" ? "awaiting-completed" : "ocr-ready" })
  }
  if (message.type === "release-page") {
    if (
      (state.phase !== "page-ready" && state.phase !== "ocr-ready") ||
      message.page !== state.currentPage ||
      message.pageID !== state.currentPageID
    ) {
      return { ok: false, code: "invalid-order" }
    }
    const nextPage = message.page + 1
    return success({
      ...state,
      phase: state.lastPage !== undefined && nextPage > state.lastPage ? "awaiting-completed" : "awaiting-page",
      nextPage,
      currentPage: undefined,
      currentPageID: undefined,
    })
  }
  if (message.type === "completed") {
    if (
      state.phase !== "awaiting-completed" ||
      message.operation !== state.operation ||
      !withinTemporaryLimit(state.limits, message.temporaryBytes)
    ) {
      return state.phase === "awaiting-completed"
        ? { ok: false, code: "limit-exceeded" }
        : { ok: false, code: "invalid-order" }
    }
    const expectedPages = state.operation === "probe" ? 0 : state.operation === "ocr" ? 1 : state.pageCount
    if (expectedPages === undefined) return { ok: false, code: "invalid-order" }
    return message.pagesProcessed === expectedPages
      ? success({ ...state, phase: "terminal" })
      : { ok: false, code: "invalid-order" }
  }
  return { ok: false, code: "invalid-order" }
}

function withinPageLimits(limits: DocumentRuntimeLimits.Requested | undefined, event: typeof PageReadyEvent.Type) {
  return (
    limits !== undefined &&
    event.dimensions.width <= limits.rasterSidePixels &&
    event.dimensions.height <= limits.rasterSidePixels &&
    event.dimensions.width * event.dimensions.height <= limits.rasterAreaPixels &&
    event.pngBytes <= limits.pngBytesPerPage &&
    event.temporaryBytes <= limits.temporaryBytes
  )
}

function withinOcrLimits(limits: DocumentRuntimeLimits.Requested | undefined, event: typeof OcrResultEvent.Type) {
  return (
    limits !== undefined &&
    event.tsvBytes <= limits.tsvBytesPerPage &&
    withinTemporaryLimit(limits, event.temporaryBytes)
  )
}

function withinTemporaryLimit(limits: DocumentRuntimeLimits.Requested | undefined, temporaryBytes: number) {
  return limits === undefined || temporaryBytes <= limits.temporaryBytes
}

function sameLimits(left: DocumentRuntimeLimits.Requested | undefined, right: DocumentRuntimeLimits.Requested) {
  return (
    left !== undefined &&
    left.dpi === right.dpi &&
    left.pdfInputBytes === right.pdfInputBytes &&
    left.imageInputBytes === right.imageInputBytes &&
    left.pages === right.pages &&
    left.rasterSidePixels === right.rasterSidePixels &&
    left.rasterAreaPixels === right.rasterAreaPixels &&
    left.pngBytesPerPage === right.pngBytesPerPage &&
    left.temporaryBytes === right.temporaryBytes &&
    left.tsvBytesPerPage === right.tsvBytesPerPage &&
    left.nativeStderrBytes === right.nativeStderrBytes &&
    left.renderDeadlineMsPerPage === right.renderDeadlineMsPerPage &&
    left.ocrDeadlineMsPerPage === right.ocrDeadlineMsPerPage &&
    left.jobDeadlineMs === right.jobDeadlineMs
  )
}

function success(state: OrderState): OrderResult {
  return { ok: true, state }
}
