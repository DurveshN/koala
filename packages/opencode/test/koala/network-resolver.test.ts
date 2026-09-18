import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { NetworkResolver } from "../../src/koala/network-resolver"
import { it } from "../lib/effect"

describe("NetworkResolver", () => {
  it.live("returns all validated answers in resolver order", () => {
    const calls: string[] = []
    return Effect.gen(function* () {
      const resolver = yield* NetworkResolver.Service

      expect(yield* resolver.resolve("model.internal")).toEqual([
        { address: "127.0.0.1", family: 4 },
        { address: "fd00::1", family: 6 },
      ])
      expect(calls).toEqual(["model.internal"])
    }).pipe(
      Effect.provide(
        NetworkResolver.layerWith({
          lookup: (hostname) => {
            calls.push(hostname)
            return Promise.resolve([
              { address: "127.0.0.1", family: 4 },
              { address: "fd00::1", family: 6 },
            ])
          },
        }),
      ),
    )
  })

  it.live("rejects malformed and excessive answer sets", () =>
    Effect.gen(function* () {
      const malformed = yield* NetworkResolver.Service
      expect((yield* malformed.resolve("model.internal").pipe(Effect.flip)).rule).toBe("invalid-result")

      const nonArray = yield* NetworkResolver.Service.pipe(
        Effect.provide(
          NetworkResolver.layerWith({ lookup: () => Promise.resolve({ address: "127.0.0.1", family: 4 }) }),
        ),
      )
      expect((yield* nonArray.resolve("model.internal").pipe(Effect.flip)).rule).toBe("invalid-result")

      const excessive = yield* NetworkResolver.Service.pipe(
        Effect.provide(
          NetworkResolver.layerWith({
            maxAddresses: 1,
            lookup: () =>
              Promise.resolve([
                { address: "127.0.0.1", family: 4 },
                { address: "127.0.0.2", family: 4 },
              ]),
          }),
        ),
      )
      expect((yield* excessive.resolve("model.internal").pipe(Effect.flip)).rule).toBe("answer-limit")
    }).pipe(
      Effect.provide(
        NetworkResolver.layerWith({
          lookup: () => Promise.resolve([{ address: "not-an-address", family: 4 }]),
        }),
      ),
    ),
  )

  it.live("bounds lookup duration and redacts lookup failures", () =>
    Effect.gen(function* () {
      const timeout = yield* NetworkResolver.Service
      const timeoutError = yield* timeout.resolve("timeout-secret.internal").pipe(Effect.flip)
      expect(timeoutError).toBeInstanceOf(NetworkResolver.ResolutionError)
      expect(timeoutError.rule).toBe("lookup-timeout")
      expect(timeoutError.message).not.toContain("timeout-secret")

      const failed = yield* NetworkResolver.Service.pipe(
        Effect.provide(
          NetworkResolver.layerWith({
            lookup: () => Promise.reject(new Error("resolver-secret-canary")),
          }),
        ),
      )
      const failedError = yield* failed.resolve("failure-secret.internal").pipe(Effect.flip)
      expect(failedError.rule).toBe("lookup-failed")
      expect(failedError.message).not.toContain("resolver-secret-canary")
      expect(failedError.message).not.toContain("failure-secret")
    }).pipe(
      Effect.provide(
        NetworkResolver.layerWith({
          timeout: "10 millis",
          lookup: () => new Promise(() => {}),
        }),
      ),
    ),
  )
})
