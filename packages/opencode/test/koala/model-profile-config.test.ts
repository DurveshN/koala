import { afterEach, beforeEach, describe, expect } from "bun:test"
import { mkdir, rm } from "fs/promises"
import path from "path"
import { ModelProfile } from "@koala-ai/core/model/profile"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Env } from "@/env"
import { ModelProfileStore } from "@/koala/model-profile-store"
import { Auth } from "@/auth"
import { Account } from "@/account/account"
import { Npm } from "@opencode-ai/core/npm"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const data = path.join(Global.Path.data, "model-profile-config-tests")
const document = path.join(data, "koala", "model-profiles.json")
const unexpectedHttp = HttpClient.make((request) =>
  Effect.die(`unexpected http request: ${request.method} ${request.url}`),
)

const layer = LayerNode.compile(
  LayerNode.group([Config.node, ModelProfileStore.node, FSUtil.node, Env.node, CrossSpawnSpawner.node]),
  [
    [Global.node, Global.layerWith({ data, state: data })],
    [Auth.node, AuthTest.empty],
    [Account.node, AccountTest.empty],
    [Npm.node, NpmTest.noop],
    [httpClient, Layer.succeed(HttpClient.HttpClient, unexpectedHttp)],
  ],
)
const it = testEffect(layer)
const decodeProvider = Schema.decodeUnknownSync(ModelProfile.Provider)

const profile = (enabled = true) =>
  decodeProvider({
    id: "local",
    displayName: "Koala Local",
    baseURL: "http://127.0.0.1:11434/v1",
    secretReference: "keychain:local",
    models: [
      {
        id: "koala-model",
        displayName: "Koala Model",
        capabilities: {
          textInput: "yes",
          imageInput: "yes",
          toolCalling: "no",
          streaming: "yes",
          structuredOutput: "unknown",
          reasoning: "yes",
        },
        contextWindow: 131_072,
        maxOutput: 16_384,
        roles: ["general", "coding", "vision"],
        enabled,
        priority: 20,
      },
    ],
  })

beforeEach(() => rm(data, { recursive: true, force: true }))
afterEach(() => rm(data, { recursive: true, force: true }))

describe("Koala model profile config projection", () => {
  it.instance(
    "projects profiles exactly, preserves unrelated providers, and overrides matching providers",
    () =>
      Effect.gen(function* () {
        const store = yield* ModelProfileStore.Service
        yield* store.create(profile())

        const config = yield* Config.use.get()
        expect(config.provider?.ordinary).toEqual({
          name: "Ordinary Provider",
          npm: "@ai-sdk/openai-compatible",
          api: "https://ordinary.example/v1",
          models: {
            ordinary: {
              name: "Ordinary Model",
              limit: { context: 8_192, output: 2_048 },
            },
          },
        })
        expect(config.provider?.local).toEqual({
          name: "Koala Local",
          npm: "@ai-sdk/openai-compatible",
          api: "http://127.0.0.1:11434/v1",
          models: {
            "koala-model": {
              name: "Koala Model",
              attachment: true,
              tool_call: false,
              reasoning: true,
              limit: { context: 131_072, output: 16_384 },
              modalities: { input: ["text", "image"], output: ["text"] },
            },
          },
        })
      }),
    {
      config: {
        provider: {
          ordinary: {
            name: "Ordinary Provider",
            npm: "@ai-sdk/openai-compatible",
            api: "https://ordinary.example/v1",
            models: {
              ordinary: {
                name: "Ordinary Model",
                limit: { context: 8_192, output: 2_048 },
              },
            },
          },
          local: {
            name: "Stale Local",
            npm: "stale-package",
            api: "https://stale.example/v1",
            options: { apiKey: "stale-key" },
            models: { stale: { name: "Stale Model" } },
          },
        },
      },
    },
  )

  it.instance("omits a profile when all of its models are disabled", () =>
    Effect.gen(function* () {
      const store = yield* ModelProfileStore.Service
      yield* store.create(profile(false))

      expect((yield* Config.use.get()).provider?.local).toBeUndefined()
    }),
  )

  it.instance("fails config loading when the profile document is malformed", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => mkdir(path.dirname(document), { recursive: true }))
      yield* Effect.promise(() => Bun.write(document, "{ malformed"))

      const exit = yield* Effect.exit(Config.use.get())
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toBeInstanceOf(ModelProfileStore.ReadError)
      }
    }),
  )

  it.instance(
    "does not write projected providers into opencode.json",
    () =>
      Effect.gen(function* () {
        const instance = yield* TestInstance
        const store = yield* ModelProfileStore.Service
        const filepath = path.join(instance.directory, "opencode.json")
        const before = yield* Effect.promise(() => Bun.file(filepath).text())
        yield* store.create(profile())

        expect((yield* Config.use.get()).provider?.local).toBeDefined()
        expect(yield* Effect.promise(() => Bun.file(filepath).text())).toBe(before)
        expect(JSON.parse(before).provider).toEqual({
          ordinary: { name: "Ordinary Provider" },
        })
      }),
    { config: { provider: { ordinary: { name: "Ordinary Provider" } } } },
  )
})
