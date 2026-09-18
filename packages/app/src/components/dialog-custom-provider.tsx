import { Button } from "@opencode-ai/ui/button"
import { Checkbox } from "@opencode-ai/ui/checkbox"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { Select } from "@opencode-ai/ui/select"
import { Switch } from "@opencode-ai/ui/switch"
import { TextField } from "@opencode-ai/ui/text-field"
import { useMutation } from "@tanstack/solid-query"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { showToast } from "@/utils/toast"
import { batch, For, Show } from "solid-js"
import { createStore, produce } from "solid-js/store"
import {
  applyModelCapabilityProbeResult,
  type FormState,
  mergeDiscoveredModelIDs,
  type ModelCapabilityProbeSnapshot,
  type ModelRow,
  modelRow,
  validateCustomProvider,
  validateModelCapabilityProbe,
  validateModelDiscovery,
} from "./dialog-custom-provider-form"

type Props = {
  onBack: () => void
}

const SUPPORT = [
  { value: "unknown", label: "provider.koala.models.support.unknown" },
  { value: "yes", label: "provider.koala.models.support.yes" },
  { value: "no", label: "provider.koala.models.support.no" },
] as const

const CAPABILITIES = [
  { value: "textInput", label: "provider.koala.models.capabilities.textInput" },
  { value: "imageInput", label: "provider.koala.models.capabilities.imageInput" },
  { value: "toolCalling", label: "provider.koala.models.capabilities.toolCalling" },
  { value: "streaming", label: "provider.koala.models.capabilities.streaming" },
  { value: "structuredOutput", label: "provider.koala.models.capabilities.structuredOutput" },
  { value: "reasoning", label: "provider.koala.models.capabilities.reasoning" },
] as const

const ROLES = [
  { value: "general", label: "provider.koala.models.roles.general" },
  { value: "coding", label: "provider.koala.models.roles.coding" },
  { value: "document", label: "provider.koala.models.roles.document" },
  { value: "vision", label: "provider.koala.models.roles.vision" },
  { value: "long-context", label: "provider.koala.models.roles.long-context" },
  { value: "fast", label: "provider.koala.models.roles.fast" },
  { value: "embedding", label: "provider.koala.models.roles.embedding" },
  { value: "reranking", label: "provider.koala.models.roles.reranking" },
] as const

export function DialogCustomProvider(props: Props) {
  const language = useLanguage()

  return (
    <Dialog
      class="h-full"
      title={
        <IconButton
          tabIndex={-1}
          icon="arrow-left"
          variant="ghost"
          onClick={props.onBack}
          aria-label={language.t("common.goBack")}
        />
      }
      transition
    >
      <CustomProviderForm />
    </Dialog>
  )
}

