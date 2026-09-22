import { sql } from "drizzle-orm"
import { check, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { ArtifactTable } from "../artifact/sql"
import { SessionTable } from "../session/sql"

export const KnowledgeEntryTable = sqliteTable(
  "koala_knowledge_entry",
  {
    id: text().primaryKey(),
    owner_session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    artifact_id: text()
      .notNull()
      .references(() => ArtifactTable.id, { onDelete: "cascade" }),
    index_profile_id: text().notNull(),
    extractor_version: text().notNull(),
    chunker_version: text().notNull(),
    chunk_index: integer().notNull(),
    chunk_text: text().notNull(),
    locator: text({ mode: "json" }).notNull(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [
    check(
      "koala_knowledge_entry_id_check",
      sql`length(${table.id}) > 4 AND substr(${table.id}, 1, 4) = 'kwe_'`,
    ),
    check("koala_knowledge_entry_chunk_index_check", sql`${table.chunk_index} >= 0`),
    check(
      "koala_knowledge_entry_locator_json_check",
      sql`json_valid(${table.locator}) AND json_type(${table.locator}) = 'object'`,
    ),
    index("koala_knowledge_entry_owner_session_idx").on(table.owner_session_id),
    index("koala_knowledge_entry_artifact_idx").on(table.artifact_id),
  ],
)

export const KnowledgeTermTable = sqliteTable(
  "koala_knowledge_term",
  {
    term: text().notNull(),
    entry_id: text()
      .notNull()
      .references(() => KnowledgeEntryTable.id, { onDelete: "cascade" }),
    count: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.term, table.entry_id] }),
    check("koala_knowledge_term_count_check", sql`${table.count} > 0`),
    check("koala_knowledge_term_term_check", sql`length(${table.term}) > 0`),
    index("koala_knowledge_term_term_idx").on(table.term),
    index("koala_knowledge_term_entry_idx").on(table.entry_id),
  ],
)
