import { Context, Effect, Schema } from "effect"

// Durable, redacted audit records for every outbound network decision made by the
// local-only network policy. Records deliberately exclude credentials, headers,
// prompts, cookies, and document content; they carry only routing metadata so the
// sovereignty claim (no external calls) is provable from the record set alone.

export const MaxFieldLength = 2048

const BoundedText = (max: number) =>
  Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(max), Schema.isTrimmed())

const Timestamp = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const ByteCount = Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)))

export const ID = Schema.String.check(
  Schema.isPattern(/^net_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
).pipe(Schema.brand("NetworkAudit.ID"))
export type ID = typeof ID.Type

export const Decision = Schema.Literals(["allowed", "denied"])
export type Decision = typeof Decision.Type

// Origin classification for allowed calls; denial code (EndpointPolicy.DenialCode
// or a transport/redirect reason) for denied calls.
export const ErrorKind = Schema.Literals(["policy", "redirect", "transport"])
export type ErrorKind = typeof ErrorKind.Type

const RecordFields = {
  id: ID,
  providerID: BoundedText(256),
  origin: BoundedText(MaxFieldLength),
  destination: BoundedText(MaxFieldLength),
  method: BoundedText(16),
  decision: Decision,
  rule: BoundedText(128),
  status: Schema.NullOr(Schema.Int),
  durationMs: Schema.NullOr(Timestamp),
  requestBytes: ByteCount,
  responseBytes: ByteCount,
  errorKind: Schema.NullOr(ErrorKind),
  timeStarted: Timestamp,
}

export interface Record extends Schema.Schema.Type<typeof Record> {}
export const Record = Schema.Struct(RecordFields).annotate({ identifier: "NetworkAudit.Record" })

export const RecordInput = Schema.Struct({
  providerID: BoundedText(256),
  origin: BoundedText(MaxFieldLength),
  destination: BoundedText(MaxFieldLength),
  method: BoundedText(16),
  decision: Decision,
  rule: BoundedText(128),
  status: Schema.optionalKey(Schema.NullOr(Schema.Int)),
  durationMs: Schema.optionalKey(Schema.NullOr(Timestamp)),
  requestBytes: Schema.optionalKey(ByteCount),
  responseBytes: Schema.optionalKey(ByteCount),
  errorKind: Schema.optionalKey(Schema.NullOr(ErrorKind)),
  timeStarted: Timestamp,
}).annotate({ identifier: "NetworkAudit.RecordInput" })
export type RecordInput = typeof RecordInput.Type

export const DefaultListLimit = 50
export const MaxListLimit = 200

export const ListQuery = Schema.Struct({
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(MaxListLimit)),
  ),
  cursor: Schema.optionalKey(Timestamp),
  decision: Schema.optionalKey(Decision),
}).annotate({ identifier: "NetworkAudit.ListQuery" })
export type ListQuery = typeof ListQuery.Type

export interface ListResult extends Schema.Schema.Type<typeof ListResult> {}
export const ListResult = Schema.Struct({
  records: Schema.Array(Record),
  nextCursor: Schema.optionalKey(Timestamp),
}).annotate({ identifier: "NetworkAudit.ListResult" })

export class WriteError extends Schema.TaggedErrorClass<WriteError>()("NetworkAuditWriteError", {
  code: Schema.Literals(["unavailable", "invalid-record"]),
}) {
  override get message() {
    return `Network audit write failed: ${this.code}`
  }
}

export class ReadError extends Schema.TaggedErrorClass<ReadError>()("NetworkAuditReadError", {
  code: Schema.Literals(["unavailable"]),
}) {
  override get message() {
    return `Network audit read failed: ${this.code}`
  }
}

export interface Interface {
  readonly record: (input: RecordInput) => Effect.Effect<Record, WriteError>
  readonly list: (query: ListQuery) => Effect.Effect<typeof ListResult.Type, ReadError>
}

export class Service extends Context.Service<Service, Interface>()("@koala-ai/core/NetworkAudit") {}

export * as NetworkAudit from "./audit"
