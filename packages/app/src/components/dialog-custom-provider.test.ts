import { describe, expect, test } from "bun:test"
import {
  type FormState,
  mergeDiscoveredModelIDs,
  type ModelRow,
  modelRow,
  validateCustomProvider,
  validateModelDiscovery,
} from "./dialog-custom-provider-form"

const t = (key: string) => key

const model = (overrides: Partial<ModelRow> = {}): ModelRow => ({
  ...modelRow(),
  row: "m0",
  id: "model-a",
  displayName: "Model A",
  contextWindow: "32768",
  maxOutput: "4096",
  capabilities: {
    textInput: "unknown",
    imageInput: "unknown",
    toolCalling: "unknown",
    streaming: "unknown",
    structuredOutput: "unknown",
    reasoning: "unknown",
  },
  roles: [],
  enabled: true,
  priority: "0",
  ...overrides,
})

const form = (overrides: Partial<FormState> = {}): FormState => ({
  providerID: "local-provider",
  name: "Local Provider",
  baseURL: "http://127.0.0.1:11434/v1",
  apiKey: "",
  models: [model()],
  err: {},
  ...overrides,
})

const validate = (
  value: FormState,
  options: { disabledProviders?: string[]; existingProviderIDs?: Set<string> } = {},
) =>
  validateCustomProvider({
    form: value,
    t,
    disabledProviders: options.disabledProviders ?? [],
    existingProviderIDs: options.existingProviderIDs ?? new Set(),
  })

