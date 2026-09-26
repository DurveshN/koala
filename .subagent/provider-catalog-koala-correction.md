# Correction: Public Model Catalog Still Appearing in Koala Model Selector

## Objective

Stop the Desktop embedded sidecar from exposing the public `models.dev` cloud provider catalog to the App, so only user-configured Koala local/private model profiles appear in the model selector and settings.

## Problem

After the Koala provider-form and model-profile integration was implemented, creating a new session still showed OpenCode Zen, Anthropic, and other cloud providers in the model selector. The runtime also attempted to use an OpenCode free-tier model, producing a provider error.

## Root Cause

The App model list is derived from the server provider catalog. The sidecar still loaded a public provider list via `ModelsDev.Service`:

- `packages/core/src/models-dev.ts` prefers an on-disk cache (`<cache>/opencode/models.json`).
- Production builds embed the catalog as `OPENCODE_MODELS_DEV` via build scripts.
- A background refresh task fetches from `https://models.opencode.ai` every 60 minutes.

None of those paths were disabled for Koala, so they superseded the local-only goal.

## Fix

Introduced a Koala-specific opt-in flag `KOALA_DISABLE_MODELS_CATALOG` that short-circuits `ModelsDev.populate` to an empty record and suppresses the background refresh fiber. The Desktop sidecar env sets that flag together with the existing `OPENCODE_DISABLE_MODELS_FETCH` flag.

### Files changed

- `packages/core/src/flag/flag.ts` — added `KOALA_DISABLE_MODELS_CATALOG` truthy flag.
- `packages/core/src/models-dev.ts` — returns `{}` early when the flag is set, skipping disk cache, bundled snapshot, and remote fetch; refresh loop skipped too.
- `packages/desktop/src/main/sidecar-env.ts` — set `OPENCODE_DISABLE_MODELS_FETCH=1` and `KOALA_DISABLE_MODELS_CATALOG=1`.
- `packages/desktop/src/main/sidecar-env.test.ts` — updated env snapshots.

## Verification

- `bun typecheck` passed for `packages/core`, `packages/desktop`, `packages/opencode`, and `packages/app`.
- `bun test test/models.test.ts` and `bun test test/plugin/models-dev.test.ts` from `packages/core`: 11 passed.
- `bun test src/main/sidecar-env.test.ts` from `packages/desktop`: 3 passed.
- `bun test test/server/httpapi-provider.test.ts` from `packages/opencode`: 5 passed, 1 skipped.

## Residual Risk

If an existing OpenCode config or auth store contains cloud `provider` / `auth.json` entries, those entries can still appear in `connected` providers because they are independent of the public catalog. A fresh Koala install is unaffected. If migrating an old state directory is required, the migration should clear non-Koala provider config and cloud auth records.

## Integration Notes

Koala model profiles continue to be injected into effective config by `packages/opencode/src/config/config.ts` lines 605–616, which is unchanged. The local/private model form (`packages/app/src/components/dialog-custom-provider.tsx`) writes those profiles through the generated SDK, so the App still has models to select once the user adds an endpoint.
