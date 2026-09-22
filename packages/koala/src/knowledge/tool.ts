export * as Knowledge from "./tool"

import { Schema } from "effect"
import { Artifact } from "../artifact/artifact"
import { IndustrialCitation } from "../industrial/citation"
import { IndustrialResult } from "../industrial/result"

export const KnowledgeEntryID = Schema.String.pipe(Schema.brand("KnowledgeEntryID"))
export type KnowledgeEntryID = typeof KnowledgeEntryID.Type

export const KnowledgeIngest = {
  Input: Schema.Struct({
    source: Artifact.ID,
    indexProfileID: Schema.optionalKey(Schema.String),
    extractorVersion: Schema.optionalKey(Schema.String),
    chunkerVersion: Schema.optionalKey(Schema.String),
  }).annotate({ identifier: "Knowledge.Ingest.Input" }),
  Result: IndustrialResult.make(
    "knowledge_ingest",
    Schema.Struct({
      entries: Schema.Int,
    }).annotate({ identifier: "Knowledge.Ingest.Data" }),
  ),
}
export type KnowledgeIngestInput = typeof KnowledgeIngest.Input.Type
export type KnowledgeIngestResult = typeof KnowledgeIngest.Result.Type

export const KnowledgeSearch = {
  Input: Schema.Struct({
    query: Schema.String,
    limit: Schema.optionalKey(Schema.Int),
  }).annotate({ identifier: "Knowledge.Search.Input" }),
  Result: IndustrialResult.make(
    "knowledge_search",
    Schema.Struct({
      results: Schema.Array(
        Schema.Struct({
          entryID: KnowledgeEntryID,
          text: Schema.String,
          score: Schema.Number,
          locator: IndustrialCitation.Locator,
        }).annotate({ identifier: "Knowledge.Search.Result" }),
      ),
    }).annotate({ identifier: "Knowledge.Search.Data" }),
  ),
}
export type KnowledgeSearchInput = typeof KnowledgeSearch.Input.Type
export type KnowledgeSearchResult = typeof KnowledgeSearch.Result.Type

export const KnowledgeOpen = {
  Input: Schema.Struct({
    entryID: KnowledgeEntryID,
  }).annotate({ identifier: "Knowledge.Open.Input" }),
  Result: IndustrialResult.make(
    "knowledge_open",
    Schema.Struct({
      entryID: KnowledgeEntryID,
      text: Schema.String,
      locator: IndustrialCitation.Locator,
    }).annotate({ identifier: "Knowledge.Open.Data" }),
  ),
}
export type KnowledgeOpenInput = typeof KnowledgeOpen.Input.Type
export type KnowledgeOpenResult = typeof KnowledgeOpen.Result.Type
