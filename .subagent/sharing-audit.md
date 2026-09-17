# Session Sharing Audit

- Task ID: `ses_f5043a6beffeGhZcRPIoiSzTQV`
- Type: read-only exploration
- Baseline: OpenCode `v1.18.31`

## Scope

Trace session sharing through UI commands, generated SDK, HTTP routes, services,
background synchronization, configuration, events, database tables, and tests.

## Key Findings

- Desktop sharing is implemented in `packages/app`, not the Electron shell.
- Session creation currently delegates through `SessionShare.Service`, so that
  service cannot be deleted before the handler is switched to normal
  `Session.Service.create`.
- `ShareNext.Service` can upload sessions, messages, parts, diffs, and model
  metadata to an external service.
- `OPENCODE_DISABLE_SHARE` stops the remote implementation but does not by
  itself remove UI commands.
- App commands and timeline controls hide when effective config contains
  `share: "disabled"`.
- Existing remote shares require an explicit revocation policy before removing
  local share IDs and secrets.

## Recommended Removal Order

1. Force effective Desktop config to `share: "disabled"`.
2. Remove App share commands and timeline controls.
3. Switch session creation from `SessionShare.create` to `Session.create`.
4. Remove share/unshare routes and regenerate the legacy SDK.
5. Remove background share services and runtime nodes.
6. Remove share config and session fields.
7. Retire persistence only after deciding how existing shares are revoked.

## Protected Boundaries

Keep generic session created/updated/deleted events, message events, SSE,
session storage, and App event reducers. They are not sharing-specific.
