import { describe, expect, test } from "bun:test"
import { EndpointPolicy } from "./endpoint-policy"

const endpoint = (value: string) => {
  const result = EndpointPolicy.parseBaseURL(value)
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`)
  return result.value
}

const denial = <T>(result: EndpointPolicy.Outcome<T>) => {
  if (result.ok) throw new Error("Expected endpoint policy denial")
  return result
}

describe("EndpointPolicy.parseBaseURL", () => {
  test.each([
    "127.0.0.0",
    "127.255.255.255",
    "10.0.0.0",
    "10.255.255.255",
    "172.16.0.0",
    "172.31.255.255",
    "192.168.0.0",
    "192.168.255.255",
  ])("allows IPv4 boundary %s", (address) => {
    const result = endpoint(`http://${address}:11434/v1`)

    expect(result).toMatchObject({ kind: "literal", hostname: address, port: 11434 })
  })

  test.each(["::1", "fc00::", "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"])("allows IPv6 boundary %s", (address) => {
    expect(endpoint(`http://[${address}]/v1`)).toMatchObject({ kind: "literal", protocol: "http:" })
  })

  test.each([
    ["http://0.0.0.0", "unspecified-address"],
    ["http://169.254.1.1", "link-local-address"],
    ["http://224.0.0.1", "multicast-address"],
    ["http://100.64.0.1", "carrier-grade-nat-address"],
    ["http://8.8.8.8", "public-address"],
    ["http://192.0.2.1", "reserved-address"],
    ["http://[::]", "unspecified-address"],
    ["http://[fe80::1]", "link-local-address"],
    ["http://[ff02::1]", "multicast-address"],
    ["http://[2001:4860:4860::8888]", "public-address"],
    ["http://[2001:db8::1]", "reserved-address"],
    ["http://[::ffff:127.0.0.1]", "ipv4-mapped-ipv6"],
  ] as const)("denies %s as %s", (value, code) => {
    expect(denial(EndpointPolicy.parseBaseURL(value)).code).toBe(code)
  })

  test.each([
    "http://169.254.169.254",
    "http://169.254.170.2",
    "http://100.100.100.200",
    "http://192.0.0.192",
    "http://[fd00:ec2::23]",
    "http://[fd00:ec2::254]",
    "http://[fd20:ce::254]",
  ])("denies metadata address %s before its general range", (value) => {
    expect(denial(EndpointPolicy.parseBaseURL(value)).code).toBe("metadata-address")
  })

  test.each([
    "metadata.google.internal",
    "metadata.google.internal.",
    "metadata.goog",
    "instance-data",
    "instance-data.ec2.internal",
    "metadata.aws.internal",
    "metadata.azure.internal",
  ])("denies metadata hostname %s", (hostname) => {
    expect(denial(EndpointPolicy.parseBaseURL(`http://${hostname}`)).code).toBe("metadata-hostname")
  })

  test.each(["http://127.1", "http://2130706433", "http://0x7f000001", "http://0177.0.0.1", "http://127.00.0.1"])(
    "denies alternate IPv4 notation %s",
    (value) => {
      expect(denial(EndpointPolicy.parseBaseURL(value)).code).toBe("noncanonical-ip-address")
    },
  )

  test.each([
    "126.255.255.255",
    "128.0.0.0",
    "9.255.255.255",
    "11.0.0.0",
    "172.15.255.255",
    "172.32.0.0",
    "192.167.255.255",
    "192.169.0.0",
  ])("denies addresses immediately outside allowed IPv4 ranges: %s", (address) => {
    expect(EndpointPolicy.parseBaseURL(`http://${address}`).ok).toBe(false)
  })

  test.each(["fbff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "fe00::"])(
    "denies addresses immediately outside allowed IPv6 ranges: %s",
    (address) => {
      expect(EndpointPolicy.parseBaseURL(`http://[${address}]`).ok).toBe(false)
    },
  )

  test("canonicalizes hostname, default port, origin, path prefix, and IPv6", () => {
    expect(endpoint("HTTP://LOCALHOST.:80/v1/")).toEqual({
      kind: "hostname",
      url: "http://localhost/v1",
      protocol: "http:",
      hostname: "localhost",
      port: 80,
      origin: "http://localhost",
      pathPrefix: "/v1",
      localhost: true,
    })
    expect(endpoint("https://[FD00:0:0:0:0:0:0:1]:443/v1/")).toMatchObject({
      url: "https://[fd00::1]/v1",
      hostname: "fd00::1",
      port: 443,
      origin: "https://[fd00::1]",
      pathPrefix: "/v1",
    })
  })

  test.each([
    ["relative/v1", "invalid-url"],
    ["http:///v1", "hostname-required"],
    ["file:///models", "unsupported-protocol"],
    ["http://user@localhost/v1", "credentials-not-allowed"],
    ["http://:secret@localhost/v1", "credentials-not-allowed"],
    ["http://localhost/v1?", "query-not-allowed"],
    ["http://localhost/v1#", "fragment-not-allowed"],
    ["http://localhost:0/v1", "port-zero"],
    ["http://*.localhost/v1", "wildcard-hostname"],
    ["http://[fe80::1%25eth0]/v1", "ipv6-zone-id"],
    ["http://%6cocalhost/v1", "invalid-hostname"],
    ["http://localhost\\models/v1", "invalid-url"],
    [" http://localhost/v1", "invalid-url"],
  ] as const)("denies invalid URL component in %s", (value, code) => {
    expect(denial(EndpointPolicy.parseBaseURL(value)).code).toBe(code)
  })
})

