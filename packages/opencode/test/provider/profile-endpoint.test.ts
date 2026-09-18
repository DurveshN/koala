import { afterEach, describe, expect } from "bun:test"
import http from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import { ModelProfile } from "@koala-ai/core/model/profile"
import { EndpointPolicy } from "@koala-ai/core/network/endpoint-policy"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import { streamText } from "ai"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { ModelEndpointClient } from "@/koala/model-endpoint-client"
import { ModelProfileStore } from "@/koala/model-profile-store"
import { NetworkResolver } from "@/koala/network-resolver"
import { Provider } from "@/provider/provider"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { it } from "../lib/effect"

const decodeProfile = Schema.decodeUnknownSync(ModelProfile.Provider)

afterEach(async () => {
  await disposeAllInstances()
})

function profile(id: string, baseURL: string) {
  return decodeProfile({
    id,
    displayName: `Profile ${id}`,
    baseURL,
    secretReference: `keychain:${id}`,
    models: [
      {
        id: "profile-model",
        displayName: "Profile Model",
        capabilities: {
          textInput: "yes",
          imageInput: "no",
          toolCalling: "yes",
          streaming: "yes",
          structuredOutput: "unknown",
          reasoning: "no",
        },
        contextWindow: 8_192,
        maxOutput: 2_048,
        roles: ["general"],
        enabled: true,
        priority: 1,
      },
    ],
  })
}

function providerLayer(
  profiles: ReadonlyArray<ModelProfile.Provider>,
  lookup: (hostname: string) => PromiseLike<ReadonlyArray<EndpointPolicy.ResolvedAddress>>,
) {
  return LayerNode.compile(LayerNode.group([Provider.node, CrossSpawnSpawner.node]), [
    [
      ModelProfileStore.node,
      Layer.mock(ModelProfileStore.Service, {
        list: () => Effect.succeed(profiles),
      }),
    ],
    [NetworkResolver.node, NetworkResolver.layerWith({ lookup })],
  ])
}

function deniedProviderLayer(item: ModelProfile.Provider) {
  return LayerNode.compile(LayerNode.group([Provider.node, CrossSpawnSpawner.node]), [
    [
      ModelProfileStore.node,
      Layer.mock(ModelProfileStore.Service, {
        list: () => Effect.succeed([item]),
      }),
    ],
    [
      ModelEndpointClient.node,
      Layer.mock(ModelEndpointClient.Service, {
        bind: () =>
          Effect.fail(
            new ModelEndpointClient.PolicyError({ rule: "public-address", origin: new URL(item.baseURL).origin }),
          ),
      }),
    ],
  ])
}

function withAuth<A, E, R>(keys: Record<string, string>, effect: Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env.OPENCODE_AUTH_CONTENT
      process.env.OPENCODE_AUTH_CONTENT = JSON.stringify(
        Object.fromEntries(Object.entries(keys).map(([id, key]) => [id, { type: "api", key }])),
      )
      return previous
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env.OPENCODE_AUTH_CONTENT
        else process.env.OPENCODE_AUTH_CONTENT = previous
      }),
  )
}

function withServer<A, E, R>(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  use: (port: number) => Effect.Effect<A, E, R>,
) {
  return Effect.acquireUseRelease(
    Effect.promise(
      () =>
        new Promise<http.Server>((resolve, reject) => {
          const server = http.createServer(handler)
          server.once("error", reject)
          server.listen(0, "127.0.0.1", () => resolve(server))
        }),
    ),
    (server) => {
      const address = server.address()
      if (!address || typeof address === "string") return Effect.die("Expected a TCP server address")
      return use(address.port)
    },
    (server) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            server.closeAllConnections()
            server.close(() => resolve())
          }),
      ),
  )
}

const prompt = [{ role: "user" as const, content: "hello" }]

async function collectError(model: LanguageModelV3) {
  const result = streamText({ model, messages: prompt, onError() {} })
  for await (const part of result.fullStream) {
    if (part.type === "error") return part.error
  }
}

function hasCause(error: unknown, check: (cause: unknown) => boolean) {
  const seen = new Set<unknown>()
  let cause = error
  while (cause && typeof cause === "object" && !seen.has(cause)) {
    if (check(cause)) return true
    seen.add(cause)
    cause = "cause" in cause ? cause.cause : undefined
  }
  return false
}

