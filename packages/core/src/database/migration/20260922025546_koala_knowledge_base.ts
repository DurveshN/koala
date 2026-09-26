import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260922025546_koala_knowledge_base",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`koala_knowledge_entry\` (
          \`id\` text PRIMARY KEY,
          \`owner_session_id\` text NOT NULL,
          \`artifact_id\` text NOT NULL,
          \`index_profile_id\` text NOT NULL,
          \`extractor_version\` text NOT NULL,
          \`chunker_version\` text NOT NULL,
          \`chunk_index\` integer NOT NULL,
          \`chunk_text\` text NOT NULL,
          \`locator\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_koala_knowledge_entry_owner_session_id_session_id_fk\` FOREIGN KEY (\`owner_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_koala_knowledge_entry_artifact_id_koala_artifact_id_fk\` FOREIGN KEY (\`artifact_id\`) REFERENCES \`koala_artifact\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT "koala_knowledge_entry_id_check" CHECK(length("id") > 4 AND substr("id", 1, 4) = 'kwe_'),
          CONSTRAINT "koala_knowledge_entry_chunk_index_check" CHECK("chunk_index" >= 0),
          CONSTRAINT "koala_knowledge_entry_locator_json_check" CHECK(json_valid("locator") AND json_type("locator") = 'object')
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`koala_knowledge_term\` (
          \`term\` text NOT NULL,
          \`entry_id\` text NOT NULL,
          \`count\` integer NOT NULL,
          CONSTRAINT \`koala_knowledge_term_pk\` PRIMARY KEY(\`term\`, \`entry_id\`),
          CONSTRAINT \`fk_koala_knowledge_term_entry_id_koala_knowledge_entry_id_fk\` FOREIGN KEY (\`entry_id\`) REFERENCES \`koala_knowledge_entry\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT "koala_knowledge_term_count_check" CHECK("count" > 0),
          CONSTRAINT "koala_knowledge_term_term_check" CHECK(length("term") > 0)
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`koala_knowledge_entry_owner_session_idx\` ON \`koala_knowledge_entry\` (\`owner_session_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`koala_knowledge_entry_artifact_idx\` ON \`koala_knowledge_entry\` (\`artifact_id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`koala_knowledge_term_term_idx\` ON \`koala_knowledge_term\` (\`term\`);`)
      yield* tx.run(`CREATE INDEX \`koala_knowledge_term_entry_idx\` ON \`koala_knowledge_term\` (\`entry_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
