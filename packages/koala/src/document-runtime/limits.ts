export * as DocumentRuntimeLimits from "./limits"

import { Schema } from "effect"

export const FixedDpi = 300
export const MaxPdfInputBytes = 100 * 1024 * 1024
export const MaxImageInputBytes = 64 * 1024 * 1024
export const MaxPages = 100
export const MaxRasterSidePixels = 10_000
export const MaxRasterAreaPixels = 25_000_000
export const MaxPngBytesPerPage = 64 * 1024 * 1024
export const MaxTemporaryBytes = 250 * 1024 * 1024
export const MaxTsvBytesPerPage = 32 * 1024 * 1024
export const MaxNativeStderrBytes = 64 * 1024
export const MaxRenderDeadlineMsPerPage = 60_000
export const MaxOcrDeadlineMsPerPage = 120_000
export const MaxJobDeadlineMs = 10 * 60_000
export const MaxCancellationGraceMs = 2_000
export const MaxConcurrentJobs = 2
export const MaxOuterIpcMessageBytes = 65_536
export const MaxOuterPendingMessages = 32
export const MaxNdjsonLineBytes = 16_384
export const MaxNdjsonUnterminatedBytes = 16_384
export const MaxNdjsonFramesPerDirection = 512
export const MaxNdjsonBytesPerDirection = 1_048_576
export const MaxNdjsonPendingWrites = 32
export const MaxInnerStderrBytes = 65_536
export const MaxOutputChunkBytes = 10_240
export const MaxOutputChunkBase64Characters = 13_656

export const Hard = Schema.Struct({
  dpi: Schema.Literal(FixedDpi),
  pdfInputBytes: Schema.Literal(MaxPdfInputBytes),
  imageInputBytes: Schema.Literal(MaxImageInputBytes),
  pages: Schema.Literal(MaxPages),
  rasterSidePixels: Schema.Literal(MaxRasterSidePixels),
  rasterAreaPixels: Schema.Literal(MaxRasterAreaPixels),
  pngBytesPerPage: Schema.Literal(MaxPngBytesPerPage),
  temporaryBytes: Schema.Literal(MaxTemporaryBytes),
  tsvBytesPerPage: Schema.Literal(MaxTsvBytesPerPage),
  nativeStderrBytes: Schema.Literal(MaxNativeStderrBytes),
  renderDeadlineMsPerPage: Schema.Literal(MaxRenderDeadlineMsPerPage),
  ocrDeadlineMsPerPage: Schema.Literal(MaxOcrDeadlineMsPerPage),
  jobDeadlineMs: Schema.Literal(MaxJobDeadlineMs),
  cancellationGraceMs: Schema.Literal(MaxCancellationGraceMs),
  concurrentJobs: Schema.Literal(MaxConcurrentJobs),
}).annotate({ identifier: "DocumentRuntimeLimits.Hard" })
export type Hard = typeof Hard.Type

export const hard = {
  dpi: FixedDpi,
  pdfInputBytes: MaxPdfInputBytes,
  imageInputBytes: MaxImageInputBytes,
  pages: MaxPages,
  rasterSidePixels: MaxRasterSidePixels,
  rasterAreaPixels: MaxRasterAreaPixels,
  pngBytesPerPage: MaxPngBytesPerPage,
  temporaryBytes: MaxTemporaryBytes,
  tsvBytesPerPage: MaxTsvBytesPerPage,
  nativeStderrBytes: MaxNativeStderrBytes,
  renderDeadlineMsPerPage: MaxRenderDeadlineMsPerPage,
  ocrDeadlineMsPerPage: MaxOcrDeadlineMsPerPage,
  jobDeadlineMs: MaxJobDeadlineMs,
  cancellationGraceMs: MaxCancellationGraceMs,
  concurrentJobs: MaxConcurrentJobs,
} as const satisfies Hard

const requested = (maximum: number) => Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(maximum))

export interface Requested extends Schema.Schema.Type<typeof Requested> {}
export const Requested = Schema.Struct({
  dpi: Schema.Literal(FixedDpi),
  pdfInputBytes: requested(MaxPdfInputBytes),
  imageInputBytes: requested(MaxImageInputBytes),
  pages: requested(MaxPages),
  rasterSidePixels: requested(MaxRasterSidePixels),
  rasterAreaPixels: requested(MaxRasterAreaPixels),
  pngBytesPerPage: requested(MaxPngBytesPerPage),
  temporaryBytes: requested(MaxTemporaryBytes),
  tsvBytesPerPage: requested(MaxTsvBytesPerPage),
  nativeStderrBytes: requested(MaxNativeStderrBytes),
  renderDeadlineMsPerPage: requested(MaxRenderDeadlineMsPerPage),
  ocrDeadlineMsPerPage: requested(MaxOcrDeadlineMsPerPage),
  jobDeadlineMs: requested(MaxJobDeadlineMs),
}).annotate({ identifier: "DocumentRuntimeLimits.Requested" })

export const requestedHard = {
  dpi: FixedDpi,
  pdfInputBytes: MaxPdfInputBytes,
  imageInputBytes: MaxImageInputBytes,
  pages: MaxPages,
  rasterSidePixels: MaxRasterSidePixels,
  rasterAreaPixels: MaxRasterAreaPixels,
  pngBytesPerPage: MaxPngBytesPerPage,
  temporaryBytes: MaxTemporaryBytes,
  tsvBytesPerPage: MaxTsvBytesPerPage,
  nativeStderrBytes: MaxNativeStderrBytes,
  renderDeadlineMsPerPage: MaxRenderDeadlineMsPerPage,
  ocrDeadlineMsPerPage: MaxOcrDeadlineMsPerPage,
  jobDeadlineMs: MaxJobDeadlineMs,
} as const satisfies Requested

export const PageNumber = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
export type PageNumber = typeof PageNumber.Type

export const PageCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(MaxPages))
export type PageCount = typeof PageCount.Type

export interface RasterDimensions extends Schema.Schema.Type<typeof RasterDimensions> {}
export const RasterDimensions = Schema.Struct({
  width: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(MaxRasterSidePixels)),
  height: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(MaxRasterSidePixels)),
}).check(
  Schema.makeFilter((dimensions) =>
    dimensions.width * dimensions.height <= MaxRasterAreaPixels
      ? undefined
      : `Raster area exceeds ${MaxRasterAreaPixels} pixels`,
  ),
)
