import { createSignal, onMount, onCleanup, For, Show, createMemo } from "solid-js"
import type { IndustrialAuditRecord, NetworkAuditRecord } from "@opencode-ai/sdk/v2/client"
import { Icon } from "@opencode-ai/ui/icon"
import { Button } from "@opencode-ai/ui/button"
import { Tabs } from "@opencode-ai/ui/tabs"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"

const PAGE_SIZE = 50

type NetworkFilter = "all" | "allowed" | "denied"

function formatTime(ms: number) {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

function formatBytes(value: number | null | undefined) {
  if (value === null || value === undefined) return "—"
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function Field(props: { label: string; value: string }) {
  return (
    <div class="flex flex-col gap-0.5">
      <div class="text-12-regular text-text-weak">{props.label}</div>
      <div class="text-12-medium text-text-strong" style={{ "word-break": "break-all" }}>
        {props.value}
      </div>
    </div>
  )
}

export function AuditPage() {
  const language = useLanguage()

  return (
    <div class="flex flex-col h-full w-full overflow-hidden">
      <div class="flex flex-col gap-1 px-6 py-4 border-b border-border-weak">
        <div class="flex items-center gap-2">
          <Icon name="shield" size="medium" />
          <h1 class="text-16-medium text-text-strong">{language.t("audit.title")}</h1>
        </div>
        <p class="text-12-regular text-text-weak">{language.t("audit.subtitle")}</p>
      </div>
      <Tabs defaultValue="network" class="flex flex-col flex-1 overflow-hidden">
        <Tabs.List class="px-6 pt-3">
          <Tabs.Trigger value="network">{language.t("audit.tab.network")}</Tabs.Trigger>
          <Tabs.Trigger value="tools">{language.t("audit.tab.tools")}</Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="network" class="flex-1 overflow-hidden">
          <NetworkMonitor />
        </Tabs.Content>
        <Tabs.Content value="tools" class="flex-1 overflow-hidden">
          <ToolActivity />
        </Tabs.Content>
      </Tabs>
    </div>
  )
}

function NetworkMonitor() {
  const language = useLanguage()
  const serverSDK = useServerSDK()
  const client = () => serverSDK().client

  const [records, setRecords] = createSignal<NetworkAuditRecord[]>([])
  const [cursor, setCursor] = createSignal<number | undefined>(undefined)
  const [filter, setFilter] = createSignal<NetworkFilter>("all")
  const [status, setStatus] = createSignal<"loading" | "ready" | "error">("loading")

  const query = (extra?: { cursor?: number }) => ({
    limit: PAGE_SIZE,
    ...(extra?.cursor !== undefined && { cursor: extra.cursor }),
    ...(filter() !== "all" && { decision: filter() as "allowed" | "denied" }),
  })

  async function loadFirst() {
    setStatus("loading")
    try {
      const data = (await client().audit.network(query())).data
      setRecords(data?.records ?? [])
      setCursor(data?.nextCursor)
      setStatus("ready")
    } catch {
      setStatus("error")
    }
  }

  async function loadMore() {
    const next = cursor()
    if (next === undefined) return
    try {
      const data = (await client().audit.network(query({ cursor: next }))).data
      setRecords((prev) => [...prev, ...(data?.records ?? [])])
      setCursor(data?.nextCursor)
    } catch {
      setStatus("error")
    }
  }

  async function onLive() {
    try {
      const data = (await client().audit.network(query())).data
      const incoming = data?.records ?? []
      setRecords((prev) => {
        const seen = new Set(prev.map((record) => record.id))
        return [...incoming.filter((record) => !seen.has(record.id)), ...prev]
      })
    } catch {
      // ignore transient live-refresh failures; the next event or manual reload recovers
    }
  }

  onMount(() => {
    void loadFirst()
    const stop = serverSDK().event.on("koala.audit.network.recorded", () => void onLive())
    onCleanup(stop)
  })

  const counts = createMemo(() => {
    const list = records()
    return {
      allowed: list.filter((record) => record.decision === "allowed").length,
      denied: list.filter((record) => record.decision === "denied").length,
    }
  })

  return (
    <div class="flex flex-col h-full overflow-hidden">
      <div class="flex items-center justify-between gap-2 px-6 py-3">
        <div class="flex items-center gap-2">
          <span class="inline-flex items-center gap-1 text-11-medium" style={{ color: "var(--syntax-success)" }}>
            <span
              style={{
                width: "8px",
                height: "8px",
                "border-radius": "9999px",
                background: "var(--syntax-success)",
                display: "inline-block",
              }}
            />
            {language.t("audit.live")}
          </span>
          <span class="text-12-regular text-text-weak">
            {language.t("audit.network.summary", { allowed: counts().allowed, denied: counts().denied })}
          </span>
        </div>
        <div class="flex items-center gap-1">
          <For each={["all", "allowed", "denied"] as const}>
            {(value) => (
              <Button
                size="small"
                variant={filter() === value ? "primary" : "ghost"}
                onClick={() => {
                  setFilter(value)
                  void loadFirst()
                }}
              >
                {language.t(`audit.network.filter.${value}`)}
              </Button>
            )}
          </For>
        </div>
      </div>
      <ScrollView class="flex-1 px-6 pb-6">
        <Show
          when={status() !== "error"}
          fallback={<ErrorState message={language.t("audit.error")} onRetry={() => void loadFirst()} />}
        >
          <Show
            when={records().length > 0}
            fallback={
              <Show when={status() === "ready"}>
                <EmptyState message={language.t("audit.empty.network")} />
              </Show>
            }
          >
            <div class="flex flex-col gap-2">
              <For each={records()}>{(record) => <NetworkCard record={record} />}</For>
              <Show when={cursor() !== undefined}>
                <Button variant="ghost" onClick={() => void loadMore()}>
                  {language.t("audit.loadMore")}
                </Button>
              </Show>
            </div>
          </Show>
        </Show>
      </ScrollView>
    </div>
  )
}

function NetworkCard(props: { record: NetworkAuditRecord }) {
  const language = useLanguage()
  const denied = () => props.record.decision === "denied"
  const color = () => (denied() ? "var(--syntax-error)" : "var(--syntax-success)")

  return (
    <div
      class="flex flex-col gap-2 rounded-md p-3 border"
      style={{ "border-color": color(), background: "var(--background-element)" }}
    >
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          <span
            class="text-11-medium px-1.5 py-0.5 rounded"
            style={{ color: "var(--background-base)", background: color() }}
          >
            {language.t(denied() ? "audit.network.decision.denied" : "audit.network.decision.allowed")}
          </span>
          <span class="text-12-medium text-text-strong" style={{ "word-break": "break-all" }}>
            {props.record.destination}
          </span>
        </div>
        <span class="text-11-regular text-text-weak">{formatTime(props.record.timeStarted)}</span>
      </div>
      <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Field label={language.t("audit.field.provider")} value={props.record.providerID} />
        <Field label={language.t("audit.field.rule")} value={props.record.rule} />
        <Field
          label={language.t("audit.field.status")}
          value={props.record.status ? String(props.record.status) : "—"}
        />
        <Field
          label={language.t("audit.field.duration")}
          value={props.record.durationMs ? `${props.record.durationMs} ms` : "—"}
        />
        <Field
          label={language.t("audit.field.bytes")}
          value={`${formatBytes(props.record.requestBytes)} / ${formatBytes(props.record.responseBytes)}`}
        />
      </div>
    </div>
  )
}

function ToolActivity() {
  const language = useLanguage()
  const serverSDK = useServerSDK()
  const client = () => serverSDK().client

  const [records, setRecords] = createSignal<IndustrialAuditRecord[]>([])
  const [cursor, setCursor] = createSignal<number | undefined>(undefined)
  const [status, setStatus] = createSignal<"loading" | "ready" | "error">("loading")

  async function loadFirst() {
    setStatus("loading")
    try {
      const data = (await client().audit.tools({ limit: PAGE_SIZE })).data
      setRecords(data?.records ?? [])
      setCursor(data?.nextCursor)
      setStatus("ready")
    } catch {
      setStatus("error")
    }
  }

  async function loadMore() {
    const next = cursor()
    if (next === undefined) return
    try {
      const data = (await client().audit.tools({ limit: PAGE_SIZE, cursor: next })).data
      setRecords((prev) => [...prev, ...(data?.records ?? [])])
      setCursor(data?.nextCursor)
    } catch {
      setStatus("error")
    }
  }

  async function onLive() {
    try {
      const data = (await client().audit.tools({ limit: PAGE_SIZE })).data
      const incoming = data?.records ?? []
      setRecords((prev) => {
        const byId = new Map(prev.map((record) => [record.id, record]))
        for (const record of incoming) byId.set(record.id, record)
        return [...byId.values()].sort((a, b) => b.startedAt - a.startedAt)
      })
    } catch {
      // ignore transient live-refresh failures
    }
  }

  onMount(() => {
    void loadFirst()
    const stop = serverSDK().event.on("koala.audit.tool.recorded", () => void onLive())
    onCleanup(stop)
  })

  return (
    <div class="flex flex-col h-full overflow-hidden">
      <ScrollView class="flex-1 px-6 py-4">
        <Show
          when={status() !== "error"}
          fallback={<ErrorState message={language.t("audit.error")} onRetry={() => void loadFirst()} />}
        >
          <Show
            when={records().length > 0}
            fallback={
              <Show when={status() === "ready"}>
                <EmptyState message={language.t("audit.empty.tools")} />
              </Show>
            }
          >
            <div class="flex flex-col gap-2">
              <For each={records()}>{(record) => <ToolCard record={record} />}</For>
              <Show when={cursor() !== undefined}>
                <Button variant="ghost" onClick={() => void loadMore()}>
                  {language.t("audit.loadMore")}
                </Button>
              </Show>
            </div>
          </Show>
        </Show>
      </ScrollView>
    </div>
  )
}

function ToolCard(props: { record: IndustrialAuditRecord }) {
  const language = useLanguage()
  const completed = () => props.record.state === "completed"
  const outcome = () => (props.record.state === "completed" ? props.record.outcome : undefined)
  const color = () => {
    if (!completed()) return "var(--syntax-info)"
    return outcome() === "success" ? "var(--syntax-success)" : "var(--syntax-error)"
  }

  return (
    <div
      class="flex flex-col gap-2 rounded-md p-3 border border-border-weak"
      style={{ background: "var(--background-element)" }}
    >
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          <span class="text-11-medium px-1.5 py-0.5 rounded" style={{ color: "var(--background-base)", background: color() }}>
            {completed()
              ? language.t("audit.tools.state.completed")
              : language.t("audit.tools.state.running")}
          </span>
          <span class="text-12-medium text-text-strong">{props.record.tool}</span>
        </div>
        <span class="text-11-regular text-text-weak">{formatTime(props.record.startedAt)}</span>
      </div>
      <div class="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Field label={language.t("audit.field.permission")} value={props.record.permission} />
        <Field label={language.t("audit.field.session")} value={props.record.sessionID} />
        <Show when={outcome()}>{(value) => <Field label={language.t("audit.field.outcome")} value={value()} />}</Show>
      </div>
    </div>
  )
}

function EmptyState(props: { message: string }) {
  return (
    <div class="flex flex-col items-center justify-center gap-2 py-16 text-text-weak">
      <Icon name="archive" size="large" />
      <span class="text-12-regular">{props.message}</span>
    </div>
  )
}

function ErrorState(props: { message: string; onRetry: () => void }) {
  const language = useLanguage()
  return (
    <div class="flex flex-col items-center justify-center gap-2 py-16 text-text-weak">
      <span class="text-12-regular">{props.message}</span>
      <Button variant="ghost" onClick={props.onRetry}>
        {language.t("audit.retry")}
      </Button>
    </div>
  )
}
