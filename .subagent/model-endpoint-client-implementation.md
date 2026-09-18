# Koala Model Endpoint Client Implementation

## Architecture

The sidecar transport is split into two Effect services:

- `NetworkResolver` wraps `node:dns/promises.lookup(hostname, { all: true,
order: "verbatim" })`. It validates the runtime result, rejects more than 32
  answers, applies a five-second timeout, and exposes only a typed redacted
  resolution rule on failure. `layerWith` accepts an injected lookup and timing
  limits for tests.
- `ModelEndpointClient` is a stable factory service. Its live `layer` and
  `LayerNode` depend on `NetworkResolver` once, and its `bind` method parses one
  canonical Koala `baseURL` plus `providerID` into a `BoundClient` containing a
  Fetch-compatible function. The bound function uses `node:http` or
  `node:https` directly, never consults environment proxy settings, disables
  agent reuse, and installs a custom lookup callback for hostname endpoints.

Each request is checked with `EndpointPolicy.authorizeRequest`. At socket
connection time, the lookup callback resolves all answers, authorizes the full
set with `EndpointPolicy.authorizeResolution`, and returns only the first
approved address to Node. Literal endpoints are authorized directly and do not
invoke DNS.

Node receives the original endpoint hostname, so it generates the original
HTTP Host value. HTTPS hostname requests also set `servername` to that original
hostname for SNI and certificate identity checks. TLS verification is left at
Node's default; the client does not set `rejectUnauthorized`.

The client ignores ordinary Fetch controls that do not affect routing, forces
manual redirect semantics, rejects every 3xx response, rejects unsafe routing
headers and transport overrides, streams request and response bodies, and
returns a standard `Response`. Public errors contain only policy rule, canonical
origin, or redirect status fields.

## Files

- `packages/opencode/src/koala/network-resolver.ts`
- `packages/opencode/src/koala/model-endpoint-client.ts`
- `packages/opencode/test/koala/network-resolver.test.ts`
- `packages/opencode/test/koala/model-endpoint-client.test.ts`
- `.subagent/model-endpoint-client-implementation.md`

No provider integration was added.

## Coverage

The focused tests build the stable service with an injectable resolver and call
`bind` for each endpoint while using local Node HTTP servers. The DNS denial
matrix binds three endpoints through one service instance. Coverage includes:

- resolver ordering, malformed results, answer caps, timeout, and redaction;
- loopback and available private-interface success;
- literal endpoints without DNS;
- fresh DNS authorization for each connection;
- mixed, public, and metadata answer denial before an HTTP request reaches the
  server;
- request origin, path, and credential denial;
- Host, Proxy-Authorization, and transport override denial;
- method, safe header, query, and JSON body preservation;
- redirect rejection without following or exposing Location;
- in-flight abort behavior;
- incremental response body streaming;
- resolver and transport error redaction.

## Verification

- `bun test test/koala/network-resolver.test.ts test/koala/model-endpoint-client.test.ts`
  from `packages/opencode`: 13 passed, 0 failed, 41 assertions.
- `bun typecheck` from `packages/opencode`: passed.
- `bun test` from `packages/koala`: 139 passed, 0 failed, 169 assertions.
- `bun typecheck` from `packages/koala`: passed.
- Prettier was run on all added TypeScript files.
- `git diff --check`: passed before this report was added and is rerun in the
  final diff check.

## Limitations

- The client is not wired into `provider.ts`; callers do not use it until the
  planned provider integration is implemented.
- The private-address success test runs only when the host has an eligible
  private interface; loopback coverage always runs.
- Host preservation is integration-tested. TLS SNI and certificate validation
  are enforced by explicit Node request options and default TLS behavior, but
  no test certificate authority or private key is embedded in this change, so
  they are not exercised by the local HTTP fixtures.
- Disabling connection pooling deliberately trades connection reuse for a new
  DNS authorization at every connection boundary.
