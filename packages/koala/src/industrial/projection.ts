export * as IndustrialProjection from "./projection"

import { Schema } from "effect"
import { IndustrialCitation } from "./citation"
import { IndustrialResult } from "./result"

export const MaxLines = 2_000
export const MaxBytes = 50 * 1024
export const TruncationMarker = "projection_truncated=true"

export interface Output extends Schema.Schema.Type<typeof Output> {}
export const Output = Schema.Struct({
  text: Schema.String,
  truncated: Schema.Boolean,
  lines: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(MaxLines)),
  bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(MaxBytes)),
}).annotate({ identifier: "IndustrialProjection.Output" })

export function project<A>(result: IndustrialResult.Checked<A>): Output {
  const lines = [
    `tool=${result.tool}`,
    `status=${result.status}`,
    `contract_version=${result.contractVersion}`,
    `engine=${result.engine.name}@${result.engine.version}`,
    `cancelled=${result.cancelled}`,
    `timed_out=${result.timedOut}`,
    `producer_truncated=${result.producerTruncated}`,
    "summary:",
    ...result.summary.split("\n").map(sanitizeSummaryLine),
    `source_count=${result.sources.length}`,
    ...result.sources.map(
      (source, index) =>
        `source[${index}]=${source.id};mime=${source.mime};size=${source.size};digest=${source.digest}`,
    ),
    `output_count=${result.outputs.length}`,
    ...result.outputs.map(
      (output, index) =>
        `output[${index}]=${output.id};mime=${output.mime};size=${output.size};digest=${output.digest}`,
    ),
    `citation_count=${result.citations.length}`,
    ...result.citations.map((citation, index) => `citation[${index}]=${renderLocator(citation)}`),
    ...(result.routeDecisionID === undefined ? [] : [`route_decision=${result.routeDecisionID}`]),
    ...(result.sandboxRunID === undefined ? [] : [`sandbox_run=${result.sandboxRunID}`]),
    ...(result.status === "error"
      ? [`error_code=${result.error.code}`, `error_retryable=${result.error.retryable}`]
      : []),
  ]
  const text = lines.join("\n")
  if (lines.length <= MaxLines && byteLength(text) <= MaxBytes) {
    return { text, truncated: false, lines: lines.length, bytes: byteLength(text) }
  }

  const kept: string[] = []
  for (const line of lines) {
    if (kept.length >= MaxLines - 1) break
    const candidate = [...kept, line, TruncationMarker].join("\n")
    if (byteLength(candidate) > MaxBytes) break
    kept.push(line)
  }
  const bounded = [...kept, TruncationMarker].join("\n")
  return { text: bounded, truncated: true, lines: kept.length + 1, bytes: byteLength(bounded) }
}

function renderLocator(locator: IndustrialCitation.Locator) {
  if (locator.type === "artifact") return `artifact:${locator.artifactID}`
  if (locator.type === "page") return `artifact:${locator.artifactID};page:${locator.page}`
  if (locator.type === "region") {
    return `artifact:${locator.artifactID};page:${locator.page};region:${locator.left},${locator.top},${locator.right},${locator.bottom}`
  }
  if (locator.type === "docx") {
    const path = locator.path.map((step) => `${step.node}[${step.index}]`).join(".")
    return `artifact:${locator.artifactID};docx:${locator.part};path:${path}${locator.elementID ? `;element:${locator.elementID}` : ""}`
  }
  if (locator.type === "slide") {
    return `artifact:${locator.artifactID};slide:${locator.slide}${locator.shapeID ? `;shape:${locator.shapeID}` : ""}`
  }
  if (locator.type === "sheet") {
    return `artifact:${locator.artifactID};sheet:${locator.sheet}${locator.range ? `;range:${locator.range}` : ""}`
  }
  return `artifact:${locator.artifactID};text:${locator.start}-${locator.end}`
}

function byteLength(value: string) {
  return new TextEncoder().encode(value).byteLength
}

function sanitizeSummaryLine(value: string) {
  return value
    .replace(/\b(?![a-z]:[\\/])[a-z][a-z0-9+.-]*:[^\s<>"'(){}\[\],;]+/gi, "[uri]")
    .replace(/(?:[a-z]:[\\/]|\\\\(?:[?.]\\)?|\/\/)[^\s<>"'(){}\[\],;]+/gi, "[absolute-path]")
    .replace(/(^|[^a-z0-9_.-])[/\\](?![/\\])[^\s<>"'(){}\[\],;]+/gi, "$1[absolute-path]")
}
