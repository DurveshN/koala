import { execFile, execFileSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import type { Configuration } from "electron-builder"
const execFileAsync = promisify(execFile)
const packageDir = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(packageDir, "../..")
const signScript = path.join(rootDir, "script", "sign-windows.ps1")
// The Electron 42 packaging update briefly installed Linux launchers/icons under
// "opencode-desktop". Keep that hidden desktop entry around so existing GNOME/KDE
// pins still resolve after the canonical app id changes back to ai.opencode.desktop.
const legacyDesktopEntry = path.join(packageDir, "resources", "linux", "opencode-desktop.desktop")
const legacyDesktopEntryFpm = `${legacyDesktopEntry}=/usr/share/applications/opencode-desktop.desktop`

const metainfoFpm = (appId: string) =>
  `${path.join(packageDir, "resources", `${appId}.metainfo.xml`)}=/usr/share/metainfo/${appId}.metainfo.xml`

async function signWindows(configuration: { path: string }) {
  if (process.platform !== "win32") return
  if (process.env.GITHUB_ACTIONS !== "true") return
  if (!confinementCandidate && !process.env.OPENCODE_RELEASE) return

  await execFileAsync(
    "pwsh",
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", signScript, configuration.path],
    { cwd: rootDir },
  )
}

const channel = (() => {
  const raw = process.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
})()
const confinementCandidate = process.env.KOALA_DOCUMENT_CONFINEMENT_CANDIDATE === "1"

const APP_IDS = {
  dev: "ai.opencode.desktop.dev",
  beta: "ai.opencode.desktop.beta",
  prod: "ai.opencode.desktop",
} as const

const prepared =
  channel === "dev"
    ? undefined
    : (JSON.parse(
        execFileSync(
          "bun",
          [
            confinementCandidate ? "./scripts/document-runtime-evidence.ts" : "./scripts/document-runtime.ts",
            confinementCandidate ? "verify-candidate" : "verify",
          ],
          {
            cwd: packageDir,
            encoding: "utf8",
            env: process.env,
          },
        ).trim(),
      ) as {
        readonly root: string
        readonly attestation: string
        readonly evidenceRoot: string
        readonly sandboxRoot: string
      })

execFileSync("bun", ["./scripts/document-runtime.ts", "verify-sandbox"], {
  cwd: packageDir,
  encoding: "utf8",
  env: process.env,
})

const getBase = (appId: string): Configuration => ({
  artifactName: "opencode-desktop-${os}-${arch}.${ext}",
  directories: {
    output: confinementCandidate ? "dist-candidate" : "dist",
    buildResources: "resources",
  },
  // Linux launchers are .desktop files, so this is the desktop file name,
  // not just the app id. For prod, app id "ai.opencode.desktop" becomes
  // "ai.opencode.desktop.desktop".
  // https://developer.gnome.org/documentation/guidelines/maintainer/integrating.html
  // https://www.electron.build/docs/linux/
  extraMetadata: {
    desktopName: `${appId}.desktop`,
  },
  files: [
    "out/**/*",
    "resources/**/*",
    "!resources/opencode-cli*",
    "!resources/document-runtime{,/**/*}",
    "!resources/document-runtime.attestation.json",
    "!resources/document-confinement-evidence{,/**/*}",
  ],
  extraResources: [
    ...(channel === "dev"
      ? [
          {
            from: "resources/",
            to: "",
            filter: ["opencode-cli*"],
          },
        ]
      : []),
    {
      from: "native/",
      to: "native/",
      filter: ["index.js", "index.d.ts", "build/Release/mac_window.node", "swift-build/**"],
    },
    {
      from: prepared?.sandboxRoot ?? "../opencode/dist/node/sandbox-runtime/",
      to: "sandbox-runtime/",
      filter: [
        "sandbox-worker.mjs",
        "document-runtime-proxy.mjs",
        "sandbox-runtime.manifest.json",
        "LICENSE",
        "vendor/**/*",
      ],
    },
    ...(prepared
      ? [
          { from: prepared.root, to: "document-runtime/", filter: ["**/*"] },
          { from: prepared.attestation, to: "document-runtime.attestation.json" },
          { from: prepared.evidenceRoot, to: "document-confinement-evidence/", filter: ["**/*"] },
        ]
      : []),
  ],
  mac: {
    category: "public.app-category.developer-tools",
    icon: `resources/icons/icon.icns`,
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "resources/entitlements.plist",
    entitlementsInherit: "resources/entitlements.plist",
    notarize: confinementCandidate || Boolean(process.env.OPENCODE_RELEASE),
    target: ["dmg", "zip"],
  },
  dmg: {
    sign: confinementCandidate || Boolean(process.env.OPENCODE_RELEASE),
  },
  protocols: {
    name: "Koala",
    schemes: ["opencode"],
  },
  win: {
    icon: `resources/icons/icon.ico`,
    signtoolOptions: {
      sign: signWindows,
    },
    target: ["nsis"],
    verifyUpdateCodeSignature: false,
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    installerIcon: `resources/icons/icon.ico`,
    installerHeaderIcon: `resources/icons/icon.ico`,
  },
  linux: {
    icon: `resources/icons`,
    category: "Development",
    executableName: appId,
    desktop: {
      entry: {
        // Match the installed .desktop file and hicolor icon basename so
        // Linux shells can associate the running Electron window with its launcher.
        StartupWMClass: appId,
      },
    },
    target: ["AppImage", "deb", "rpm"],
  },
})

function getConfig() {
  const appId = APP_IDS[channel]
  const base = getBase(appId)

  switch (channel) {
    case "dev": {
      return {
        ...base,
        appId,
        productName: "Koala Dev",
        deb: { fpm: [metainfoFpm(appId)] },
        rpm: { packageName: "opencode-dev", fpm: [metainfoFpm(appId)] },
      }
    }
    case "beta": {
      return {
        ...base,
        appId,
        productName: "Koala Beta",
        protocols: { name: "Koala Beta", schemes: ["opencode"] },
        publish: { provider: "github", owner: "anomalyco", repo: "opencode-beta", channel: "latest" },
        deb: { fpm: [metainfoFpm(appId)] },
        rpm: { packageName: "opencode-beta", fpm: [metainfoFpm(appId)] },
      }
    }
    case "prod": {
      return {
        ...base,
        appId,
        productName: "Koala",
        protocols: { name: "Koala", schemes: ["opencode"] },
        publish: { provider: "github", owner: "anomalyco", repo: "opencode", channel: "latest" },
        deb: { fpm: [metainfoFpm(appId), legacyDesktopEntryFpm] },
        rpm: { packageName: "opencode", fpm: [metainfoFpm(appId), legacyDesktopEntryFpm] },
      }
    }
  }
}

export default getConfig()
