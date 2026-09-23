# Koala state rebrand: opencode → koala

## Objective

Stop Koala Desktop and its embedded sidecar from creating any local file or directory with `opencode` in its name. State should live under koala-named paths.

## Research

A research subagent audited the repository and identified all path literals used for persisted state:

- `packages/core/src/global.ts` defines the XDG root directory name (`opencode`).
- `packages/core/src/database/database.ts` and `packages/core/src/observability/logging.ts` define default database/log filenames.
- `packages/desktop/src/main/index.ts` defines the Electron `appId` that determines `userData`.
- `packages/desktop/src/main/store-keys.ts`, `store-cleanup.ts`, `windows.ts`, `install-state.ts`, `updater.ts`, and `logging.ts` define renderer/electron-store filenames.
- `packages/app/src/utils/persist.ts`, `entry.tsx`, and `context/language.tsx` define renderer storage namespaces.
- `packages/desktop/src/renderer/index.tsx` and `renderer/i18n/index.ts` define last-active URL and locale storage keys.
- `packages/desktop/electron-builder.config.ts` defines artifact and package names.
- `packages/desktop/scripts/utils.ts` and `background-cli.ts` bundle the CLI binary under the `resources/opencode-cli*` name.

## Changes made

### Core XDG / database / logs

- `packages/core/src/global.ts`: `const app = "koala"`
- `packages/core/src/database/database.ts`: default DB file `koala.db`
- `packages/core/src/observability/logging.ts`: default log file `koala.log`
- `packages/core/drizzle.config.ts`: updated hardcoded example DB URL
- `packages/core/test/global.test.ts` and `test/effect/observability.test.ts`: updated expectations

### Desktop app identity

- `packages/desktop/src/main/index.ts`: `APP_IDS` → `ai.koala.desktop.*`
- `packages/desktop/electron-builder.config.ts`:
  - `APP_IDS` → `ai.koala.desktop.*`
  - artifact name → `koala-desktop-${os}-${arch}.${ext}`
  - Linux rpm/deb package names → `koala`, `koala-dev`, `koala-beta`
  - `!resources/koala-cli*` exclusion and dev extra resource filter
- `packages/desktop/scripts/copy-metainfo.ts`: generated metainfo uses `ai.koala.desktop.*`
- `nix/desktop.nix`: icon and metainfo install paths use `ai.koala.desktop`

### Desktop persisted stores / logs

- `packages/desktop/src/main/store-keys.ts`: `koala.settings`
- `packages/desktop/src/main/store-cleanup.ts`: cleanup regexes match `koala.*`
- `packages/desktop/src/main/windows.ts`: per-window data file `koala.window.*.dat`
- `packages/desktop/src/main/install-state.ts`: detect `koala.settings`, `koala.global.dat`, `koala` directory
- `packages/desktop/src/main/updater.ts`: `koala.updater`
- `packages/desktop/src/main/logging.ts`: debug zip `koala-debug-*.zip`; server log roots under `.../koala/log`
- `packages/desktop/src/main/migrate.ts`: `opencode.settings.dat` Tauri migration now maps to `koala.settings`

### App renderer storage

- `packages/app/src/utils/persist.ts`: `koala.global.dat`, `koala.window.*.dat`, `koala.workspace.*.dat`, `koala.draft.*.dat`
- `packages/app/src/entry.tsx`: `koala.settings.dat:defaultServerUrl`
- `packages/app/src/context/language.tsx`: `koala.global.dat:language`

### Desktop renderer storage keys

- `packages/desktop/src/renderer/index.tsx`: `koala.desktop.window.*.last-active-url`, initial locale store `koala.global.dat`
- `packages/desktop/src/renderer/i18n/index.ts`: `koala.global.dat`

### Bundled CLI binary

- `packages/desktop/scripts/utils.ts`: copy to `resources/koala-cli`
- `packages/desktop/src/main/background-cli.ts`: executable name `koala-cli` / `koala-cli.exe`
- `packages/desktop/.gitignore`: `resources/koala-cli*`
- Removed stale `packages/desktop/resources/opencode-cli.exe*` artifacts.

### Linux legacy launcher

- `packages/desktop/resources/linux/opencode-desktop.desktop`: Exec/Icon/StartupWMClass now point to `ai.koala.desktop`. The file name itself remains `opencode-desktop.desktop` as a hidden entry for old launcher pins.

### Misc

- `packages/opencode/src/config/managed.ts`: moved managed config dirs to `/Library/Application Support/koala`, `%ProgramData%\koala`, `/etc/koala`, and plist domain to `ai.koala.managed`.
- Updated `packages/opencode/test/cli/mcp-add.test.ts` to the new `.config/koala/...` path.
- Updated `packages/app/e2e/**/*.ts` and `packages/web/src/content/docs/**/troubleshooting.mdx` to reference `koala.*` storage keys.

### What was intentionally not renamed

- Project-level `.opencode` directories and `opencode.json`/`opencode.jsonc` files — this is a workspace compatibility contract.
- Global config default write path still uses `opencode.jsonc` inside `~/.config/koala` because a large body of tests and docs depend on it.
- Internal identifiers such as the `opencode://` URL protocol, the BasicAuth username used by the v2 background service, environment variable names, npm package names, and the `@opencode-ai/*` internal package scope.

## Verification

- `bun typecheck` passed for `packages/core`, `packages/desktop`, `packages/app`, and `packages/opencode`.
- `bun test` passed for:
  - `packages/core/test/global.test.ts`
  - `packages/core/test/effect/observability.test.ts`
  - `packages/desktop/src/main/sidecar-env.test.ts`
  - `packages/desktop/src/main/store-cleanup.test.ts`
  - `packages/desktop/src/main/install-state.test.ts`
  - `packages/desktop/electron-builder.config.test.ts`
  - `packages/desktop/src/main` (minus a pre-existing `node:sqlite` failure in draft-store.test.ts)
  - `packages/app/src/utils/persist.test.ts`
  - `packages/app/src/components/prompt-input/build-request-parts.test.ts`
  - `packages/app/src/components/dialog-custom-provider.test.ts`
  - `packages/opencode/test/config/config.test.ts`
  - `packages/opencode/test/cli/mcp-add.test.ts`
  - `packages/opencode/test/server/httpapi-koala-provider.test.ts`
  - `packages/opencode/test/koala/model-profile-config.test.ts`
