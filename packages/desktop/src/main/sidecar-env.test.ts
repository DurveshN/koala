import { describe, expect, test } from "bun:test"
import { createSidecarEnv } from "./sidecar-env"

describe("sidecar environment", () => {
  test("disables external runtime services and removes telemetry configuration", () => {
    const env = createSidecarEnv(
      {
        DEBUG: "*",
        KOALA_LOCAL_MODEL: "http://127.0.0.1:8000/v1",
        OPENCODE_DISABLE_AUTOUPDATE: "0",
        OPENCODE_DISABLE_SHARE: "0",
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://telemetry.example.com",
        OTEL_EXPORTER_OTLP_HEADERS: "authorization=secret",
        OTEL_RESOURCE_ATTRIBUTES: "service.name=desktop",
      },
      "win32",
    )

    expect(env).toEqual({
      KOALA_LOCAL_MODEL: "http://127.0.0.1:8000/v1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_SHARE: "1",
    })
  })

  test("removes Linux preload injection", () => {
    expect(createSidecarEnv({ LD_PRELOAD: "/tmp/inject.so", PATH: "/usr/bin" }, "linux")).toEqual({
      PATH: "/usr/bin",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_SHARE: "1",
    })
  })
})
