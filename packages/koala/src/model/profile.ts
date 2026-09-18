export * as ModelProfile from "./profile"

import { Schema } from "effect"
import { EndpointPolicy } from "../network/endpoint-policy"

export const ProviderID = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9._-]*$/)).pipe(
  Schema.brand("ModelProfile.ProviderID"),
)
export type ProviderID = typeof ProviderID.Type

export const ModelID = Schema.Trim.check(Schema.isNonEmpty()).pipe(Schema.brand("ModelProfile.ModelID"))
export type ModelID = typeof ModelID.Type

export const SecretReference = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9+.-]*:\S+$/i)).pipe(
  Schema.brand("ModelProfile.SecretReference"),
)
export type SecretReference = typeof SecretReference.Type

export const BaseURL = Schema.String.check(
  Schema.makeFilter((value) => {
    const result = EndpointPolicy.parseBaseURL(value)
    return result.ok ? undefined : result.message
  }),
).pipe(Schema.brand("ModelProfile.BaseURL"))
export type BaseURL = typeof BaseURL.Type

export const Detectable = Schema.Literals(["yes", "no", "unknown"])
export type Detectable = typeof Detectable.Type

export const Capability = Schema.Literals([
  "textInput",
  "imageInput",
  "toolCalling",
  "streaming",
  "structuredOutput",
  "reasoning",
])
export type Capability = typeof Capability.Type

export const Role = Schema.Literals([
  "general",
  "coding",
  "document",
  "vision",
  "long-context",
  "fast",
  "embedding",
  "reranking",
])
export type Role = typeof Role.Type

export interface Capabilities extends Schema.Schema.Type<typeof Capabilities> {}
export const Capabilities = Schema.Struct({
  textInput: Detectable,
  imageInput: Detectable,
  toolCalling: Detectable,
  streaming: Detectable,
  structuredOutput: Detectable,
  reasoning: Detectable,
}).annotate({ identifier: "ModelProfile.Capabilities" })

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))

const ModelFields = Schema.Struct({
  id: ModelID,
  displayName: Schema.Trim.check(Schema.isNonEmpty()),
  capabilities: Capabilities,
  contextWindow: PositiveInt,
  maxOutput: PositiveInt,
  roles: Schema.Array(Role),
  enabled: Schema.Boolean,
  priority: Schema.Int,
})

export interface Model extends Schema.Schema.Type<typeof Model> {}
export const Model = ModelFields.check(
  Schema.makeFilter((profile) =>
    profile.maxOutput <= profile.contextWindow ? undefined : "Maximum output cannot exceed the context window",
  ),
  Schema.makeFilter((profile) =>
    profile.capabilities.textInput !== "no" || profile.capabilities.imageInput !== "no"
      ? undefined
      : "At least one input modality must be yes or unknown",
  ),
).annotate({ identifier: "ModelProfile.Model" })

export interface Provider extends Schema.Schema.Type<typeof Provider> {}
const ProviderFields = Schema.Struct({
  id: ProviderID,
  displayName: Schema.Trim.check(Schema.isNonEmpty()),
  baseURL: BaseURL,
  secretReference: Schema.optional(SecretReference),
  models: Schema.Array(Model).check(Schema.isMinLength(1)),
})

export const Provider = ProviderFields.check(
  Schema.makeFilter((provider) =>
    new Set(provider.models.map((model) => model.id)).size === provider.models.length
      ? undefined
      : "Model IDs must be unique within a provider",
  ),
).annotate({ identifier: "ModelProfile.Provider" })
