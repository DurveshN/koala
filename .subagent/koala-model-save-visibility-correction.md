# Correction: Local Model Form Save Not Visible / Roles Click Blank Popup

## Objective

Fix two problems with the Koala local/private model form:

1. Clicking a "Preferred role" checkbox opened a blank popup.
2. After submitting the form, the saved model/provider did not appear anywhere in the UI.

## Investigations

### Save/visibility path

- The form writes credentials through `sdk.client.auth.set` and the profile through `sdk.client.modelProfile.create` / `.update`.
- Profiles are stored at `<Global.Path.data>/koala/model-profiles.json`; credentials are stored at `<Global.Path.data>/auth.json` as plain JSON (`packages/opencode/src/auth/index.ts`).
- The backend projects saved profiles into effective `ConfigV1` providers (`packages/opencode/src/config/config.ts` lines 605–616).
- A focused integration test (`packages/opencode/test/server/httpapi-koala-provider.test.ts`) confirmed that after creating a profile, `GET /provider` returns the provider and its model.
- The App's provider list query (`packages/app/src/context/global-sync/bootstrap.ts` `loadProvidersQuery`) uses the new `/provider` endpoint when the server is detected as v1, so the backend is capable of surfacing the model.
- The missing UI update was caused by weak cache invalidation after a profile mutation: the form calls `serverSync().updateConfig(...)` to remove the provider from `disabled_providers`, but the global provider query was not reliably refetched afterward, especially because the server only emits `global.disposed` on profile changes and never a `config.updated` / `catalog.updated` event.

### Blank popup on roles

- Roles are rendered with the shared `<Checkbox>` component from `@opencode-ai/ui`.
- The checkbox root in `packages/ui/src/components/checkbox.css` had no `position: relative`, while the hidden `<input>` inside is `position: absolute`.
- Without a positioned ancestor, the hidden input could be laid out against the nearest positioned ancestor (the dialog container), causing a stray blank focus/autofill popup at the top-left of the dialog when clicking any role label.

## Fixes

### Files changed

- `packages/ui/src/components/checkbox.css` — added `position: relative` to the checkbox root so the hidden input is anchored inside each checkbox cell.
- `packages/app/src/components/dialog-custom-provider.tsx` — explicitly calls `serverSync().refreshProviders()` after the profile is saved and `disabled_providers` is updated, so the provider list is refetched immediately.
- `packages/desktop/src/main/sidecar-env.ts` — added an optional `userDataPath` parameter; when provided, it sets `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, and `XDG_CACHE_HOME` to that directory so the sidecar's auth, config, profile, and cache files live inside Electron's `userData` instead of the platform XDG defaults.
- `packages/desktop/src/main/server.ts` — passes `options.userDataPath` into `createSidecarEnv`.
- `packages/desktop/src/main/sidecar-env.test.ts` — added a test verifying the XDG isolation when `userDataPath` is supplied.
- `packages/opencode/test/server/httpapi-koala-provider.test.ts` — added a focused integration test proving that a saved Koala profile is visible through `GET /provider`.

## Verification

- `bun typecheck` passed for `packages/ui`, `packages/desktop`, and `packages/app`.
- `bun test src/main/sidecar-env.test.ts` from `packages/desktop` — 4 passed.
- `bun test test/server/httpapi-koala-provider.test.ts` from `packages/opencode` — 1 passed.
- `bun test src/components/dialog-custom-provider.test.ts` from `packages/app` — 63 passed.

## Remaining notes

[Inference] Credentials remain stored as plain JSON inside the sidecar `userData` directory; no additional encryption or OS keychain integration was added because OpenCode's existing `Auth.Service` also stores plain `auth.json`. If Koala later needs keychain-backed storage, that would be a separate sidecar-level change.

[Inference] Old cloud `provider`/`auth.json` entries from a previous OpenCode state could still appear if the same data directory is reused before the new `userData` isolation takes effect. A fresh Koala install is unaffected.
