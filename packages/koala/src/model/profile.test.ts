import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ModelProfile } from "./profile"

const model = (capabilities: Partial<Record<ModelProfile.Capability, ModelProfile.Detectable>> = {}) => ({
  id: "local-model",
  displayName: "Local Model",
  capabilities: {
    textInput: "yes" as const,
    imageInput: "no" as const,
    toolCalling: "yes" as const,
    streaming: "yes" as const,
    structuredOutput: "yes" as const,
    reasoning: "unknown" as const,
    ...capabilities,
  },
  contextWindow: 32_768,
  maxOutput: 4_096,
  roles: ["general" as const],
  enabled: true,
  priority: 10,
})

const provider = (profile = model()) => ({
  id: "local",
  displayName: "Local Provider",
  baseURL: "http://127.0.0.1:11434/v1",
  secretReference: "keychain:local-provider",
  models: [profile],
})

describe("ModelProfile.Provider", () => {
  test("accepts a valid local provider profile", () => {
    expect(String(Schema.decodeUnknownSync(ModelProfile.Provider)(provider()).models[0]?.id)).toBe("local-model")
  })

  test("rejects a provider with no models", () => {
    expect(() => Schema.decodeUnknownSync(ModelProfile.Provider)({ ...provider(), models: [] })).toThrow()
  })

  test("rejects duplicate model IDs within a provider", () => {
    expect(() =>
      Schema.decodeUnknownSync(ModelProfile.Provider)({
        ...provider(),
        models: [model(), { ...model(), displayName: "Duplicate Local Model" }],
      }),
    ).toThrow("Model IDs must be unique within a provider")
  })

  test("accepts unknown as a declared input modality", () => {
    expect(
      Schema.decodeUnknownSync(ModelProfile.Provider)(provider(model({ textInput: "unknown", imageInput: "no" })))
        .models[0]?.capabilities.textInput,
    ).toBe("unknown")
  })

  test("rejects maximum output greater than the context window", () => {
    expect(() =>
      Schema.decodeUnknownSync(ModelProfile.Provider)(provider({ ...model(), contextWindow: 4_096, maxOutput: 8_192 })),
    ).toThrow("Maximum output cannot exceed the context window")
  })

  test("rejects profiles with both input modalities declared no", () => {
    expect(() =>
      Schema.decodeUnknownSync(ModelProfile.Provider)(provider(model({ textInput: "no", imageInput: "no" }))),
    ).toThrow("At least one input modality must be yes or unknown")
  })

  test("rejects non-positive limits and non-HTTP base URLs", () => {
    expect(() => Schema.decodeUnknownSync(ModelProfile.Provider)(provider({ ...model(), contextWindow: 0 }))).toThrow()
    expect(() => Schema.decodeUnknownSync(ModelProfile.Provider)({ ...provider(), baseURL: "file:///models" })).toThrow(
      "Expected an absolute HTTP or HTTPS URL",
    )
  })

  test("rejects a raw value in place of a secret reference", () => {
    expect(() =>
      Schema.decodeUnknownSync(ModelProfile.Provider)({ ...provider(), secretReference: "raw-secret-value" }),
    ).toThrow()
  })
})
