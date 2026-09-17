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

## Deferred Deployment Infrastructure

- Windows, macOS, and Linux installers
- Code signing and notarization
- Offline update bundles or internal update server
- Centralized multi-user deployment
- Organization identity and access management
- Administrator policy distribution
