import { randomUUID } from "node:crypto"
import { Artifact } from "@koala-ai/core/artifact/artifact"
import { DocumentNormalized } from "@koala-ai/core/document/normalized"
import { IndustrialCitation } from "@koala-ai/core/industrial/citation"
import { Knowledge } from "@koala-ai/core/knowledge/tool"
import { KnowledgeEntryTable, KnowledgeTermTable } from "@opencode-ai/core/knowledge/sql"
import { Database } from "@opencode-ai/core/database/database"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { SessionID } from "@/session/schema"
import { and, eq, sql } from "drizzle-orm"
import { Context, Effect, Layer, Option, Schema } from "effect"

const MaxChunkSize = 1000

const stopWords = new Set([
  "the", "a", "an", "and", "or", "but", "for", "nor", "so", "yet", "with", "without", "from", "into", "to", "of",
  "in", "on", "at", "by", "about", "as", "is", "are", "was", "were", "be", "been", "being", "have", "has", "had",
  "do", "does", "did", "will", "would", "could", "should", "may", "might", "must", "can", "this", "that", "these",
  "those", "i", "you", "he", "she", "it", "we", "they", "them", "their", "there", "than", "then", "now", "here",
  "when", "where", "why", "how", "what", "which", "who", "whom", "whose", "if", "because", "until", "while",
  "during", "before", "after", "above", "below", "between", "through", "over", "under", "again", "once", "more",
  "most", "some", "any", "all", "each", "every", "both", "few", "many", "much", "other", "such", "only", "own",
  "same", "so", "very", "just", "also", "not", "no", "yes", "up", "down", "out", "off", "its", "our", "my",
])

export type SearchResult = {
  readonly entryID: Knowledge.KnowledgeEntryID
  readonly text: string
  readonly score: number
  readonly locator: IndustrialCitation.Locator
}

export interface Interface {
  readonly ingest: (input: {
    sessionID: SessionID
    artifactID: Artifact.ID
    artifactName: string
    text: string
    indexProfileID: string
    extractorVersion: string
    chunkerVersion: string
  }) => Effect.Effect<number>
  readonly search: (input: { sessionID: SessionID; query: string; limit?: number }) => Effect.Effect<ReadonlyArray<SearchResult>>
  readonly open: (input: { sessionID: SessionID; entryID: string }) => Effect.Effect<SearchResult | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/KnowledgeStore") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const ingest = Effect.fn("KnowledgeStore.ingest")(
      function* (input: {
        sessionID: SessionID
        artifactID: Artifact.ID
        artifactName: string
        text: string
        indexProfileID: string
        extractorVersion: string
        chunkerVersion: string
      }) {
        yield* db
          .delete(KnowledgeEntryTable)
          .where(
            and(
              eq(KnowledgeEntryTable.owner_session_id, input.sessionID),
              eq(KnowledgeEntryTable.artifact_id, input.artifactID),
            ),
          )
          .run()

        const locator = Schema.decodeUnknownSync(IndustrialCitation.ArtifactLocator)({
          type: "artifact",
          artifactID: input.artifactID,
        })
        const chunks = extractChunks(input.text)
        const entries = chunks.map((chunk, index) => ({
          id: Schema.decodeUnknownSync(Knowledge.KnowledgeEntryID)(`kwe_${randomUUID()}`),
          owner_session_id: input.sessionID,
          artifact_id: input.artifactID,
          index_profile_id: input.indexProfileID,
          extractor_version: input.extractorVersion,
          chunker_version: input.chunkerVersion,
          chunk_index: index,
          chunk_text: chunk,
          locator,
          time_created: Date.now(),
        }))

        if (entries.length === 0) return 0

        yield* db.insert(KnowledgeEntryTable).values(entries).run()

        const terms = entries.flatMap((entry) => {
          const counts = tokenize(entry.chunk_text)
          return Array.from(counts.entries()).map(([term, count]) => ({
            term,
            entry_id: entry.id,
            count,
          }))
        })

        if (terms.length > 0) yield* db.insert(KnowledgeTermTable).values(terms).run()
        return entries.length
      },
    )

    const search = Effect.fn("KnowledgeStore.search")(
      function* (input: { sessionID: SessionID; query: string; limit?: number }) {
        const tokens = Array.from(tokenize(input.query).keys())
        if (tokens.length === 0) return []

        const limit = input.limit ?? 10
        const query = sql`
          SELECT e.id, e.chunk_text, e.locator, SUM(t.count) AS score
          FROM koala_knowledge_entry e
          JOIN koala_knowledge_term t ON t.entry_id = e.id
          WHERE e.owner_session_id = ${input.sessionID}
            AND t.term IN (${sql.join(tokens.map((term) => sql`${term}`), sql.raw(", "))})
          GROUP BY e.id
          HAVING COUNT(DISTINCT t.term) = ${tokens.length}
          ORDER BY score DESC
          LIMIT ${limit}
        `

        const rows = yield* db.all<{
          id: string
          chunk_text: string
          locator: unknown
          score: number | bigint
        }>(query)

        return rows.flatMap((row) => {
          const locator = parseLocator(row.locator)
          const entryID = Schema.decodeUnknownOption(Knowledge.KnowledgeEntryID)(row.id)
          if (locator._tag === "None" || entryID._tag === "None") return []
          return [
            {
              entryID: entryID.value,
              text: row.chunk_text,
              score: Number(row.score),
              locator: locator.value,
            },
          ]
        })
      },
    )

    const open = Effect.fn("KnowledgeStore.open")(
      function* (input: { sessionID: SessionID; entryID: string }) {
        const row = yield* db
          .select({
            id: KnowledgeEntryTable.id,
            chunk_text: KnowledgeEntryTable.chunk_text,
            locator: KnowledgeEntryTable.locator,
          })
          .from(KnowledgeEntryTable)
          .where(and(eq(KnowledgeEntryTable.id, input.entryID), eq(KnowledgeEntryTable.owner_session_id, input.sessionID)))
          .get()

        if (!row) return undefined
        const locator = parseLocator(row.locator)
        const entryID = Schema.decodeUnknownOption(Knowledge.KnowledgeEntryID)(row.id)
        if (locator._tag === "None" || entryID._tag === "None") return undefined
        return {
          entryID: entryID.value,
          text: row.chunk_text,
          score: 0,
          locator: locator.value,
        }
      },
    )

    return Service.of({
      ingest: (input) => ingest(input).pipe(Effect.orDie),
      search: (input) => search(input).pipe(Effect.orDie),
      open: (input) => open(input).pipe(Effect.orDie),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })

