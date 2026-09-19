import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { DocumentRuntimeLimits } from "./limits"

describe("DocumentRuntimeLimits", () => {
  test("exposes the fixed hard ceilings", () => {
    expect(Schema.encodeSync(DocumentRuntimeLimits.Hard)(DocumentRuntimeLimits.hard)).toEqual({
      dpi: 300,
      pdfInputBytes: 100 * 1024 * 1024,
      imageInputBytes: 64 * 1024 * 1024,
      pages: 100,
      rasterSidePixels: 10_000,
      rasterAreaPixels: 25_000_000,
      pngBytesPerPage: 64 * 1024 * 1024,
      temporaryBytes: 250 * 1024 * 1024,
      tsvBytesPerPage: 32 * 1024 * 1024,
      nativeStderrBytes: 64 * 1024,
      renderDeadlineMsPerPage: 60_000,
      ocrDeadlineMsPerPage: 120_000,
      jobDeadlineMs: 600_000,
      cancellationGraceMs: 2_000,
      concurrentJobs: 2,
    })
  })

  test("round trips lower caller-requested limits", () => {
    const limits = {
      ...DocumentRuntimeLimits.requestedHard,
      pdfInputBytes: 1,
      pages: 1,
      rasterSidePixels: 5_000,
      jobDeadlineMs: 1_000,
    }
    const decoded = Schema.decodeUnknownSync(DocumentRuntimeLimits.Requested)(limits)
    expect(Schema.encodeSync(DocumentRuntimeLimits.Requested)(decoded)).toEqual(limits)
  })

  test.each([
    ["dpi", 299],
    ["pages", 0],
    ["pages", 101],
    ["rasterSidePixels", 10_001],
    ["pngBytesPerPage", 64 * 1024 * 1024 + 1],
    ["nativeStderrBytes", 64 * 1024 + 1],
    ["renderDeadlineMsPerPage", 60_001],
    ["ocrDeadlineMsPerPage", 120_001],
    ["jobDeadlineMs", 600_001],
  ] as const)("rejects requested %s=%s", (field, value) => {
    expect(() =>
      Schema.decodeUnknownSync(DocumentRuntimeLimits.Requested)({
        ...DocumentRuntimeLimits.requestedHard,
        [field]: value,
      }),
    ).toThrow()
  })

  test("keeps coordinator concurrency and cancellation grace out of request-controlled limits", () => {
    expect(DocumentRuntimeLimits.requestedHard).not.toHaveProperty("concurrentJobs")
    expect(DocumentRuntimeLimits.requestedHard).not.toHaveProperty("cancellationGraceMs")
    const decoded = Schema.decodeUnknownSync(DocumentRuntimeLimits.Requested)({
      ...DocumentRuntimeLimits.requestedHard,
      concurrentJobs: 1,
      cancellationGraceMs: 1,
    })
    expect(decoded).not.toHaveProperty("concurrentJobs")
    expect(decoded).not.toHaveProperty("cancellationGraceMs")
  })

  test("enforces raster side and area limits before allocation", () => {
    const decode = Schema.decodeUnknownSync(DocumentRuntimeLimits.RasterDimensions)
    expect(decode({ width: 5_000, height: 5_000 })).toEqual({ width: 5_000, height: 5_000 })
    expect(() => decode({ width: 5_001, height: 5_000 })).toThrow()
    expect(() => decode({ width: 10_001, height: 1 })).toThrow()
    expect(() => decode({ width: 0, height: 1 })).toThrow()
  })
})
