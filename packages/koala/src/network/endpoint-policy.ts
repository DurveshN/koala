export * as EndpointPolicy from "./endpoint-policy"

import ipaddr from "ipaddr.js"

export const DenialMessages = {
  "invalid-url": "Expected an absolute HTTP or HTTPS URL",
  "unsupported-protocol": "Expected an absolute HTTP or HTTPS URL",
  "credentials-not-allowed": "Endpoint credentials are not allowed",
  "query-not-allowed": "Endpoint query parameters are not allowed",
  "fragment-not-allowed": "Endpoint fragments are not allowed",
  "hostname-required": "A hostname is required",
  "wildcard-hostname": "Wildcard hostnames are not allowed",
  "invalid-hostname": "The hostname is invalid",
  "port-zero": "Port zero is not allowed",
  "metadata-hostname": "Metadata service hostnames are not allowed",
  "ipv6-zone-id": "IPv6 zone identifiers are not allowed",
  "noncanonical-ip-address": "Noncanonical IP address notation is not allowed",
  "invalid-address": "The resolved address is invalid",
  "invalid-address-family": "The resolved address family is invalid",
  "address-family-mismatch": "The resolved address does not match its address family",
  "unspecified-address": "Unspecified addresses are not allowed",
  "link-local-address": "Link-local addresses are not allowed",
  "multicast-address": "Multicast addresses are not allowed",
  "carrier-grade-nat-address": "Carrier-grade NAT addresses are not allowed",
  "public-address": "Public addresses are not allowed",
  "reserved-address": "Reserved addresses are not allowed",
  "metadata-address": "Metadata service addresses are not allowed",
  "ipv4-mapped-ipv6": "IPv4-mapped IPv6 addresses are not allowed",
  "empty-resolution": "DNS resolution returned no addresses",
  "mixed-resolution": "DNS resolution returned both allowed and denied addresses",
  "localhost-non-loopback": "Localhost names must resolve only to loopback addresses",
  "literal-resolution-mismatch": "The resolved address does not match the literal endpoint",
  "request-origin-mismatch": "The request URL is outside the authorized endpoint origin",
  "request-path-mismatch": "The request URL is outside the authorized endpoint path",
} as const

export type DenialCode = keyof typeof DenialMessages

export interface Denied {
  readonly ok: false
  readonly code: DenialCode
  readonly message: (typeof DenialMessages)[DenialCode]
}

export type Outcome<T> = { readonly ok: true; readonly value: T } | Denied

export interface ResolvedAddress {
  readonly address: string
  readonly family: number
}

export interface ClassifiedAddress extends ResolvedAddress {
  readonly family: 4 | 6
  readonly classification: "loopback" | "private"
}

interface EndpointBase {
  readonly url: string
  readonly protocol: "http:" | "https:"
  readonly hostname: string
  readonly port: number
  readonly origin: string
  readonly pathPrefix: string
  readonly localhost: boolean
}

export type Endpoint = EndpointBase &
  ({ readonly kind: "hostname" } | { readonly kind: "literal"; readonly address: ClassifiedAddress })

export interface AuthorizedResolution {
  readonly endpoint: Endpoint
  readonly addresses: readonly [ClassifiedAddress, ...ClassifiedAddress[]]
}

const metadataHostnames = new Set([
  "instance-data",
  "instance-data.ec2.internal",
  "metadata.aws.internal",
  "metadata.azure.internal",
  "metadata.google.internal",
  "metadata.goog",
])

const metadataAddresses = new Set([
  "100.100.100.200",
  "169.254.169.254",
  "169.254.170.2",
  "192.0.0.192",
  "fd00:ec2::23",
  "fd00:ec2::254",
  "fd20:ce::254",
])

const ipv4Loopback = ipaddr.IPv4.parseCIDR("127.0.0.0/8")
const ipv4Private = [
  ipaddr.IPv4.parseCIDR("10.0.0.0/8"),
  ipaddr.IPv4.parseCIDR("172.16.0.0/12"),
  ipaddr.IPv4.parseCIDR("192.168.0.0/16"),
]
const ipv6Loopback = ipaddr.IPv6.parseCIDR("::1/128")
const ipv6Private = ipaddr.IPv6.parseCIDR("fc00::/7")

