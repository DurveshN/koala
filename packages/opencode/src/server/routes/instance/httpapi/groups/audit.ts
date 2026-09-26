import { IndustrialAudit } from "@koala-ai/core/industrial/audit"
import { NetworkAudit } from "@koala-ai/core/network/audit"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { UnknownError } from "../errors"
import { described } from "./metadata"

const root = "/global/audit"

export const AuditPaths = {
  tools: `${root}/tools`,
  network: `${root}/network`,
} as const

const Limit = Schema.NumberFromString.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(IndustrialAudit.MaxListLimit),
)
const Cursor = Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))

const ToolsQuery = Schema.Struct({
  limit: Schema.optional(Limit),
  cursor: Schema.optional(Cursor),
  sessionID: Schema.optional(Schema.String),
})

const NetworkQuery = Schema.Struct({
  limit: Schema.optional(Limit),
  cursor: Schema.optional(Cursor),
  decision: Schema.optional(NetworkAudit.Decision),
})

export const AuditApi = HttpApi.make("audit").add(
  HttpApiGroup.make("audit")
    .add(
      HttpApiEndpoint.get("tools", AuditPaths.tools, {
        query: ToolsQuery,
        success: described(IndustrialAudit.ListResult, "Tool-call audit records"),
        error: UnknownError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "audit.tools",
          summary: "List tool-call audit records",
          description: "Paginated durable, redacted audit records for industrial tool calls.",
        }),
      ),
      HttpApiEndpoint.get("network", AuditPaths.network, {
        query: NetworkQuery,
        success: described(NetworkAudit.ListResult, "Network decision audit records"),
        error: UnknownError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "audit.network",
          summary: "List network decision audit records",
          description: "Paginated durable, redacted audit records for outbound network policy decisions.",
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "audit", description: "Global Koala audit log routes." })),
)
