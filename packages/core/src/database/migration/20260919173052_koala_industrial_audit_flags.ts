import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"
import { ensureIndustrialConstraints } from "../industrial-constraints"

export default {
  id: "20260919173052_koala_industrial_audit_flags",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`koala_tool_audit\` ADD \`producer_truncated\` integer DEFAULT false NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`koala_tool_audit\` ADD \`projection_truncated\` integer DEFAULT false NOT NULL;`)
      yield* tx.run(`PRAGMA foreign_keys=OFF;`)
      yield* tx.run(`
        CREATE TABLE \`__new_koala_tool_audit\` (
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
        `INSERT INTO \`__new_koala_tool_audit\`(\`id\`, \`state\`, \`tool_name\`, \`permission_class\`, \`session_id\`, \`message_id\`, \`tool_call_id\`, \`time_started\`, \`time_finished\`, \`duration_ms\`, \`outcome_code\`, \`cancelled\`, \`timed_out\`, \`producer_truncated\`, \`projection_truncated\`, \`truncated\`, \`engine_name\`, \`engine_version\`, \`contract_version\`, \`input_sha256\`, \`input_summary\`, \`source_artifact_ids\`, \`output_artifact_ids\`, \`sandbox_run_id\`, \`route_decision_id\`, \`error_code\`) SELECT \`id\`, \`state\`, \`tool_name\`, \`permission_class\`, \`session_id\`, \`message_id\`, \`tool_call_id\`, \`time_started\`, \`time_finished\`, \`duration_ms\`, \`outcome_code\`, \`cancelled\`, \`timed_out\`, \`truncated\`, 0, \`truncated\`, \`engine_name\`, \`engine_version\`, \`contract_version\`, \`input_sha256\`, \`input_summary\`, \`source_artifact_ids\`, \`output_artifact_ids\`, \`sandbox_run_id\`, \`route_decision_id\`, CASE WHEN \`error_code\` IS NULL OR \`error_code\` IN ('invalid-input', 'permission-denied', 'source-not-found', 'source-access-denied', 'source-not-owned', 'source-changed', 'source-invalid', 'unsupported-format', 'input-too-large', 'limit-exceeded', 'engine-unavailable', 'engine-failed', 'protocol-error', 'sandbox-nonzero-exit', 'validation-failed', 'sandbox-violation', 'output-truncated', 'artifact-storage-failed', 'audit-unavailable', 'internal-error', 'cancelled', 'deadline-exceeded') THEN \`error_code\` ELSE 'internal-error' END FROM \`koala_tool_audit\`;`,
      )
      yield* tx.run(`DROP TABLE \`koala_tool_audit\`;`)
      yield* tx.run(`ALTER TABLE \`__new_koala_tool_audit\` RENAME TO \`koala_tool_audit\`;`)
      yield* tx.run(`PRAGMA foreign_keys=ON;`)
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
      yield* ensureIndustrialConstraints(tx)
    })
  },
} satisfies DatabaseMigration.Migration