export function parseBaseURL(input: string): Outcome<Endpoint> {
  if (input !== input.trim() || /[\u0000-\u001f\u007f\\]/.test(input)) return deny("invalid-url")

  const authority = input.match(/^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i)?.[1]
  if (authority?.startsWith("[") && authority.slice(0, authority.indexOf("]") + 1).includes("%")) {
    return deny("ipv6-zone-id")
  }
  if (!URL.canParse(input)) return deny("invalid-url")

  const url = new URL(input)
  if (url.protocol !== "http:" && url.protocol !== "https:") return deny("unsupported-protocol")
  if (!authority || !url.hostname) return deny("hostname-required")
  if (authority.includes("@") || url.username || url.password) return deny("credentials-not-allowed")
  if (input.includes("?")) return deny("query-not-allowed")
  if (input.includes("#")) return deny("fragment-not-allowed")
  if (url.port === "0") return deny("port-zero")

  const rawHostname = authority.startsWith("[")
    ? authority.slice(1, authority.indexOf("]"))
    : authority.slice(0, authority.lastIndexOf(":") === -1 ? authority.length : authority.lastIndexOf(":"))
  if (rawHostname.includes("%")) return deny("invalid-hostname")
  const hostnameResult = canonicalizeHostname(rawHostname, url.hostname)
  if (!hostnameResult.ok) return hostnameResult

  const hostname = hostnameResult.value
  if (hostname.includes("*")) return deny("wildcard-hostname")
  if (metadataHostnames.has(hostname)) return deny("metadata-hostname")

  const protocol: EndpointBase["protocol"] = url.protocol === "http:" ? "http:" : "https:"
  const port = url.port ? Number(url.port) : protocol === "http:" ? 80 : 443
  const pathPrefix = url.pathname.replace(/\/+$/, "") || "/"
  const literal = classifyLiteral(hostname)
  if (literal && !literal.ok) return literal

  const host = literal?.ok && literal.value.family === 6 ? `[${hostname}]` : hostname
  const origin = `${protocol}//${host}${port === (protocol === "http:" ? 80 : 443) ? "" : `:${port}`}`
  const endpoint = {
    url: `${origin}${pathPrefix}`,
    protocol,
    hostname,
    port,
    origin,
    pathPrefix,
    localhost: hostname === "localhost" || hostname.endsWith(".localhost"),
  }

  if (literal?.ok) return { ok: true, value: { ...endpoint, kind: "literal", address: literal.value } }
  return { ok: true, value: { ...endpoint, kind: "hostname" } }
}

export function classifyAddress(input: ResolvedAddress): Outcome<ClassifiedAddress> {
  if (input.family !== 4 && input.family !== 6) return deny("invalid-address-family")

  if (input.family === 4) {
    if (!ipaddr.IPv4.isValid(input.address)) {
      if (ipaddr.IPv6.isValid(input.address)) return deny("address-family-mismatch")
      return deny("invalid-address")
    }
    if (!ipaddr.IPv4.isValidFourPartDecimal(input.address)) return deny("noncanonical-ip-address")

    const address = ipaddr.IPv4.parse(input.address)
    const canonical = address.toString()
    if (canonical !== input.address) return deny("noncanonical-ip-address")
    if (metadataAddresses.has(canonical)) return deny("metadata-address")
    if (address.match(ipv4Loopback)) {
      return { ok: true, value: { address: canonical, family: 4, classification: "loopback" } }
    }
    if (ipv4Private.some((range) => address.match(range))) {
      return { ok: true, value: { address: canonical, family: 4, classification: "private" } }
    }
    return denyIPv4Range(address.range())
  }

  if (ipaddr.IPv4.isValid(input.address)) return deny("address-family-mismatch")
  if (!ipaddr.IPv6.isValid(input.address)) return deny("invalid-address")

  const address = ipaddr.IPv6.parse(input.address)
  if (address.zoneId) return deny("ipv6-zone-id")
  if (address.isIPv4MappedAddress()) return deny("ipv4-mapped-ipv6")

  const canonical = address.toString()
  if (metadataAddresses.has(canonical)) return deny("metadata-address")
  if (address.match(ipv6Loopback)) {
    return { ok: true, value: { address: canonical, family: 6, classification: "loopback" } }
  }
  if (address.match(ipv6Private)) {
    return { ok: true, value: { address: canonical, family: 6, classification: "private" } }
  }
  return denyIPv6Range(address.range())
}

