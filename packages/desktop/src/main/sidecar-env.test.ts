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
        KOALA_DOCUMENT_RUNTIME_PATH: "C:\\untrusted\\runtime",
        KOALA_DOCUMENT_RUNTIME_MANIFEST_SHA256: "untrusted-hash",
        KOALA_DOCUMENT_RUNTIME_REQUIRE_RELEASE_READY: "false",
        KOALA_DOCUMENT_RUNTIME_OVERRIDE: "C:\\untrusted\\override",
        KOALA_DOCUMENT_RUNTIME_RELEASE_ROOT: "C:\\ci\\runtime",
        KOALA_DOCUMENT_RUNTIME_ATTESTATION: "C:\\ci\\runtime.attestation.json",
        KOALA_DOCUMENT_RUNTIME_PROXY_PATH: "C:\\untrusted\\proxy.mjs",
        KOALA_DOCUMENT_RUNTIME_PROXY_ASSETS_ROOT: "C:\\untrusted\\sandbox-runtime",
        KOALA_DOCUMENT_RUNTIME_FUTURE_KEY: "untrusted",
        KOALA_SANDBOX_WORKER_PATH: "C:\\untrusted\\sandbox-worker.mjs",
        KOALA_LOCAL_MODEL: "http://127.0.0.1:8000/v1",
        OPENCODE_DISABLE_AUTOUPDATE: "0",
        OPENCODE_DISABLE_SHARE: "0",
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://telemetry.example.com",
        OTEL_EXPORTER_OTLP_HEADERS: "authorization=secret",
        OTEL_RESOURCE_ATTRIBUTES: "service.name=desktop",
      },
      "win32",
      "C:\\Koala\\sandbox-worker.mjs",
      {
        root: "C:\\Program Files\\Koala\\resources\\document-runtime",
        manifestSha256: "a".repeat(64),
        releaseReady: true,
        proxyPath: "C:\\Program Files\\Koala\\resources\\sandbox-runtime\\document-runtime-proxy.mjs",
        proxyAssetsRoot: "C:\\Program Files\\Koala\\resources\\sandbox-runtime",
      },
    )

    expect(env).toEqual({
      AWS_EC2_METADATA_DISABLED: "true",
      KOALA_LOCAL_MODEL: "http://127.0.0.1:8000/v1",
      KOALA_AGENT_EXECUTION: "sandbox",
      KOALA_DOCUMENT_RUNTIME_MANIFEST_SHA256: "a".repeat(64),
      KOALA_DOCUMENT_RUNTIME_PATH: "C:\\Program Files\\Koala\\resources\\document-runtime",
      KOALA_DOCUMENT_RUNTIME_PROXY_ASSETS_ROOT: "C:\\Program Files\\Koala\\resources\\sandbox-runtime",
      KOALA_DOCUMENT_RUNTIME_PROXY_PATH:
        "C:\\Program Files\\Koala\\resources\\sandbox-runtime\\document-runtime-proxy.mjs",
      KOALA_DOCUMENT_RUNTIME_REQUIRE_RELEASE_READY: "true",
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

  test("does not forward inherited document runtime configuration without a verified runtime", () => {
    const env = createSidecarEnv({
      KOALA_DOCUMENT_RUNTIME_PATH: "/untrusted/runtime",
      KOALA_DOCUMENT_RUNTIME_MANIFEST_SHA256: "untrusted-hash",
      KOALA_DOCUMENT_RUNTIME_REQUIRE_RELEASE_READY: "true",
      KOALA_DOCUMENT_RUNTIME_OVERRIDE: "/untrusted/override",
      KOALA_DOCUMENT_RUNTIME_RELEASE_ROOT: "/external/ci/runtime",
      KOALA_DOCUMENT_RUNTIME_ATTESTATION: "/external/ci/runtime.attestation.json",
      KOALA_DOCUMENT_RUNTIME_PROXY_PATH: "/untrusted/document-runtime-proxy.mjs",
      KOALA_DOCUMENT_RUNTIME_PROXY_ASSETS_ROOT: "/untrusted/sandbox-runtime",
      KOALA_DOCUMENT_RUNTIME_FUTURE_KEY: "untrusted",
      KOALA_SANDBOX_WORKER_PATH: "/untrusted/sandbox-worker.mjs",
      koala_document_runtime_lowercase: "/untrusted/lowercase",
      koala_sandbox_worker_path: "/untrusted/lowercase-worker.mjs",
    })

    expect(Object.keys(env).filter((key) => key.startsWith("KOALA_DOCUMENT_RUNTIME"))).toEqual([])
    expect(env.KOALA_SANDBOX_WORKER_PATH).toBeUndefined()
    expect(env.koala_sandbox_worker_path).toBeUndefined()
  })
})
