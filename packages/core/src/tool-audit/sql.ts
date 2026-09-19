import { sql } from "drizzle-orm"
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const ToolAuditTable = sqliteTable(
  "koala_tool_audit",
  {
    id: text().primaryKey(),
    state: text().notNull(),
    tool_name: text().notNull(),
    permission_class: text().notNull(),
    session_id: text().notNull(),
    message_id: text().notNull(),
    tool_call_id: text().notNull(),
    time_started: integer().notNull(),
    time_finished: integer(),
    duration_ms: integer(),
    outcome_code: text(),
    cancelled: integer({ mode: "boolean" }).notNull().default(false),
    timed_out: integer({ mode: "boolean" }).notNull().default(false),
    producer_truncated: integer({ mode: "boolean" }).notNull().default(false),
    projection_truncated: integer({ mode: "boolean" }).notNull().default(false),
    truncated: integer({ mode: "boolean" }).notNull().default(false),
    engine_name: text().notNull(),
    engine_version: text().notNull(),
    contract_version: integer().notNull(),
    input_sha256: text().notNull(),
    input_summary: text({ mode: "json" }).notNull().$type<Record<string, unknown>>(),
    source_artifact_ids: text({ mode: "json" }).notNull().$type<string[]>(),
    output_artifact_ids: text({ mode: "json" }).notNull().$type<string[]>(),
    sandbox_run_id: text(),
    route_decision_id: text(),
    error_code: text(),
  },
  (table) => [
    check(
      "koala_tool_audit_id_check",
      sql`length(${table.id}) = 40 AND substr(${table.id}, 1, 4) = 'aud_' AND substr(${table.id}, 13, 1) = '-' AND substr(${table.id}, 18, 1) = '-' AND substr(${table.id}, 19, 1) = '4' AND substr(${table.id}, 23, 1) = '-' AND substr(${table.id}, 24, 1) GLOB '[89ab]' AND substr(${table.id}, 28, 1) = '-' AND length(replace(substr(${table.id}, 5), '-', '')) = 32 AND replace(substr(${table.id}, 5), '-', '') NOT GLOB '*[^0-9a-f]*'`,
    ),
    check("koala_tool_audit_state_check", sql`${table.state} IN ('running', 'completed')`),
    check(
      "koala_tool_audit_tool_name_check",
      sql`${table.tool_name} IN ('document_extract', 'ocr_extract', 'vision_analyze', 'knowledge_ingest', 'knowledge_search', 'knowledge_open', 'docx_read', 'docx_create', 'docx_update', 'pptx_read', 'pptx_create', 'pptx_update', 'spreadsheet_read', 'spreadsheet_write', 'spreadsheet_update', 'pdf_read', 'pdf_create', 'pdf_update', 'calculate', 'sandbox_execute', 'sandbox_test', 'artifact_validate')`,
    ),
    check(
      "koala_tool_audit_permission_class_check",
      sql`${table.permission_class} IN ('document_read', 'document_write', 'vision_analyze', 'knowledge_read', 'knowledge_write', 'calculate', 'sandbox_execute')`,
    ),
    check(
      "koala_tool_audit_tool_permission_check",
      sql`${table.permission_class} = CASE ${table.tool_name} WHEN 'document_extract' THEN 'document_read' WHEN 'ocr_extract' THEN 'document_read' WHEN 'vision_analyze' THEN 'vision_analyze' WHEN 'knowledge_ingest' THEN 'knowledge_write' WHEN 'knowledge_search' THEN 'knowledge_read' WHEN 'knowledge_open' THEN 'knowledge_read' WHEN 'docx_read' THEN 'document_read' WHEN 'docx_create' THEN 'document_write' WHEN 'docx_update' THEN 'document_write' WHEN 'pptx_read' THEN 'document_read' WHEN 'pptx_create' THEN 'document_write' WHEN 'pptx_update' THEN 'document_write' WHEN 'spreadsheet_read' THEN 'document_read' WHEN 'spreadsheet_write' THEN 'document_write' WHEN 'spreadsheet_update' THEN 'document_write' WHEN 'pdf_read' THEN 'document_read' WHEN 'pdf_create' THEN 'document_write' WHEN 'pdf_update' THEN 'document_write' WHEN 'calculate' THEN 'calculate' WHEN 'sandbox_execute' THEN 'sandbox_execute' WHEN 'sandbox_test' THEN 'sandbox_execute' WHEN 'artifact_validate' THEN 'document_read' END`,
    ),
    check(
      "koala_tool_audit_context_id_check",
      sql`length(${table.session_id}) BETWEEN 1 AND 128 AND ${table.session_id} = trim(${table.session_id}) AND length(${table.message_id}) BETWEEN 1 AND 128 AND ${table.message_id} = trim(${table.message_id}) AND length(${table.tool_call_id}) BETWEEN 1 AND 512 AND instr(${table.tool_call_id}, char(0)) = 0 AND ${table.tool_call_id} NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || ']*')`,
    ),
    check(
      "koala_tool_audit_lifecycle_check",
      sql`(${table.state} = 'running' AND ${table.time_finished} IS NULL AND ${table.duration_ms} IS NULL AND ${table.outcome_code} IS NULL AND ${table.cancelled} = 0 AND ${table.timed_out} = 0 AND ${table.producer_truncated} = 0 AND ${table.projection_truncated} = 0 AND ${table.truncated} = 0 AND ${table.error_code} IS NULL AND json_array_length(${table.output_artifact_ids}) = 0) OR (${table.state} = 'completed' AND ${table.time_finished} IS NOT NULL AND ${table.duration_ms} IS NOT NULL AND ${table.outcome_code} IS NOT NULL)`,
    ),
    check(
      "koala_tool_audit_time_check",
      sql`${table.time_started} >= 0 AND (${table.time_finished} IS NULL OR (${table.time_finished} >= ${table.time_started} AND ${table.duration_ms} = ${table.time_finished} - ${table.time_started}))`,
    ),
    check(
      "koala_tool_audit_flags_check",
      sql`${table.cancelled} IN (0, 1) AND ${table.timed_out} IN (0, 1) AND ${table.producer_truncated} IN (0, 1) AND ${table.projection_truncated} IN (0, 1) AND ${table.truncated} IN (0, 1) AND ${table.truncated} = (${table.producer_truncated} OR ${table.projection_truncated})`,
    ),
    check(
      "koala_tool_audit_engine_check",
      sql`length(${table.engine_name}) BETWEEN 1 AND 128 AND ${table.engine_name} = trim(${table.engine_name}) AND length(${table.engine_version}) BETWEEN 1 AND 128 AND ${table.engine_version} = trim(${table.engine_version}) AND ${table.contract_version} = 1`,
    ),
    check(
      "koala_tool_audit_input_sha256_check",
      sql`length(${table.input_sha256}) = 64 AND ${table.input_sha256} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check(
      "koala_tool_audit_input_summary_check",
      sql`length(${table.input_summary}) <= 4096 AND json_valid(${table.input_summary}) AND json_type(${table.input_summary}) = 'object'`,
    ),
    check(
      "koala_tool_audit_source_artifact_ids_check",
      sql`length(${table.source_artifact_ids}) <= 16384 AND json_valid(${table.source_artifact_ids}) AND json_type(${table.source_artifact_ids}) = 'array' AND json_array_length(${table.source_artifact_ids}) <= 100`,
    ),
    check(
      "koala_tool_audit_output_artifact_ids_check",
      sql`length(${table.output_artifact_ids}) <= 4096 AND json_valid(${table.output_artifact_ids}) AND json_type(${table.output_artifact_ids}) = 'array' AND json_array_length(${table.output_artifact_ids}) <= 10`,
    ),
    check(
      "koala_tool_audit_optional_reference_check",
      sql`(${table.sandbox_run_id} IS NULL OR (length(${table.sandbox_run_id}) BETWEEN 1 AND 128 AND ${table.sandbox_run_id} = trim(${table.sandbox_run_id}))) AND (${table.route_decision_id} IS NULL OR (length(${table.route_decision_id}) BETWEEN 1 AND 128 AND ${table.route_decision_id} = trim(${table.route_decision_id})))`,
    ),
    check(
      "koala_tool_audit_outcome_code_check",
      sql`${table.outcome_code} IS NULL OR ${table.outcome_code} IN ('success', 'error', 'cancelled', 'timeout')`,
    ),
    check(
      "koala_tool_audit_terminal_consistency_check",
      sql`${table.state} = 'running' OR (${table.outcome_code} = 'success' AND ${table.cancelled} = 0 AND ${table.timed_out} = 0 AND ${table.error_code} IS NULL) OR (${table.outcome_code} = 'error' AND ${table.cancelled} = 0 AND ${table.timed_out} = 0 AND ${table.error_code} IS NOT NULL) OR (${table.outcome_code} = 'cancelled' AND ${table.cancelled} = 1 AND ${table.timed_out} = 0 AND ${table.error_code} = 'cancelled') OR (${table.outcome_code} = 'timeout' AND ${table.cancelled} = 0 AND ${table.timed_out} = 1 AND ${table.error_code} = 'deadline-exceeded')`,
    ),
    check(
      "koala_tool_audit_error_code_check",
      sql`${table.error_code} IS NULL OR ${table.error_code} IN ('invalid-input', 'permission-denied', 'source-not-found', 'source-access-denied', 'source-not-owned', 'source-changed', 'source-invalid', 'unsupported-format', 'input-too-large', 'limit-exceeded', 'engine-unavailable', 'engine-failed', 'protocol-error', 'sandbox-nonzero-exit', 'validation-failed', 'sandbox-violation', 'output-truncated', 'artifact-storage-failed', 'audit-unavailable', 'internal-error', 'cancelled', 'deadline-exceeded')`,
    ),
    index("koala_tool_audit_session_started_idx").on(table.session_id, table.time_started),
    index("koala_tool_audit_message_idx").on(table.message_id),
    index("koala_tool_audit_tool_call_idx").on(table.tool_call_id),
    index("koala_tool_audit_state_started_idx").on(table.state, table.time_started),
    index("koala_tool_audit_sandbox_run_idx").on(table.sandbox_run_id),
    index("koala_tool_audit_route_decision_idx").on(table.route_decision_id),
  ],
)
