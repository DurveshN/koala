import { Effect } from "effect"
import type { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"

type Database = EffectDrizzleSqlite.EffectSQLiteDatabase
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0]

export function ensureIndustrialConstraints(db: Database | Transaction) {
  return Effect.gen(function* () {
    yield* db.run(`
      CREATE TRIGGER IF NOT EXISTS koala_tool_audit_artifact_ids_insert
      BEFORE INSERT ON koala_tool_audit
      BEGIN
        SELECT CASE WHEN
          EXISTS (
            SELECT 1 FROM json_each(NEW.source_artifact_ids)
            WHERE type <> 'text' OR length(value) <> 40 OR substr(value, 1, 4) <> 'art_'
              OR substr(value, 13, 1) <> '-' OR substr(value, 18, 1) <> '-' OR substr(value, 19, 1) <> '4'
              OR substr(value, 23, 1) <> '-' OR substr(value, 24, 1) NOT GLOB '[89ab]'
              OR substr(value, 28, 1) <> '-' OR length(replace(substr(value, 5), '-', '')) <> 32
              OR replace(substr(value, 5), '-', '') GLOB '*[^0-9a-f]*'
          ) OR EXISTS (
            SELECT 1 FROM json_each(NEW.output_artifact_ids)
            WHERE type <> 'text' OR length(value) <> 40 OR substr(value, 1, 4) <> 'art_'
              OR substr(value, 13, 1) <> '-' OR substr(value, 18, 1) <> '-' OR substr(value, 19, 1) <> '4'
              OR substr(value, 23, 1) <> '-' OR substr(value, 24, 1) NOT GLOB '[89ab]'
              OR substr(value, 28, 1) <> '-' OR length(replace(substr(value, 5), '-', '')) <> 32
              OR replace(substr(value, 5), '-', '') GLOB '*[^0-9a-f]*'
          ) OR (SELECT count(*) FROM json_each(NEW.source_artifact_ids)) <>
            (SELECT count(DISTINCT value) FROM json_each(NEW.source_artifact_ids))
          OR (SELECT count(*) FROM json_each(NEW.output_artifact_ids)) <>
            (SELECT count(DISTINCT value) FROM json_each(NEW.output_artifact_ids))
        THEN RAISE(ABORT, 'invalid audit artifact IDs') END;
      END;
    `)
    yield* db.run(`
      CREATE TRIGGER IF NOT EXISTS koala_tool_audit_artifact_ids_update
      BEFORE UPDATE OF source_artifact_ids, output_artifact_ids ON koala_tool_audit
      BEGIN
        SELECT CASE WHEN
          EXISTS (
            SELECT 1 FROM json_each(NEW.source_artifact_ids)
            WHERE type <> 'text' OR length(value) <> 40 OR substr(value, 1, 4) <> 'art_'
              OR substr(value, 13, 1) <> '-' OR substr(value, 18, 1) <> '-' OR substr(value, 19, 1) <> '4'
              OR substr(value, 23, 1) <> '-' OR substr(value, 24, 1) NOT GLOB '[89ab]'
              OR substr(value, 28, 1) <> '-' OR length(replace(substr(value, 5), '-', '')) <> 32
              OR replace(substr(value, 5), '-', '') GLOB '*[^0-9a-f]*'
          ) OR EXISTS (
            SELECT 1 FROM json_each(NEW.output_artifact_ids)
            WHERE type <> 'text' OR length(value) <> 40 OR substr(value, 1, 4) <> 'art_'
              OR substr(value, 13, 1) <> '-' OR substr(value, 18, 1) <> '-' OR substr(value, 19, 1) <> '4'
              OR substr(value, 23, 1) <> '-' OR substr(value, 24, 1) NOT GLOB '[89ab]'
              OR substr(value, 28, 1) <> '-' OR length(replace(substr(value, 5), '-', '')) <> 32
              OR replace(substr(value, 5), '-', '') GLOB '*[^0-9a-f]*'
          ) OR (SELECT count(*) FROM json_each(NEW.source_artifact_ids)) <>
            (SELECT count(DISTINCT value) FROM json_each(NEW.source_artifact_ids))
          OR (SELECT count(*) FROM json_each(NEW.output_artifact_ids)) <>
            (SELECT count(DISTINCT value) FROM json_each(NEW.output_artifact_ids))
        THEN RAISE(ABORT, 'invalid audit artifact IDs') END;
      END;
    `)
  })
}
