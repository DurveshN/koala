# Model Routing Core Implementation

## Objective

Add a bounded Koala-owned package for validated local model profiles and pure deterministic routing without coupling it to OpenCode runtime or infrastructure code.

## Files

- `packages/koala/package.json`
- `packages/koala/tsconfig.json`
- `packages/koala/src/index.ts`
- `packages/koala/src/model/profile.ts`
- `packages/koala/src/model/profile.test.ts`
- `packages/koala/src/model/router.ts`
- `packages/koala/src/model/router.test.ts`
- `bun.lock`
- `.subagent/model-routing-core-implementation.md`

## Choices

- The package is named `@koala-ai/core` because it is Koala-owned, contains the product's bounded pure domain core, and should not imply ownership by the upstream `@opencode-ai` namespace.
- The package omits a license declaration while Koala's owner-selected license is pending. The upstream root license remains unchanged.
- Provider profiles store only an optional URI-like secret reference. They never accept a raw credential field.
- Provider profiles require at least one model and reject duplicate model IDs within the same provider.
- A model profile is valid when at least one input modality is `yes` or `unknown`. This permits a profile to exist before capability probing completes. Routing requires `yes` for every task or caller-required capability, so `unknown` cannot satisfy a hard requirement.
- Task kinds impose a hard text or image input requirement and prefer the corresponding role. If no eligible model has the preferred role, routing falls back to all eligible models.
- A user override narrows selection to the exact provider and model. It does not bypass enabled or capability checks and does not silently fall back when the target is unsuitable.
- Lower numeric priority ranks first. Ties use provider ID and then model ID.

## Commands And Results

- `bun test`: 21 passed and 0 failed from `packages/koala`.
- `bun typecheck`: passed from `packages/koala`.

## Risks

- Task-to-role preferences are initial domain policy and may need extension when endpoint availability and measured capability probes are introduced.
- The router accepts already-decoded profiles; callers must decode untrusted configuration with `ModelProfile.Provider` before routing.
