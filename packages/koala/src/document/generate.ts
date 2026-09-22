export * as DocumentGenerate from "./generate"

import { Schema } from "effect"
import { Artifact } from "../artifact/artifact"
import { IndustrialResult } from "../industrial/result"

export const DocxContent = Schema.Struct({
  title: Schema.optionalKey(Schema.String),
  author: Schema.optionalKey(Schema.String),
  sections: Schema.Array(
    Schema.Struct({
      type: Schema.Literals(["heading", "paragraph", "table", "page-break"]),
      text: Schema.optionalKey(Schema.String),
      level: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
      rows: Schema.optionalKey(Schema.Array(Schema.Array(Schema.String))),
    }),
  ),
}).annotate({ identifier: "DocumentGenerate.DocxContent" })

export const DocxCreate = {
  Input: Schema.Struct({ contents: DocxContent }).annotate({ identifier: "DocumentGenerate.DocxCreate.Input" }),
  Result: IndustrialResult.make("docx_create", Schema.Struct({ artifact: Artifact.Reference })).annotate({
    identifier: "DocumentGenerate.DocxCreate.Result",
  }),
}
