# Koala Provider Form Integration

## Files

- `packages/app/package.json` and `bun.lock`: added the `@koala-ai/core` workspace dependency.
- `packages/app/src/i18n/koala.ts`: added the dedicated English fallback copy for the local/private model flow.
- `packages/app/src/context/language.tsx`: merged Koala copy into the typed English base dictionary.
- `packages/app/src/i18n/koala.test.ts`: verified base-dictionary inclusion and untranslated locale fallback.
- `packages/app/src/components/dialog-custom-provider-form.ts`: defined Koala model form state, defaults, validation, and canonical profile output using the narrow model-profile export.
- `packages/app/src/components/dialog-custom-provider.tsx`: expanded the existing legacy form and added model-profile persistence.
- `packages/app/src/components/dialog-custom-provider.test.ts`: covered defaults, output, credentials, capabilities, roles, limits, URLs, collisions, and schema validation.
- `packages/app/src/components/dialog-connect-provider.tsx`: named the synthetic provider with the Koala local/private title in both legacy and V2 pickers.
- `packages/app/src/components/settings-providers.tsx`: used local/private model copy for the legacy settings entry point.
- `packages/app/src/components/settings-v2/providers.tsx`: used the same local/private title and description in V2 settings.

## UX

The existing dialog and scroll container remain in place. Provider fields now describe a local or private OpenAI-compatible endpoint, with no external documentation link or arbitrary header editor. Each model is a vertical card containing identity, limits, six tri-state capability selects, role checkboxes, an enabled switch, and integer priority. Capability and role groups use `fieldset` and `legend`; visible labels and select trigger relationships provide keyboard-accessible names. Legacy and V2 provider pickers and settings use the same local/private model title while retaining the Custom tag.

Model discovery is available next to the base URL and API key fields before submission. It validates only the provider ID and endpoint, disables its action while pending, and leaves model capabilities, roles, and limits for the user to complete. An empty response preserves all rows and reports that no IDs were returned. Success reports the number of rows added and the server-provided duplicate count; request failures use fixed credential-free copy.

Each model capability fieldset also provides one probe action. A shared mutation probes one row at a time and disables every probe action, discovery, and submission while pending. Capability selectors remain editable so a manual choice made during a probe stays authoritative. Rows with no unknown capabilities report that no request was sent. Help copy explains that reasoning uses observable response metadata and structured output uses the native JSON Schema response format.

## Discovery

Discovery calls only the generated `modelProfile.discover` operation with the trimmed provider ID, base URL, and optional transient API key. It does not write auth, profiles, or config. The base URL is checked with Koala's static `EndpointPolicy.parseBaseURL` before the request.

Discovered IDs are merged without deleting existing rows. A single untouched starter row is replaced; otherwise every row remains in order. Existing edited data wins when its trimmed ID matches, and only new trimmed IDs are appended. New rows use `modelRow` defaults and initially use the model ID as their display name.

## Capability Probing

The generated `modelProfile.probe` operation receives the trimmed provider ID, base URL, model ID, canonical list of currently unknown capabilities, and optional transient API key. The request snapshot also retains exact raw provider, endpoint, credential, model, and row identity values. It does not write auth, profiles, or config.

On success, the form rejects the entire result if any snapshotted identity changed, the row was removed or replaced, or the returned model ID differs. Otherwise it applies only requested `yes` or `no` classifications that are still `unknown`; unknown classifications, manual choices, unrequested capabilities, and unrelated row fields remain unchanged. The success toast reports verified yes, endpoint-rejected no, and still-unknown counts without showing evidence details, request data, endpoint errors, or credentials.

## Persistence

Submission requires the V1 protocol. Validation returns a `ModelProfile.Provider` decoded by the Koala schema and a separate optional raw key. When supplied, the key is written through `auth.set` and the profile contains only `opencode-auth:<providerID>` as its secret reference. The form lists profiles through the generated SDK, updates an existing provider ID or creates a new one, then removes the provider ID from `disabled_providers` through `updateConfig`. It does not write a provider config subtree. Empty-key updates skip auth writes and preserve an existing profile secret reference. The success toast reports that the configuration was saved and does not claim endpoint connectivity or availability.

## Localization

New copy intentionally exists only in `i18n/koala.ts`. It is merged into the English base dictionary before locale dictionaries are overlaid, so untranslated locales receive the English fallback without fabricated translations. Existing locale dictionaries and parity requirements were not changed.

## Verification

- Focused form and Koala i18n tests: 68 passed, 0 failed.
- App i18n parity tests: 5 passed, 0 failed.
- `packages/app` typecheck: passed.
- `packages/desktop` typecheck: passed.
- Prettier formatting: completed for changed app files.
- Targeted Oxlint: 0 warnings, 0 errors.
- Desktop production build: passed.
- Git diff check: passed.

Discovery validation and merge tests cover partial forms, transient keys, endpoint-policy denials, starter replacement, empty responses, edited-row preservation, deduplication, defaults, append order, and retention of rows absent from discovery.

Capability-probe tests cover canonical unknown selection, endpoint and bounded model-ID validation, transient keys, no-request completion, yes/no/unknown application, manual override precedence, unrequested results, summary counts, and stale provider, endpoint, credential, model, row, removal, and response identities.

## Risks

- Saving a valid profile does not verify that the configured endpoint is reachable or OpenAI-compatible.
- Auth, profile, and config updates are separate requests, so a later request failure can leave an earlier successful write in place.
- Non-English users see the intentional English fallback until reviewed translations are added.
- Discovery verifies only that the endpoint can list model IDs; users must still enter limits and review capabilities and roles before submission.
- A successful discovery response can become stale before the profile is submitted, and model IDs that disappear later remain in the form by design.
- Capability probes make active model requests and can consume endpoint resources. Results describe one bounded observation and can vary with deployment state or model behavior.
