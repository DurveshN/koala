# Provider Config Adapter Implementation

## Objective

Add a pure Koala-to-OpenCode V1 provider configuration adapter without adding a runtime dependency on `@opencode-ai/core`.

## Files

- `packages/koala/src/model/provider-config.ts`
- `packages/koala/src/model/provider-config.test.ts`
- `packages/koala/src/index.ts`
- `.subagent/provider-config-adapter-implementation.md`

## Mapping Choices

- Return the provider ID separately from the V1 provider config so callers can place the config under the correct provider record key.
- Set provider `npm` to `@ai-sdk/openai-compatible`, map the display name and base URL, and emit only enabled models.
- Use a narrow readonly Koala-owned output contract instead of importing the V1 Core schema at runtime.
- Map only `yes` capabilities to `true`; map `no` and `unknown` to `false`.
- Derive attachment support and the image input modality from `imageInput`, preserve text-before-image modality ordering, and emit text as the sole output modality.
- Whitelist output fields so secret references, routing metadata, probing capabilities, headers, environment names, raw keys, and arbitrary options are omitted.

## Tests And Results

- Tests cover exact projection, tri-state capabilities, modality combinations and ordering, exact limits, disabled and all-disabled models, secret and unsupported-field canaries, deterministic repeated output, and input non-mutation.
- `bun test`: 36 passed and 0 failed from `packages/koala`.
- `bun typecheck`: passed from `packages/koala`.
- `git diff --check`: passed from the repository root.

## Risks

- The adapter intentionally maps only the bounded Koala profile fields currently required by OpenCode V1. New V1 configuration needs must be added explicitly rather than flowing through automatically.
- An all-disabled provider produces an empty model record; the caller decides whether to include or discard that provider entry.
