export function createSidecarEnv(source = process.env, platform = process.platform) {
  const env = Object.fromEntries(
    Object.entries(source).flatMap(([key, value]) => (value === undefined ? [] : [[key, String(value)]])),
  )

  delete env.DEBUG
  delete env.OTEL_EXPORTER_OTLP_ENDPOINT
  delete env.OTEL_EXPORTER_OTLP_HEADERS
  delete env.OTEL_RESOURCE_ATTRIBUTES
  if (platform === "linux") delete env.LD_PRELOAD

  env.OPENCODE_DISABLE_AUTOUPDATE = "1"
  env.OPENCODE_DISABLE_SHARE = "1"
  return env
}
