import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ModelProfile } from "./profile"
import { ModelRouter } from "./router"

const capabilities = (values: Partial<Record<ModelProfile.Capability, ModelProfile.Detectable>> = {}) => ({
  textInput: "yes" as const,
  imageInput: "yes" as const,
  toolCalling: "yes" as const,
  streaming: "yes" as const,
  structuredOutput: "yes" as const,
  reasoning: "yes" as const,
  ...values,
})

const model = (
  id: string,
  priority: number,
  roles: ReadonlyArray<ModelProfile.Role>,
  values: Partial<Record<ModelProfile.Capability, ModelProfile.Detectable>> = {},
  enabled = true,
) => ({
  id,
  displayName: id,
  capabilities: capabilities(values),
  contextWindow: 32_768,
  maxOutput: 4_096,
  roles,
  enabled,
  priority,
})

const provider = (id: string, models: ReadonlyArray<ReturnType<typeof model>>) =>
  Schema.decodeUnknownSync(ModelProfile.Provider)({
    id,
    displayName: id,
    baseURL: `http://${id}.localhost/v1`,
    models,
  })

const route = (
  profiles: ReadonlyArray<ModelProfile.Provider>,
  task: ModelRouter.TaskKind = "general-chat",
  requiredCapabilities: ReadonlyArray<ModelProfile.Capability> = [],
  userOverride?: ModelRouter.Override,
) => ModelRouter.route({ task, requiredCapabilities, userOverride, profiles })

describe("ModelRouter.route", () => {
  test.each([
    ["general-chat", "general"],
    ["coding", "coding"],
    ["document-analysis", "document"],
    ["document-generation", "document"],
    ["vision", "vision"],
    ["knowledge-retrieval", "embedding"],
    ["calculation", "fast"],
  ] as const)("routes %s to its preferred %s role", (task, role) => {
    const profiles = [provider("local", [model("fallback", 1, ["reranking"]), model(`${role}-model`, 100, [role])])]
    expect(String(route(profiles, task).selected?.profile.id)).toBe(`${role}-model`)
  })

  test("rejects candidates missing an explicitly required capability", () => {
    const result = route(
      [
        provider("local", [
          model("without-tools", 1, ["general"], { toolCalling: "no" }),
          model("tools", 2, ["general"]),
        ]),
      ],
      "general-chat",
      ["toolCalling"],
    )

    expect(String(result.selected?.profile.id)).toBe("tools")
    expect(result.rejected[0]?.reasons).toContainEqual({
      code: "required-capability-unavailable",
      capability: "toolCalling",
      detected: "no",
    })
  })

  test("does not treat unknown as satisfying a required capability", () => {
    const result = route(
      [provider("local", [model("unknown-tools", 1, ["general"], { toolCalling: "unknown" })])],
      "general-chat",
      ["toolCalling"],
    )

    expect(result.selected).toBeUndefined()
    expect(result.rejected[0]?.reasons).toContainEqual({
      code: "required-capability-unavailable",
      capability: "toolCalling",
      detected: "unknown",
    })
  })

  test("honors a valid override ahead of normal ranking", () => {
    const profiles = [provider("local", [model("first", 1, ["general"]), model("override", 100, ["general"])])]
    const override = {
      providerID: profiles[0]!.id,
      modelID: profiles[0]!.models[1]!.id,
    }

    expect(String(route(profiles, "general-chat", [], override).selected?.profile.id)).toBe("override")
  })

  test("does not fall back when an override fails required capabilities", () => {
    const profiles = [
      provider("local", [model("fallback", 1, ["general"]), model("override", 2, ["general"], { reasoning: "no" })]),
    ]
    const override = {
      providerID: profiles[0]!.id,
      modelID: profiles[0]!.models[1]!.id,
    }
    const result = route(profiles, "general-chat", ["reasoning"], override)

    expect(result.selected).toBeUndefined()
    expect(result.rejected.find((candidate) => candidate.profile.id === "override")?.reasons).toContainEqual({
      code: "required-capability-unavailable",
      capability: "reasoning",
      detected: "no",
    })
  })

  test("never routes disabled models", () => {
    const result = route([
      provider("local", [model("disabled", 1, ["general"], {}, false), model("enabled", 2, ["general"])]),
    ])

    expect(String(result.selected?.profile.id)).toBe("enabled")
    expect(result.rejected[0]?.reasons).toContainEqual({ code: "disabled" })
  })

  test("breaks priority ties by provider ID then model ID", () => {
    const profiles = [
      provider("provider-b", [model("model-a", 1, ["general"])]),
      provider("provider-a", [model("model-b", 1, ["general"]), model("model-a", 1, ["general"])]),
    ]

    expect(route(profiles).selected).toMatchObject({ providerID: "provider-a", profile: { id: "model-a" } })
    expect(route([...profiles].reverse()).selected).toMatchObject({
      providerID: "provider-a",
      profile: { id: "model-a" },
    })
  })
})
