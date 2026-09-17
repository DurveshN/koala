export * as ModelProviderConfig from "./provider-config"

import { ModelProfile } from "./profile"

export const OpenAICompatiblePackage = "@ai-sdk/openai-compatible" as const

export interface V1ModelConfig {
  readonly name: string
  readonly attachment: boolean
  readonly tool_call: boolean
  readonly reasoning: boolean
  readonly limit: {
    readonly context: number
    readonly output: number
  }
  readonly modalities: {
    readonly input: ReadonlyArray<"text" | "image">
    readonly output: readonly ["text"]
  }
}

export interface V1ProviderConfig {
  readonly name: string
  readonly npm: typeof OpenAICompatiblePackage
  readonly api: string
  readonly models: Readonly<Record<string, V1ModelConfig>>
}

export interface V1ProviderEntry {
  readonly providerID: ModelProfile.ProviderID
  readonly config: V1ProviderConfig
}

export function toV1OpenAICompatible(provider: ModelProfile.Provider): V1ProviderEntry {
  return {
    providerID: provider.id,
    config: {
      name: provider.displayName,
      npm: OpenAICompatiblePackage,
      api: provider.baseURL,
      models: Object.fromEntries(
        provider.models
          .filter((model) => model.enabled)
          .map((model) => [
            model.id,
            {
              name: model.displayName,
              attachment: model.capabilities.imageInput === "yes",
              tool_call: model.capabilities.toolCalling === "yes",
              reasoning: model.capabilities.reasoning === "yes",
              limit: {
                context: model.contextWindow,
                output: model.maxOutput,
              },
              modalities: {
                input: [
                  ...(model.capabilities.textInput === "yes" ? (["text"] as const) : []),
                  ...(model.capabilities.imageInput === "yes" ? (["image"] as const) : []),
                ],
                output: ["text"],
              },
            },
          ]),
      ),
    },
  }
}
