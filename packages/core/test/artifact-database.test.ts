import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import artifactStoreMigration from "@opencode-ai/core/database/migration/20260919125324_koala_artifact_store"
import artifactIndexMigration from "@opencode-ai/core/database/migration/20260919125730_koala_artifact_sandbox_run_index"
import artifactConstraintsMigration from "@opencode-ai/core/database/migration/20260919133950_koala_artifact_constraints"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { Effect, Exit } from "effect"
import { sql } from "drizzle-orm"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"

const run = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

const makeDb = EffectDrizzleSqlite.makeWithDefaults()

describe("artifact database", () => {
  test("includes artifact tables, foreign keys, and lookup indexes in the full schema", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`PRAGMA foreign_keys = ON`)
        yield* DatabaseMigration.apply(db)

        expect(
          yield* db.all<{ name: string }>(sql`
            SELECT name
            FROM sqlite_master
            WHERE type = 'table' AND name LIKE 'koala_artifact%'
            ORDER BY name
          `),
        ).toEqual([{ name: "koala_artifact" }, { name: "koala_artifact_blob" }, { name: "koala_artifact_lineage" }])
        expect(
          yield* db.all<{ name: string }>(sql`
            SELECT name
            FROM sqlite_master
            WHERE type = 'index' AND name LIKE 'koala_artifact_%_idx'
            ORDER BY name
          `),
        ).toEqual([
          { name: "koala_artifact_digest_idx" },
          { name: "koala_artifact_lineage_source_idx" },
          { name: "koala_artifact_owner_message_idx" },
          { name: "koala_artifact_owner_session_idx" },
          { name: "koala_artifact_sandbox_run_idx" },
        ])
        expect(
          (yield* db.all<{ table: string }>(sql`PRAGMA foreign_key_list('koala_artifact')`))
            .map((key) => key.table)
            .sort(),
        ).toEqual(["koala_artifact_blob", "message", "session"])
        expect(
          (yield* db.all<{ table: string }>(sql`PRAGMA foreign_key_list('koala_artifact_lineage')`))
            .map((key) => key.table)
            .sort(),
        ).toEqual(["koala_artifact", "koala_artifact"])
      }),
    )
  })

  test("applies the incremental migration and enforces artifact constraints", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`PRAGMA foreign_keys = ON`)
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY)`)
        yield* db.run(
          sql`CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL REFERENCES session(id) ON DELETE CASCADE)`,
        )
        yield* DatabaseMigration.applyOnly(db, [
          artifactStoreMigration,
          artifactIndexMigration,
          artifactConstraintsMigration,
        ])
        yield* db.run(sql`INSERT INTO session (id) VALUES ('session')`)
        yield* db.run(sql`INSERT INTO message (id, session_id) VALUES ('message', 'session')`)

        const digest = "a".repeat(64)
        const insertArtifact = (
          id: string,
          options: {
            readonly name?: string
            readonly mime?: string
            readonly state?: string
            readonly validator?: string
            readonly validatorVersion?: string
            readonly validation?: string
          } = {},
        ) => {
          const state = options.state ?? "accepted"
          const validator = options.validator ?? "basic"
          const validatorVersion = options.validatorVersion ?? "1"
          const validation = options.validation ?? JSON.stringify({ state, validator, validatorVersion, findings: [] })
          return db.run(sql`
            INSERT INTO koala_artifact (
              id, digest, name, mime, validation_state, validator, validator_version,
              validation, owner_session_id, owner_message_id, tool_name, tool_call_id,
              sandbox_run_id, time_created
            ) VALUES (
              ${id}, ${digest}, ${options.name ?? "report.txt"}, ${options.mime ?? "text/plain"},
              ${state}, ${validator}, ${validatorVersion}, ${validation}, 'session', 'message',
              'sandbox_execute', 'call', 'run', 1
            )
          `)
        }

        expect(
          (yield* Effect.forEach(
            [
              db.run(
                sql`INSERT INTO koala_artifact_blob (digest, size, time_created) VALUES (${"A".repeat(64)}, 1, 1)`,
              ),
              db.run(
                sql`INSERT INTO koala_artifact_blob (digest, size, time_created) VALUES (${"b".repeat(64)}, -1, 1)`,
              ),
              db.run(
                sql`INSERT INTO koala_artifact_blob (digest, size, time_created) VALUES (${"c".repeat(64)}, ${100 * 1024 * 1024 + 1}, 1)`,
              ),
            ],
            (effect) => Effect.exit(effect),
          )).every(Exit.isFailure),
        ).toBe(true)

        yield* db.run(sql`INSERT INTO koala_artifact_blob (digest, size, time_created) VALUES (${digest}, 4, 1)`)
        expect(
          (yield* Effect.forEach(
            [
              insertArtifact("bad_id"),
              insertArtifact("art_00000000-0000-4000-8000-000000000-01"),
              insertArtifact("art_00000000-0000-4000-8000-000000000010", { state: "pending" }),
              insertArtifact("art_00000000-0000-4000-8000-000000000011", { validation: "not-json" }),
              insertArtifact("art_00000000-0000-4000-8000-000000000017", { validation: '{"findings":[]}' }),
              insertArtifact("art_00000000-0000-4000-8000-000000000012", {
                validation: JSON.stringify({
                  state: "rejected",
                  validator: "basic",
                  validatorVersion: "1",
                  findings: [],
                }),
              }),
              insertArtifact("art_00000000-0000-4000-8000-000000000013", { name: "" }),
              insertArtifact("art_00000000-0000-4000-8000-000000000014", { name: "x".repeat(256) }),
              insertArtifact("art_00000000-0000-4000-8000-000000000015", { mime: "" }),
              insertArtifact("art_00000000-0000-4000-8000-000000000016", { mime: "x".repeat(128) }),
            ],
            (effect) => Effect.exit(effect),
          )).every(Exit.isFailure),
        ).toBe(true)

        const source = "art_00000000-0000-4000-8000-000000000001"
        const derived = "art_00000000-0000-4000-8000-000000000002"
        yield* insertArtifact(source)
        yield* insertArtifact(derived)
        yield* db.run(
          sql`INSERT INTO koala_artifact_lineage (artifact_id, source_artifact_id, relation) VALUES (${derived}, ${source}, 'derived-from')`,
        )

        expect(yield* db.all(sql`SELECT id, digest FROM koala_artifact ORDER BY id`)).toEqual([
          { id: source, digest },
          { id: derived, digest },
        ])
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              db.run(
                sql`INSERT INTO koala_artifact_lineage (artifact_id, source_artifact_id, relation) VALUES (${derived}, ${source}, 'derived_from')`,
              ),
            ),
          ),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              db.run(
                sql`INSERT INTO koala_artifact_lineage (artifact_id, source_artifact_id, relation) VALUES (${source}, ${source}, 'derived-from')`,
              ),
            ),
          ),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              db.run(
                sql`INSERT INTO koala_artifact_lineage (artifact_id, source_artifact_id, relation) VALUES (${derived}, 'art_00000000-0000-4000-8000-000000000099', 'derived-from')`,
              ),
            ),
          ),
        ).toBe(true)

        yield* db.run(sql`DELETE FROM message WHERE id = 'message'`)
        expect(yield* db.get(sql`SELECT count(*) AS count FROM koala_artifact`)).toEqual({ count: 0 })
        expect(yield* db.get(sql`SELECT count(*) AS count FROM koala_artifact_lineage`)).toEqual({ count: 0 })
      }),
    )
  })
})
