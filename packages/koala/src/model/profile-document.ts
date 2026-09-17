export * as ModelProfileDocument from "./profile-document"

import { Schema } from "effect"
import { ModelProfile } from "./profile"

export const Version = Schema.Literal(1)
export type Version = typeof Version.Type

export interface Document extends Schema.Schema.Type<typeof Document> {}
export const Document = Schema.Struct({
  version: Version,
  profiles: Schema.Array(ModelProfile.Provider),
})
  .check(
    Schema.makeFilter((document) =>
      new Set(document.profiles.map((provider) => provider.id)).size === document.profiles.length
        ? undefined
        : "Provider IDs must be unique within a document",
    ),
  )
  .annotate({ identifier: "ModelProfileDocument.Document" })

export const empty: Document = Object.freeze({
  version: 1,
  profiles: Object.freeze([]),
})
