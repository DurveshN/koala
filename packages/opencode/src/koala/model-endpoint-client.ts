import http from "node:http"
import https from "node:https"
import type { LookupFunction } from "node:net"
import { EndpointPolicy } from "@koala-ai/core/network/endpoint-policy"
import { ModelProfile } from "@koala-ai/core/model/profile"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Context, Effect, Layer, Schema } from "effect"
import { NetworkResolver } from "./network-resolver"

const forbiddenHeaders = new Set([
  "connection",
  "host",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
])

const forbiddenOverrides = [
  "agent",
  "auth",
  "autoSelectFamily",
  "ca",
  "cert",
  "checkServerIdentity",
  "createConnection",
  "dispatcher",
  "family",
  "hints",
  "host",
  "hostname",
  "key",
  "localAddress",
  "localPort",
  "lookup",
  "path",
  "pfx",
  "port",
  "protocol",
  "proxy",
  "rejectUnauthorized",
  "secureContext",
  "servername",
  "setHost",
  "socketPath",
  "tls",
  "unix",
] as const

export class PolicyError extends Schema.TaggedErrorClass<PolicyError>()("KoalaModelEndpointPolicyError", {
  rule: Schema.String,
  origin: Schema.String,
}) {
  override get message() {
    return `Model endpoint request denied (${this.rule}) for ${this.origin}`
  }
}

export class TransportError extends Schema.TaggedErrorClass<TransportError>()("KoalaModelEndpointTransportError", {
  origin: Schema.String,
}) {
  override get message() {
    return `Model endpoint transport failed for ${this.origin}`
  }
}

export class RedirectError extends Schema.TaggedErrorClass<RedirectError>()("KoalaModelEndpointRedirectError", {
  origin: Schema.String,
  status: Schema.Int,
}) {
  override get message() {
    return `Model endpoint redirect denied (${this.status}) for ${this.origin}`
  }
}

export interface BoundClient {
  readonly providerID: ModelProfile.ProviderID
  readonly baseURL: ModelProfile.BaseURL
  readonly fetch: Fetch
}

export interface Options {
  readonly providerID: ModelProfile.ProviderID
  readonly baseURL: ModelProfile.BaseURL
}

export type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export interface Interface {
  readonly bind: (options: Options) => Effect.Effect<BoundClient, PolicyError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/KoalaModelEndpointClient") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const resolver = yield* NetworkResolver.Service
    const bind = Effect.fn("ModelEndpointClient.bind")(function* (options: Options) {
      const parsed = EndpointPolicy.parseBaseURL(options.baseURL)
      if (!parsed.ok) return yield* new PolicyError({ rule: parsed.code, origin: "invalid" })

      const endpoint = parsed.value
      const fetch: Fetch = async (input, init) => {
        try {
          const requestURL = input instanceof Request ? input.url : input
          const authorizedRequest = EndpointPolicy.authorizeRequest(endpoint, requestURL)
          if (!authorizedRequest.ok) throw new PolicyError({ rule: authorizedRequest.code, origin: endpoint.origin })

          if (init && forbiddenOverrides.some((name) => Object.hasOwn(init, name))) {
            throw new PolicyError({ rule: "transport-override", origin: endpoint.origin })
          }

          const request = new Request(input, {
            ...(init?.method !== undefined && { method: init.method }),
            ...(init?.headers !== undefined && { headers: init.headers }),
            ...(init?.body !== undefined && { body: init.body }),
            ...(init?.signal !== undefined && { signal: init.signal }),
            redirect: "manual",
          })
          if ([...request.headers.keys()].some((name) => forbiddenHeaders.has(name.toLowerCase()))) {
            throw new PolicyError({ rule: "unsafe-header", origin: endpoint.origin })
          }
          if (request.signal.aborted) throw abortError()

          if (endpoint.kind === "literal") {
            const authorized = EndpointPolicy.authorizeResolution(endpoint, [endpoint.address])
            if (!authorized.ok) throw new PolicyError({ rule: authorized.code, origin: endpoint.origin })
          }

          const socketLookup: LookupFunction | undefined =
            endpoint.kind === "literal"
              ? undefined
              : (hostname, lookupOptions, callback) => {
                  if (hostname.toLowerCase().replace(/\.$/, "") !== endpoint.hostname) {
                    callback(new PolicyError({ rule: "request-origin-mismatch", origin: endpoint.origin }), "", 0)
                    return
                  }

                  Effect.runPromise(resolver.resolve(hostname)).then(
                    (addresses) => {
                      const authorized = EndpointPolicy.authorizeResolution(endpoint, addresses)
                      if (!authorized.ok) {
                        callback(new PolicyError({ rule: authorized.code, origin: endpoint.origin }), "", 0)
                        return
                      }
                      const address = authorized.value.addresses[0]
                      callback(
                        null,
                        lookupOptions.all ? [{ address: address.address, family: address.family }] : address.address,
                        lookupOptions.all ? undefined : address.family,
                      )
                    },
                    () => callback(new TransportError({ origin: endpoint.origin }), "", 0),
                  )
                }

          return await dispatch(request, authorizedRequest.value, endpoint, socketLookup)
        } catch (error) {
          if (error instanceof PolicyError || error instanceof RedirectError || error instanceof TransportError)
            throw error
          if ((input instanceof Request ? input.signal : init?.signal)?.aborted) throw abortError()
          if (error instanceof DOMException && error.name === "AbortError") throw abortError()
          throw new TransportError({ origin: endpoint.origin })
        }
      }

      return { providerID: options.providerID, baseURL: options.baseURL, fetch }
    })

    return Service.of({ bind })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [NetworkResolver.node] })

