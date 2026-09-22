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

export const OutputID = Schema.String.check(
  Schema.isPattern(/^output_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
).pipe(Schema.brand("DocumentRuntimeProtocol.OutputID"))
export type OutputID = typeof OutputID.Type

export const OutputSourcePath = DocumentRuntimeManifest.RelativePath.check(
  Schema.makeFilter((value) => {
    const validDocument =
      (value.startsWith("pages/") && value.endsWith(".png")) || (value.startsWith("ocr/") && value.endsWith(".tsv"))
    const validOffice = value.startsWith("office/") && value.endsWith(".json")
    const validPdf = value.startsWith("pdf/") && value.endsWith(".json")
    const validDocx = value.startsWith("generate/") && value.endsWith(".docx")
    if ((validDocument || validOffice || validPdf || validDocx) && !value.includes("\\") && !value.includes(":")) return undefined
    return "Expected a canonical document output path"
  }),
).pipe(Schema.brand("DocumentRuntimeProtocol.OutputSourcePath"))
export type OutputSourcePath = typeof OutputSourcePath.Type

const PdfInputBytes = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(DocumentRuntimeLimits.MaxPdfInputBytes),
)
const ImageInputBytes = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(DocumentRuntimeLimits.MaxImageInputBytes),
)
const OfficeInputBytes = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(DocumentRuntimeLimits.MaxOfficeInputBytes),
)
const DocxInputBytes = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(DocumentRuntimeLimits.MaxOfficeInputBytes),
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
    request.source.inputBytes <= request.limits.imageInputBytes ? undefined : "Image input exceeds the requested limit",
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

export const OfficeFormat = Schema.Literals(["docx", "pptx", "xlsx"])
export type OfficeFormat = typeof OfficeFormat.Type

export const ReadOfficeRequest = Schema.Struct({
  ...CommonRequest,
  type: Schema.Literal("read-office"),
  format: OfficeFormat,
  inputPath: DocumentRuntimeManifest.RelativePath,
  inputBytes: OfficeInputBytes,
})

export const ReadPdfRequest = Schema.Struct({
  ...CommonRequest,
  type: Schema.Literal("read-pdf"),
  inputPath: DocumentRuntimeManifest.RelativePath,
  inputBytes: PdfInputBytes,
  limits: DocumentRuntimeLimits.Requested,
}).check(
  Schema.makeFilter((request) =>
    request.inputBytes <= request.limits.pdfInputBytes ? undefined : "PDF input exceeds the requested limit",
  ),
)

export const CreateDocxRequest = Schema.Struct({
  ...CommonRequest,
  type: Schema.Literal("create-docx"),
  inputPath: DocumentRuntimeManifest.RelativePath,
  inputBytes: DocxInputBytes,
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

export const InitialRequest = Schema.Union([
  ProbeRequest,
  RenderRequest,
  ImageOcrRequest,
  ReadOfficeRequest,
  ReadPdfRequest,
  CreateDocxRequest,
]).annotate({
  discriminator: "type",
  identifier: "DocumentRuntimeProtocol.InitialRequest",
})
export type InitialRequest = typeof InitialRequest.Type

export type StartRequest =
  | typeof ProbeRequest.Type
  | typeof RenderRequest.Type
  | typeof OcrRequest.Type
  | typeof ReadOfficeRequest.Type
  | typeof ReadPdfRequest.Type
  | typeof CreateDocxRequest.Type

export const ContinuationRequest = Schema.Union([RenderedPageOcrRequest, ReleasePageRequest]).annotate({
  discriminator: "type",
  identifier: "DocumentRuntimeProtocol.ContinuationRequest",
})
export type ContinuationRequest = typeof ContinuationRequest.Type

export const WorkerRequest = Schema.Union([
  ProbeRequest,
  RenderRequest,
  OcrRequest,
  ReadOfficeRequest,
  ReadPdfRequest,
  CreateDocxRequest,
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

export const Operation = Schema.Literals(["probe", "render", "ocr", "read-office", "read-pdf", "create-docx"])
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
  outputID: OutputID,
  outputSha256: DocumentRuntimeManifest.Digest,
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
  outputID: OutputID,
  outputSha256: DocumentRuntimeManifest.Digest,
  tsvBytes: TsvBytes,
  temporaryBytes: TemporaryBytes,
})

export const OfficeReadyEvent = Schema.Struct({
  ...CommonEvent,
  type: Schema.Literal("office-ready"),
  format: OfficeFormat,
  outputPath: DocumentRuntimeManifest.RelativePath,
  outputID: OutputID,
  outputSha256: DocumentRuntimeManifest.Digest,
  outputBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(DocumentRuntimeLimits.MaxOfficeOutputBytes)),
  sectionCount: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(DocumentRuntimeLimits.MaxOfficeSections),
  ),
})