export function authorizeResolution(
  endpoint: Endpoint,
  resolved: ReadonlyArray<ResolvedAddress>,
): Outcome<AuthorizedResolution> {
  if (resolved.length === 0) return deny("empty-resolution")

  const classified = resolved.map(classifyAddress)
  const malformed = classified.find(
    (result) =>
      !result.ok &&
      ["invalid-address", "invalid-address-family", "address-family-mismatch", "noncanonical-ip-address"].includes(
        result.code,
      ),
  )
  if (malformed && !malformed.ok) return malformed

  const allowed = classified.flatMap((result) => (result.ok ? [result.value] : []))
  const denied = classified.filter((result) => !result.ok)
  if (allowed.length > 0 && denied.length > 0) return deny("mixed-resolution")
  if (allowed.length === 0) return denied[0] ?? deny("empty-resolution")
  if (endpoint.localhost && allowed.some((address) => address.classification !== "loopback")) {
    return deny("localhost-non-loopback")
  }

  const unique = [...new Map(allowed.map((address) => [`${address.family}:${address.address}`, address])).values()]
  const first = unique[0]
  if (!first) return deny("empty-resolution")
  if (
    endpoint.kind === "literal" &&
    unique.some((address) => address.family !== endpoint.address.family || address.address !== endpoint.address.address)
  ) {
    return deny("literal-resolution-mismatch")
  }
  return { ok: true, value: { endpoint, addresses: [first, ...unique.slice(1)] } }
}

export function authorizeRequest(endpoint: Endpoint, input: string | URL): Outcome<URL> {
  const value = input instanceof URL ? input.href : input
  if (!URL.canParse(value)) return deny("invalid-url")

  const request = new URL(value)
  const authority = request.href.match(/^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i)?.[1]
  if (authority?.includes("@") || request.username || request.password) return deny("credentials-not-allowed")
  if (request.protocol !== "http:" && request.protocol !== "https:") return deny("unsupported-protocol")

  const hostnameResult = canonicalizeHostname(
    request.hostname.startsWith("[") ? request.hostname.slice(1, -1) : request.hostname,
    request.hostname,
  )
  if (!hostnameResult.ok) return hostnameResult

  const port = request.port ? Number(request.port) : request.protocol === "http:" ? 80 : 443
  if (request.protocol !== endpoint.protocol || hostnameResult.value !== endpoint.hostname || port !== endpoint.port) {
    return deny("request-origin-mismatch")
  }
  if (
    endpoint.pathPrefix !== "/" &&
    request.pathname !== endpoint.pathPrefix &&
    !request.pathname.startsWith(`${endpoint.pathPrefix}/`)
  ) {
    return deny("request-path-mismatch")
  }
  return { ok: true, value: request }
}

export function isRedirectStatus(status: number) {
  return Number.isInteger(status) && status >= 300 && status < 400
}

function canonicalizeHostname(rawHostname: string, parsedHostname: string): Outcome<string> {
  const parsed = parsedHostname.startsWith("[") ? parsedHostname.slice(1, -1) : parsedHostname
  if (!parsed) return deny("hostname-required")

  if (ipaddr.IPv4.isValid(parsed)) {
    if (!ipaddr.IPv4.isValidFourPartDecimal(rawHostname)) return deny("noncanonical-ip-address")
    const canonical = ipaddr.IPv4.parse(parsed).toString()
    if (rawHostname !== canonical) return deny("noncanonical-ip-address")
    return { ok: true, value: canonical }
  }

  if (ipaddr.IPv6.isValid(parsed)) {
    const address = ipaddr.IPv6.parse(parsed)
    if (address.zoneId || rawHostname.includes("%")) return deny("ipv6-zone-id")
    return { ok: true, value: address.toString() }
  }

  const hostname = parsed.toLowerCase().replace(/\.$/, "")
  if (!hostname) return deny("hostname-required")
  if (hostname.includes("*")) return deny("wildcard-hostname")
  if (
    hostname.length > 253 ||
    hostname
      .split(".")
      .some((label) => label.length === 0 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))
  ) {
    return deny("invalid-hostname")
  }
  return { ok: true, value: hostname }
}

function classifyLiteral(hostname: string) {
  if (ipaddr.IPv4.isValid(hostname)) return classifyAddress({ address: hostname, family: 4 })
  if (ipaddr.IPv6.isValid(hostname)) return classifyAddress({ address: hostname, family: 6 })
  return undefined
}

function denyIPv4Range(range: ReturnType<InstanceType<typeof ipaddr.IPv4>["range"]>): Denied {
  if (range === "unspecified") return deny("unspecified-address")
  if (range === "linkLocal") return deny("link-local-address")
  if (range === "multicast") return deny("multicast-address")
  if (range === "carrierGradeNat") return deny("carrier-grade-nat-address")
  if (range === "unicast") return deny("public-address")
  return deny("reserved-address")
}

function denyIPv6Range(range: ReturnType<InstanceType<typeof ipaddr.IPv6>["range"]>): Denied {
  if (range === "unspecified") return deny("unspecified-address")
  if (range === "linkLocal") return deny("link-local-address")
  if (range === "multicast") return deny("multicast-address")
  if (range === "unicast") return deny("public-address")
  return deny("reserved-address")
}

function deny(code: DenialCode): Denied {
  return { ok: false, code, message: DenialMessages[code] }
}
