import { ModelProfile } from "@koala-ai/core/model/profile"
import { EndpointPolicy } from "@koala-ai/core/network/endpoint-policy"
import { Option, Schema } from "effect"

const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]*$/
const POSITIVE_INTEGER = /^[1-9]\d*$/
const INTEGER = /^-?\d+$/
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/
const MAXIMUM_PROBE_MODEL_ID_LENGTH = 512
const PROBE_CAPABILITIES = [
  "textInput",
  "imageInput",
  "toolCalling",
  "streaming",
  "structuredOutput",
  "reasoning",
] as const satisfies ReadonlyArray<ModelProfile.Capability>

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

type ProbeArgs = {
  form: Pick<FormState, "providerID" | "baseURL" | "apiKey">
  model: ModelRow
  t: Translator
}

export type ModelCapabilityProbeSnapshot = {
  row: string
  providerID: string
  baseURL: string
  apiKey: string
  modelID: string
  requestedCapabilities: ModelProfile.Capability[]
  input: {
    providerID: string
    baseURL: string
    modelID: string
    capabilities: ModelProfile.Capability[]
    apiKey?: string
  }
}

type ModelCapabilityProbeResult = {
  modelID: string
  results: ReadonlyArray<{
    capability: ModelProfile.Capability
    classification: ModelProfile.Detectable
  }>
}

export function validateModelCapabilityProbe(input: ProbeArgs) {
  const requestedCapabilities = PROBE_CAPABILITIES.filter(
    (capability) => input.model.capabilities[capability] === "unknown",
  )
  if (requestedCapabilities.length === 0) {
    return {
      err: { providerID: undefined, baseURL: undefined, modelID: undefined },
      complete: true as const,
    }
  }

  const providerID = input.form.providerID.trim()
  const baseURL = input.form.baseURL.trim()
  const apiKey = input.form.apiKey.trim() || undefined
  const modelID = input.model.id.trim()
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
  const modelIDError = !modelID
    ? input.t("provider.koala.error.required")
    : modelID.length > MAXIMUM_PROBE_MODEL_ID_LENGTH || CONTROL_CHARACTERS.test(modelID)
      ? input.t("provider.koala.probe.error.modelID")
      : undefined
  const err = { providerID: providerIDError, baseURL: baseURLError, modelID: modelIDError }
  if (providerIDError || baseURLError || modelIDError) return { err, complete: false as const }

  return {
    err,
    complete: false as const,
    result: {
      row: input.model.row,
      providerID: input.form.providerID,
      baseURL: input.form.baseURL,
      apiKey: input.form.apiKey,
      modelID: input.model.id,
      requestedCapabilities: [...requestedCapabilities],
      input: {
        providerID,
        baseURL,
        modelID,
        capabilities: [...requestedCapabilities],
        ...(apiKey ? { apiKey } : {}),
      },
    } satisfies ModelCapabilityProbeSnapshot,
  }
}

export function applyModelCapabilityProbeResult(
  form: Pick<FormState, "providerID" | "baseURL" | "apiKey" | "models">,
  snapshot: ModelCapabilityProbeSnapshot,
  result: ModelCapabilityProbeResult,
) {
  const summary = summarizeProbeResult(snapshot.requestedCapabilities, result.results)
  const index = form.models.findIndex((model) => model.row === snapshot.row)
  const model = form.models[index]
  const stale =
    !model ||
    form.providerID !== snapshot.providerID ||
    form.baseURL !== snapshot.baseURL ||
    form.apiKey !== snapshot.apiKey ||
    model.id !== snapshot.modelID ||
    result.modelID !== snapshot.input.modelID
  if (stale) return { models: form.models, stale: true, summary }

  const results = new Map(
    result.results
      .filter((entry) => snapshot.requestedCapabilities.includes(entry.capability))
      .map((entry) => [entry.capability, entry.classification]),
  )
  const capabilities = snapshot.requestedCapabilities.reduce((current, capability) => {
    const classification = results.get(capability)
    if (current[capability] !== "unknown" || (classification !== "yes" && classification !== "no")) return current
    return { ...current, [capability]: classification }
  }, model.capabilities)
  const changed = snapshot.requestedCapabilities.some(
    (capability) => capabilities[capability] !== model.capabilities[capability],
  )
  if (!changed) return { models: form.models, stale: false, summary }

  return {
    models: form.models.map((current, currentIndex) =>
      currentIndex === index ? { ...current, capabilities } : current,
    ),
    stale: false,
    summary,
  }
}

function summarizeProbeResult(
  requested: ReadonlyArray<ModelProfile.Capability>,
  results: ModelCapabilityProbeResult["results"],
) {
  const classifications = new Map(
    results
      .filter((entry) => requested.includes(entry.capability))
      .map((entry) => [entry.capability, entry.classification]),
  )
  return requested.reduce(
    (counts, capability) => {
      const classification = classifications.get(capability)
      if (classification === "yes") counts.verified++
      if (classification === "no") counts.rejected++
      if (classification !== "yes" && classification !== "no") counts.unknown++
      return counts
    },
    { verified: 0, rejected: 0, unknown: 0 },
  )
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
    : !EndpointPolicy.parseBaseURL(baseURL).ok
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