export const DocxReadyEvent = Schema.Struct({
  ...CommonEvent,
  type: Schema.Literal("docx-ready"),
  outputPath: DocumentRuntimeManifest.RelativePath,
  outputID: OutputID,
  outputSha256: DocumentRuntimeManifest.Digest,
  outputBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(DocumentRuntimeLimits.MaxOfficeOutputBytes)),
})

export const PdfInfoEvent = Schema.Struct({
  ...CommonEvent,
  type: Schema.Literal("pdf-info"),
  pageCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(DocumentRuntimeLimits.MaxPages)),
  outputPath: DocumentRuntimeManifest.RelativePath,
  outputID: OutputID,
  outputSha256: DocumentRuntimeManifest.Digest,
  outputBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(DocumentRuntimeLimits.MaxOfficeOutputBytes)),
  metadata: Schema.optional(
    Schema.Struct({
      title: Schema.optional(Schema.String),
      author: Schema.optional(Schema.String),
      subject: Schema.optional(Schema.String),
      creator: Schema.optional(Schema.String),
      producer: Schema.optional(Schema.String),
      creationDate: Schema.optional(Schema.String),
      modDate: Schema.optional(Schema.String),
    }),
  ),
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
  "office-limit-exceeded",
  "office-output-limit-exceeded",
  "pdf-output-limit-exceeded",
  "docx-generation-failed",
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
  OfficeReadyEvent,
  DocxReadyEvent,
  PdfInfoEvent,
  CompletedEvent,
  CancelledEvent,
  FailureEvent,
]).annotate({ discriminator: "type", identifier: "DocumentRuntimeProtocol.WorkerEvent" })
export type WorkerEvent = typeof WorkerEvent.Type
const decodeEvent = Schema.decodeUnknownSync(WorkerEvent, strictDecodeOptions)
export const decodeWorkerEvent = (input: unknown) => decodeEvent(input)

const OutputStartCommon = {
  ...CommonEvent,
  type: Schema.Literal("output-start"),
  outputID: OutputID,
  page: DocumentRuntimeLimits.PageNumber,
  pageID: PageID,
  sourcePath: OutputSourcePath,
  declaredBytes: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(DocumentRuntimeLimits.MaxPngBytesPerPage),
  ),
}

export const PageOutputStart = Schema.Struct({
  ...OutputStartCommon,
  kind: Schema.Literal("page-png"),
})

export const OcrOutputStart = Schema.Struct({
  ...OutputStartCommon,
  kind: Schema.Literal("ocr-tsv"),
  resultID: ResultID,
}).check(
  Schema.makeFilter((value) =>
    value.declaredBytes <= DocumentRuntimeLimits.MaxTsvBytesPerPage ? undefined : "TSV output exceeds hard limit",
  ),
)

export const OfficeOutputStart = Schema.Struct({
  ...OutputStartCommon,
  kind: Schema.Literal("office-text"),
}).check(
  Schema.makeFilter((value) =>
    value.declaredBytes <= DocumentRuntimeLimits.MaxOfficeOutputBytes ? undefined : "Office output exceeds hard limit",
  ),
)

export const PdfOutputStart = Schema.Struct({
  ...OutputStartCommon,
  kind: Schema.Literal("pdf-text"),
}).check(
  Schema.makeFilter((value) =>
    value.declaredBytes <= DocumentRuntimeLimits.MaxOfficeOutputBytes ? undefined : "PDF output exceeds hard limit",
  ),
)

export const DocxOutputStart = Schema.Struct({
  ...OutputStartCommon,
  kind: Schema.Literal("docx-output"),
}).check(
  Schema.makeFilter((value) =>
    value.declaredBytes <= DocumentRuntimeLimits.MaxOfficeOutputBytes ? undefined : "DOCX output exceeds hard limit",
  ),
)

