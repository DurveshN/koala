import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260919125730_koala_artifact_sandbox_run_index",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`CREATE INDEX \`koala_artifact_sandbox_run_idx\` ON \`koala_artifact\` (\`sandbox_run_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
