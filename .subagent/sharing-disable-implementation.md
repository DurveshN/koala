# Sharing Disable Implementation

## Objective

Make effective V1 configuration report `share: "disabled"` when `OPENCODE_DISABLE_SHARE` is `"1"` or `"true"`, regardless of user or legacy automatic-sharing configuration.

## Files Changed

- `packages/opencode/src/config/config.ts`
- `packages/opencode/test/config/config.test.ts`
- `.subagent/sharing-disable-implementation.md`

## Design

Apply the shared environment `truthy` parser after all config sources are merged and legacy `autoshare` is normalized. This changes only the effective in-memory V1 config and leaves persisted user configuration unchanged.

## Tests And Results

- `bun test test/config/config.test.ts --timeout 30000 --test-name-pattern "sharing|autoshare"`: 3 passed, 0 failed.
- `bun typecheck`: passed from `packages/opencode`.

Coverage includes user `share: "auto"` with the switch set to `"1"`, legacy `autoshare: true` with the switch set to `"true"`, and normal legacy migration when the switch is absent.

## Unresolved Risks

None identified for the launch-time sidecar switch. As with other instance configuration, changing the process environment after an instance config is cached requires that instance state to be reloaded.