export const OutputStart = Schema.Union([PageOutputStart, OcrOutputStart, OfficeOutputStart, PdfOutputStart, DocxOutputStart]).annotate({
  discriminator: "kind",
  identifier: "DocumentRuntimeProtocol.OutputStart",
})
export type OutputStart = typeof OutputStart.Type

export const OutputChunk = Schema.Struct({
  ...CommonEvent,
  type: Schema.Literal("output-chunk"),
  outputID: OutputID,
  sequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  data: Schema.String.check(
    Schema.isMinLength(4),
    Schema.isMaxLength(DocumentRuntimeLimits.MaxOutputChunkBase64Characters),
    Schema.isPattern(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  ),
})
export type OutputChunk = typeof OutputChunk.Type

export const OutputEnd = Schema.Struct({
  ...CommonEvent,
  type: Schema.Literal("output-end"),
  outputID: OutputID,
  chunks: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  actualBytes: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(DocumentRuntimeLimits.MaxPngBytesPerPage),
  ),
  sha256: DocumentRuntimeManifest.Digest,
})
export type OutputEnd = typeof OutputEnd.Type

export const OutputFrame = Schema.Union([OutputStart, OutputChunk, OutputEnd]).annotate({
  discriminator: "type",
  identifier: "DocumentRuntimeProtocol.OutputFrame",
})
export type OutputFrame = typeof OutputFrame.Type
const decodeOutput = Schema.decodeUnknownSync(OutputFrame, strictDecodeOptions)
export const decodeOutputFrame = (input: unknown) => decodeOutput(input)

export const WorkerOutput = Schema.Union([WorkerEvent, OutputFrame]).annotate({
  discriminator: "type",
  identifier: "DocumentRuntimeProtocol.WorkerOutput",
})
export type WorkerOutput = typeof WorkerOutput.Type
const decodeWorkerOutputValue = Schema.decodeUnknownSync(WorkerOutput, strictDecodeOptions)
export const decodeWorkerOutput = (input: unknown) => decodeWorkerOutputValue(input)
export type OrderPhase =
  | "awaiting-started"
  | "awaiting-page"
  | "page-ready"
  | "awaiting-ocr-result"
  | "ocr-ready"
  | "awaiting-office"
  | "office-ready"
  | "awaiting-docx"
  | "docx-ready"
  | "awaiting-pdf"
  | "pdf-ready"
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
  if (request.type === "read-office") {
    return { jobID: request.jobID, operation: request.type, phase: "awaiting-started" }
  }
  if (request.type === "read-pdf") {
    return { jobID: request.jobID, operation: request.type, phase: "awaiting-started", limits: request.limits }
  }
  if (request.type === "create-docx") {
    return { jobID: request.jobID, operation: request.type, phase: "awaiting-started" }
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
    if (state.operation === "read-office") return success({ ...state, phase: "awaiting-office" })
    if (state.operation === "read-pdf") return success({ ...state, phase: "awaiting-pdf" })
    if (state.operation === "create-docx") return success({ ...state, phase: "awaiting-docx" })
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
  if (message.type === "office-ready") {
    if (state.phase !== "awaiting-office") return { ok: false, code: "invalid-order" }
    return success({ ...state, phase: "awaiting-completed" })
  }
  if (message.type === "docx-ready") {
    if (state.phase !== "awaiting-docx") return { ok: false, code: "invalid-order" }
    return success({ ...state, phase: "awaiting-completed" })
  }
  if (message.type === "pdf-info") {
    if (state.phase !== "awaiting-pdf") return { ok: false, code: "invalid-order" }
    return success({ ...state, phase: "awaiting-completed" })
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
    const expectedPages =
      state.operation === "probe" ||
      state.operation === "read-office" ||
      state.operation === "read-pdf" ||
      state.operation === "create-docx"
        ? 0
        : state.operation === "ocr"
          ? 1
          : state.pageCount
    if (expectedPages === undefined) return { ok: false, code: "invalid-order" }
    return message.pagesProcessed === expectedPages
      ? success({ ...state, phase: "terminal" })
      : { ok: false, code: "invalid-order" }
  }
  return { ok: false, code: "invalid-order" }
}