function dispatch(request: Request, url: URL, endpoint: EndpointPolicy.Endpoint, lookup: LookupFunction | undefined) {
  return new Promise<Response>((resolve, reject) => {
    const clientRequest = (endpoint.protocol === "http:" ? http.request : https.request)(
      {
        protocol: endpoint.protocol,
        hostname: endpoint.hostname,
        port: endpoint.port,
        method: request.method,
        path: `${url.pathname}${url.search}`,
        headers: Object.fromEntries(request.headers.entries()),
        signal: request.signal,
        agent: false,
        ...(lookup && { lookup }),
        ...(endpoint.protocol === "https:" && endpoint.kind === "hostname" && { servername: endpoint.hostname }),
      },
      (response) => {
        if (EndpointPolicy.isRedirectStatus(response.statusCode ?? 0)) {
          response.destroy()
          reject(new RedirectError({ origin: endpoint.origin, status: response.statusCode ?? 300 }))
          return
        }

        const headers = new Headers()
        response.rawHeaders.forEach((value, index, values) => {
          if (index % 2 === 0) headers.append(value, values[index + 1] ?? "")
        })
        const empty = request.method === "HEAD" || [204, 205, 304].includes(response.statusCode ?? 0)
        resolve(
          new Response(empty ? null : responseBody(response, endpoint.origin, request.signal), {
            status: response.statusCode,
            statusText: response.statusMessage,
            headers,
          }),
        )
      },
    )

    clientRequest.on("error", reject)
    if (!request.body) {
      clientRequest.end()
      return
    }
    const reader = request.body.getReader()
    const write = (): Promise<void> =>
      reader.read().then((part) => {
        if (part.done) {
          clientRequest.end()
          return
        }
        if (clientRequest.write(part.value)) return write()
        return new Promise<void>((resume) => clientRequest.once("drain", resume)).then(write)
      })
    write().catch((error) => clientRequest.destroy(error instanceof Error ? error : undefined))
  })
}

function responseBody(response: http.IncomingMessage, origin: string, signal: AbortSignal) {
  response.pause()
  let settled = false
  return new ReadableStream<Uint8Array>({
    start(controller) {
      response.on("data", (chunk: Uint8Array) => {
        if (settled) return
        controller.enqueue(new Uint8Array(chunk))
        response.pause()
      })
      response.once("end", () => {
        if (settled) return
        settled = true
        controller.close()
      })
      const fail = () => {
        if (settled) return
        settled = true
        controller.error(signal.aborted ? abortError() : new TransportError({ origin }))
      }
      response.once("aborted", fail)
      response.once("error", fail)
    },
    pull() {
      response.resume()
    },
    cancel() {
      settled = true
      response.destroy()
    },
  })
}

function abortError() {
  return new DOMException("The operation was aborted", "AbortError")
}

export * as ModelEndpointClient from "./model-endpoint-client"
