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
- Desktop sidecar environment sets `KOALA_AGENT_EXECUTION=sandbox` and passes
  the packaged sandbox-worker path explicitly.

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

Implemented capability-probe flow:

```text
Unknown capabilities on one model row
    -> stale-safe request snapshot
    -> authenticated modelProfile.probe API
    -> pinned sequential chat-completions requests
    -> exact nonce/shape evidence classification
    -> Yes/No applied only to fields still Unknown
```

Probe requests have per-request and suite deadlines, bounded request/response
sizes, no retry, redacted outcomes, and no local profile or credential mutation.
The visual probe generates its PNG entirely inside the sidecar.

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

## Implemented Industrial Tool Foundation

```text
V1 tool adapter
    -> Industrial Execution
        -> typed Koala input/result contract
        -> permission classification
        -> cancellation/deadline
        -> bounded model projection
        -> durable redacted audit
        -> artifact input/output references
```

The closed registry contract contains all 22 approved industrial tool names,
but only tools with real engines are model-visible. Artifact or authorized path
inputs resolve into immutable private snapshots. The audit table stores tool and
engine identity, timings, terminal flags, input digest, safe counts, and artifact
IDs without raw commands, expressions, document text, credentials, URLs, native
stderr, or host paths.

`calculate` is the first additional model-visible tool on this boundary. A
bounded tokenizer and Pratt parser feed a generator-based `decimal.js`
evaluator. Its synchronous and cooperative Effect entry points share that one
evaluation path; the Effect driver yields between bounded operations so caller
cancellation and engine deadlines can be observed without executing model input
as JavaScript or delegating it to a shell or sandbox.

## Document Runtime Foundation

```text
Desktop trusted resolver
    -> detached release attestation + strict target profile
    -> OpenCode process-global coordinator (fixed max 2 jobs)
        -> required native-confinement launcher
            -> short-lived document worker
            +-- PDF.js + target canvas: sequential 300-DPI pages
            +-- bundled Tesseract: bounded English TSV OCR
```

The worker protocol supports probe, direct image OCR, sequential PDF rendering,
OCR for every rendered page, page release, cancellation, and curated failures.
Manifests bind target, architecture, components, every file hash/mode, dependency
inventory, and licenses. A detached attestation outside the runtime tree pins
the manifest digest and exact source/dependency inventory. Packaged startup and
release staging both consume that independently supplied trust input. Workers
receive a reduced environment and verify the parent-supplied digest before
dynamically loading native code.

Development artifacts are not release artifacts. Beta/prod packaging accepts
only a separately prepared, target-matched `releaseReady` runtime. Release
verification requires an explicit `RUST_TARGET`, a detached attestation, the
strict production component/path/executable profile, and an offline probe on a
host-compatible target. Tesseract and canvas native headers must also match the
attested PE, ELF, or Mach-O architecture. The native Tesseract/Leptonica/tessdata
six-target build, complete licenses, signing matrix, and native-confinement
launcher remain release gates; no system executable or runtime download fallback
exists.

Cross-target staging accepts no local-probe exemption by itself. The detached
attestation must instead carry target-native render/OCR evidence bound to the
same target and manifest digest. Process-tree and confinement-launcher shutdown
have finite reap deadlines; failure to observe termination is a runtime cleanup
failure.

## Implemented Sandbox Infrastructure

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

The target sandbox has no network access, receives only explicit task inputs,
writes to a temporary workspace and artifact output directory, removes
credentials, and has no host execution fallback.

The implemented tool grants the active project as a read root and host-created
`work/` and `artifacts/` directories as its only write roots. Explicit outputs
are promoted only from clean executions. Desktop omits the host `bash` tool and
the shell implementation rejects direct calls while sandbox mode is active.
Each run uses schema-validated child-process IPC, bounded combined output,
timeout and cancellation handling, process-tree termination, and runtime
cleanup/reset.

`sandbox_test` reuses this same runtime and engine identity but has no command,
path, URL, timeout, or output parameter. It first queries runtime availability;
an unavailable result is returned as normal diagnostics and no execution is
attempted. For an available runtime, the host creates private nonces, fixed Node
scripts, and fixed configuration for these named checks:

- staging read and write;
- project read and write denial;
- separate external-temporary read and write denial;
- loopback TCP denial;
- readiness-driven local cancellation;
- verified cleanup.

The sandbox receives only its staging tree as a read root and its staging work
directory as a write root. The host independently checks created or absent files
and records whether its loopback listener accepted a connection. A second fixed
run writes a readiness file before waiting; bounded polling observes that file,
then a local `AbortSignal` requests cancellation. No probe artifact is promoted.
The listener, canaries, external directory, staging tree, and cancellation
controller are covered by idempotent explicit cleanup plus a finalizer.

Preparation resources use scoped acquisition. The project boundary is one
atomically created UUID-named directory containing both project canaries; no
individual path is recorded before ownership is established, and cleanup removes
only that directory. Staging, the external directory, listener, and host-written
files also register releases before preparation advances. Diagnostic command
arguments are not interpolated into Windows `cmd.exe` syntax: a fixed encoded
PowerShell launcher starts the runtime/script, while base64 JSON arguments are
passed through the closed `KOALA_SANDBOX_TEST_ARGUMENTS` environment key and
decoded by the fixed script.

Native CI remains blocked on machine provisioning rather than test code. The
repository has no sandbox setup action or script. Windows runners need the
elevated upstream `windows-install` operation to create the dedicated sandbox
account and machine-wide WFP filters. Ubuntu runners need `bubblewrap`, `socat`,
and `ripgrep`, plus either an AppArmor profile granting user namespaces or the
privileged `kernel.apparmor_restrict_unprivileged_userns=0` setting. Existing CI
runners do not establish these prerequisites, so the native test remains
explicitly capability-gated and no OS-enforcement result is claimed.

## Implemented Artifact Infrastructure

```text
<Koala data>/artifacts/staging/<run-id>/
<Koala data>/artifacts/blobs/sha256/<prefix>/<digest>
<Application database>/koala_artifact*
```

The existing application SQLite database stores artifact metadata, ownership,
tool and sandbox provenance, validation, and source lineage. Immutable bytes are
stored by digest outside SQLite. Logical artifact IDs remain distinct from blob
digests so multiple provenance records can safely share one physical blob.

Promotion rejects traversal, links, non-regular files, unstable files, and
limit violations. It hashes and copies from one opened source handle, publishes
without replacing an existing digest, verifies deduplicated blobs, and writes
metadata only after the blob exists. The initial validator detects common media
signatures and strict UTF-8 text; deep document-format validation remains a
later phase.

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
