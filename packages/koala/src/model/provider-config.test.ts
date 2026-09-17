import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ModelProfile } from "./profile"
import { ModelProviderConfig } from "./provider-config"

const capabilities = (values: Partial<Record<ModelProfile.Capability, ModelProfile.Detectable>> = {}) => ({
  textInput: "yes" as const,
  imageInput: "no" as const,
  toolCalling: "yes" as const,
  streaming: "yes" as const,
  structuredOutput: "yes" as const,
  reasoning: "unknown" as const,
  ...values,
})

const model = (
  id: string,
  values: Partial<Record<ModelProfile.Capability, ModelProfile.Detectable>> = {},
  enabled = true,
) => ({
  id,
  displayName: `${id} display name`,
  capabilities: capabilities(values),
  contextWindow: 32_768,
  maxOutput: 4_096,
  roles: ["general" as const, "coding" as const],
  enabled,
  priority: 7,
})

const provider = (models: ReadonlyArray<ReturnType<typeof model>> = [model("local-model")]) =>
  Schema.decodeUnknownSync(ModelProfile.Provider)({
    id: "local",
    displayName: "Local Provider",
    baseURL: "http://127.0.0.1:11434/v1",
    secretReference: "keychain:provider-config-secret-canary",
    models,
  })

describe("ModelProviderConfig.toV1OpenAICompatible", () => {
  test("projects the exact supported V1 provider config", () => {
    const input = provider()

    expect(ModelProviderConfig.toV1OpenAICompatible(input)).toEqual({
      providerID: input.id,
      config: {
        name: "Local Provider",
        npm: "@ai-sdk/openai-compatible",
        api: "http://127.0.0.1:11434/v1",
        models: {
          "local-model": {
            name: "local-model display name",
            attachment: false,
            tool_call: true,
            reasoning: false,
            limit: {
              context: 32_768,
              output: 4_096,
            },
            modalities: {
              input: ["text"],
              output: ["text"],
            },
          },
        },
      },
    })
  })

  test.each([
    ["yes", true],
    ["no", false],
    ["unknown", false],
  ] as const)("maps %s tri-state capabilities to %s", (detected, expected) => {
    const result = ModelProviderConfig.toV1OpenAICompatible(
      provider([
        model("tri-state", {
          imageInput: detected,
          toolCalling: detected,
          reasoning: detected,
        }),
      ]),
    )

    expect(result.config.models["tri-state"]).toMatchObject({
      attachment: expected,
      tool_call: expected,
      reasoning: expected,
    })
  })

  test.each([
    ["yes", "yes", ["text", "image"]],
    ["yes", "no", ["text"]],
    ["no", "yes", ["image"]],
    ["unknown", "unknown", []],
    ["unknown", "yes", ["image"]],
  ] as const)("maps %s text and %s image input in stable order", (textInput, imageInput, expected) => {
    const result = ModelProviderConfig.toV1OpenAICompatible(provider([model("modalities", { textInput, imageInput })]))

    expect(result.config.models.modalities?.modalities).toEqual({
      input: expected,
      output: ["text"],
    })
  })

  test("copies context and output limits exactly", () => {
    const profile = model("large-context")
    const result = ModelProviderConfig.toV1OpenAICompatible(
      provider([{ ...profile, contextWindow: 262_144, maxOutput: 65_537 }]),
    )

    expect(result.config.models["large-context"]?.limit).toEqual({ context: 262_144, output: 65_537 })
  })

  test("omits disabled models", () => {
    const result = ModelProviderConfig.toV1OpenAICompatible(provider([model("disabled", {}, false), model("enabled")]))

    expect(Object.keys(result.config.models)).toEqual(["enabled"])
  })

  test("emits an empty model record when all models are disabled", () => {
    const result = ModelProviderConfig.toV1OpenAICompatible(
      provider([model("disabled-a", {}, false), model("disabled-b", {}, false)]),
    )

    expect(result.config.models).toEqual({})
  })

  test("omits the secret reference canary", () => {
    const output = JSON.stringify(ModelProviderConfig.toV1OpenAICompatible(provider()))

    expect(output).not.toContain("provider-config-secret-canary")
    expect(output).not.toContain("secretReference")
  })

  test("omits unsupported and arbitrary fields", () => {
    const profile = provider()
    const input = {
      ...profile,
      env: ["SECRET_ENV_CANARY"],
      headers: { authorization: "header-canary" },
      options: { apiKey: "option-canary" },
      raw_provider_key: "provider-raw-canary",
      models: profile.models.map((item) => ({
        ...item,
        headers: { authorization: "model-header-canary" },
        options: { private: "model-option-canary" },
        raw_model_key: "model-raw-canary",
      })),
    }
    const result = ModelProviderConfig.toV1OpenAICompatible(input)
    const outputModel = result.config.models["local-model"]

    expect(Object.keys(result.config).sort()).toEqual(["api", "models", "name", "npm"])
    expect(Object.keys(outputModel ?? {}).sort()).toEqual([
      "attachment",
      "limit",
      "modalities",
      "name",
      "reasoning",
      "tool_call",
    ])
    expect(JSON.stringify(result)).not.toContain("canary")
    expect(outputModel).not.toHaveProperty("streaming")
    expect(outputModel).not.toHaveProperty("structuredOutput")
    expect(outputModel).not.toHaveProperty("roles")
    expect(outputModel).not.toHaveProperty("enabled")
    expect(outputModel).not.toHaveProperty("priority")
  })

  test("returns deterministic values without mutating the input", () => {
    const input = provider([model("first"), model("second", { imageInput: "yes" })])
    const before = JSON.stringify(input)
    const first = ModelProviderConfig.toV1OpenAICompatible(input)
    const second = ModelProviderConfig.toV1OpenAICompatible(input)

    expect(first).toEqual(second)
    expect(first).not.toBe(second)
    expect(JSON.stringify(input)).toBe(before)
  })
})
