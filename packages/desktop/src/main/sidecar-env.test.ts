import { describe, expect, test } from "bun:test"
import { createSidecarEnv } from "./sidecar-env"

describe("sidecar environment", () => {
  test("disables external runtime services and removes telemetry configuration", () => {
    const env = createSidecarEnv(
      {
        DEBUG: "*",
        AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://credential-secret.internal",
        AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/credential-secret",
        AWS_EC2_METADATA_SERVICE_ENDPOINT: "http://metadata-secret.internal",
        GCE_METADATA_HOST: "metadata-secret.internal",
        GCE_METADATA_IP: "10.0.0.2",
        KOALA_LOCAL_MODEL: "http://127.0.0.1:8000/v1",
        OPENCODE_DISABLE_AUTOUPDATE: "0",
        OPENCODE_DISABLE_SHARE: "0",
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://telemetry.example.com",
        OTEL_EXPORTER_OTLP_HEADERS: "authorization=secret",
        OTEL_RESOURCE_ATTRIBUTES: "service.name=desktop",
      },
      "win32",
      "C:\\Koala\\sandbox-worker.mjs",
    )

    expect(env).toEqual({
      AWS_EC2_METADATA_DISABLED: "true",
      KOALA_LOCAL_MODEL: "http://127.0.0.1:8000/v1",
      KOALA_AGENT_EXECUTION: "sandbox",
      KOALA_SANDBOX_WORKER_PATH: "C:\\Koala\\sandbox-worker.mjs",
      METADATA_SERVER_DETECTION: "none",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_SHARE: "1",
    })
  })

  test("removes Linux preload injection", () => {
    expect(createSidecarEnv({ LD_PRELOAD: "/tmp/inject.so", PATH: "/usr/bin" }, "linux")).toEqual({
      AWS_EC2_METADATA_DISABLED: "true",
      METADATA_SERVER_DETECTION: "none",
      PATH: "/usr/bin",
      KOALA_AGENT_EXECUTION: "sandbox",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_SHARE: "1",
    })
  })
})
