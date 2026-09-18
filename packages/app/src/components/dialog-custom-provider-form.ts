import { ModelProfile } from "@koala-ai/core/model/profile"
import { EndpointPolicy } from "@koala-ai/core/network/endpoint-policy"
import { Option, Schema } from "effect"

const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]*$/
const POSITIVE_INTEGER = /^[1-9]\d*$/
const INTEGER = /^-?\d+$/

type Translator = (key: string, vars?: Record<string, string | number | boolean>) => string

export type ModelErr = {
  id?: string
  displayName?: string
  contextWindow?: string
  maxOutput?: string
  priority?: string
  input?: string
}

export type ModelRow = {
  row: string
  id: string
  displayName: string
  contextWindow: string
  maxOutput: string
  capabilities: Record<ModelProfile.Capability, ModelProfile.Detectable>
  roles: ModelProfile.Role[]
  enabled: boolean
  priority: string
  err: ModelErr
}

export type FormState = {
  providerID: string
  name: string
  baseURL: string
  apiKey: string
  models: ModelRow[]
  err: {
    providerID?: string
    name?: string
    baseURL?: string
    profile?: string
  }
}

type ValidateArgs = {
  form: FormState
  t: Translator
  disabledProviders: string[]
  existingProviderIDs: Set<string>
}

type DiscoveryArgs = {
  form: Pick<FormState, "providerID" | "baseURL" | "apiKey">
  t: Translator
}

export function validateModelDiscovery(input: DiscoveryArgs) {
  const providerID = input.form.providerID.trim()
  const baseURL = input.form.baseURL.trim()
  const apiKey = input.form.apiKey.trim() || undefined
  const providerIDError = !providerID
    ? input.t("provider.koala.error.providerID.required")
    : !PROVIDER_ID.test(providerID)
      ? input.t("provider.koala.error.providerID.format")
      : undefined
  const baseURLError = !baseURL
    ? input.t("provider.koala.error.baseURL.required")
    : !EndpointPolicy.parseBaseURL(baseURL).ok
      ? input.t("provider.koala.error.baseURL.format")
      : undefined
  const err = { providerID: providerIDError, baseURL: baseURLError }
  if (providerIDError || baseURLError) return { err }

  return {
    err,
    result: {
      providerID,
      baseURL,
      ...(apiKey ? { apiKey } : {}),
    },
  }
}

export function mergeDiscoveredModelIDs(models: ModelRow[], discovered: ReadonlyArray<{ id: string }>) {
  const ids = [...new Set(discovered.map((model) => model.id.trim()).filter(Boolean))]
  if (ids.length === 0) return { models, addedCount: 0 }

  const current = models.length === 1 && isStarterModelRow(models[0]) ? [] : models
  const seen = new Set(current.map((model) => model.id.trim()).filter(Boolean))
  const added = ids.filter((id) => !seen.has(id))
  if (added.length === 0) return { models, addedCount: 0 }

  return {
    models: [
      ...current,
      ...added.map((id) => ({
        ...modelRow(),
        id,
        displayName: id,
      })),
    ],
    addedCount: added.length,
  }
}

export function validateCustomProvider(input: ValidateArgs) {
  const providerID = input.form.providerID.trim()
  const name = input.form.name.trim()
  const baseURL = input.form.baseURL.trim()
  const key = input.form.apiKey.trim() || undefined
  const idError = !providerID
    ? input.t("provider.koala.error.providerID.required")
    : !PROVIDER_ID.test(providerID)
      ? input.t("provider.koala.error.providerID.format")
      : undefined
  const nameError = !name ? input.t("provider.koala.error.name.required") : undefined
  const urlError = !baseURL
    ? input.t("provider.koala.error.baseURL.required")
    : !URL.canParse(baseURL) || !["http:", "https:"].includes(new URL(baseURL).protocol)
      ? input.t("provider.koala.error.baseURL.format")
      : undefined
  const existsError = idError
    ? undefined
    : input.existingProviderIDs.has(providerID) && !input.disabledProviders.includes(providerID)
      ? input.t("provider.koala.error.providerID.exists")
      : undefined

  const seenModels = new Set<string>()
  const models = input.form.models.map((model) => {
    const id = model.id.trim()
    const contextWindow = positiveInteger(model.contextWindow)
    const maxOutput = positiveInteger(model.maxOutput)
    const priority = integer(model.priority)
    const idError = !id
      ? input.t("provider.koala.error.required")
      : seenModels.has(id)
        ? input.t("provider.koala.error.duplicate")
        : undefined
    if (id && !seenModels.has(id)) seenModels.add(id)

    return {
      id: idError,
      displayName: !model.displayName.trim() ? input.t("provider.koala.error.required") : undefined,
      contextWindow:
        contextWindow === undefined
          ? model.contextWindow.trim()
            ? input.t("provider.koala.error.positiveInteger")
            : input.t("provider.koala.error.required")
          : undefined,
      maxOutput:
        maxOutput === undefined
          ? model.maxOutput.trim()
            ? input.t("provider.koala.error.positiveInteger")
            : input.t("provider.koala.error.required")
          : contextWindow !== undefined && maxOutput > contextWindow
            ? input.t("provider.koala.error.maxOutput")
            : undefined,
      priority:
        priority === undefined
          ? model.priority.trim()
            ? input.t("provider.koala.error.integer")
            : input.t("provider.koala.error.required")
          : undefined,
      input:
        model.capabilities.textInput === "no" && model.capabilities.imageInput === "no"
          ? input.t("provider.koala.error.input")
          : undefined,
    }
  })
  const modelsValid = models.every((model) => Object.values(model).every((error) => !error))
  const err = {
    providerID: idError ?? existsError,
    name: nameError,
    baseURL: urlError,
    profile: undefined as string | undefined,
  }
  const valid = !idError && !existsError && !nameError && !urlError && modelsValid
  if (!valid) return { err, models }

  const profile = Option.getOrUndefined(
    Schema.decodeUnknownOption(ModelProfile.Provider)({
      id: providerID,
      displayName: name,
      baseURL,
      ...(key ? { secretReference: `opencode-auth:${providerID}` } : {}),
      models: input.form.models.map((model) => ({
        id: model.id.trim(),
        displayName: model.displayName.trim(),
        capabilities: { ...model.capabilities },
        contextWindow: Number(model.contextWindow),
        maxOutput: Number(model.maxOutput),
        roles: [...model.roles],
        enabled: model.enabled,
        priority: Number(model.priority),
      })),
    }),
  )
  if (!profile) return { err: { ...err, profile: input.t("provider.koala.error.profile") }, models }

  return {
    err,
    models,
    result: {
      profile,
      key,
    },
  }
}

function positiveInteger(value: string) {
  const trimmed = value.trim()
  if (!POSITIVE_INTEGER.test(trimmed)) return undefined
  const parsed = Number(trimmed)
  if (!Number.isSafeInteger(parsed)) return undefined
  return parsed
}

function integer(value: string) {
  const trimmed = value.trim()
  if (!INTEGER.test(trimmed)) return undefined
  const parsed = Number(trimmed)
  if (!Number.isSafeInteger(parsed)) return undefined
  return parsed
}

let row = 0

const nextRow = () => `row-${row++}`

export const modelRow = (): ModelRow => ({
  row: nextRow(),
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

function isStarterModelRow(model: ModelRow | undefined) {
  return (
    !!model &&
    !model.id &&
    !model.displayName &&
    !model.contextWindow &&
    !model.maxOutput &&
    Object.values(model.capabilities).every((value) => value === "unknown") &&
    model.roles.length === 0 &&
    model.enabled &&
    model.priority === "0"
  )
}
