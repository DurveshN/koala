import {
  DOCUMENT_RUNTIME_MANIFEST_SHA256,
  DOCUMENT_RUNTIME_ATTESTATION,
  DOCUMENT_RUNTIME_OVERRIDE,
  DOCUMENT_RUNTIME_PATH,
  DOCUMENT_RUNTIME_RELEASE_ROOT,
  DOCUMENT_RUNTIME_REQUIRE_RELEASE_READY,
  type ResolvedDocumentRuntime,
} from "./document-runtime"

export function createSidecarEnv(
  source = process.env,
  platform = process.platform,
  sandboxWorkerPath?: string,
  documentRuntime?: ResolvedDocumentRuntime,
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
  delete env[DOCUMENT_RUNTIME_PATH]
  delete env[DOCUMENT_RUNTIME_MANIFEST_SHA256]
  delete env[DOCUMENT_RUNTIME_REQUIRE_RELEASE_READY]
  delete env[DOCUMENT_RUNTIME_OVERRIDE]
  delete env[DOCUMENT_RUNTIME_RELEASE_ROOT]
  delete env[DOCUMENT_RUNTIME_ATTESTATION]
  if (platform === "linux") delete env.LD_PRELOAD

  env.AWS_EC2_METADATA_DISABLED = "true"
  env.METADATA_SERVER_DETECTION = "none"
  env.OPENCODE_DISABLE_AUTOUPDATE = "1"
  env.OPENCODE_DISABLE_SHARE = "1"
  env.KOALA_AGENT_EXECUTION = "sandbox"
  if (sandboxWorkerPath) env.KOALA_SANDBOX_WORKER_PATH = sandboxWorkerPath
  if (documentRuntime) {
    env[DOCUMENT_RUNTIME_PATH] = documentRuntime.root
    env[DOCUMENT_RUNTIME_MANIFEST_SHA256] = documentRuntime.manifestSha256
    env[DOCUMENT_RUNTIME_REQUIRE_RELEASE_READY] = String(documentRuntime.releaseReady)
  }
  return env
}