export interface OutputOrderState {
  readonly jobID: JobID
  readonly request: StartRequest
  readonly used: ReadonlySet<OutputID>
  readonly active?: {
    readonly start: OutputStart
    readonly chunks: number
    readonly bytes: number
  }
  readonly completed?: {
    readonly start: OutputStart
    readonly chunks: number
    readonly bytes: number
    readonly sha256: DocumentRuntimeManifest.Digest
  }
  readonly published: ReadonlyArray<{
    readonly outputID: OutputID
    readonly page?: number
    readonly pageID?: PageID
    readonly bytes: number
    readonly kind: "page-png" | "ocr-tsv" | "office-text" | "pdf-text" | "docx-output"
  }>
  readonly cumulativeBytes: number
  readonly liveBytes: number
  readonly releasedPages: number
  readonly terminal: boolean
}

export type OutputOrderResult =
  | {
      readonly ok: true
      readonly state: OutputOrderState
      readonly decodedChunk?: Uint8Array
    }
  | {
      readonly ok: false
      readonly code: "job-mismatch" | "invalid-output-order" | "output-limit-exceeded" | "invalid-base64"
    }

export function beginOutputOrder(request: StartRequest): OutputOrderState {
  return {
    jobID: request.jobID,
    request,
    used: new Set(),
    published: [],
    cumulativeBytes: 0,
    liveBytes: 0,
    releasedPages: 0,
    terminal: false,
  }
}

export function advanceOutputOrder(
  state: OutputOrderState,
  message: OutputFrame | WorkerEvent | typeof ReleasePageRequest.Type,
): OutputOrderResult {
  if (message.jobID !== state.jobID) return { ok: false, code: "job-mismatch" }
  if (state.terminal) return { ok: false, code: "invalid-output-order" }
  if (message.type === "output-start") return startOutput(state, message)
  if (message.type === "output-chunk") return chunkOutput(state, message)
  if (message.type === "output-end") return endOutput(state, message)
  if (
    message.type === "page-ready" ||
    message.type === "ocr-result" ||
    message.type === "office-ready" ||
    message.type === "docx-ready" ||
    message.type === "pdf-info"
  ) {
    return publishOutput(state, message)
  }
  if (message.type === "release-page") {
    if (state.active || state.completed) return { ok: false, code: "invalid-output-order" }
    const released = state.published.filter(
      (output) => output.page === message.page && output.pageID === message.pageID,
    )
    if (released.length === 0) return { ok: false, code: "invalid-output-order" }
    return outputSuccess({
      ...state,
      published: state.published.filter((output) => output.page !== message.page || output.pageID !== message.pageID),
      liveBytes: state.liveBytes - released.reduce((total, output) => total + output.bytes, 0),
      releasedPages: state.releasedPages + 1,
    })
  }
  if (state.active || state.completed) return { ok: false, code: "invalid-output-order" }
  if (message.type === "completed" || message.type === "cancelled" || message.type === "failure") {
    return outputSuccess({ ...state, terminal: true })
  }
  return outputSuccess(state)
}

function startOutput(state: OutputOrderState, start: OutputStart): OutputOrderResult {
  if (state.active || state.completed || state.used.has(start.outputID)) {
    return { ok: false, code: "invalid-output-order" }
  }
  if (!matchesExpectedOutput(state, start)) return { ok: false, code: "invalid-output-order" }
  const perOutputLimit = outputLimitForStart(state.request, start)
  if (start.declaredBytes > perOutputLimit) return { ok: false, code: "output-limit-exceeded" }
  if (state.cumulativeBytes + start.declaredBytes > cumulativePayloadLimit(state.request)) {
    return { ok: false, code: "output-limit-exceeded" }
  }
  const temporaryLimit = temporaryLimitForRequest(state.request)
  if (state.liveBytes + start.declaredBytes > temporaryLimit) {
    return { ok: false, code: "output-limit-exceeded" }
  }
  return outputSuccess({
    ...state,
    used: new Set([...state.used, start.outputID]),
    active: { start, chunks: 0, bytes: 0 },
  })
}

