# Profile Inference Transport Integration

## Design

`Provider.Service` now depends directly on `ModelProfileStore.Service` and `ModelEndpointClient.Service`. During per-instance provider state construction it loads canonical profiles, selects profiles with enabled models, and binds each profile ID and base URL to a `ModelEndpointClient`.

`resolveSDK` recognizes profile-backed provider IDs from that bound state. It uses the canonical profile base URL and selects the bound client before assigning the existing timeout-aware provider `fetch` wrapper. This ordering means config and plugin fetch/base URL values do not replace profile transport policy. The wrapper still combines caller abort, header timeout, chunk timeout, and provider timeout signals, then applies SSE chunk timeout handling to the policy response.

Binding failures are retained for the affected profile and raised as provider initialization failures during language-model resolution. There is no global-fetch fallback for a profile-backed provider. Providers not backed by an enabled canonical profile keep the existing custom-fetch/global-fetch selection.

## Files

- `packages/opencode/src/provider/provider.ts`
  - Added stable profile store and endpoint client dependencies.
  - Bound canonical profile endpoints in provider instance state.
  - Selected canonical base URLs and pinned fetch functions during SDK resolution.
- `packages/opencode/test/provider/profile-endpoint.test.ts`
  - Added AI SDK inference transport integration coverage.
- `packages/opencode/test/session/llm-native.test.ts`
  - Added native gate coverage for an arbitrary profile provider ID.
- `.subagent/profile-inference-transport-integration.md`
  - Records this design and verification.

## Tests And Results

- `packages/opencode`: `bun test test/provider/provider.test.ts test/provider/header-timeout.test.ts test/provider/profile-endpoint.test.ts test/session/llm.test.ts test/session/llm-native.test.ts --timeout 30000`
  - 162 passed, 0 failed.
- `packages/opencode`: `bun test test/provider/profile-endpoint.test.ts --timeout 30000`
  - 5 passed, 0 failed after strengthening wrapped-cause assertions.
- `packages/opencode`: `bun typecheck`
  - Passed.
- `packages/koala`: `bun test`
  - 139 passed, 0 failed.
- `packages/koala`: `bun typecheck`
  - Passed.
- `packages/opencode`: `bunx prettier --check "src/provider/provider.ts" "test/provider/profile-endpoint.test.ts" "test/session/llm-native.test.ts"`
  - Passed.
- `packages/desktop`: `bun run build`
  - Passed.

The focused transport tests use local HTTP servers and fake DNS resolution to verify:

- A profile-backed OpenAI-compatible request reaches the pinned address.
- The AI SDK-generated `Authorization: Bearer` header reaches the allowed endpoint.
- Runtime mutation of profile provider `baseURL` and `fetch` options does not replace the canonical policy transport.
- Public-only and mixed public/private DNS responses are denied before the local server receives a request.
- Redirect responses are rejected and their target is not requested.
- A denied endpoint binding fails profile language-model resolution.
- An unrelated configured provider still uses its configured test fetch.

## Native Runtime Conclusion

Canonical profile projection continues to set `npm` to `@ai-sdk/openai-compatible`. The native runtime cannot select arbitrary profile provider IDs: its provider-ID gate accepts only `openai`, `anthropic`, and IDs beginning with `opencode`. A focused test covers a `profile-local` OpenAI-compatible provider with a fetch function and confirms the gate returns `provider is not openai, opencode, or anthropic`. Profile-backed inference therefore remains on the AI SDK path in this slice.

## Risks

- Profile recognition is based on the canonical profile ID loaded for the same provider instance. Profile changes take effect after the existing instance disposal/reload path.
- A canonical profile with no enabled models is not treated as an active profile-backed provider because config projection omits it.
- Native transport integration is intentionally deferred while arbitrary profile IDs remain outside the native runtime gate.