describe("validateCustomProvider", () => {
  test("creates model rows with unknown capabilities and local-profile defaults", () => {
    expect(modelRow() as unknown).toEqual({
      row: expect.any(String),
      id: "",
      displayName: "",
      contextWindow: "",
      maxOutput: "",
      capabilities: {
        textInput: "unknown",
        imageInput: "unknown",
        toolCalling: "unknown",
        streaming: "unknown",
        structuredOutput: "unknown",
        reasoning: "unknown",
      },
      roles: [],
      enabled: true,
      priority: "0",
      err: {},
    })
  })

  test("returns the exact canonical profile and keeps the raw key outside it", () => {
    const result = validate(
      form({
        providerID: " local-provider ",
        name: " Local Provider ",
        baseURL: " http://127.0.0.1:11434/v1 ",
        apiKey: " raw-secret ",
        models: [
          model({
            id: " model-a ",
            displayName: " Model A ",
            contextWindow: " 32768 ",
            maxOutput: " 4096 ",
            capabilities: {
              textInput: "yes",
              imageInput: "no",
              toolCalling: "yes",
              streaming: "unknown",
              structuredOutput: "yes",
              reasoning: "no",
            },
            roles: ["general", "coding", "long-context"],
            enabled: false,
            priority: " -3 ",
          }),
        ],
      }),
    )

    expect(result.result as unknown).toEqual({
      key: "raw-secret",
      profile: {
        id: "local-provider",
        displayName: "Local Provider",
        baseURL: "http://127.0.0.1:11434/v1",
        secretReference: "opencode-auth:local-provider",
        models: [
          {
            id: "model-a",
            displayName: "Model A",
            contextWindow: 32768,
            maxOutput: 4096,
            capabilities: {
              textInput: "yes",
              imageInput: "no",
              toolCalling: "yes",
              streaming: "unknown",
              structuredOutput: "yes",
              reasoning: "no",
            },
            roles: ["general", "coding", "long-context"],
            enabled: false,
            priority: -3,
          },
        ],
      },
    })
    expect(JSON.stringify(result.result?.profile)).not.toContain("raw-secret")
  })

  test("omits the secret reference and key when the API key is blank", () => {
    const result = validate(form({ apiKey: "   " }))

    expect(result.result?.key).toBeUndefined()
    expect(result.result?.profile.secretReference).toBeUndefined()
  })

  test("accepts unknown support, empty roles, enabled models, and zero priority", () => {
    const result = validate(form())

    expect(result.result?.profile.models[0]).toMatchObject({
      capabilities: {
        textInput: "unknown",
        imageInput: "unknown",
        toolCalling: "unknown",
        streaming: "unknown",
        structuredOutput: "unknown",
        reasoning: "unknown",
      },
      roles: [],
      enabled: true,
      priority: 0,
    })
  })

  test("validates required provider and model fields", () => {
    const result = validate(
      form({
        providerID: "",
        name: " ",
        baseURL: "",
        models: [model({ id: "", displayName: " " })],
      }),
    )

    expect(result.err).toMatchObject({
      providerID: "provider.koala.error.providerID.required",
      name: "provider.koala.error.name.required",
      baseURL: "provider.koala.error.baseURL.required",
    })
    expect(result.models[0]).toMatchObject({
      id: "provider.koala.error.required",
      displayName: "provider.koala.error.required",
    })
  })

  test("rejects malformed provider IDs", () => {
    const result = validate(form({ providerID: "Invalid Provider" }))

    expect(result.err.providerID).toBe("provider.koala.error.providerID.format")
    expect(result.result).toBeUndefined()
  })

  test.each(["api.example.com/v1", "ftp://api.example.com/v1", "https://"])(
    "rejects malformed or non-HTTP URL %s",
    (baseURL) => {
      const result = validate(form({ baseURL }))

      expect(result.err.baseURL).toBe("provider.koala.error.baseURL.format")
      expect(result.result).toBeUndefined()
    },
  )

  test("rejects duplicate trimmed model IDs", () => {
    const result = validate(
      form({
        models: [model(), model({ row: "m1", id: " model-a ", displayName: "Second Model" })],
      }),
    )

    expect(result.models[1]?.id).toBe("provider.koala.error.duplicate")
    expect(result.result).toBeUndefined()
  })

  test.each([
    ["contextWindow", "", "provider.koala.error.required"],
    ["contextWindow", "0", "provider.koala.error.positiveInteger"],
    ["contextWindow", "1.5", "provider.koala.error.positiveInteger"],
    ["contextWindow", "9007199254740992", "provider.koala.error.positiveInteger"],
    ["maxOutput", "", "provider.koala.error.required"],
    ["maxOutput", "-1", "provider.koala.error.positiveInteger"],
    ["maxOutput", "2.5", "provider.koala.error.positiveInteger"],
  ] as const)("rejects invalid %s value %s", (field, value, error) => {
    const result = validate(form({ models: [model({ [field]: value })] }))

    expect(result.models[0]?.[field]).toBe(error)
    expect(result.result).toBeUndefined()
  })

  test("rejects maximum output greater than context window", () => {
    const result = validate(form({ models: [model({ contextWindow: "4096", maxOutput: "8192" })] }))

    expect(result.models[0]?.maxOutput).toBe("provider.koala.error.maxOutput")
    expect(result.result).toBeUndefined()
  })

  test.each(["", "1.5", "9007199254740992"])("rejects invalid priority %s", (priority) => {
    const result = validate(form({ models: [model({ priority })] }))

    expect(result.models[0]?.priority).toBe(priority ? "provider.koala.error.integer" : "provider.koala.error.required")
    expect(result.result).toBeUndefined()
  })

  test("rejects models with both input modalities set to no", () => {
    const current = model()
    const result = validate(
      form({
        models: [
          model({
            capabilities: { ...current.capabilities, textInput: "no", imageInput: "no" },
          }),
        ],
      }),
    )

    expect(result.models[0]?.input).toBe("provider.koala.error.input")
    expect(result.result).toBeUndefined()
  })

  test("rejects an active provider collision", () => {
    const result = validate(form(), { existingProviderIDs: new Set(["local-provider"]) })

    expect(result.err.providerID).toBe("provider.koala.error.providerID.exists")
    expect(result.result).toBeUndefined()
  })

  test("allows an existing disabled provider to reconnect", () => {
    const result = validate(form(), {
      disabledProviders: ["local-provider"],
      existingProviderIDs: new Set(["local-provider"]),
    })

    expect(result.err.providerID).toBeUndefined()
    expect(String(result.result?.profile.id)).toBe("local-provider")
  })

  test("reports final Koala schema rejection", () => {
    const result = validate(form({ models: [] }))

    expect(result.err.profile).toBe("provider.koala.error.profile")
    expect(result.result).toBeUndefined()
  })
})

