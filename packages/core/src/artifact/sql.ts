import { sql } from "drizzle-orm"
import { check, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { MessageTable, SessionTable } from "../session/sql"

export const ArtifactBlobTable = sqliteTable(
  "koala_artifact_blob",
  {
    digest: text().primaryKey(),
    size: integer().notNull(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [
    check(
      "koala_artifact_blob_digest_check",
      sql`length(${table.digest}) = 64 AND ${table.digest} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check("koala_artifact_blob_size_check", sql`${table.size} BETWEEN 0 AND 104857600`),
  ],
)

export const ArtifactTable = sqliteTable(
  "koala_artifact",
  {
    id: text().primaryKey(),
    digest: text()
      .notNull()
      .references(() => ArtifactBlobTable.digest),
    name: text().notNull(),
    mime: text().notNull(),
    validation_state: text().notNull(),
    validator: text().notNull(),
    validator_version: text().notNull(),
    validation: text({ mode: "json" }).notNull(),
    owner_session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    owner_message_id: text()
      .notNull()
      .references(() => MessageTable.id, { onDelete: "cascade" }),
    tool_name: text().notNull(),
    tool_call_id: text(),
    sandbox_run_id: text(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [
    check(
      "koala_artifact_id_check",
      sql`length(${table.id}) = 40 AND substr(${table.id}, 1, 4) = 'art_' AND substr(${table.id}, 13, 1) = '-' AND substr(${table.id}, 18, 1) = '-' AND substr(${table.id}, 19, 1) = '4' AND substr(${table.id}, 23, 1) = '-' AND substr(${table.id}, 24, 1) GLOB '[89ab]' AND substr(${table.id}, 28, 1) = '-' AND length(replace(substr(${table.id}, 5), '-', '')) = 32 AND replace(substr(${table.id}, 5), '-', '') NOT GLOB '*[^0-9a-f]*'`,
    ),
    check("koala_artifact_name_check", sql`length(${table.name}) BETWEEN 1 AND 255`),
    check("koala_artifact_mime_check", sql`length(${table.mime}) BETWEEN 1 AND 127`),
    check("koala_artifact_validation_state_check", sql`${table.validation_state} IN ('accepted', 'rejected')`),
    check(
      "koala_artifact_validation_json_check",
      sql`json_valid(${table.validation}) AND json_type(${table.validation}) = 'object'`,
    ),
    check(
      "koala_artifact_validation_scalar_check",
      sql`json_type(${table.validation}, '$.state') IS 'text' AND json_extract(${table.validation}, '$.state') IS ${table.validation_state} AND json_type(${table.validation}, '$.validator') IS 'text' AND json_extract(${table.validation}, '$.validator') IS ${table.validator} AND json_type(${table.validation}, '$.validatorVersion') IS 'text' AND json_extract(${table.validation}, '$.validatorVersion') IS ${table.validator_version}`,
    ),
    index("koala_artifact_digest_idx").on(table.digest),
    index("koala_artifact_owner_session_idx").on(table.owner_session_id),
    index("koala_artifact_owner_message_idx").on(table.owner_message_id),
    index("koala_artifact_sandbox_run_idx").on(table.sandbox_run_id),
  ],
)

export const ArtifactLineageTable = sqliteTable(
  "koala_artifact_lineage",
  {
    artifact_id: text()
      .notNull()
      .references(() => ArtifactTable.id, { onDelete: "cascade" }),
    source_artifact_id: text()
      .notNull()
      .references(() => ArtifactTable.id, { onDelete: "cascade" }),
    relation: text().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.artifact_id, table.source_artifact_id, table.relation] }),
    check("koala_artifact_lineage_not_self_check", sql`${table.artifact_id} <> ${table.source_artifact_id}`),
    check("koala_artifact_lineage_relation_check", sql`${table.relation} = 'derived-from'`),
    index("koala_artifact_lineage_source_idx").on(table.source_artifact_id),
  ],
)
