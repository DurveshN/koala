import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect, Layer } from "effect"
import { resetDatabase } from "../fixture/db"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const testStateLayer = Layer.effectDiscard(
  Effect.acquireRelease(
    Effect.promise(() => resetDatabase()),
    () => Effect.promise(() => resetDatabase()),
  ),
)

const it = testEffect(Layer.mergeAll(testStateLayer, LayerNode.compile(FSUtil.node), httpApiLayer))
const projectOptions = { config: { formatter: false, lsp: false } }

const providerID = "koala-visible-provider"
const modelID = "koala-visible-model"

function modelProfile() {
  return {
    id: providerID,
    displayName: "Koala Visible Provider",
    baseURL: "http://127.0.0.1:11434/v1",
    models: [
      {
        id: modelID,
        displayName: "Koala Visible Model",
        capabilities: {
          textInput: "yes",
          imageInput: "no",
          toolCalling: "yes",
          streaming: "yes",
          structuredOutput: "yes",
          reasoning: "unknown",
        },
        contextWindow: 32768,
        maxOutput: 4096,
        roles: ["general"],
        enabled: true,
        priority: 10,
      },
    ],
  }
}

function providerFromList(list: unknown, id: string) {
  if (!Array.isArray(list)) return undefined
  return list.find((item) => typeof item === "object" && item !== null && (item as Record<string, unknown>).id === id)
}

describe("Koala model profile /provider visibility", () => {
  it.instance(
    "shows a saved Koala model profile in the App's /provider list",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory

      const createResponse = yield* requestInDirectory("/global/model-profile", directory, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(modelProfile()),
      })
      expect(createResponse.status).toBe(200)

      const providerResponse = yield* requestInDirectory("/provider", directory)
      expect(providerResponse.status).toBe(200)

      const body = (yield* providerResponse.json) as Record<string, unknown>
      expect(Array.isArray(body.all)).toBe(true)

      const provider = providerFromList(body.all, providerID)
      expect(provider).toBeDefined()
      expect(typeof provider).toBe("object")
      expect(provider).not.toBeNull()

      const models = (provider as Record<string, unknown>).models
      expect(typeof models).toBe("object")
      expect(models).not.toBeNull()
      expect((models as Record<string, unknown>)[modelID]).toBeDefined()
    }),
    projectOptions,
    30000,
  )
})