function chunkOutput(state: OutputOrderState, chunk: OutputChunk): OutputOrderResult {
  const active = state.active
  if (!active || active.start.outputID !== chunk.outputID || chunk.sequence !== active.chunks) {
    return { ok: false, code: "invalid-output-order" }
  }
  let decoded: Uint8Array
  try {
    decoded = decodeCanonicalBase64(chunk.data)
  } catch {
    return { ok: false, code: "invalid-base64" }
  }
  const expectedChunks = Math.ceil(active.start.declaredBytes / DocumentRuntimeLimits.MaxOutputChunkBytes)
  if (chunk.sequence >= expectedChunks) return { ok: false, code: "invalid-output-order" }
  const expectedBytes =
    chunk.sequence === expectedChunks - 1
      ? active.start.declaredBytes - chunk.sequence * DocumentRuntimeLimits.MaxOutputChunkBytes
      : DocumentRuntimeLimits.MaxOutputChunkBytes
  if (decoded.byteLength !== expectedBytes) return { ok: false, code: "invalid-output-order" }
  return outputSuccess(
    {
      ...state,
      active: {
        ...active,
        chunks: active.chunks + 1,
        bytes: active.bytes + decoded.byteLength,
      },
    },
    decoded,
  )
}

function endOutput(state: OutputOrderState, end: OutputEnd): OutputOrderResult {
  const active = state.active
  if (!active || active.start.outputID !== end.outputID) return { ok: false, code: "invalid-output-order" }
  const expectedChunks = Math.ceil(active.start.declaredBytes / DocumentRuntimeLimits.MaxOutputChunkBytes)
  if (
    active.chunks !== expectedChunks ||
    end.chunks !== expectedChunks ||
    active.bytes !== active.start.declaredBytes ||
    end.actualBytes !== active.start.declaredBytes
  ) {
    return { ok: false, code: "invalid-output-order" }
  }
  return outputSuccess({
    ...state,
    active: undefined,
    completed: {
      start: active.start,
      chunks: active.chunks,
      bytes: active.bytes,
      sha256: end.sha256,
    },
    cumulativeBytes: state.cumulativeBytes + active.bytes,
    liveBytes: state.liveBytes + active.bytes,
  })
}

function publishOutput(
  state: OutputOrderState,
  event:
    | typeof PageReadyEvent.Type
    | typeof OcrResultEvent.Type
    | typeof OfficeReadyEvent.Type
    | typeof DocxReadyEvent.Type
    | typeof PdfInfoEvent.Type,
): OutputOrderResult {
  const completed = state.completed
  if (!completed) return { ok: false, code: "invalid-output-order" }
  const start = completed.start
  if (start.kind === "office-text") {
    if (event.type !== "office-ready" || start.outputID !== event.outputID || completed.sha256 !== event.outputSha256) {
      return { ok: false, code: "invalid-output-order" }
    }
    return outputSuccess({
      ...state,
      completed: undefined,
      published: [...state.published, { outputID: event.outputID, bytes: completed.bytes, kind: "office-text" }],
    })
  }
  if (start.kind === "pdf-text") {
    if (event.type !== "pdf-info" || start.outputID !== event.outputID || completed.sha256 !== event.outputSha256) {
      return { ok: false, code: "invalid-output-order" }
    }
    return outputSuccess({
      ...state,
      completed: undefined,
      published: [...state.published, { outputID: event.outputID, bytes: completed.bytes, kind: "pdf-text" }],
    })
  }
  if (start.kind === "docx-output") {
    if (event.type !== "docx-ready" || start.outputID !== event.outputID || completed.sha256 !== event.outputSha256) {
      return { ok: false, code: "invalid-output-order" }
    }
    return outputSuccess({
      ...state,
      completed: undefined,
      published: [...state.published, { outputID: event.outputID, bytes: completed.bytes, kind: "docx-output" }],
    })
  }
  if (event.type !== "page-ready" && event.type !== "ocr-result") {
    return { ok: false, code: "invalid-output-order" }
  }
  if (
    start.outputID !== event.outputID ||
    start.page !== event.page ||
    start.pageID !== event.pageID ||
    start.sourcePath !== event.outputPath ||
    completed.sha256 !== event.outputSha256 ||
    (event.type === "page-ready"
      ? start.kind !== "page-png" || start.declaredBytes !== event.pngBytes
      : start.kind !== "ocr-tsv" ||
        start.resultID !== event.resultID ||
        start.declaredBytes !== event.tsvBytes)
  ) {
    return { ok: false, code: "invalid-output-order" }
  }
  return outputSuccess({
    ...state,
    completed: undefined,
    published: [
      ...state.published,
      {
        outputID: event.outputID,
        page: event.page,
        pageID: event.pageID,
        bytes: completed.bytes,
        kind: start.kind,
      },
    ],
  })
}

