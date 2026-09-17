# Model Profile Runtime Integration

## Objective

Project canonical Koala model profiles into the effective OpenCode V1 provider configuration without persisting derived providers or resolving profile secret references.

## Files

- `packages/opencode/src/config/config.ts`: injects the profile store, projects profiles during instance config assembly, and wires the store node into Config.
- `packages/opencode/test/koala/model-profile-config.test.ts`: exercises the real Config and profile-store layers.
- `.subagent/model-profile-runtime-integration.md`: records the integration boundary and verification.

## Merge Precedence

Config loads ordinary, remote, project, environment-content, account, and managed sources first, then applies legacy normalization. Canonical profiles are read afterward and projected with `ModelProviderConfig.toV1OpenAICompatible`.

Profile-derived providers replace ordinary providers with the same ID. Ordinary providers with unrelated IDs remain unchanged. Profiles with no enabled models produce no projection. The projection is assigned only to the effective in-memory config; Config write paths continue to use caller-supplied config values.

`ModelProfileStore.ReadError` is not caught or replaced with an empty profile set, so malformed profile documents fail effective config loading. `secretReference` is not read by this integration; runtime credentials continue to use the existing Auth lookup by provider ID.

## Validated Mutable Boundary

Each enabled-model projection is decoded with `ConfigParse.schema(ConfigProviderV1.Info, ...)` before it enters `Object.fromEntries`. This existing OpenCode V1 schema boundary validates the Koala adapter output and returns the mutable provider shape expected by `ConfigV1.Info`, so the readonly-to-mutable cast is unnecessary. Decode failures remain visible as configuration errors.

## Tests And Results

- `bun test test/koala/model-profile-store.test.ts test/koala/model-profile-config.test.ts --timeout 30000` from `packages/opencode`: 18 passed.
- `bun test` from `packages/koala`: 42 passed.
- `bun typecheck` from `packages/koala`: passed.
- `bun typecheck` from `packages/opencode`: passed.
- `bunx prettier --write packages/opencode/src/config/config.ts .subagent/model-profile-runtime-integration.md`: passed.
- `git diff --check`: passed.

## Risks

- A valid profile intentionally supersedes all ordinary provider fields for the same ID, rather than deep-merging them.
- An all-disabled profile does not supersede an ordinary provider with the same ID because no projection is emitted.
- A malformed canonical document blocks effective instance config loading until the document is corrected.