export function CustomProviderForm(props: { autofocus?: boolean } = {}) {
  const dialog = useDialog()
  const serverSync = useServerSync()
  const serverSDK = useServerSDK()
  const language = useLanguage()

  const [form, setForm] = createStore<FormState>({
    providerID: "",
    name: "",
    baseURL: "",
    apiKey: "",
    models: [modelRow()],
    err: {},
  })

  const addModel = () => {
    setForm(
      "models",
      produce((rows) => {
        rows.push(modelRow())
      }),
    )
  }

  const removeModel = (index: number) => {
    if (form.models.length <= 1) return
    setForm(
      "models",
      produce((rows) => {
        rows.splice(index, 1)
      }),
    )
  }

  const setField = (key: "providerID" | "name" | "baseURL" | "apiKey", value: string) => {
    setForm(key, value)
    if (key === "apiKey") return
    setForm("err", key, undefined)
  }

  const setModel = (
    index: number,
    key: "id" | "displayName" | "contextWindow" | "maxOutput" | "priority",
    value: string,
  ) => {
    batch(() => {
      setForm("models", index, key, value)
      setForm("models", index, "err", key, undefined)
    })
  }

  const setCapability = (
    index: number,
    key: keyof ModelRow["capabilities"],
    value: ModelRow["capabilities"][keyof ModelRow["capabilities"]],
  ) => {
    batch(() => {
      setForm("models", index, "capabilities", key, value)
      setForm("models", index, "err", "input", undefined)
    })
  }

  const setRole = (index: number, role: ModelRow["roles"][number], checked: boolean) => {
    setForm("models", index, "roles", (roles) =>
      checked ? (roles.includes(role) ? roles : [...roles, role]) : roles.filter((value) => value !== role),
    )
  }

  const validate = () => {
    const output = validateCustomProvider({
      form,
      t: language.t,
      disabledProviders: serverSync().data.config.disabled_providers ?? [],
      existingProviderIDs: new Set(serverSync().data.provider.all.keys()),
    })
    batch(() => {
      setForm("err", output.err)
      output.models.forEach((err, index) => setForm("models", index, "err", err))
    })
    return output.result
  }

  const probeMutation = useMutation(() => ({
    mutationFn: async (snapshot: ModelCapabilityProbeSnapshot) => {
      const response = await serverSDK().client.modelProfile.probe({ modelCapabilityProbeInput: snapshot.input })
      if (!response.data) throw new Error()
      return { snapshot, result: response.data }
    },
    onSuccess: ({ snapshot, result }) => {
      const applied = applyModelCapabilityProbeResult(form, snapshot, result)
      if (applied.stale) {
        showToast({
          title: language.t("provider.koala.probe.stale.title"),
          description: language.t("provider.koala.probe.stale.description"),
        })
        return
      }

      if (applied.models !== form.models) setForm("models", applied.models)
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("provider.koala.probe.success.title"),
        description: language.t("provider.koala.probe.success.description", applied.summary),
      })
    },
    onError: () => {
      showToast({
        variant: "error",
        title: language.t("provider.koala.probe.failure.title"),
        description: language.t("provider.koala.probe.failure.description"),
      })
    },
  }))

  const probe = (model: ModelRow, index: number) => {
    if (probeMutation.isPending || discoverMutation.isPending || saveMutation.isPending) return

    const output = validateModelCapabilityProbe({ form, model, t: language.t })
    if (output.complete) {
      showToast({
        title: language.t("provider.koala.probe.complete.title"),
        description: language.t("provider.koala.probe.complete.description"),
      })
      return
    }

    if (!output.result) {
      batch(() => {
        setForm("err", "providerID", output.err.providerID)
        setForm("err", "baseURL", output.err.baseURL)
        setForm("models", index, "err", "id", output.err.modelID)
      })
      return
    }
    probeMutation.mutate(output.result)
  }

  const discoverMutation = useMutation(() => ({
    mutationFn: async (input: NonNullable<ReturnType<typeof validateModelDiscovery>["result"]>) => {
      const response = await serverSDK().client.modelProfile.discover({ modelDiscoveryInput: input })
      if (!response.data) throw new Error()
      return response.data
    },
    onSuccess: (result) => {
      if (result.models.length === 0) {
        showToast({
          title: language.t("provider.koala.discovery.empty.title"),
          description: language.t("provider.koala.discovery.empty.description"),
        })
        return
      }

      const merged = mergeDiscoveredModelIDs(form.models, result.models)
      setForm("models", merged.models)
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("provider.koala.discovery.success", { count: merged.addedCount }),
        description: language.t("provider.koala.discovery.duplicates", { count: result.duplicateCount }),
      })
    },
    onError: () => {
      showToast({
        variant: "error",
        title: language.t("provider.koala.discovery.failure.title"),
        description: language.t("provider.koala.discovery.failure.description"),
      })
    },
  }))

  const discover = () => {
    if (discoverMutation.isPending || probeMutation.isPending || saveMutation.isPending) return

    const output = validateModelDiscovery({ form, t: language.t })
    batch(() => {
      setForm("err", "providerID", output.err.providerID)
      setForm("err", "baseURL", output.err.baseURL)
    })
    if (!output.result) return
    discoverMutation.mutate(output.result)
  }

  const saveMutation = useMutation(() => ({
    mutationFn: async (result: NonNullable<ReturnType<typeof validate>>) => {
      const sdk = serverSDK()
      if ((await sdk.protocol) !== "v1") throw new Error(language.t("provider.koala.unavailable"))
      const disabledProviders = serverSync().data.config.disabled_providers ?? []

      if (result.key) {
        await sdk.client.auth.set({
          providerID: result.profile.id,
          auth: {
            type: "api",
            key: result.key,
          },
        })
      }

      const profiles = (await sdk.client.modelProfile.list()).data ?? []
      const existing = profiles.find((profile) => profile.id === result.profile.id)
      const profile = {
        ...result.profile,
        ...(existing?.secretReference && !result.key ? { secretReference: existing.secretReference } : {}),
        models: result.profile.models.map((model) => ({
          ...model,
          capabilities: { ...model.capabilities },
          roles: [...model.roles],
        })),
      }
      if (existing) {
        await sdk.client.modelProfile.update({
          providerID: profile.id,
          modelProfileProvider: profile,
        })
      } else {
        await sdk.client.modelProfile.create({ modelProfileProvider: profile })
      }

      await serverSync().updateConfig({
        disabled_providers: disabledProviders.filter((id) => id !== profile.id),
      })
      return result
    },
    onSuccess: (result) => {
      dialog.close()
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("provider.koala.toast.saved.title", { provider: result.profile.displayName }),
        description: language.t("provider.koala.toast.saved.description", {
          provider: result.profile.displayName,
        }),
      })
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : String(err)
      showToast({ title: language.t("common.requestFailed"), description: message })
    },
  }))

  const save = (e: SubmitEvent) => {
    e.preventDefault()
    if (saveMutation.isPending || discoverMutation.isPending || probeMutation.isPending) return

    const result = validate()
    if (!result) return
    saveMutation.mutate(result)
  }

  return (
    <div class="flex flex-col gap-6 px-2.5 pb-3 overflow-y-auto max-h-[60vh]">
      <div class="px-2.5 flex gap-4 items-center">
        <ProviderIcon id="synthetic" class="size-5 shrink-0 icon-strong-base" />
        <div class="text-16-medium text-text-strong">{language.t("provider.koala.title")}</div>
      </div>

      <form onSubmit={save} class="px-2.5 pb-6 flex flex-col gap-6">
        <p class="text-14-regular text-text-base">{language.t("provider.koala.description")}</p>

        <div class="flex flex-col gap-4">
          <TextField
            autofocus={props.autofocus ?? true}
            label={language.t("provider.koala.field.providerID.label")}
            placeholder={language.t("provider.koala.field.providerID.placeholder")}
            description={language.t("provider.koala.field.providerID.description")}
            value={form.providerID}
            onChange={(value) => setField("providerID", value)}
            validationState={form.err.providerID ? "invalid" : undefined}
            error={form.err.providerID}
          />
          <TextField
            label={language.t("provider.koala.field.name.label")}
            placeholder={language.t("provider.koala.field.name.placeholder")}
            value={form.name}
            onChange={(value) => setField("name", value)}
            validationState={form.err.name ? "invalid" : undefined}
            error={form.err.name}
          />
          <TextField
            label={language.t("provider.koala.field.baseURL.label")}
            placeholder={language.t("provider.koala.field.baseURL.placeholder")}
            value={form.baseURL}
            onChange={(value) => setField("baseURL", value)}
            validationState={form.err.baseURL ? "invalid" : undefined}
            error={form.err.baseURL}
          />
          <TextField
            type="password"
            label={language.t("provider.koala.field.apiKey.label")}
            placeholder={language.t("provider.koala.field.apiKey.placeholder")}
            description={language.t("provider.koala.field.apiKey.description")}
            value={form.apiKey}
            onChange={(value) => setField("apiKey", value)}
          />
          <Button
            type="button"
            size="small"
            variant="secondary"
            onClick={discover}
            disabled={discoverMutation.isPending || probeMutation.isPending || saveMutation.isPending}
            aria-busy={discoverMutation.isPending}
            class="self-start"
          >
            {discoverMutation.isPending
              ? language.t("provider.koala.discovery.pending")
              : language.t("provider.koala.discovery.action")}
          </Button>
        </div>

        <div class="flex flex-col gap-3">
          <div class="text-12-medium text-text-weak">{language.t("provider.koala.models.label")}</div>
          <For each={form.models}>
            {(model, index) => (
              <fieldset class="flex flex-col gap-5 rounded-md border border-border-weak-base p-4" data-row={model.row}>
                <legend class="px-1 text-12-medium text-text-weak">
                  {language.t("provider.koala.models.legend", { index: index() + 1 })}
                </legend>
                <div class="flex justify-end -mt-4">
                  <IconButton
                    type="button"
                    icon="trash"
                    variant="ghost"
                    onClick={() => removeModel(index())}
                    disabled={form.models.length <= 1}
                    aria-label={language.t("provider.koala.models.remove")}
                  />
                </div>

                <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <TextField
                    label={language.t("provider.koala.models.id.label")}
                    placeholder={language.t("provider.koala.models.id.placeholder")}
                    value={model.id}
                    onChange={(value) => setModel(index(), "id", value)}
                    validationState={model.err.id ? "invalid" : undefined}
                    error={model.err.id}
                  />
                  <TextField
                    label={language.t("provider.koala.models.name.label")}
                    placeholder={language.t("provider.koala.models.name.placeholder")}
                    value={model.displayName}
                    onChange={(value) => setModel(index(), "displayName", value)}
                    validationState={model.err.displayName ? "invalid" : undefined}
                    error={model.err.displayName}
                  />
                  <TextField
                    type="number"
                    min="1"
                    step="1"
                    inputMode="numeric"
                    label={language.t("provider.koala.models.contextWindow.label")}
                    placeholder={language.t("provider.koala.models.contextWindow.placeholder")}
                    value={model.contextWindow}
                    onChange={(value) => setModel(index(), "contextWindow", value)}
                    validationState={model.err.contextWindow ? "invalid" : undefined}
                    error={model.err.contextWindow}
                  />
                  <TextField
                    type="number"
                    min="1"
                    step="1"
                    inputMode="numeric"
                    label={language.t("provider.koala.models.maxOutput.label")}
                    placeholder={language.t("provider.koala.models.maxOutput.placeholder")}
                    value={model.maxOutput}
                    onChange={(value) => setModel(index(), "maxOutput", value)}
                    validationState={model.err.maxOutput ? "invalid" : undefined}
                    error={model.err.maxOutput}
                  />
                </div>

                <fieldset class="flex flex-col gap-3">
                  <legend class="text-12-medium text-text-weak">
                    {language.t("provider.koala.models.capabilities.legend")}
                  </legend>
                  <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <For each={CAPABILITIES}>
                      {(capability) => {
                        const labelID = `${model.row}-${capability.value}`
                        return (
                          <div class="flex items-center justify-between gap-3">
                            <span id={labelID} class="text-13-regular text-text-base">
                              {language.t(capability.label)}
                            </span>
                            <Select
                              options={[...SUPPORT]}
                              current={SUPPORT.find((option) => option.value === model.capabilities[capability.value])}
                              value={(option) => option.value}
                              label={(option) => language.t(option.label)}
                              onSelect={(option) => option && setCapability(index(), capability.value, option.value)}
                              variant="secondary"
                              size="small"
                              triggerVariant="settings"
                              triggerProps={{ "aria-labelledby": labelID }}
                            />
                          </div>
                        )
                      }}
                    </For>
                  </div>
                  <Show when={model.err.input}>
                    <p class="text-12-regular text-text-danger-base">{model.err.input}</p>
                  </Show>
                  <Button
                    type="button"
                    size="small"
                    variant="secondary"
                    onClick={() => probe(model, index())}
                    disabled={probeMutation.isPending || discoverMutation.isPending || saveMutation.isPending}
                    aria-busy={probeMutation.isPending && probeMutation.variables?.row === model.row}
                    class="self-start"
                  >
                    {probeMutation.isPending && probeMutation.variables?.row === model.row
                      ? language.t("provider.koala.probe.pending")
                      : language.t("provider.koala.probe.action")}
                  </Button>
                  <p class="text-12-regular text-text-weak">{language.t("provider.koala.probe.help")}</p>
                </fieldset>

                <fieldset class="flex flex-col gap-3">
                  <legend class="text-12-medium text-text-weak">
                    {language.t("provider.koala.models.roles.legend")}
                  </legend>
                  <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <For each={ROLES}>
                      {(role) => (
                        <Checkbox
                          checked={model.roles.includes(role.value)}
                          onChange={(checked) => setRole(index(), role.value, checked)}
                        >
                          {language.t(role.label)}
                        </Checkbox>
                      )}
                    </For>
                  </div>
                </fieldset>

                <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:items-end">
                  <Switch
                    checked={model.enabled}
                    onChange={(checked) => setForm("models", index(), "enabled", checked)}
                    description={language.t("provider.koala.models.enabled.description")}
                  >
                    {language.t("provider.koala.models.enabled.label")}
                  </Switch>
                  <TextField
                    type="number"
                    step="1"
                    inputMode="numeric"
                    label={language.t("provider.koala.models.priority.label")}
                    placeholder={language.t("provider.koala.models.priority.placeholder")}
                    value={model.priority}
                    onChange={(value) => setModel(index(), "priority", value)}
                    validationState={model.err.priority ? "invalid" : undefined}
                    error={model.err.priority}
                  />
                </div>
              </fieldset>
            )}
          </For>
          <Button type="button" size="small" variant="ghost" icon="plus-small" onClick={addModel} class="self-start">
            {language.t("provider.koala.models.add")}
          </Button>
        </div>

        <Show when={form.err.profile}>
          <p class="text-12-regular text-text-danger-base">{form.err.profile}</p>
        </Show>
        <Button
          class="w-auto self-start"
          type="submit"
          size="large"
          variant="primary"
          disabled={saveMutation.isPending || discoverMutation.isPending || probeMutation.isPending}
        >
          {saveMutation.isPending ? language.t("common.saving") : language.t("common.submit")}
        </Button>
      </form>
    </div>
  )
}
