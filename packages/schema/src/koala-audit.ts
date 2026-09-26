export * as KoalaAudit from "./koala-audit"

import { Schema } from "effect"
import { define, inventory } from "./event"
import { optional } from "./schema"

// Browser-safe, redacted live-activity events for the Koala audit log. The durable
// history lives in the SQLite audit tables (read via REST); these events only
// announce that a new record was appended so panels can update in real time.

const ToolRecorded = define({
  type: "koala.audit.tool.recorded",
  schema: {
    id: Schema.String,
    sessionID: Schema.String,
    messageID: Schema.String,
    toolCallID: Schema.String,
    tool: Schema.String,
    permission: Schema.String,
    state: Schema.Literals(["running", "completed"]),
    outcome: Schema.String.pipe(optional),
    timeStarted: Schema.Int,
  },
})

const NetworkRecorded = define({
  type: "koala.audit.network.recorded",
  schema: {
    id: Schema.String,
    providerID: Schema.String,
    origin: Schema.String,
    destination: Schema.String,
    method: Schema.String,
    decision: Schema.Literals(["allowed", "denied"]),
    rule: Schema.String,
    status: Schema.Int.pipe(optional),
    timeStarted: Schema.Int,
  },
})

export const Event = {
  ToolRecorded,
  NetworkRecorded,
  Definitions: inventory(ToolRecorded, NetworkRecorded),
}
