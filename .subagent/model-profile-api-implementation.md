# Model Profile CRUD API Implementation

## Objective

Complete and verify the authenticated global Koala model-profile CRUD API, including typed route contracts, store-backed handlers, active-instance disposal after successful mutations, HTTP exercise coverage, and legacy JavaScript SDK generation.

## Files

- `packages/opencode/src/server/routes/instance/httpapi/groups/model-profile.ts`: declares the four global routes and their success/error schemas.
- `packages/opencode/src/server/routes/instance/httpapi/handlers/model-profile.ts`: calls `ModelProfileStore`, maps store failures to public API errors, and schedules global instance disposal after successful mutations.
- `packages/opencode/src/server/routes/instance/httpapi/api.ts`: adds the model-profile group to `RootHttpApi`.
- `packages/opencode/src/server/routes/instance/httpapi/server.ts`: provides the handlers and store node to the server graph.
- `packages/opencode/test/server/httpapi-model-profile.test.ts`: covers CRUD, validation, error mapping, credential redaction, and disposal ordering.
- `packages/opencode/test/server/httpapi-global.test.ts` and `packages/opencode/test/server/httpapi-control-plane.test.ts`: provide the new root handler/store dependencies in existing route tests.
- `packages/opencode/test/server/httpapi-exercise/index.ts`: exercises all four routes in coverage, auth, and effect modes.
- `packages/sdk/js/src/v2/gen/sdk.gen.ts` and `packages/sdk/js/src/v2/gen/types.gen.ts`: generated client methods and types.

## Route And Error Contract

- `GET /global/model-profile`: returns `200` with all canonical providers; repository read failures return opaque `UnknownError` at `500`.
- `POST /global/model-profile`: returns the canonical provider at `200`; invalid input returns `400`, duplicate IDs return `ConflictError` at `409`, and repository failures return opaque `UnknownError` at `500`.
- `PUT /global/model-profile/{providerID}`: returns the replacement at `200`; invalid input or an ID mismatch returns `InvalidRequestError` at `400`, a missing provider returns `ProviderNotFoundError` at `404`, and repository failures return opaque `UnknownError` at `500`.
- `DELETE /global/model-profile/{providerID}`: returns `true` at `200`; invalid paths return `400`, a missing provider returns `ProviderNotFoundError` at `404`, and repository failures return opaque `UnknownError` at `500`.
- Root authorization applies to all four routes. The schema middleware supplies request-decoding `400` responses.
- Create, update, and delete schedule `disposeAllInstancesAndEmitGlobalDisposed` only after the corresponding store operation succeeds. Disposal errors are logged and swallowed after persistence succeeds; failed mutations do not schedule disposal.
- Store failures are translated at the handler boundary. Repository details and submitted credential-like excess fields are absent from error responses.

## SDK Generation

Run from the repository root on Windows:

```sh
bun ./packages/sdk/js/script/build.ts
```

The command completed successfully, including the generator's internal TypeScript build. No `packages/client` generation was run and generated files were not edited manually.

## Tests And Results

- `bun test test/server/httpapi-model-profile.test.ts` from `packages/opencode`: 7 passed, 0 failed, 52 assertions.
- `bun test test/server/httpapi-global.test.ts test/server/httpapi-control-plane.test.ts` from `packages/opencode`: 5 passed, 0 failed.
- Focused `httpapi-exercise` coverage mode with `--include model-profile --fail-on-missing --fail-on-skip`: 4 passed, 0 failed, 0 skipped, 0 missing, 0 extra.
- Focused `httpapi-exercise` auth mode with the same filters: 4 passed, 0 failed, 0 skipped, 0 missing, 0 extra.
- Focused `httpapi-exercise` effect mode with the same filters: 4 passed, 0 failed, 0 skipped, 0 missing, 0 extra.
- `bun test test/server/httpapi-public-openapi.test.ts` from `packages/opencode`: 18 passed, 0 failed.
- `bun typecheck` from `packages/sdk/js`: passed.
- Formatting completed with no source/test changes required beyond the focused test additions.

## Unresolved Risks

- `bun typecheck` from `packages/opencode` is blocked by the separate concurrent runtime Config projection at `src/config/config.ts:604`: `TS2352` reports that readonly `V1ProviderConfig` model data cannot be cast to the mutable V1 config provider shape. The API wiring itself produced no type error, and this file was not modified for the API task.
- Active-instance disposal is intentionally asynchronous after a successful mutation. The API response does not wait for disposal completion, matching the existing global config-update lifecycle behavior.