describe("validateModelDiscovery", () => {
  test("accepts partial forms and returns trimmed transient input", () => {
    const result = validateModelDiscovery({
      form: form({
        providerID: " local-provider ",
        name: "",
        baseURL: " http://127.0.0.1:11434/v1 ",
        apiKey: " transient-key ",
        models: [],
      }),
      t,
    })

    expect(result).toEqual({
      err: { providerID: undefined, baseURL: undefined },
      result: {
        providerID: "local-provider",
        baseURL: "http://127.0.0.1:11434/v1",
        apiKey: "transient-key",
      },
    })
  })

  test("omits an empty transient API key", () => {
    const result = validateModelDiscovery({ form: form({ apiKey: "   " }), t })

    expect(result.result).toEqual({
      providerID: "local-provider",
      baseURL: "http://127.0.0.1:11434/v1",
    })
  })

  test.each([
    ["", "provider.koala.error.providerID.required"],
    ["Invalid Provider", "provider.koala.error.providerID.format"],
  ])("rejects provider ID %s", (providerID, error) => {
    const result = validateModelDiscovery({ form: form({ providerID }), t })

    expect(result.err.providerID).toBe(error)
    expect(result.result).toBeUndefined()
  })

  test.each([
    ["", "provider.koala.error.baseURL.required"],
    ["api.example.com/v1", "provider.koala.error.baseURL.format"],
    ["http://user:secret@localhost/v1", "provider.koala.error.baseURL.format"],
    ["http://localhost/v1?token=secret", "provider.koala.error.baseURL.format"],
    ["http://169.254.169.254/v1", "provider.koala.error.baseURL.format"],
  ])("applies endpoint policy to base URL %s", (baseURL, error) => {
    const result = validateModelDiscovery({ form: form({ baseURL }), t })

    expect(result.err.baseURL).toBe(error)
    expect(result.result).toBeUndefined()
  })
})

describe("mergeDiscoveredModelIDs", () => {
  test("replaces the untouched starter row and defaults discovered rows through modelRow", () => {
    const result = mergeDiscoveredModelIDs([modelRow()], [{ id: "model-a" }, { id: "model-b" }])

    expect(result.addedCount).toBe(2)
    expect(result.models).toHaveLength(2)
    expect(result.models.map((item) => ({ id: item.id, displayName: item.displayName }))).toEqual([
      { id: "model-a", displayName: "model-a" },
      { id: "model-b", displayName: "model-b" },
    ])
    expect(result.models[0]).toMatchObject({
      contextWindow: "",
      maxOutput: "",
      capabilities: {
        textInput: "unknown",
        imageInput: "unknown",
        toolCalling: "unknown",
        streaming: "unknown",
        structuredOutput: "unknown",
        reasoning: "unknown",
      },
      roles: [],
      enabled: true,
      priority: "0",
      err: {},
    })
  })

  test("leaves rows unchanged for an empty discovery result", () => {
    const rows = [model(), model({ row: "m1", id: "manual", displayName: "Manual" })]
    const result = mergeDiscoveredModelIDs(rows, [])

    expect(result).toEqual({ models: rows, addedCount: 0 })
    expect(result.models).toBe(rows)
  })

  test("preserves every manual row and appends only new IDs", () => {
    const first = model({
      id: " model-a ",
      displayName: "Edited model",
      contextWindow: "65536",
      roles: ["coding"],
      enabled: false,
      err: { maxOutput: "Keep this error" },
    })
    const blank = modelRow()
    blank.row = "m1"
    blank.priority = "2"
    const rows = [first, blank]
    const result = mergeDiscoveredModelIDs(rows, [{ id: "model-a" }, { id: "model-b" }])

    expect(result.addedCount).toBe(1)
    expect(result.models.slice(0, 2)).toEqual(rows)
    expect(result.models[0]).toBe(first)
    expect(result.models[0]).toMatchObject({
      displayName: "Edited model",
      contextWindow: "65536",
      roles: ["coding"],
      enabled: false,
      err: { maxOutput: "Keep this error" },
    })
    expect(result.models[1]).toBe(blank)
    expect(result.models[2]).toMatchObject({ id: "model-b", displayName: "model-b" })
  })

  test("does not add duplicate discovered or existing trimmed IDs", () => {
    const existing = model({ id: " model-a ", displayName: "Keep me" })
    const result = mergeDiscoveredModelIDs(
      [existing],
      [{ id: "model-a" }, { id: " model-b " }, { id: "model-b" }, { id: "model-c" }, { id: "model-c" }],
    )

    expect(result.addedCount).toBe(2)
    expect(result.models.map((item) => item.id)).toEqual([" model-a ", "model-b", "model-c"])
    expect(result.models[0]).toBe(existing)
  })

  test("does not delete rows absent from discovery", () => {
    const rows = [model({ id: "manual-a" }), model({ row: "m1", id: "manual-b" })]
    const result = mergeDiscoveredModelIDs(rows, [{ id: "model-c" }])

    expect(result.models.map((item) => item.id)).toEqual(["manual-a", "manual-b", "model-c"])
  })

  test("keeps an untouched starter row when all discovered IDs already exist as blanks", () => {
    const rows = [modelRow()]
    const result = mergeDiscoveredModelIDs(rows, [{ id: " " }, { id: "" }])

    expect(result).toEqual({ models: rows, addedCount: 0 })
    expect(result.models).toBe(rows)
  })
})
