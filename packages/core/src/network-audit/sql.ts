import { sql } from "drizzle-orm"
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const NetworkAuditTable = sqliteTable(
  "koala_network_audit",
  {
    id: text().primaryKey(),
    provider_id: text().notNull(),
    origin: text().notNull(),
    destination: text().notNull(),
    method: text().notNull(),
    decision: text().notNull(),
    rule: text().notNull(),
    status: integer(),
    duration_ms: integer(),
    request_bytes: integer(),
    response_bytes: integer(),
    error_kind: text(),
    time_started: integer().notNull(),
  },
  (table) => [
    check(
      "koala_network_audit_id_check",
      sql`length(${table.id}) = 40 AND substr(${table.id}, 1, 4) = 'net_' AND substr(${table.id}, 13, 1) = '-' AND substr(${table.id}, 18, 1) = '-' AND substr(${table.id}, 19, 1) = '4' AND substr(${table.id}, 23, 1) = '-' AND substr(${table.id}, 24, 1) GLOB '[89ab]' AND substr(${table.id}, 28, 1) = '-' AND length(replace(substr(${table.id}, 5), '-', '')) = 32 AND replace(substr(${table.id}, 5), '-', '') NOT GLOB '*[^0-9a-f]*'`,
    ),
    check("koala_network_audit_decision_check", sql`${table.decision} IN ('allowed', 'denied')`),
    check(
      "koala_network_audit_text_check",
      sql`length(${table.provider_id}) BETWEEN 1 AND 256 AND length(${table.origin}) BETWEEN 1 AND 2048 AND length(${table.destination}) BETWEEN 1 AND 2048 AND length(${table.method}) BETWEEN 1 AND 16 AND length(${table.rule}) BETWEEN 1 AND 128`,
    ),
    check(
      "koala_network_audit_error_kind_check",
      sql`${table.error_kind} IS NULL OR ${table.error_kind} IN ('policy', 'redirect', 'transport')`,
    ),
    check(
      "koala_network_audit_bytes_check",
      sql`(${table.request_bytes} IS NULL OR ${table.request_bytes} >= 0) AND (${table.response_bytes} IS NULL OR ${table.response_bytes} >= 0)`,
    ),
    check(
      "koala_network_audit_time_check",
      sql`${table.time_started} >= 0 AND (${table.duration_ms} IS NULL OR ${table.duration_ms} >= 0)`,
    ),
    index("koala_network_audit_time_idx").on(table.time_started),
    index("koala_network_audit_decision_time_idx").on(table.decision, table.time_started),
    index("koala_network_audit_provider_idx").on(table.provider_id),
  ],
)
