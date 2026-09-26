import { IndustrialAudit } from "@koala-ai/core/industrial/audit"
import { NetworkAudit } from "@koala-ai/core/network/audit"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { RootHttpApi } from "../api"
import { UnknownError } from "../errors"

export const auditHandlers = HttpApiBuilder.group(RootHttpApi, "audit", (handlers) =>
  Effect.gen(function* () {
    const toolAudit = yield* IndustrialAudit.Service
    const networkAudit = yield* NetworkAudit.Service

    const tools = Effect.fn("AuditHttpApi.tools")(function* (ctx: {
      query: { limit?: number; cursor?: number; sessionID?: string }
    }) {
      return yield* toolAudit
        .list({
          ...(ctx.query.limit !== undefined && { limit: ctx.query.limit }),
          ...(ctx.query.cursor !== undefined && { cursor: ctx.query.cursor }),
          ...(ctx.query.sessionID !== undefined && { sessionID: ctx.query.sessionID }),
        })
        .pipe(Effect.mapError(() => new UnknownError({ message: "Failed to read the tool audit log" })))
    })

    const network = Effect.fn("AuditHttpApi.network")(function* (ctx: {
      query: { limit?: number; cursor?: number; decision?: NetworkAudit.Decision }
    }) {
      return yield* networkAudit
        .list({
          ...(ctx.query.limit !== undefined && { limit: ctx.query.limit }),
          ...(ctx.query.cursor !== undefined && { cursor: ctx.query.cursor }),
          ...(ctx.query.decision !== undefined && { decision: ctx.query.decision }),
        })
        .pipe(Effect.mapError(() => new UnknownError({ message: "Failed to read the network audit log" })))
    })

    return handlers.handle("tools", tools).handle("network", network)
  }),
)
