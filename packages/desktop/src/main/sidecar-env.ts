export function createSidecarEnv(source = process.env, platform = process.platform, sandboxWorkerPath?: string) {
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
  if (platform === "linux") delete env.LD_PRELOAD

  env.AWS_EC2_METADATA_DISABLED = "true"
  env.METADATA_SERVER_DETECTION = "none"
  env.OPENCODE_DISABLE_AUTOUPDATE = "1"
  env.OPENCODE_DISABLE_SHARE = "1"
  env.KOALA_AGENT_EXECUTION = "sandbox"
  if (sandboxWorkerPath) env.KOALA_SANDBOX_WORKER_PATH = sandboxWorkerPath
  return env
}
