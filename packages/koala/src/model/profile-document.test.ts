import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ModelProfileDocument } from "./profile-document"

const model = () => ({
  id: "local-model",
  displayName: "Local Model",
  capabilities: {
    textInput: "yes" as const,
    imageInput: "no" as const,
    toolCalling: "yes" as const,
    streaming: "yes" as const,
    structuredOutput: "yes" as const,
    reasoning: "unknown" as const,
  },
  contextWindow: 32_768,
  maxOutput: 4_096,
  roles: ["general" as const, "coding" as const],
  enabled: true,
  priority: 10,
})

const provider = () => ({
  id: "local",
  displayName: "Local Provider",
  baseURL: "http://127.0.0.1:11434/v1",
  secretReference: "keychain:local-provider",
  models: [model()],
})

const decode = Schema.decodeUnknownSync(ModelProfileDocument.Document)
const encode = Schema.encodeSync(ModelProfileDocument.Document)

describe("ModelProfileDocument.Document", () => {
  test("provides a canonical immutable empty document", () => {
    expect(ModelProfileDocument.empty).toEqual({ version: 1, profiles: [] })
    expect(decode(ModelProfileDocument.empty)).toEqual(ModelProfileDocument.empty)
    expect(encode(ModelProfileDocument.empty)).toEqual({ version: 1, profiles: [] })
    expect(Object.isFrozen(ModelProfileDocument.empty)).toBe(true)
    expect(Object.isFrozen(ModelProfileDocument.empty.profiles)).toBe(true)
  })

  test("round trips a complete document", () => {
    const input = { version: 1 as const, profiles: [provider()] }
    const decoded = decode(input)
    const encoded = encode(decoded)

    expect(encoded).toEqual(input)
    expect(decode(encoded)).toEqual(decoded)
  })

  test("rejects duplicate provider IDs", () => {
    expect(() =>
      decode({
        version: 1,
        profiles: [provider(), { ...provider(), displayName: "Duplicate Local Provider" }],
      }),
    ).toThrow("Provider IDs must be unique within a document")
  })

  test("rejects unsupported and missing versions", () => {
    expect(() => decode({ version: 2, profiles: [] })).toThrow()
    expect(() => decode({ profiles: [] })).toThrow()
  })

  test("applies nested provider and model validation", () => {
    expect(() =>
      decode({
        version: 1,
        profiles: [
          {
            ...provider(),
            models: [{ ...model(), contextWindow: 4_096, maxOutput: 8_192 }],
          },
        ],
      }),
    ).toThrow("Maximum output cannot exceed the context window")
  })

  test("strips unknown credential-like fields from canonical encoding", () => {
    const input = provider()
    const decoded = decode({
      version: 1,
      apiKey: "document-key-canary",
      credentials: { token: "document-token-canary" },
      profiles: [
        {
          ...input,
          apiKey: "provider-key-canary",
          headers: { authorization: "provider-header-canary" },
          models: [
            {
              ...input.models[0],
              token: "model-token-canary",
              capabilities: {
                ...input.models[0]?.capabilities,
                apiKey: "capability-key-canary",
              },
            },
          ],
        },
      ],
    })
    const encoded = encode(decoded)

    expect(encoded).toEqual({ version: 1, profiles: [input] })
    expect(JSON.stringify(encoded)).not.toContain("canary")
    expect(JSON.stringify(encoded)).not.toContain("apiKey")
    expect(JSON.stringify(encoded)).not.toContain("credentials")
    expect(JSON.stringify(encoded)).not.toContain("headers")
    expect(JSON.stringify(encoded)).not.toContain("token")
  })
})
