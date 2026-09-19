import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260919125324_koala_artifact_store",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`koala_artifact_blob\` (
          \`digest\` text PRIMARY KEY,
          \`size\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT "koala_artifact_blob_digest_check" CHECK(length("digest") = 64 AND "digest" NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "koala_artifact_blob_size_check" CHECK("size" >= 0)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`koala_artifact_lineage\` (
          \`artifact_id\` text NOT NULL,
          \`source_artifact_id\` text NOT NULL,
          \`relation\` text NOT NULL,
          CONSTRAINT \`koala_artifact_lineage_pk\` PRIMARY KEY(\`artifact_id\`, \`source_artifact_id\`, \`relation\`),
          CONSTRAINT \`fk_koala_artifact_lineage_artifact_id_koala_artifact_id_fk\` FOREIGN KEY (\`artifact_id\`) REFERENCES \`koala_artifact\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_koala_artifact_lineage_source_artifact_id_koala_artifact_id_fk\` FOREIGN KEY (\`source_artifact_id\`) REFERENCES \`koala_artifact\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT "koala_artifact_lineage_not_self_check" CHECK("artifact_id" <> "source_artifact_id")
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`koala_artifact\` (
          \`id\` text PRIMARY KEY,
          \`digest\` text NOT NULL,
          \`name\` text NOT NULL,
          \`mime\` text NOT NULL,
          \`validation_state\` text NOT NULL,
          \`validator\` text NOT NULL,
          \`validator_version\` text NOT NULL,
          \`validation\` text NOT NULL,
          \`owner_session_id\` text NOT NULL,
          \`owner_message_id\` text NOT NULL,
          \`tool_name\` text NOT NULL,
          \`tool_call_id\` text,
          \`sandbox_run_id\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_koala_artifact_digest_koala_artifact_blob_digest_fk\` FOREIGN KEY (\`digest\`) REFERENCES \`koala_artifact_blob\`(\`digest\`),
          CONSTRAINT \`fk_koala_artifact_owner_session_id_session_id_fk\` FOREIGN KEY (\`owner_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_koala_artifact_owner_message_id_message_id_fk\` FOREIGN KEY (\`owner_message_id\`) REFERENCES \`message\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT "koala_artifact_validation_state_check" CHECK("validation_state" IN ('accepted', 'rejected')),
          CONSTRAINT "koala_artifact_validation_json_check" CHECK(json_valid("validation"))
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`koala_artifact_lineage_source_idx\` ON \`koala_artifact_lineage\` (\`source_artifact_id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`koala_artifact_digest_idx\` ON \`koala_artifact\` (\`digest\`);`)
      yield* tx.run(`CREATE INDEX \`koala_artifact_owner_session_idx\` ON \`koala_artifact\` (\`owner_session_id\`);`)
      yield* tx.run(`CREATE INDEX \`koala_artifact_owner_message_idx\` ON \`koala_artifact\` (\`owner_message_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
