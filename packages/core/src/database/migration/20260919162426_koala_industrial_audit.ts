import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260919162426_koala_industrial_audit",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`koala_tool_audit\` (
          \`id\` text PRIMARY KEY,
          \`state\` text NOT NULL,
          \`tool_name\` text NOT NULL,
          \`permission_class\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`message_id\` text NOT NULL,
          \`tool_call_id\` text NOT NULL,
          \`time_started\` integer NOT NULL,
          \`time_finished\` integer,
          \`duration_ms\` integer,
          \`outcome_code\` text,
          \`cancelled\` integer DEFAULT false NOT NULL,
          \`timed_out\` integer DEFAULT false NOT NULL,
          \`truncated\` integer DEFAULT false NOT NULL,
          \`engine_name\` text NOT NULL,
          \`engine_version\` text NOT NULL,
          \`contract_version\` text NOT NULL,
          \`input_sha256\` text NOT NULL,
          \`input_summary\` text NOT NULL,
          \`source_artifact_ids\` text NOT NULL,
          \`output_artifact_ids\` text NOT NULL,
          \`sandbox_run_id\` text,
          \`route_decision_id\` text,
          \`error_code\` text,
          CONSTRAINT "koala_tool_audit_id_check" CHECK(length("id") BETWEEN 1 AND 128 AND "id" = trim("id")),
          CONSTRAINT "koala_tool_audit_state_check" CHECK("state" IN ('running', 'completed')),
          CONSTRAINT "koala_tool_audit_tool_name_check" CHECK("tool_name" IN ('document_extract', 'ocr_extract', 'vision_analyze', 'knowledge_ingest', 'knowledge_search', 'knowledge_open', 'docx_read', 'docx_create', 'docx_update', 'pptx_read', 'pptx_create', 'pptx_update', 'spreadsheet_read', 'spreadsheet_write', 'spreadsheet_update', 'pdf_read', 'pdf_create', 'pdf_update', 'calculate', 'sandbox_execute', 'sandbox_test', 'artifact_validate')),
          CONSTRAINT "koala_tool_audit_permission_class_check" CHECK("permission_class" IN ('document_read', 'document_write', 'vision_analyze', 'knowledge_read', 'knowledge_write', 'calculate', 'sandbox_execute')),
          CONSTRAINT "koala_tool_audit_context_id_check" CHECK(length("session_id") BETWEEN 1 AND 128 AND "session_id" = trim("session_id") AND length("message_id") BETWEEN 1 AND 128 AND "message_id" = trim("message_id") AND length("tool_call_id") BETWEEN 1 AND 512 AND instr("tool_call_id", char(0)) = 0 AND "tool_call_id" NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || ']*')),
          CONSTRAINT "koala_tool_audit_lifecycle_check" CHECK(("state" = 'running' AND "time_finished" IS NULL AND "duration_ms" IS NULL AND "outcome_code" IS NULL AND "cancelled" = 0 AND "timed_out" = 0 AND "truncated" = 0 AND "error_code" IS NULL) OR ("state" = 'completed' AND "time_finished" IS NOT NULL AND "duration_ms" IS NOT NULL AND "outcome_code" IS NOT NULL)),
          CONSTRAINT "koala_tool_audit_time_check" CHECK("time_started" >= 0 AND ("time_finished" IS NULL OR ("time_finished" >= "time_started" AND "duration_ms" = "time_finished" - "time_started"))),
          CONSTRAINT "koala_tool_audit_flags_check" CHECK("cancelled" IN (0, 1) AND "timed_out" IN (0, 1) AND "truncated" IN (0, 1)),
          CONSTRAINT "koala_tool_audit_engine_check" CHECK(length("engine_name") BETWEEN 1 AND 128 AND "engine_name" = trim("engine_name") AND length("engine_version") BETWEEN 1 AND 128 AND "engine_version" = trim("engine_version") AND length("contract_version") BETWEEN 1 AND 128 AND "contract_version" = trim("contract_version")),
          CONSTRAINT "koala_tool_audit_input_sha256_check" CHECK(length("input_sha256") = 64 AND "input_sha256" NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "koala_tool_audit_input_summary_check" CHECK(length("input_summary") <= 4096 AND json_valid("input_summary") AND json_type("input_summary") = 'object'),
          CONSTRAINT "koala_tool_audit_source_artifact_ids_check" CHECK(length("source_artifact_ids") <= 16384 AND json_valid("source_artifact_ids") AND json_type("source_artifact_ids") = 'array' AND json_array_length("source_artifact_ids") <= 100),
          CONSTRAINT "koala_tool_audit_output_artifact_ids_check" CHECK(length("output_artifact_ids") <= 16384 AND json_valid("output_artifact_ids") AND json_type("output_artifact_ids") = 'array' AND json_array_length("output_artifact_ids") <= 100),
          CONSTRAINT "koala_tool_audit_optional_reference_check" CHECK(("sandbox_run_id" IS NULL OR (length("sandbox_run_id") BETWEEN 1 AND 128 AND "sandbox_run_id" = trim("sandbox_run_id"))) AND ("route_decision_id" IS NULL OR (length("route_decision_id") BETWEEN 1 AND 128 AND "route_decision_id" = trim("route_decision_id")))),
          CONSTRAINT "koala_tool_audit_outcome_code_check" CHECK("outcome_code" IS NULL OR (length("outcome_code") BETWEEN 1 AND 64 AND "outcome_code" NOT GLOB '*[^a-z0-9._-]*')),
          CONSTRAINT "koala_tool_audit_error_code_check" CHECK("error_code" IS NULL OR (length("error_code") BETWEEN 1 AND 64 AND "error_code" NOT GLOB '*[^a-z0-9._-]*'))
        );
      `)
      yield* tx.run(
        `CREATE TEMP TABLE \`__saved_koala_artifact_lineage\` AS SELECT \`artifact_id\`, \`source_artifact_id\`, \`relation\` FROM \`koala_artifact_lineage\`;`,
      )
      yield* tx.run(`DROP TABLE \`koala_artifact_lineage\`;`)
      yield* tx.run(`ALTER TABLE \`koala_artifact\` ADD \`source_project_path\` text;`)
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
          \`source_project_path\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_koala_artifact_digest_koala_artifact_blob_digest_fk\` FOREIGN KEY (\`digest\`) REFERENCES \`koala_artifact_blob\`(\`digest\`),
          CONSTRAINT \`fk_koala_artifact_owner_session_id_session_id_fk\` FOREIGN KEY (\`owner_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_koala_artifact_owner_message_id_message_id_fk\` FOREIGN KEY (\`owner_message_id\`) REFERENCES \`message\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT "koala_artifact_id_check" CHECK(length("id") = 40 AND substr("id", 1, 4) = 'art_' AND substr("id", 13, 1) = '-' AND substr("id", 18, 1) = '-' AND substr("id", 19, 1) = '4' AND substr("id", 23, 1) = '-' AND substr("id", 24, 1) GLOB '[89ab]' AND substr("id", 28, 1) = '-' AND length(replace(substr("id", 5), '-', '')) = 32 AND replace(substr("id", 5), '-', '') NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "koala_artifact_name_check" CHECK(length("name") BETWEEN 1 AND 255),
          CONSTRAINT "koala_artifact_mime_check" CHECK(length("mime") BETWEEN 1 AND 127),
          CONSTRAINT "koala_artifact_source_project_path_check" CHECK("source_project_path" IS NULL OR (length("source_project_path") BETWEEN 1 AND 1024 AND substr("source_project_path", 1, 1) <> '/' AND substr("source_project_path", -1, 1) NOT IN ('/', '.', ' ') AND instr("source_project_path", '\\') = 0 AND instr("source_project_path", ':') = 0 AND instr("source_project_path", '//') = 0 AND instr("source_project_path", char(0)) = 0 AND "source_project_path" NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || ']*') AND "source_project_path" <> '.' AND "source_project_path" <> '..' AND "source_project_path" NOT LIKE './%' AND "source_project_path" NOT LIKE '../%' AND "source_project_path" NOT LIKE '%/./%' AND "source_project_path" NOT LIKE '%/../%' AND "source_project_path" NOT LIKE '%/.' AND "source_project_path" NOT LIKE '%/..' AND "source_project_path" NOT LIKE '%./%' AND "source_project_path" NOT LIKE '% /%' AND lower('/' || "source_project_path" || '/') NOT GLOB '*/con/*' AND lower('/' || "source_project_path" || '/') NOT GLOB '*/con.*/*' AND lower('/' || "source_project_path" || '/') NOT GLOB '*/prn/*' AND lower('/' || "source_project_path" || '/') NOT GLOB '*/prn.*/*' AND lower('/' || "source_project_path" || '/') NOT GLOB '*/aux/*' AND lower('/' || "source_project_path" || '/') NOT GLOB '*/aux.*/*' AND lower('/' || "source_project_path" || '/') NOT GLOB '*/nul/*' AND lower('/' || "source_project_path" || '/') NOT GLOB '*/nul.*/*' AND lower('/' || "source_project_path" || '/') NOT GLOB '*/com[1-9¹²³]/*' AND lower('/' || "source_project_path" || '/') NOT GLOB '*/com[1-9¹²³].*/*' AND lower('/' || "source_project_path" || '/') NOT GLOB '*/lpt[1-9¹²³]/*' AND lower('/' || "source_project_path" || '/') NOT GLOB '*/lpt[1-9¹²³].*/*')),
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
      yield* tx.run(`
        CREATE TABLE \`koala_artifact_lineage\` (
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
        `INSERT INTO \`koala_artifact_lineage\`(\`artifact_id\`, \`source_artifact_id\`, \`relation\`) SELECT \`artifact_id\`, \`source_artifact_id\`, \`relation\` FROM \`__saved_koala_artifact_lineage\`;`,
      )
      yield* tx.run(`DROP TABLE \`__saved_koala_artifact_lineage\`;`)
      yield* tx.run(`PRAGMA foreign_keys=ON;`)
      yield* tx.run(`CREATE INDEX \`koala_artifact_digest_idx\` ON \`koala_artifact\` (\`digest\`);`)
      yield* tx.run(`CREATE INDEX \`koala_artifact_owner_session_idx\` ON \`koala_artifact\` (\`owner_session_id\`);`)
      yield* tx.run(`CREATE INDEX \`koala_artifact_owner_message_idx\` ON \`koala_artifact\` (\`owner_message_id\`);`)
      yield* tx.run(`CREATE INDEX \`koala_artifact_sandbox_run_idx\` ON \`koala_artifact\` (\`sandbox_run_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`koala_artifact_lineage_source_idx\` ON \`koala_artifact_lineage\` (\`source_artifact_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`koala_tool_audit_session_started_idx\` ON \`koala_tool_audit\` (\`session_id\`,\`time_started\`);`,
      )
      yield* tx.run(`CREATE INDEX \`koala_tool_audit_message_idx\` ON \`koala_tool_audit\` (\`message_id\`);`)
      yield* tx.run(`CREATE INDEX \`koala_tool_audit_tool_call_idx\` ON \`koala_tool_audit\` (\`tool_call_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`koala_tool_audit_state_started_idx\` ON \`koala_tool_audit\` (\`state\`,\`time_started\`);`,
      )
      yield* tx.run(`CREATE INDEX \`koala_tool_audit_sandbox_run_idx\` ON \`koala_tool_audit\` (\`sandbox_run_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`koala_tool_audit_route_decision_idx\` ON \`koala_tool_audit\` (\`route_decision_id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
