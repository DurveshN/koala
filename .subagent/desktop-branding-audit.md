# Desktop Branding And Startup Audit

- Task ID: `ses_f5043a6ceffed9Ez6mbuc3FtaL`
- Type: read-only exploration
- Baseline: OpenCode `v1.18.31`

## Scope

Trace Desktop branding, public updater paths, telemetry initialization, release
notes, notification assets, application IDs, protocols, and external links.

## Key Findings

- Visible branding spans Electron main/window titles, renderer HTML, shared logo
  components, native translations, 62 locale dictionaries, themes, favicons,
  and native icon matrices.
- Application IDs, deep-link protocols, persistence keys, and product branding
  are coupled but should not be renamed in one broad replacement.
- The updater was disabled in local development but remained enabled for
  packaged beta and production channels.
- Desktop Sentry initialization depended on build environment variables, and
  the Vite plugin could upload source maps.
- OTLP export could be activated by inherited sidecar environment variables.
- Release highlights fetched `https://opencode.ai/changelog.json` independently
  of binary updates.
- Desktop notifications fetched a public icon URL.

## Integrated Result

The first sovereignty slice disabled updates in all channels, removed Desktop
Sentry startup and upload integration, sanitized sidecar telemetry variables,
disabled share/autoupdate in the sidecar, skipped Desktop release notes, and
made notification icons local.

## Remaining Work

- Replace visible OpenCode branding with Koala through localized strings and
  shared assets.
- Remove public help, feedback, OAuth, provider, terminal, and Markdown links or
  place them behind explicit local policy.
- Remove unused Sentry dependencies after shared App error-reporting code is
  deleted.
