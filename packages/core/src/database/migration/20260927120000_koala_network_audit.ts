import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260927120000_koala_network_audit",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`koala_network_audit\` (
          \`id\` text PRIMARY KEY,
          \`provider_id\` text NOT NULL,
          \`origin\` text NOT NULL,
          \`destination\` text NOT NULL,
          \`method\` text NOT NULL,
          \`decision\` text NOT NULL,
          \`rule\` text NOT NULL,
          \`status\` integer,
          \`duration_ms\` integer,
          \`request_bytes\` integer,
          \`response_bytes\` integer,
          \`error_kind\` text,
          \`time_started\` integer NOT NULL,
          CONSTRAINT "koala_network_audit_id_check" CHECK(length("id") = 40 AND substr("id", 1, 4) = 'net_' AND substr("id", 13, 1) = '-' AND substr("id", 18, 1) = '-' AND substr("id", 19, 1) = '4' AND substr("id", 23, 1) = '-' AND substr("id", 24, 1) GLOB '[89ab]' AND substr("id", 28, 1) = '-' AND length(replace(substr("id", 5), '-', '')) = 32 AND replace(substr("id", 5), '-', '') NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "koala_network_audit_decision_check" CHECK("decision" IN ('allowed', 'denied')),
          CONSTRAINT "koala_network_audit_text_check" CHECK(length("provider_id") BETWEEN 1 AND 256 AND length("origin") BETWEEN 1 AND 2048 AND length("destination") BETWEEN 1 AND 2048 AND length("method") BETWEEN 1 AND 16 AND length("rule") BETWEEN 1 AND 128),
          CONSTRAINT "koala_network_audit_error_kind_check" CHECK("error_kind" IS NULL OR "error_kind" IN ('policy', 'redirect', 'transport')),
          CONSTRAINT "koala_network_audit_bytes_check" CHECK(("request_bytes" IS NULL OR "request_bytes" >= 0) AND ("response_bytes" IS NULL OR "response_bytes" >= 0)),
          CONSTRAINT "koala_network_audit_time_check" CHECK("time_started" >= 0 AND ("duration_ms" IS NULL OR "duration_ms" >= 0))
        );
      `)
      yield* tx.run(`CREATE INDEX \`koala_network_audit_time_idx\` ON \`koala_network_audit\` (\`time_started\`);`)
      yield* tx.run(
        `CREATE INDEX \`koala_network_audit_decision_time_idx\` ON \`koala_network_audit\` (\`decision\`,\`time_started\`);`,
      )
      yield* tx.run(`CREATE INDEX \`koala_network_audit_provider_idx\` ON \`koala_network_audit\` (\`provider_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