describe("EndpointPolicy.authorizeResolution", () => {
  const local = endpoint("http://ollama.local/v1")

  test("returns a non-empty tuple of canonical, deduplicated allowed addresses", () => {
    const result = EndpointPolicy.authorizeResolution(local, [
      { address: "10.0.0.1", family: 4 },
      { address: "fd00:0:0:0:0:0:0:1", family: 6 },
      { address: "10.0.0.1", family: 4 },
    ])

    expect(result).toEqual({
      ok: true,
      value: {
        endpoint: local,
        addresses: [
          { address: "10.0.0.1", family: 4, classification: "private" },
          { address: "fd00::1", family: 6, classification: "private" },
        ],
      },
    })
  })

  test("rejects empty and mixed DNS results", () => {
    expect(denial(EndpointPolicy.authorizeResolution(local, [])).code).toBe("empty-resolution")
    expect(
      denial(
        EndpointPolicy.authorizeResolution(local, [
          { address: "10.0.0.1", family: 4 },
          { address: "8.8.8.8", family: 4 },
        ]),
      ).code,
    ).toBe("mixed-resolution")
  })

  test.each([
    [{ address: "not-an-address", family: 4 }, "invalid-address"],
    [{ address: "::1", family: 4 }, "address-family-mismatch"],
    [{ address: "127.0.0.1", family: 6 }, "address-family-mismatch"],
    [{ address: "127.1", family: 4 }, "noncanonical-ip-address"],
    [{ address: "127.0.0.1", family: 5 }, "invalid-address-family"],
  ] as const)("rejects malformed resolution %#", (address, code) => {
    expect(denial(EndpointPolicy.authorizeResolution(local, [address])).code).toBe(code)
  })

  test("rejects localhost poisoning while allowing loopback-only answers", () => {
    const localhost = endpoint("http://api.localhost/v1")

    expect(denial(EndpointPolicy.authorizeResolution(localhost, [{ address: "10.0.0.1", family: 4 }])).code).toBe(
      "localhost-non-loopback",
    )
    expect(
      EndpointPolicy.authorizeResolution(localhost, [
        { address: "127.0.0.1", family: 4 },
        { address: "::1", family: 6 },
      ]).ok,
    ).toBe(true)
  })

  test("does not authorize a DNS result different from a literal endpoint", () => {
    expect(
      denial(EndpointPolicy.authorizeResolution(endpoint("http://10.0.0.1/v1"), [{ address: "10.0.0.2", family: 4 }]))
        .code,
    ).toBe("literal-resolution-mismatch")
  })
})

describe("EndpointPolicy.authorizeRequest", () => {
  const base = endpoint("https://LOCALHOST:8443/v1/")

  test.each([
    "https://localhost:8443/v1",
    "https://localhost:8443/v1/models",
    "https://localhost:8443/v1/models?page=1#result",
  ])("allows in-scope request %s", (value) => {
    expect(EndpointPolicy.authorizeRequest(base, value).ok).toBe(true)
  })

  test.each([
    ["http://localhost:8443/v1/models", "request-origin-mismatch"],
    ["https://other.localhost:8443/v1/models", "request-origin-mismatch"],
    ["https://localhost/v1/models", "request-origin-mismatch"],
    ["https://localhost:8443/v10", "request-path-mismatch"],
    ["https://localhost:8443/v1-models", "request-path-mismatch"],
    ["https://user@localhost:8443/v1/models", "credentials-not-allowed"],
  ] as const)("denies out-of-scope request %s", (value, code) => {
    expect(denial(EndpointPolicy.authorizeRequest(base, value)).code).toBe(code)
  })

  test("allows every path when the base prefix is root", () => {
    expect(EndpointPolicy.authorizeRequest(endpoint("http://localhost"), "http://localhost/models").ok).toBe(true)
  })
})

describe("EndpointPolicy.isRedirectStatus", () => {
  test("recognizes every 3xx status", () => {
    expect(Array.from({ length: 100 }, (_, index) => index + 300).every(EndpointPolicy.isRedirectStatus)).toBe(true)
  })

  test.each([199, 299, 400, 500, 300.5])("rejects non-redirect status %s", (status) => {
    expect(EndpointPolicy.isRedirectStatus(status)).toBe(false)
  })
})
