import { describe, expect } from "bun:test"
import path from "node:path"
import { NetworkAudit } from "@koala-ai/core/network/audit"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { NetworkAuditLive } from "../../src/koala/network-audit"
import { tmpdir } from "../fixture/fixture"
import { it } from "../lib/effect"

const withAudit = <A, E>(body: () => Effect.Effect<A, E, NetworkAudit.Service | Database.Service>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) =>
      body().pipe(
        Effect.provide(
          LayerNode.compile(LayerNode.group([NetworkAuditLive.node, Database.node]), [
            [Database.node, Database.layerFromPath(path.join(tmp.path, "network-audit.db"))],
            [
              EventV2Bridge.node,
              Layer.mock(EventV2Bridge.Service, { publish: () => Effect.succeed(undefined as never) }),
            ],
          ]),
        ),
      ),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

const allowed = (timeStarted: number): NetworkAudit.RecordInput => ({
  providerID: "local",
  origin: "http://127.0.0.1:11434",
  destination: "http://127.0.0.1:11434/v1/chat/completions",
  method: "POST",
  decision: "allowed",
  rule: "loopback",
  status: 200,
  durationMs: 12,
  requestBytes: 128,
  responseBytes: 4096,
  timeStarted,
})

const denied = (timeStarted: number): NetworkAudit.RecordInput => ({
  providerID: "local",
  origin: "https://api.public.example",
  destination: "https://api.public.example/v1",
  method: "POST",
  decision: "denied",
  rule: "public-address",
  errorKind: "policy",
  timeStarted,
})

describe("NetworkAudit", () => {
  it.live("records a decision, generates a strict ID, and reads it back", () =>
    withAudit(() =>
      Effect.gen(function* () {
        const audit = yield* NetworkAudit.Service
        const record = yield* audit.record(allowed(1000))
        expect(record.id).toMatch(/^net_[0-9a-f-]{36}$/)
        expect(record.decision).toBe("allowed")

        const listed = yield* audit.list({})
        expect(listed.records).toHaveLength(1)
        expect(listed.records[0]!.destination).toBe("http://127.0.0.1:11434/v1/chat/completions")
        expect(listed.records[0]!.responseBytes).toBe(4096)
      }),
    ),
  )

  it.live("orders by most recent first and filters by decision", () =>
    withAudit(() =>
      Effect.gen(function* () {
        const audit = yield* NetworkAudit.Service
        yield* audit.record(allowed(1000))
        yield* audit.record(denied(2000))
        yield* audit.record(allowed(3000))

        const all = yield* audit.list({})
        expect(all.records.map((r) => r.timeStarted)).toEqual([3000, 2000, 1000])

        const deniedOnly = yield* audit.list({ decision: "denied" })
        expect(deniedOnly.records).toHaveLength(1)
        expect(deniedOnly.records[0]!.rule).toBe("public-address")
        expect(deniedOnly.records[0]!.status).toBeNull()
      }),
    ),
  )

  it.live("paginates with a cursor", () =>
    withAudit(() =>
      Effect.gen(function* () {
        const audit = yield* NetworkAudit.Service
        for (let i = 1; i <= 3; i++) yield* audit.record(allowed(i * 1000))

        const first = yield* audit.list({ limit: 2 })
        expect(first.records.map((r) => r.timeStarted)).toEqual([3000, 2000])
        expect(first.nextCursor).toBe(2000)

        const second = yield* audit.list({ limit: 2, cursor: first.nextCursor! })
        expect(second.records.map((r) => r.timeStarted)).toEqual([1000])
        expect(second.nextCursor).toBeUndefined()
      }),
    ),
  )
})
