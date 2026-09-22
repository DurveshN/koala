import { afterEach, beforeEach, describe, expect } from "bun:test"
import { DocumentRuntime } from "@/document/runtime"
import { ToolRegistry } from "@/tool/registry"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"
import { disposeAllInstances } from "../fixture/fixture"

const configLayer = TestConfig.layer({
  directories: () => InstanceState.directory.pipe(Effect.map((dir) => [])),
})

const documentToolIDs = [
  "docx_create",
  "docx_read",
  "pptx_read",
  "spreadsheet_read",
  "pdf_read",
  "ocr_extract",
  "vision_analyze",
  "document_extract",
]

const unavailableRuntime = Layer.mock(DocumentRuntime.Service, {
  availability: () =>
    Effect.succeed({
      status: "unavailable",
      code: "runtime-unavailable",
    } as DocumentRuntime.Availability),
})

const availableRuntime = Layer.mock(DocumentRuntime.Service, {
  availability: () =>
    Effect.succeed({
      status: "available",
      target: {} as any,
      runtimeVersion: "1",
      releaseReady: true,
    } as DocumentRuntime.Availability),
})

const root = LayerNode.group([ToolRegistry.node, Agent.node])

const baseReplacements = [
  [Config.node, configLayer],
  [RuntimeFlags.node, RuntimeFlags.layer()],
] as const

afterEach(async () => {
  delete process.env.KOALA_ENABLE_DOCUMENT_TOOLS
  await disposeAllInstances()
})

describe("tool.registry.document", () => {
  testEffect(LayerNode.compile(root, [...baseReplacements, [DocumentRuntime.node, unavailableRuntime]])).instance(
    "hides document tools when runtime is unavailable and env flag is unset",
    () =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        const ids = yield* registry.ids()

        for (const id of documentToolIDs) {
          expect(ids).not.toContain(id)
        }
      }),
  )

  testEffect(LayerNode.compile(root, [...baseReplacements, [DocumentRuntime.node, unavailableRuntime]])).instance(
    "shows document tools when KOALA_ENABLE_DOCUMENT_TOOLS is set",
    () => {
      process.env.KOALA_ENABLE_DOCUMENT_TOOLS = "1"
      return Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        const ids = yield* registry.ids()

        for (const id of documentToolIDs) {
          expect(ids).toContain(id)
        }
      })
    },
  )

  testEffect(
    LayerNode.compile(root, [
      ...baseReplacements,
      [DocumentRuntime.node, availableRuntime],
      [RuntimeFlags.node, RuntimeFlags.layer({ agentExecution: "sandbox" })],
    ]),
  ).instance("shows document tools under sandbox execution when runtime is available", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()

      for (const id of documentToolIDs) {
        expect(ids).toContain(id)
      }
    }),
  )
})
