# Koala Infrastructure

## Current Runtime

```text
Electron main process
    |
    +-- secure preload IPC
    |
Electron renderer: packages/app + packages/ui + packages/session-ui
    |
    +-- authenticated HTTP/SSE over loopback
    |
Embedded sidecar utility process
    |
    +-- OpenCode session and agent runtime
    +-- provider adapters
    +-- tool registry and permissions
    +-- SQLite session persistence
```

The sidecar binds to loopback on an ephemeral port and uses a generated Basic
authentication password. Model requests originate in the sidecar, not the
renderer.

## Source Boundaries

```text
packages/desktop     Electron shell, preload, local sidecar lifecycle
packages/app         Shared application routes, state, dialogs, settings
packages/ui          Shared components, themes, logo and visual tokens
packages/session-ui  Messages, tool cards, artifacts and timeline rendering
packages/opencode    Embedded compatibility server and agent runtime
packages/core        Database, current runtime services and shared behavior
packages/server      Current HTTP handlers
packages/schema      Shared domain and transport schemas
packages/protocol    Current HTTP API contracts
packages/llm         Native model protocol adapters
packages/koala       Planned Koala domain services
```

## Current Local-Only Controls

- Desktop updater is disabled for every channel.
- Desktop Sentry initialization is removed.
- Desktop Sentry source-map upload integration is removed.
- Desktop release-note retrieval is skipped.
- Desktop notifications use a bundled icon.
- Sidecar environment removes OTLP endpoint, headers, and resource attributes.
- Sidecar environment sets `OPENCODE_DISABLE_AUTOUPDATE=1`.
- Sidecar environment sets `OPENCODE_DISABLE_SHARE=1`.

These controls are the first layer. Cloud provider, sharing, remote plugin, web
tool, MCP, server-selection, and external-link code still requires staged
removal.

## Target Model Infrastructure

```text
Koala Model Registry
    |
    +-- endpoint and optional credential reference
    +-- one or more model profiles
    +-- modalities and agent capabilities
    +-- context and output limits
    +-- preferred task roles
    |
Capability-aware Router
    |
OpenAI-compatible local/private endpoint
```

The router records required capabilities, candidate rejection reasons, selected
profile, fallback decision, and user override.

Implemented in `packages/koala`:

- OpenAI-compatible provider profile contracts
- Secret references without raw credential storage
- Tri-state model capabilities
- Required context and output limits
- Model roles, enabled state, and priority
- Deterministic capability-aware routing
- Capability-safe user overrides

Pending infrastructure includes profile persistence, endpoint network policy,
capability probes, health state, and OpenCode provider/session adapters.

Implemented profile persistence:

```text
<Global data>/koala/model-profiles.json
    |
    +-- versioned canonical profile document
    +-- locked atomic create/update/delete
    +-- authenticated global CRUD API
    +-- generated legacy SDK client
    +-- effective V1 provider projection in the sidecar
```

Profiles remain canonical JSON data. The OpenCode provider configuration is a
derived in-memory view and is not written into `opencode.json`.

Implemented Desktop profile flow:

```text
Local/private model form
    +-- required model limits
    +-- tri-state capabilities
    +-- roles, enabled state and priority
    +-- optional API key kept outside profile data
    |
Generated authenticated model-profile client
    |
Sidecar JSON profile repository
    |
Effective OpenCode provider projection
```

Active endpoint discovery and capability probes remain pending. A saved profile
must not be presented as a verified connection until those checks succeed.

Profile-backed inference now obtains a bound pinned fetch during provider
instance construction. The canonical profile base URL and transport take
precedence over matching config/plugin values, while unrelated providers retain
their existing transports. Binding or DNS policy denial fails the profile-backed
model request without a global-fetch fallback.

The Desktop sidecar also disables common EC2 and GCP metadata discovery
variables and removes inherited metadata endpoint overrides.

## Target Tool Infrastructure

```text
Agent tool request
    |
Permission policy
    |
Koala tool registry
    +-- document and OCR tools
    +-- vision tools
    +-- Office and PDF generation
    +-- calculations
    +-- local knowledge retrieval
    +-- artifact validation
    +-- sandbox execution
```

Binary outputs are artifact references, not data embedded in chat history.

## Target Sandbox Infrastructure

```text
sidecar
    |
sandbox_execute tool
    |
short-lived worker process
    |
@anthropic-ai/sandbox-runtime
    +-- macOS Seatbelt
    +-- Linux Bubblewrap and namespaces
    +-- Windows restricted account, ACLs, WFP and job object
```

The sandbox has no network access, receives only explicit task inputs, writes to
a temporary workspace and artifact output directory, removes credentials, and
has no host execution fallback.

## Target Data Infrastructure

```text
<Koala data>/koala.db
<Koala data>/artifacts/staging/<run-id>/
<Koala data>/artifacts/blobs/sha256/<prefix>/<digest>
```

SQLite stores artifact metadata, model profiles, routing decisions, audit
records, knowledge metadata, chunks, and citations. Immutable binary data is
stored by digest outside SQLite.

## Target Network Boundary

Allowed destinations are loopback and explicitly approved private organization
model endpoints. Public destinations, redirects outside policy, cloud metadata
addresses, and sandbox traffic are denied by default.

Koala records application network decisions, but organization deployments
should also use host firewall policy or an independent network monitor.

Implemented pure endpoint policy:

- IPv4 loopback and RFC1918 allowlist
- IPv6 loopback and ULA allowlist
- Metadata, public, reserved, CGNAT, link-local, multicast, unspecified, and
  IPv4-mapped IPv6 denials
- Strict base URL component validation
- DNS answer-set authorization with mixed-result denial
- Endpoint origin and base-path request scoping
- Redirect status classification

The sidecar DNS-pinned transport remains the next network implementation layer.

Implemented sidecar endpoint transport:

```text
Bound provider base URL
    -> request origin/path authorization
    -> fresh OS DNS lookup
    -> complete answer-set authorization
    -> approved address returned to socket lookup
    -> direct Node HTTP/HTTPS request
    -> redirect rejection
```

The original hostname remains available for HTTP Host and TLS verification.
Environment proxy routing and insecure TLS overrides are not part of this
transport.

Implemented discovery path:

```text
POST /global/model-profile/discover
    -> optional transient key or stored provider API key
    -> pinned endpoint transport
    -> GET <baseURL>/models
    -> bounded OpenAI-compatible response parser
    -> ordered unique model IDs
```

Discovery is read-only. It does not persist credentials, profiles, config, or
instance state.

Implemented Desktop discovery flow:

```text
Provider ID + base URL + optional transient key
    -> Discover models
    -> authenticated sidecar discovery API
    -> ordered unique IDs
    -> merge into existing model rows
    -> user completes limits, capabilities and roles
    -> Submit persists credentials and canonical profile
```

## Deferred Deployment Infrastructure

- Windows, macOS, and Linux installers
- Code signing and notarization
- Offline update bundles or internal update server
- Centralized multi-user deployment
- Organization identity and access management
- Administrator policy distribution
