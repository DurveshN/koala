import { Effect } from "effect"
import type { DatabaseMigration } from "./migration"

export default {
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`workspace\` (
          \`id\` text PRIMARY KEY,
          \`type\` text NOT NULL,
          \`name\` text DEFAULT '' NOT NULL,
          \`branch\` text,
          \`directory\` text,
          \`extra\` text,
          \`project_id\` text NOT NULL,
          \`time_used\` integer NOT NULL,
          CONSTRAINT \`fk_workspace_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`data_migration\` (
          \`name\` text PRIMARY KEY,
          \`time_completed\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`account_state\` (
          \`id\` integer PRIMARY KEY,
          \`active_account_id\` text,
          \`active_org_id\` text,
          CONSTRAINT \`fk_account_state_active_account_id_account_id_fk\` FOREIGN KEY (\`active_account_id\`) REFERENCES \`account\`(\`id\`) ON DELETE SET NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`account\` (
          \`id\` text PRIMARY KEY,
          \`email\` text NOT NULL,
          \`url\` text NOT NULL,
          \`access_token\` text NOT NULL,
          \`refresh_token\` text NOT NULL,
          \`token_expiry\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`control_account\` (
          \`email\` text NOT NULL,
          \`url\` text NOT NULL,
          \`access_token\` text NOT NULL,
          \`refresh_token\` text NOT NULL,
          \`token_expiry\` integer,
          \`active\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`control_account_pk\` PRIMARY KEY(\`email\`, \`url\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`koala_artifact_blob\` (
          \`digest\` text PRIMARY KEY,
          \`size\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT "koala_artifact_blob_digest_check" CHECK(length("digest") = 64 AND "digest" NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "koala_artifact_blob_size_check" CHECK("size" BETWEEN 0 AND 104857600)
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
          CONSTRAINT "koala_artifact_lineage_not_self_check" CHECK("artifact_id" <> "source_artifact_id"),
          CONSTRAINT "koala_artifact_lineage_relation_check" CHECK("relation" = 'derived-from')
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
      yield* tx.run(`
        CREATE TABLE \`credential\` (
          \`id\` text PRIMARY KEY,
          \`integration_id\` text,
          \`label\` text NOT NULL,
          \`value\` text NOT NULL,
          \`connector_id\` text,
          \`method_id\` text,
          \`active\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`event_sequence\` (
          \`aggregate_id\` text PRIMARY KEY,
          \`seq\` integer NOT NULL,
          \`owner_id\` text
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`event\` (
          \`id\` text PRIMARY KEY,
          \`aggregate_id\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`type\` text NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_event_aggregate_id_event_sequence_aggregate_id_fk\` FOREIGN KEY (\`aggregate_id\`) REFERENCES \`event_sequence\`(\`aggregate_id\`) ON DELETE CASCADE
        );
      `)
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
      yield* tx.run(`
        CREATE TABLE \`permission\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`action\` text NOT NULL,
          \`resource\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_permission_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`project_directory\` (
          \`project_id\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`type\` text,
          \`strategy\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`project_directory_pk\` PRIMARY KEY(\`project_id\`, \`directory\`),
          CONSTRAINT \`fk_project_directory_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`project\` (
          \`id\` text PRIMARY KEY,
          \`worktree\` text NOT NULL,
          \`vcs\` text,
          \`name\` text,
          \`icon_url\` text,
          \`icon_url_override\` text,
          \`icon_color\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_initialized\` integer,
          \`sandboxes\` text NOT NULL,
          \`commands\` text
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`message\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_message_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`part\` (
          \`id\` text PRIMARY KEY,
          \`message_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_part_message_id_message_id_fk\` FOREIGN KEY (\`message_id\`) REFERENCES \`message\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_context_epoch\` (
          \`session_id\` text PRIMARY KEY,
          \`baseline\` text NOT NULL,
          \`snapshot\` text NOT NULL,
          \`baseline_seq\` integer NOT NULL,
          CONSTRAINT \`fk_session_context_epoch_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_input\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`prompt\` text NOT NULL,
          \`delivery\` text NOT NULL,
          \`admitted_seq\` integer NOT NULL,
          \`promoted_seq\` integer,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_input_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_message\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`type\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_session_message_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`workspace_id\` text,
          \`parent_id\` text,
          \`slug\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`path\` text,
          \`title\` text NOT NULL,
          \`version\` text NOT NULL,
          \`share_url\` text,
          \`summary_additions\` integer,
          \`summary_deletions\` integer,
          \`summary_files\` integer,
          \`summary_diffs\` text,
          \`metadata\` text,
          \`cost\` real DEFAULT 0 NOT NULL,
          \`tokens_input\` integer DEFAULT 0 NOT NULL,
          \`tokens_output\` integer DEFAULT 0 NOT NULL,
          \`tokens_reasoning\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_read\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_write\` integer DEFAULT 0 NOT NULL,
          \`revert\` text,
          \`permission\` text,
          \`agent\` text,
          \`model\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_compacting\` integer,
          \`time_archived\` integer,
          CONSTRAINT \`fk_session_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`todo\` (
          \`session_id\` text NOT NULL,
          \`content\` text NOT NULL,
          \`status\` text NOT NULL,
          \`priority\` text NOT NULL,
          \`position\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`todo_pk\` PRIMARY KEY(\`session_id\`, \`position\`),
          CONSTRAINT \`fk_todo_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_share\` (
          \`session_id\` text PRIMARY KEY,
          \`id\` text NOT NULL,
          \`secret\` text NOT NULL,
          \`url\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_session_share_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
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
          \`producer_truncated\` integer DEFAULT false NOT NULL,
          \`projection_truncated\` integer DEFAULT false NOT NULL,
          \`truncated\` integer DEFAULT false NOT NULL,
          \`engine_name\` text NOT NULL,
          \`engine_version\` text NOT NULL,
          \`contract_version\` integer NOT NULL,
          \`input_sha256\` text NOT NULL,
          \`input_summary\` text NOT NULL,
          \`source_artifact_ids\` text NOT NULL,
          \`output_artifact_ids\` text NOT NULL,
          \`sandbox_run_id\` text,
          \`route_decision_id\` text,
          \`error_code\` text,
          CONSTRAINT "koala_tool_audit_id_check" CHECK(length("id") = 40 AND substr("id", 1, 4) = 'aud_' AND substr("id", 13, 1) = '-' AND substr("id", 18, 1) = '-' AND substr("id", 19, 1) = '4' AND substr("id", 23, 1) = '-' AND substr("id", 24, 1) GLOB '[89ab]' AND substr("id", 28, 1) = '-' AND length(replace(substr("id", 5), '-', '')) = 32 AND replace(substr("id", 5), '-', '') NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "koala_tool_audit_state_check" CHECK("state" IN ('running', 'completed')),
          CONSTRAINT "koala_tool_audit_tool_name_check" CHECK("tool_name" IN ('document_extract', 'ocr_extract', 'vision_analyze', 'knowledge_ingest', 'knowledge_search', 'knowledge_open', 'docx_read', 'docx_create', 'docx_update', 'pptx_read', 'pptx_create', 'pptx_update', 'spreadsheet_read', 'spreadsheet_write', 'spreadsheet_update', 'pdf_read', 'pdf_create', 'pdf_update', 'calculate', 'sandbox_execute', 'sandbox_test', 'artifact_validate')),
          CONSTRAINT "koala_tool_audit_permission_class_check" CHECK("permission_class" IN ('document_read', 'document_write', 'vision_analyze', 'knowledge_read', 'knowledge_write', 'calculate', 'sandbox_execute')),
          CONSTRAINT "koala_tool_audit_tool_permission_check" CHECK("permission_class" = CASE "tool_name" WHEN 'document_extract' THEN 'document_read' WHEN 'ocr_extract' THEN 'document_read' WHEN 'vision_analyze' THEN 'vision_analyze' WHEN 'knowledge_ingest' THEN 'knowledge_write' WHEN 'knowledge_search' THEN 'knowledge_read' WHEN 'knowledge_open' THEN 'knowledge_read' WHEN 'docx_read' THEN 'document_read' WHEN 'docx_create' THEN 'document_write' WHEN 'docx_update' THEN 'document_write' WHEN 'pptx_read' THEN 'document_read' WHEN 'pptx_create' THEN 'document_write' WHEN 'pptx_update' THEN 'document_write' WHEN 'spreadsheet_read' THEN 'document_read' WHEN 'spreadsheet_write' THEN 'document_write' WHEN 'spreadsheet_update' THEN 'document_write' WHEN 'pdf_read' THEN 'document_read' WHEN 'pdf_create' THEN 'document_write' WHEN 'pdf_update' THEN 'document_write' WHEN 'calculate' THEN 'calculate' WHEN 'sandbox_execute' THEN 'sandbox_execute' WHEN 'sandbox_test' THEN 'sandbox_execute' WHEN 'artifact_validate' THEN 'document_read' END),
          CONSTRAINT "koala_tool_audit_context_id_check" CHECK(length("session_id") BETWEEN 1 AND 128 AND "session_id" = trim("session_id") AND length("message_id") BETWEEN 1 AND 128 AND "message_id" = trim("message_id") AND length("tool_call_id") BETWEEN 1 AND 512 AND instr("tool_call_id", char(0)) = 0 AND "tool_call_id" NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || ']*')),
          CONSTRAINT "koala_tool_audit_lifecycle_check" CHECK(("state" = 'running' AND "time_finished" IS NULL AND "duration_ms" IS NULL AND "outcome_code" IS NULL AND "cancelled" = 0 AND "timed_out" = 0 AND "producer_truncated" = 0 AND "projection_truncated" = 0 AND "truncated" = 0 AND "error_code" IS NULL AND json_array_length("output_artifact_ids") = 0) OR ("state" = 'completed' AND "time_finished" IS NOT NULL AND "duration_ms" IS NOT NULL AND "outcome_code" IS NOT NULL)),
          CONSTRAINT "koala_tool_audit_time_check" CHECK("time_started" >= 0 AND ("time_finished" IS NULL OR ("time_finished" >= "time_started" AND "duration_ms" = "time_finished" - "time_started"))),
          CONSTRAINT "koala_tool_audit_flags_check" CHECK("cancelled" IN (0, 1) AND "timed_out" IN (0, 1) AND "producer_truncated" IN (0, 1) AND "projection_truncated" IN (0, 1) AND "truncated" IN (0, 1) AND "truncated" = ("producer_truncated" OR "projection_truncated")),
          CONSTRAINT "koala_tool_audit_engine_check" CHECK(length("engine_name") BETWEEN 1 AND 128 AND "engine_name" = trim("engine_name") AND length("engine_version") BETWEEN 1 AND 128 AND "engine_version" = trim("engine_version") AND "contract_version" = 1),
          CONSTRAINT "koala_tool_audit_input_sha256_check" CHECK(length("input_sha256") = 64 AND "input_sha256" NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "koala_tool_audit_input_summary_check" CHECK(length("input_summary") <= 4096 AND json_valid("input_summary") AND json_type("input_summary") = 'object'),
          CONSTRAINT "koala_tool_audit_source_artifact_ids_check" CHECK(length("source_artifact_ids") <= 16384 AND json_valid("source_artifact_ids") AND json_type("source_artifact_ids") = 'array' AND json_array_length("source_artifact_ids") <= 100),
          CONSTRAINT "koala_tool_audit_output_artifact_ids_check" CHECK(length("output_artifact_ids") <= 4096 AND json_valid("output_artifact_ids") AND json_type("output_artifact_ids") = 'array' AND json_array_length("output_artifact_ids") <= 10),
          CONSTRAINT "koala_tool_audit_optional_reference_check" CHECK(("sandbox_run_id" IS NULL OR (length("sandbox_run_id") BETWEEN 1 AND 128 AND "sandbox_run_id" = trim("sandbox_run_id"))) AND ("route_decision_id" IS NULL OR (length("route_decision_id") BETWEEN 1 AND 128 AND "route_decision_id" = trim("route_decision_id")))),
          CONSTRAINT "koala_tool_audit_outcome_code_check" CHECK("outcome_code" IS NULL OR "outcome_code" IN ('success', 'error', 'cancelled', 'timeout')),
          CONSTRAINT "koala_tool_audit_terminal_consistency_check" CHECK("state" = 'running' OR ("outcome_code" = 'success' AND "cancelled" = 0 AND "timed_out" = 0 AND "error_code" IS NULL) OR ("outcome_code" = 'error' AND "cancelled" = 0 AND "timed_out" = 0 AND "error_code" IS NOT NULL) OR ("outcome_code" = 'cancelled' AND "cancelled" = 1 AND "timed_out" = 0 AND "error_code" = 'cancelled') OR ("outcome_code" = 'timeout' AND "cancelled" = 0 AND "timed_out" = 1 AND "error_code" = 'deadline-exceeded')),
          CONSTRAINT "koala_tool_audit_error_code_check" CHECK("error_code" IS NULL OR "error_code" IN ('invalid-input', 'permission-denied', 'source-not-found', 'source-access-denied', 'source-not-owned', 'source-changed', 'source-invalid', 'unsupported-format', 'input-too-large', 'limit-exceeded', 'engine-unavailable', 'engine-failed', 'protocol-error', 'sandbox-nonzero-exit', 'validation-failed', 'sandbox-violation', 'output-truncated', 'artifact-storage-failed', 'audit-unavailable', 'internal-error', 'cancelled', 'deadline-exceeded'))
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`koala_artifact_lineage_source_idx\` ON \`koala_artifact_lineage\` (\`source_artifact_id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`koala_artifact_digest_idx\` ON \`koala_artifact\` (\`digest\`);`)
      yield* tx.run(`CREATE INDEX \`koala_artifact_owner_session_idx\` ON \`koala_artifact\` (\`owner_session_id\`);`)
      yield* tx.run(`CREATE INDEX \`koala_artifact_owner_message_idx\` ON \`koala_artifact\` (\`owner_message_id\`);`)
      yield* tx.run(`CREATE INDEX \`koala_artifact_sandbox_run_idx\` ON \`koala_artifact\` (\`sandbox_run_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`event_aggregate_seq_idx\` ON \`event\` (\`aggregate_id\`,\`seq\`);`)
      yield* tx.run(`CREATE INDEX \`event_aggregate_type_seq_idx\` ON \`event\` (\`aggregate_id\`,\`type\`,\`seq\`);`)
      yield* tx.run(
        `CREATE INDEX \`koala_knowledge_entry_owner_session_idx\` ON \`koala_knowledge_entry\` (\`owner_session_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`koala_knowledge_entry_artifact_idx\` ON \`koala_knowledge_entry\` (\`artifact_id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`koala_knowledge_term_term_idx\` ON \`koala_knowledge_term\` (\`term\`);`)
      yield* tx.run(`CREATE INDEX \`koala_knowledge_term_entry_idx\` ON \`koala_knowledge_term\` (\`entry_id\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`permission_project_action_resource_idx\` ON \`permission\` (\`project_id\`,\`action\`,\`resource\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`message_session_time_created_id_idx\` ON \`message\` (\`session_id\`,\`time_created\`,\`id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`part_message_id_id_idx\` ON \`part\` (\`message_id\`,\`id\`);`)
      yield* tx.run(`CREATE INDEX \`part_session_idx\` ON \`part\` (\`session_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`session_input_session_pending_delivery_seq_idx\` ON \`session_input\` (\`session_id\`,\`promoted_seq\`,\`delivery\`,\`admitted_seq\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_input_session_admitted_seq_idx\` ON \`session_input\` (\`session_id\`,\`admitted_seq\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_input_session_promoted_seq_idx\` ON \`session_input\` (\`session_id\`,\`promoted_seq\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_message_session_seq_idx\` ON \`session_message\` (\`session_id\`,\`seq\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_message_session_type_seq_idx\` ON \`session_message\` (\`session_id\`,\`type\`,\`seq\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_message_session_time_created_id_idx\` ON \`session_message\` (\`session_id\`,\`time_created\`,\`id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`session_message_time_created_idx\` ON \`session_message\` (\`time_created\`);`)
      yield* tx.run(`CREATE INDEX \`session_project_idx\` ON \`session\` (\`project_id\`);`)
      yield* tx.run(`CREATE INDEX \`session_workspace_idx\` ON \`session\` (\`workspace_id\`);`)
      yield* tx.run(`CREATE INDEX \`session_parent_idx\` ON \`session\` (\`parent_id\`);`)
      yield* tx.run(`CREATE INDEX \`todo_session_idx\` ON \`todo\` (\`session_id\`);`)
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
} satisfies Omit<DatabaseMigration.Migration, "id">
