import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260919133950_koala_artifact_constraints",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`PRAGMA foreign_keys=OFF;`)
      yield* tx.run(`
        CREATE TABLE \`__new_koala_artifact_lineage\` (
          \`artifact_id\` text NOT NULL,
          \`source_artifact_id\` text NOT NULL,
          \`relation\` text NOT NULL,
          CONSTRAINT \`koala_artifact_lineage_pk\` PRIMARY KEY(\`artifact_id\`, \`source_artifact_id\`, \`relation\`),
          CONSTRAINT \`fk_koala_artifact_lineage_artifact_id_koala_artifact_id_fk\` FOREIGN KEY (\`artifact_id\`) REFERENCES \`koala_artifact\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_koala_artifact_lineage_source_artifact_id_koala_artifact_id_fk\` FOREIGN KEY (\`source_artifact_id\`) REFERENCES \`koala_artifact\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT "koala_artifact_lineage_not_self_check" CHECK("artifact_id" <> "source_artifact_id"),
          CONSTRAINT "koala_artifact_lineage_relation_check" CHECK("relation" = 'derived-from')
        );
      `)
      yield* tx.run(
        `INSERT INTO \`__new_koala_artifact_lineage\`(\`artifact_id\`, \`source_artifact_id\`, \`relation\`) SELECT \`artifact_id\`, \`source_artifact_id\`, \`relation\` FROM \`koala_artifact_lineage\`;`,
      )
      yield* tx.run(`DROP TABLE \`koala_artifact_lineage\`;`)
      yield* tx.run(`ALTER TABLE \`__new_koala_artifact_lineage\` RENAME TO \`koala_artifact_lineage\`;`)
      yield* tx.run(`PRAGMA foreign_keys=ON;`)
      yield* tx.run(`PRAGMA foreign_keys=OFF;`)
      yield* tx.run(`
        CREATE TABLE \`__new_koala_artifact\` (
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
          CONSTRAINT "koala_artifact_id_check" CHECK(length("id") = 40 AND substr("id", 1, 4) = 'art_' AND substr("id", 13, 1) = '-' AND substr("id", 18, 1) = '-' AND substr("id", 19, 1) = '4' AND substr("id", 23, 1) = '-' AND substr("id", 24, 1) GLOB '[89ab]' AND substr("id", 28, 1) = '-' AND length(replace(substr("id", 5), '-', '')) = 32 AND replace(substr("id", 5), '-', '') NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "koala_artifact_name_check" CHECK(length("name") BETWEEN 1 AND 255),
          CONSTRAINT "koala_artifact_mime_check" CHECK(length("mime") BETWEEN 1 AND 127),
          CONSTRAINT "koala_artifact_validation_state_check" CHECK("validation_state" IN ('accepted', 'rejected')),
          CONSTRAINT "koala_artifact_validation_json_check" CHECK(json_valid("validation") AND json_type("validation") = 'object'),
          CONSTRAINT "koala_artifact_validation_scalar_check" CHECK(json_type("validation", '$.state') IS 'text' AND json_extract("validation", '$.state') IS "validation_state" AND json_type("validation", '$.validator') IS 'text' AND json_extract("validation", '$.validator') IS "validator" AND json_type("validation", '$.validatorVersion') IS 'text' AND json_extract("validation", '$.validatorVersion') IS "validator_version")
        );
      `)
      yield* tx.run(
        `INSERT INTO \`__new_koala_artifact\`(\`id\`, \`digest\`, \`name\`, \`mime\`, \`validation_state\`, \`validator\`, \`validator_version\`, \`validation\`, \`owner_session_id\`, \`owner_message_id\`, \`tool_name\`, \`tool_call_id\`, \`sandbox_run_id\`, \`time_created\`) SELECT \`id\`, \`digest\`, \`name\`, \`mime\`, \`validation_state\`, \`validator\`, \`validator_version\`, \`validation\`, \`owner_session_id\`, \`owner_message_id\`, \`tool_name\`, \`tool_call_id\`, \`sandbox_run_id\`, \`time_created\` FROM \`koala_artifact\`;`,
      )
      yield* tx.run(`DROP TABLE \`koala_artifact\`;`)
      yield* tx.run(`ALTER TABLE \`__new_koala_artifact\` RENAME TO \`koala_artifact\`;`)
      yield* tx.run(`PRAGMA foreign_keys=ON;`)
      yield* tx.run(`PRAGMA foreign_keys=OFF;`)
      yield* tx.run(`
        CREATE TABLE \`__new_koala_artifact_blob\` (
          \`digest\` text PRIMARY KEY,
          \`size\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT "koala_artifact_blob_digest_check" CHECK(length("digest") = 64 AND "digest" NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "koala_artifact_blob_size_check" CHECK("size" BETWEEN 0 AND 104857600)
        );
      `)
      yield* tx.run(
        `INSERT INTO \`__new_koala_artifact_blob\`(\`digest\`, \`size\`, \`time_created\`) SELECT \`digest\`, \`size\`, \`time_created\` FROM \`koala_artifact_blob\`;`,
      )
      yield* tx.run(`DROP TABLE \`koala_artifact_blob\`;`)
      yield* tx.run(`ALTER TABLE \`__new_koala_artifact_blob\` RENAME TO \`koala_artifact_blob\`;`)
      yield* tx.run(`PRAGMA foreign_keys=ON;`)
      yield* tx.run(
        `CREATE INDEX \`koala_artifact_lineage_source_idx\` ON \`koala_artifact_lineage\` (\`source_artifact_id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`koala_artifact_digest_idx\` ON \`koala_artifact\` (\`digest\`);`)
      yield* tx.run(`CREATE INDEX \`koala_artifact_owner_session_idx\` ON \`koala_artifact\` (\`owner_session_id\`);`)
      yield* tx.run(`CREATE INDEX \`koala_artifact_owner_message_idx\` ON \`koala_artifact\` (\`owner_message_id\`);`)
      yield* tx.run(`CREATE INDEX \`koala_artifact_sandbox_run_idx\` ON \`koala_artifact\` (\`sandbox_run_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
