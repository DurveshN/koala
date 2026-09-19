export * as IndustrialTool from "./tool"

import { Schema } from "effect"

export const ApprovedNames = [
  "document_extract",
  "ocr_extract",
  "vision_analyze",
  "knowledge_ingest",
  "knowledge_search",
  "knowledge_open",
  "docx_read",
  "docx_create",
  "docx_update",
  "pptx_read",
  "pptx_create",
  "pptx_update",
  "spreadsheet_read",
  "spreadsheet_write",
  "spreadsheet_update",
  "pdf_read",
  "pdf_create",
  "pdf_update",
  "calculate",
  "sandbox_execute",
  "sandbox_test",
  "artifact_validate",
] as const

export const Name = Schema.Literals(ApprovedNames)
export type Name = typeof Name.Type

export const Permission = Schema.Literals([
  "document_read",
  "document_write",
  "vision_analyze",
  "knowledge_read",
  "knowledge_write",
  "calculate",
  "sandbox_execute",
])
export type Permission = typeof Permission.Type

export const PermissionByName = {
  document_extract: "document_read",
  ocr_extract: "document_read",
  vision_analyze: "vision_analyze",
  knowledge_ingest: "knowledge_write",
  knowledge_search: "knowledge_read",
  knowledge_open: "knowledge_read",
  docx_read: "document_read",
  docx_create: "document_write",
  docx_update: "document_write",
  pptx_read: "document_read",
  pptx_create: "document_write",
  pptx_update: "document_write",
  spreadsheet_read: "document_read",
  spreadsheet_write: "document_write",
  spreadsheet_update: "document_write",
  pdf_read: "document_read",
  pdf_create: "document_write",
  pdf_update: "document_write",
  calculate: "calculate",
  sandbox_execute: "sandbox_execute",
  sandbox_test: "sandbox_execute",
  artifact_validate: "document_read",
} as const satisfies Record<Name, Permission>

export const ContractVersion = Schema.Literal(1)
export type ContractVersion = typeof ContractVersion.Type

const EngineIdentifier = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,127}$/i),
).pipe(Schema.brand("IndustrialTool.EngineIdentifier"))

export interface Engine extends Schema.Schema.Type<typeof Engine> {}
export const Engine = Schema.Struct({
  name: EngineIdentifier,
  version: EngineIdentifier,
}).annotate({ identifier: "IndustrialTool.Engine" })

export function permission(name: Name): Permission {
  return PermissionByName[name]
}
