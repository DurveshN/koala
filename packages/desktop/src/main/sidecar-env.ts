import {
  DOCUMENT_RUNTIME_MANIFEST_SHA256,
  DOCUMENT_RUNTIME_PATH,
  DOCUMENT_RUNTIME_PROXY_ASSETS_ROOT,
  DOCUMENT_RUNTIME_PROXY_PATH,
  DOCUMENT_RUNTIME_REQUIRE_RELEASE_READY,
  type ResolvedDocumentRuntime,
} from "./document-runtime"

export function createSidecarEnv(
  source = process.env,
  platform = process.platform,
  sandboxWorkerPath?: string,
  documentRuntime?: ResolvedDocumentRuntime,
  userDataPath?: string,
) {
  const env = Object.fromEntries(
    Object.entries(source).flatMap(([key, value]) => (value === undefined ? [] : [[key, String(value)]])),
  )

  delete env.DEBUG
  delete env.OTEL_EXPORTER_OTLP_ENDPOINT
  delete env.OTEL_EXPORTER_OTLP_HEADERS
  delete env.OTEL_RESOURCE_ATTRIBUTES
  delete env.AWS_CONTAINER_CREDENTIALS_FULL_URI
  delete env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI
  delete env.AWS_EC2_METADATA_SERVICE_ENDPOINT
  delete env.GCE_METADATA_HOST
  delete env.GCE_METADATA_IP
  for (const key of Object.keys(env)) {
    const normalized = key.toUpperCase()
    if (normalized.startsWith("KOALA_DOCUMENT_RUNTIME_") || normalized === "KOALA_SANDBOX_WORKER_PATH") delete env[key]
  }
  if (platform === "linux") delete env.LD_PRELOAD

  env.AWS_EC2_METADATA_DISABLED = "true"
  env.METADATA_SERVER_DETECTION = "none"
  env.OPENCODE_DISABLE_AUTOUPDATE = "1"
  env.OPENCODE_DISABLE_SHARE = "1"
  // Sandbox mode: requires proper installation via NSIS installer
  // The installer runs `srt-win.exe install` with admin privileges to set up:
  // - Sandbox user account (srt-sandbox)
  // - Windows Filtering Platform (WFP) filters
  // - ACL permissions on runtime paths
  env.KOALA_AGENT_EXECUTION = "sandbox"
  env.KOALA_ENABLE_DOCUMENT_TOOLS = "1"
  // Hide the upstream cloud model catalog (OpenAI/Anthropic/Google/GitHub
  // Copilot/OpenCode Zen/OpenCode Go and the hosted "free" models) from the
  // model-select dialog. Only locally-connected /connect model profiles remain
  // selectable, matching the sovereign local-only workbench.
  env.KOALA_DISABLE_MODELS_CATALOG = "1"
  // Sovereign local-only networking: public/cloud API model endpoints are denied.
  // Set KOALA_NETWORK_ALLOW_PUBLIC=1 only for temporary development testing against
  // a cloud API while local models are too slow to iterate against; every such call
  // is still recorded in the network audit (rule "public-test-allowed").
  if (userDataPath) {
    env.XDG_DATA_HOME = userDataPath
    env.XDG_CONFIG_HOME = userDataPath
    env.XDG_CACHE_HOME = userDataPath
  }
  if (sandboxWorkerPath) env.KOALA_SANDBOX_WORKER_PATH = sandboxWorkerPath
  if (documentRuntime) {
    env[DOCUMENT_RUNTIME_PATH] = documentRuntime.root
    env[DOCUMENT_RUNTIME_MANIFEST_SHA256] = documentRuntime.manifestSha256
    env[DOCUMENT_RUNTIME_REQUIRE_RELEASE_READY] = String(documentRuntime.releaseReady)
    env[DOCUMENT_RUNTIME_PROXY_PATH] = documentRuntime.proxyPath
    env[DOCUMENT_RUNTIME_PROXY_ASSETS_ROOT] = documentRuntime.proxyAssetsRoot
  }
  return env
}