describe("profile-backed provider inference transport", () => {
  it.live("uses the pinned client and preserves API-key authorization", () => {
    const resolutions: string[] = []
    const authorizations: Array<string | undefined> = []
    let configuredFetchCalls = 0
    return withServer(
      (request, response) => {
        authorizations.push(request.headers.authorization)
        response.writeHead(200, { "content-type": "text/event-stream" })
        response.end('data: {"choices":[{"delta":{"content":"pinned"}}]}\n\ndata: [DONE]\n\n')
      },
      (port) => {
        const item = profile("profile-local", `http://model.internal:${port}/v1`)
        return withAuth(
          { "profile-local": "profile-secret" },
          provideTmpdirInstance(() =>
            Effect.gen(function* () {
              const provider = yield* Provider.Service
              const configured = yield* provider.getProvider(ProviderV2.ID.make("profile-local"))
              configured.options.baseURL = "http://127.0.0.1:1/escape"
              configured.options.fetch = async () => {
                configuredFetchCalls++
                throw new Error("configured fetch must not run")
              }
              const model = yield* provider.getModel(
                ProviderV2.ID.make("profile-local"),
                ModelV2.ID.make("profile-model"),
              )
              expect(model.api.npm).toBe("@ai-sdk/openai-compatible")
              const result = streamText({ model: yield* provider.getLanguage(model), messages: prompt })

              expect(yield* Effect.promise(() => result.text)).toBe("pinned")
              expect(resolutions).toEqual(["model.internal"])
              expect(authorizations).toEqual(["Bearer profile-secret"])
              expect(configuredFetchCalls).toBe(0)
            }),
          ).pipe(
            Effect.provide(
              providerLayer([item], (hostname) => {
                resolutions.push(hostname)
                return Promise.resolve([{ address: "127.0.0.1", family: 4 }])
              }),
            ),
          ),
        )
      },
    )
  })

  it.live("denies public and mixed DNS answers before connecting", () => {
    let requests = 0
    return withServer(
      (_request, response) => {
        requests++
        response.end("unexpected")
      },
      (port) => {
        const profiles = [
          profile("profile-public", `http://public.internal:${port}/v1`),
          profile("profile-mixed", `http://mixed.internal:${port}/v1`),
        ]
        return withAuth(
          { "profile-public": "public-secret", "profile-mixed": "mixed-secret" },
          provideTmpdirInstance(() =>
            Effect.gen(function* () {
              const provider = yield* Provider.Service
              for (const id of ["profile-public", "profile-mixed"]) {
                const model = yield* provider.getModel(ProviderV2.ID.make(id), ModelV2.ID.make("profile-model"))
                const language = yield* provider.getLanguage(model)
                const error = yield* Effect.promise(() => collectError(language))
                expect(hasCause(error, (cause) => cause instanceof ModelEndpointClient.PolicyError)).toBe(true)
              }
              expect(requests).toBe(0)
            }),
          ).pipe(
            Effect.provide(
              providerLayer(profiles, (hostname) =>
                Promise.resolve(
                  hostname === "public.internal"
                    ? [{ address: "8.8.8.8", family: 4 }]
                    : [
                        { address: "127.0.0.1", family: 4 },
                        { address: "8.8.8.8", family: 4 },
                      ],
                ),
              ),
            ),
          ),
        )
      },
    )
  })

  it.live("does not follow redirects from profile endpoints", () => {
    let redirects = 0
    let targets = 0
    return withServer(
      (request, response) => {
        if (request.url === "/target") {
          targets++
          response.end("followed")
          return
        }
        redirects++
        response.writeHead(302, { location: "/target" })
        response.end()
      },
      (port) => {
        const item = profile("profile-redirect", `http://redirect.internal:${port}/v1`)
        return withAuth(
          { "profile-redirect": "redirect-secret" },
          provideTmpdirInstance(() =>
            Effect.gen(function* () {
              const provider = yield* Provider.Service
              const model = yield* provider.getModel(
                ProviderV2.ID.make("profile-redirect"),
                ModelV2.ID.make("profile-model"),
              )
              const language = yield* provider.getLanguage(model)
              const error = yield* Effect.promise(() => collectError(language))
              expect(hasCause(error, (cause) => cause instanceof ModelEndpointClient.RedirectError)).toBe(true)
              expect(redirects).toBe(1)
              expect(targets).toBe(0)
            }),
          ).pipe(Effect.provide(providerLayer([item], () => Promise.resolve([{ address: "127.0.0.1", family: 4 }])))),
        )
      },
    )
  })

  it.live("fails profile model resolution when endpoint binding is denied", () => {
    const item = profile("profile-denied", "http://denied.internal:11434/v1")
    return withAuth(
      { "profile-denied": "denied-secret" },
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderV2.ID.make("profile-denied"), ModelV2.ID.make("profile-model"))
          const exit = yield* Effect.exit(provider.getLanguage(model))
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) {
            const error = Cause.squash(exit.cause)
            expect(error).toBeInstanceOf(Provider.InitError)
            expect((error as Provider.InitError).cause).toBeInstanceOf(ModelEndpointClient.PolicyError)
          }
        }),
      ).pipe(Effect.provide(deniedProviderLayer(item))),
    )
  })

  it.live("keeps an unrelated configured provider's fetch transport", () => {
    const item = profile("profile-local", "http://profile.internal:11434/v1")
    let fetchCalls = 0
    return provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const configured = yield* provider.getProvider(ProviderV2.ID.make("ordinary"))
          configured.options.fetch = async () => {
            fetchCalls++
            return new Response('data: {"choices":[{"delta":{"content":"ordinary"}}]}\n\ndata: [DONE]\n\n', {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            })
          }
          const model = yield* provider.getModel(ProviderV2.ID.make("ordinary"), ModelV2.ID.make("ordinary-model"))
          const result = streamText({ model: yield* provider.getLanguage(model), messages: prompt })

          expect(yield* Effect.promise(() => result.text)).toBe("ordinary")
          expect(fetchCalls).toBe(1)
        }),
      {
        config: {
          provider: {
            ordinary: {
              name: "Ordinary",
              npm: "@ai-sdk/openai-compatible",
              api: "https://ordinary.example/v1",
              models: {
                "ordinary-model": {
                  name: "Ordinary Model",
                  limit: { context: 8_192, output: 2_048 },
                },
              },
              options: { apiKey: "ordinary-secret" },
            },
          },
        },
      },
    ).pipe(
      Effect.provide(
        providerLayer([item], () => Promise.reject(new Error("profile DNS must not run for ordinary provider"))),
      ),
    )
  })
})
