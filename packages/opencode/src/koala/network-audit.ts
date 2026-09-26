import { randomUUID } from "node:crypto"
import { NetworkAudit } from "@koala-ai/core/network/audit"
import { Database } from "@opencode-ai/core/database/database"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { NetworkAuditTable } from "@opencode-ai/core/network-audit/sql"
import { KoalaAudit } from "@opencode-ai/schema/koala-audit"
import { and, desc, eq, lt } from "drizzle-orm"
import { Effect, Layer, Schema } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"

const layer = Layer.effect(
  NetworkAudit.Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2Bridge.Service
    const decodeInput = Schema.decodeUnknownEffect(NetworkAudit.RecordInput)
    const decodeRecord = Schema.decodeUnknownEffect(NetworkAudit.Record)

    const record = Effect.fn("NetworkAudit.record")(function* (unsafeInput: NetworkAudit.RecordInput) {
      const input = yield* decodeInput(unsafeInput).pipe(
        Effect.mapError(() => new NetworkAudit.WriteError({ code: "invalid-record" })),
      )
      const value = yield* decodeRecord({
        id: `net_${randomUUID()}`,
        providerID: input.providerID,
        origin: input.origin,
        destination: input.destination,
        method: input.method,
        decision: input.decision,
        rule: input.rule,
        status: input.status ?? null,
        durationMs: input.durationMs ?? null,
        requestBytes: input.requestBytes ?? null,
        responseBytes: input.responseBytes ?? null,
        errorKind: input.errorKind ?? null,
        timeStarted: input.timeStarted,
      }).pipe(Effect.mapError(() => new NetworkAudit.WriteError({ code: "invalid-record" })))

      yield* db
        .insert(NetworkAuditTable)
        .values({
          id: value.id,
          provider_id: value.providerID,
          origin: value.origin,
          destination: value.destination,
          method: value.method,
          decision: value.decision,
          rule: value.rule,
          status: value.status,
          duration_ms: value.durationMs,
          request_bytes: value.requestBytes,
          response_bytes: value.responseBytes,
          error_kind: value.errorKind,
          time_started: value.timeStarted,
        })
        .run()
        .pipe(
          Effect.mapError(() => new NetworkAudit.WriteError({ code: "unavailable" })),
          Effect.catchDefect(() => Effect.fail(new NetworkAudit.WriteError({ code: "unavailable" }))),
        )

      yield* events
        .publish(KoalaAudit.Event.NetworkRecorded, {
          id: value.id,
          providerID: value.providerID,
          origin: value.origin,
          destination: value.destination,
          method: value.method,
          decision: value.decision,
          rule: value.rule,
          ...(value.status !== null && { status: value.status }),
          timeStarted: value.timeStarted,
        })
        .pipe(Effect.ignore)

      return value
    })

    const list = Effect.fn("NetworkAudit.list")(function* (query: NetworkAudit.ListQuery) {
      const limit = query.limit ?? NetworkAudit.DefaultListLimit
      const conditions = [
        query.cursor !== undefined ? lt(NetworkAuditTable.time_started, query.cursor) : undefined,
        query.decision !== undefined ? eq(NetworkAuditTable.decision, query.decision) : undefined,
      ].filter((condition) => condition !== undefined)

      const rows = yield* db
        .select()
        .from(NetworkAuditTable)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(NetworkAuditTable.time_started), desc(NetworkAuditTable.id))
        .limit(limit + 1)
        .all()
        .pipe(
          Effect.mapError(() => new NetworkAudit.ReadError({ code: "unavailable" })),
          Effect.catchDefect(() => Effect.fail(new NetworkAudit.ReadError({ code: "unavailable" }))),
        )

      const page = rows.length > limit ? rows.slice(0, limit) : rows
      const records = page.map((row) => ({
        id: row.id as NetworkAudit.ID,
        providerID: row.provider_id,
        origin: row.origin,
        destination: row.destination,
        method: row.method,
        decision: row.decision as NetworkAudit.Decision,
        rule: row.rule,
        status: row.status,
        durationMs: row.duration_ms,
        requestBytes: row.request_bytes,
        responseBytes: row.response_bytes,
        errorKind: row.error_kind as NetworkAudit.ErrorKind | null,
        timeStarted: row.time_started,
      }))

      return rows.length > limit && page.length > 0
        ? { records, nextCursor: page[page.length - 1].time_started }
        : { records }
    })

    return NetworkAudit.Service.of({ record, list })
  }),
)

export const node = makeGlobalNode({
  service: NetworkAudit.Service,
  layer,
  deps: [Database.node, EventV2Bridge.node],
})

export * as NetworkAuditLive from "./network-audit"