function matchesExpectedOutput(state: OutputOrderState, start: OutputStart) {
  const request = state.request
  if (request.type === "probe") return false
  if (start.kind === "office-text") {
    return request.type === "read-office" && start.sourcePath.startsWith("office/")
  }
  if (start.kind === "pdf-text") {
    return request.type === "read-pdf" && start.sourcePath.startsWith("pdf/")
  }
  if (start.kind === "docx-output") {
    return request.type === "create-docx" && start.sourcePath.startsWith("generate/")
  }
  if (start.kind === "page-png") {
    return (
      request.type === "render" &&
      start.page === request.startPage + state.releasedPages &&
      start.page <= request.startPage + request.pageCount - 1 &&
      start.sourcePath.startsWith("pages/")
    )
  }
  if (!start.sourcePath.startsWith("ocr/")) return false
  if (request.type === "ocr") return start.page === request.page && start.pageID === request.pageID
  return (
    state.published.some(
      (output) => output.kind === "page-png" && output.page === start.page && output.pageID === start.pageID,
    ) &&
    !state.published.some(
      (output) => output.kind === "ocr-tsv" && output.page === start.page && output.pageID === start.pageID,
    )
  )
}

function cumulativePayloadLimit(request: StartRequest) {
  if (request.type === "probe") return 0
  if (request.type === "ocr") return request.limits.tsvBytesPerPage
  if (request.type === "read-office" || request.type === "read-pdf" || request.type === "create-docx")
    return DocumentRuntimeLimits.MaxOfficeOutputBytes
  return request.pageCount * (request.limits.pngBytesPerPage + request.limits.tsvBytesPerPage)
}

function outputLimitForStart(request: StartRequest, start: OutputStart): number {
  if (start.kind === "office-text" || start.kind === "pdf-text" || start.kind === "docx-output")
    return DocumentRuntimeLimits.MaxOfficeOutputBytes
  if (request.type === "render") return start.kind === "page-png" ? request.limits.pngBytesPerPage : request.limits.tsvBytesPerPage
  if (request.type === "ocr") return start.kind === "page-png" ? 0 : request.limits.tsvBytesPerPage
  return 0
}

function temporaryLimitForRequest(request: StartRequest): number {
  if (request.type === "read-office" || request.type === "read-pdf" || request.type === "create-docx")
    return DocumentRuntimeLimits.MaxOfficeOutputBytes
  if (request.type === "probe") return 0
  return request.limits.temporaryBytes
}

export function decodeCanonicalBase64(value: string) {
  if (
    value.length === 0 ||
    value.length > DocumentRuntimeLimits.MaxOutputChunkBase64Characters ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new Error("invalid-base64")
  }
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0
  const output = new Uint8Array((value.length / 4) * 3 - padding)
  let offset = 0
  for (let index = 0; index < value.length; index += 4) {
    const a = alphabet.indexOf(value[index]!)
    const b = alphabet.indexOf(value[index + 1]!)
    const c = value[index + 2] === "=" ? 0 : alphabet.indexOf(value[index + 2]!)
    const d = value[index + 3] === "=" ? 0 : alphabet.indexOf(value[index + 3]!)
    const bits = (a << 18) | (b << 12) | (c << 6) | d
    if (offset < output.length) output[offset++] = bits >> 16
    if (offset < output.length) output[offset++] = bits >> 8
    if (offset < output.length) output[offset++] = bits
  }
  if (encodeCanonicalBase64(output) !== value) throw new Error("invalid-base64")
  return output
}

export function encodeCanonicalBase64(value: Uint8Array) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
  let output = ""
  for (let index = 0; index < value.length; index += 3) {
    const a = value[index]!
    const b = value[index + 1]
    const c = value[index + 2]
    output += alphabet[a >> 2]
    output += alphabet[((a & 3) << 4) | ((b ?? 0) >> 4)]
    output += b === undefined ? "=" : alphabet[((b & 15) << 2) | ((c ?? 0) >> 6)]
    output += c === undefined ? "=" : alphabet[c & 63]
  }
  return output
}

function outputSuccess(state: OutputOrderState, decodedChunk?: Uint8Array): OutputOrderResult {
  return decodedChunk ? { ok: true, state, decodedChunk } : { ok: true, state }
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