function extractChunks(text: string): ReadonlyArray<string> {
  const doc = parseNormalized(text)
  const pieces = doc ? extractNormalizedPieces(doc) : [text]
  return pieces.flatMap((piece) => chunkText(piece))
}

function parseNormalized(text: string): DocumentNormalized.NormalizedDocument | undefined {
  try {
    const parsed = JSON.parse(text)
    return Schema.decodeUnknownOption(DocumentNormalized.NormalizedDocument)(parsed).pipe(
      (option) => (option._tag === "Some" ? option.value : undefined),
    )
  } catch {
    return undefined
  }
}

function extractNormalizedPieces(doc: DocumentNormalized.NormalizedDocument): string[] {
  const pieces: string[] = []
  for (const section of doc.sections) {
    if (section.body) pieces.push(section.body)
  }
  for (const page of doc.pages) {
    for (const block of page.textBlocks) {
      for (const paragraph of block.paragraphs) pieces.push(paragraph)
    }
  }
  return pieces
}

function chunkText(text: string, maxSize = MaxChunkSize): string[] {
  if (text.length <= maxSize) return text.length > 0 ? [text] : []
  const chunks: string[] = []
  let start = 0
  while (start < text.length) {
    if (start + maxSize >= text.length) {
      chunks.push(text.slice(start))
      break
    }
    let end = text.lastIndexOf("\n", start + maxSize)
    if (end <= start) end = start + maxSize
    chunks.push(text.slice(start, end))
    start = end
  }
  return chunks
}

function tokenize(text: string): Map<string, number> {
  const counts = new Map<string, number>()
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2 && !stopWords.has(token))
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1)
  }
  return counts
}

function parseLocator(value: unknown): Option.Option<IndustrialCitation.Locator> {
  return Schema.decodeUnknownOption(IndustrialCitation.Locator)(
    typeof value === "string" ? JSON.parse(value) : value,
  )
}

export * as KnowledgeStore from "./knowledge-store"
