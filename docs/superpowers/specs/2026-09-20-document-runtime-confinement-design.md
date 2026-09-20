# Document Runtime Confinement Design

## Status

This is the approved confinement design for the bundled document runtime. It
narrows the Phase 9B launcher boundary described in
`2026-09-19-industrial-tools-design.md`; it does not implement the boundary or
register a document tool.

The implementation must remain fail-closed. A production document job is
unavailable unless the verified runtime, trusted proxy, pinned Sandbox Runtime
(SRT) assets, and native policy dependencies are all available. There is no
direct production launch path for the document worker.

Native policy execution has not been verified on the current development host
or across the six release targets. This document specifies required behavior;
it does not claim that SRT currently provides verified enforcement in Koala.

## Decision

Each probe, image OCR, or PDF render/OCR call gets one short-lived trusted Node
proxy. The proxy owns one process-local `SandboxManager` singleton, initializes
one fixed SRT policy, starts one inner document worker through SRT, bridges only
validated protocol messages, tears down the full process tree, calls SRT command
cleanup and reset, and exits. It is not reused for another job.

The process boundary is:

```text
Desktop main process
  -> OpenCode sidecar and DocumentRuntime coordinator (trusted parent)
    -> one document-runtime proxy per job (trusted, Node IPC)
      -> one SRT-wrapped document worker (untrusted, bounded NDJSON)
        -> bundled PDF.js/@napi-rs/canvas in-process
        -> bundled Tesseract as a descendant process
```

The trusted parent remains responsible for runtime and input verification,
deadlines, protocol order, output validation, concurrency, and final deletion
of all per-job storage. The proxy is a narrow confinement and output-handoff
broker. It does not parse document content, expose arbitrary command execution,
or publish artifacts. The inner worker and every descendant are treated as
compromised once document bytes are opened.

## Goals

- Confine every document job before any untrusted document parser or native
  document dependency loads.
- Give the inner process read access only to audited system loader roots, the
  verified runtime, and its private job root.
- Make the verified runtime read-only and the private job root the only ordinary
  writable filesystem root visible to the sandbox. A parent-owned sibling
  pending root is writable only by the trusted proxy and parent and is never
  granted to the inner process.
- Give the inner process an empty network allowlist, no local binding, no
  arbitrary Unix socket access, no PTY, and no weaker nested mode.
- Preserve the existing versioned, ordered document protocol and one-page-at-a-
  time release flow without placing a Node IPC channel inside the sandbox.
- Bound every control channel, diagnostic stream, process lifetime, temporary
  allocation, and cleanup phase.
- Treat cancellation, timeout, malformed protocol, proxy failure, worker crash,
  descendant survival, reset failure, and incomplete deletion as job failures.
- Package and resolve the proxy and all SRT target assets without a system
  package, download, `PATH`, or source-file fallback in production.

## Non-Goals

- This design does not replace the artifact store, document format validators,
  or Industrial Execution audit boundary.
- It does not add model-facing OCR, PDF, or document tools.
- It does not broaden the generic `sandbox_execute` command policy.
- It does not establish confinement against a compromised operating-system
  kernel, administrator, signed application bundle, or build pipeline.
- It does not claim complete denial of resource-exhaustion or microarchitectural
  side channels. Existing byte, page, raster, output, concurrency, and deadline
  limits remain mandatory controls.
- It does not add a network exception for private model endpoints. Document
  parsing has no network requirement; model-backed vision remains a separate
  trusted host operation over the existing pinned transport.

## Trust Boundaries

### Trusted parent

The OpenCode `DocumentRuntime` coordinator is trusted. Before creating the
proxy it must:

1. Resolve the exact host target.
2. Load the detached Desktop attestation when packaged.
3. Verify the complete runtime manifest, target, digest, paths, file hashes,
   executable modes, native architecture, release-ready policy, and absence of
   symbolic links at the existing verification boundary.
4. Create a unique private job directory and a unique sibling pending directory
   beneath one private parent-owned temporary directory. Record all three
   canonical paths and filesystem identities before launch.
5. Stage one stable regular-file input with no link following and verify its
   declared size.
6. Create the job-local `tmp` directory before confinement starts.
7. Launch only the packaged proxy through the resolved absolute proxy path. The
   parent never opens a path reported by the worker and resolves accepted output
   paths only beneath the recorded pending root.

The parent treats all proxy messages as untrusted input despite the proxy being
part of the trusted computing base. It validates schemas, job identity, message
order, counts, byte limits, paths, and exactly one terminal outcome.

### Trusted proxy

The proxy contains only the Koala launch/control adapter, bounded output stream
receiver, the pinned SRT library, and process lifecycle code. It does not import
PDF.js, canvas, Tesseract, Office parsers, or interpret document bytes. It
independently verifies the runtime root, manifest digest, target, worker path,
job-root and pending-root identities, sibling relationship, path separation,
and SRT asset paths before initialization.

The upstream `SandboxManager` is process-global. A fresh proxy process therefore
owns exactly one singleton and one job. No other sandbox command can overlap its
initialization, policy, violation store, command cleanup, or reset.

### Untrusted inner worker

The inner document worker, PDF.js, native canvas library, Tesseract, codecs, and
all descendants are untrusted. Their stdout, stderr, exit state, output paths,
files, byte declarations, and protocol order are hostile inputs. They receive no
Node IPC handle and cannot address the trusted parent directly.

The runtime tree is executable/readable but not writable. The job tree is
readable and writable; it is the only ordinary writable root granted to the
sandbox. The sibling pending root is not present in the SRT read or write
allowlists, command arguments, bootstrap environment, or worker protocol.
Audited character devices needed for null and inherited standard streams are
not treated as persistent writable roots.

## Job Lifecycle

1. The parent acquires one of the existing two global document-job permits.
2. It verifies the target runtime, creates and identifies the private job and
   sibling pending roots, and stages input only in the job root.
3. It forks one trusted proxy with Node IPC, ignored stdin, bounded piped stdout
   and stderr, no extra IPC handles, `serialization: "json"`, and a minimal
   trusted-broker environment.
4. The parent sends one `launch` message containing the start request, job root,
   and sibling pending root and waits for `accepted`.
5. The proxy validates the launch, independently verifies the runtime, checks
   strict native dependencies, and initializes its sole SRT singleton.
6. The proxy builds the fixed policy, obtains the SRT-wrapped spawn descriptor,
   starts the inner bootstrap with `shell: false`, and binds bounded stdin,
   stdout, and stderr streams. The bootstrap reconstructs the environment and
   only then dynamically imports the document worker, so no document module
   loads before confinement and environment scrubbing.
7. The proxy emits `accepted`, writes the validated start request as one NDJSON
   frame, and bridges validated continuation commands and control events. Output
   bytes travel only through the strict inner output frames described below.
8. For each PNG or TSV, the proxy receives one complete output transfer, writes
   it to an exclusive proxy-generated file beneath the pending root, verifies
   its stable size and SHA-256, and only then forwards the corresponding normal
   `page-ready` or `ocr-result` event with a pending-root-relative path.
9. The existing `DocumentRuntimeProtocol` state machine remains authoritative
   for page ordering, page identity, job identity, limits, release, cancellation,
   and one terminal worker event. Its public event names and page flow do not
   expose output transfer frames.
10. The proxy withholds the worker's terminal event until the inner process has
   exited and SRT command cleanup plus reset have completed. It then emits the
   terminal worker event followed by `closed`, disconnects Node IPC, and exits
   with code zero.
11. The parent accepts success only after the expected terminal event, `closed`,
    a clean proxy exit, output validation, and verified deletion of the job and
    pending roots.

Any failed step enters the same termination and cleanup path. A proxy-level
failure uses a closed safe code; raw SRT, parser, native stderr, environment
values, and host paths do not cross the parent boundary.

## Parent/Proxy Protocol

Add a browser-safe `DocumentSandboxProtocol` alongside the existing document
protocol. Version 1 is a closed discriminated union. Unknown fields, missing
fields, unsupported versions, invalid branded IDs, non-absolute host paths, and
messages outside the state machine are rejected.

Parent requests are:

```text
launch {
  protocolVersion: 1,
  type: "launch",
  jobID,
  target,
  runtimeRoot,
  manifestSha256,
  jobRoot,
  pendingRoot,
  start
}

command {
  protocolVersion: 1,
  type: "command",
  jobID,
  command
}

cancel {
  protocolVersion: 1,
  type: "cancel",
  jobID
}
```

`start` is exactly one existing `ProbeRequest`, `RenderRequest`, or standalone
image `OcrRequest`. Its job ID must equal the outer job ID. `jobRoot` and
`pendingRoot` must be canonical, non-link, disjoint direct children of the same
recorded private parent; neither may contain the other. `command` contains only
a continuation valid for that start: rendered-page `OcrRequest` or
`ReleasePageRequest`. Cancellation has a separate outer message so the proxy can
begin hard termination even if the inner input stream is blocked. The proxy
does not pass `pendingRoot` or a derivative of it to the sandbox.

Proxy events are:

```text
accepted { protocolVersion: 1, type: "accepted", jobID }
event    { protocolVersion: 1, type: "event", jobID, event }
failure  { protocolVersion: 1, type: "failure", jobID | null, code, stage, retryable }
closed   { protocolVersion: 1, type: "closed", jobID | null }
```

`event` contains exactly one `DocumentRuntimeProtocol.WorkerEvent` with the same
job ID. The `page-ready` and `ocr-result` schemas retain their names and ordering
and add `outputID` plus lowercase `outputSha256`. For those events, the proxy
requires the worker values to match the completed transfer, replaces the
worker's path with its own canonical relative path beneath `pendingRoot`, and
publishes the proxy-verified ID and digest; no worker-supplied path crosses the
parent boundary. `failure` uses a closed proxy-specific vocabulary covering
invalid launch, protocol mismatch, sandbox unavailable, dependency failure,
spawn failure, transport overflow, output handoff failure, worker crash,
termination failure, command cleanup failure, and reset failure. It contains no
arbitrary message or cause.
Only an undecodable first message may produce `failure` and `closed` with a null
job ID. Once a launch is decoded, every outer and inner message must carry that
launch's job ID.

There are exactly two valid sequences. A launch rejected before inner spawn is
one `launch`, one `failure`, one `closed`, IPC disconnect, and clean proxy exit.
An accepted launch is one `launch`, one `accepted`, zero or more nonterminal
`event` messages, exactly one terminal `event` or `failure`, one `closed`, IPC
disconnect, and clean proxy exit. The parent advances the document order state
to cancellation when it sends outer `cancel`. It holds a terminal success as
provisional until the complete sequence and per-job storage deletion finish.
Extra messages, an early disconnect, a nonzero exit, or a second terminal value
fail the job.

Each Node IPC message must encode to at most 64 KiB of UTF-8 JSON. Each side has
a queue capacity of 32 messages. Exceeding either bound begins hard termination;
messages are not dropped and processing does not continue.

## Inner NDJSON Transport

The SRT-wrapped worker uses stdin for requests and stdout for control events and
output transfers. Each frame is one UTF-8 JSON value followed by one LF byte.
There are no blank lines, multiline JSON values, raw binary bytes, path payloads
outside the schemas, or logging on stdout. Binary output is represented only by
canonical base64 in `output-chunk.data`.

The proxy and worker both apply these hard transport limits before schema
decoding:

- 16 KiB maximum per complete line, including the LF;
- 16 KiB maximum unterminated receive buffer;
- 512 control frames and 1 MiB total encoded control bytes in each direction per
  job;
- output transfer frames and their encoded bytes are accounted separately from
  the control frame and byte totals;
- one write at a time with stream backpressure;
- 64 KiB aggregate inner stderr;
- no recovery after malformed UTF-8, invalid JSON, schema failure, overflow,
  unexpected EOF, or invalid order.

The worker-to-proxy output union adds these exact strict frames:

```text
output-start {
  protocolVersion: 1,
  type: "output-start",
  jobID,
  outputID,
  kind: "page-png" | "ocr-tsv",
  page,
  pageID,
  resultID?,
  sourcePath,
  declaredBytes
}

output-chunk {
  protocolVersion: 1,
  type: "output-chunk",
  jobID,
  outputID,
  sequence,
  data
}

output-end {
  protocolVersion: 1,
  type: "output-end",
  jobID,
  outputID,
  chunks,
  actualBytes,
  sha256
}
```

`outputID` is a branded random ID that is unique for the entire job and is never
reused, including after release or failed transfer. `resultID` is required only
for `ocr-tsv` and forbidden for `page-png`; kind, page, page ID, and result ID
must match the following normal event. `sequence` starts at zero and increments
by one. `data` is canonical RFC 4648 base64 with no whitespace;
decode followed by re-encode must produce the identical string. A non-final
chunk decodes to exactly 10 KiB and the final chunk decodes to the exact
remaining 1 through 10 KiB. A declared zero-byte TSV has no chunk frames. These
rules make the expected chunk count exact from `declaredBytes`; tiny-chunk frame
flooding is not permitted. Ten KiB encodes to at most 13,656 base64 characters,
leaving more than 2 KiB of the 16-KiB line for the closed metadata schema and LF.

Payload limits are operation-derived rather than charged to the 1-MiB control
budget:

- one `page-png` is bounded by the request's PNG limit and the hard 64-MiB
  `MaxPngBytesPerPage`; its page dimensions must already satisfy the 10,000-pixel
  side and 25,000,000-pixel raster limits;
- one `ocr-tsv` is bounded by the request's TSV limit and the hard 32-MiB
  `MaxTsvBytesPerPage`;
- a standalone OCR job has a cumulative decoded payload bound of one requested
  TSV limit;
- a render job has a cumulative decoded payload bound of
  `pageCount * (requested PNG limit + requested TSV limit)`, at most 9,600 MiB
  (10,066,329,600 bytes) for 100 pages at hard limits;
- incomplete output plus completed pending files awaiting release must remain
  within the request's temporary-byte limit and the hard 250-MiB
  `MaxTemporaryBytes` at every point.

Each transfer has exactly one start, its exact calculated number of chunks, and
one end. Only one transfer may be active, and at most one completed transfer may
await its matching normal event. Duplicate IDs, duplicate starts or ends,
interleaved transfers, missing or repeated sequence numbers, chunks after end,
an event before end, an unrelated event after end, trailing chunks, EOF during a
transfer, and payload after a terminal event are fatal protocol failures. Start
declarations, decoded chunk bytes, end `actualBytes`, event `pngBytes` or
`tsvBytes`, cumulative payload accounting, and the proxy's actual file size must
all agree. The event's `outputID` must equal the transfer ID. The proxy-computed
streaming SHA-256 must equal the lowercase digest in `output-end`, the worker
event's `outputSha256`, and a second digest computed from the closed pending
file. The proxy places that verified digest in the outer normal event.

The `sourcePath` and the path in the following worker event must be the same
canonical relative POSIX path, within the existing 1,024-character relative-
path limit, with the required `pages/` plus `.png` or `ocr/` plus `.tsv` shape.
Absolute, empty, dot, traversal, backslash, NUL, drive, UNC, device, alternate-
data-stream, non-normalized, and wrong-prefix or extension forms are rejected.
The path is correlation metadata only: the proxy never opens it. The proxy
instead creates a random, exclusive, non-link mode-`0600` destination beneath
the verified pending root, writes and hashes decoded bytes serially, flushes and
closes the file, reopens it without following links, and verifies identity,
size, and digest before publishing its own pending-relative path in the normal
event.

Output frame counts are bounded by declared bytes and the exact chunk rule, not
by the 512-control-frame ceiling. At hard limits a PNG needs at most 6,554 chunk
frames, a TSV at most 3,277, and a 100-page render/OCR job at most 983,100 chunk
frames plus exactly two framing messages per output. A future protocol that
needs larger control messages, chunks, output types, or payload totals must
revise and version these limits rather than silently raising them.

The proxy decodes and re-encodes every control message instead of forwarding
arbitrary JSON. It runs the document order state machine independently of the
parent and advances it for an output event only after the matching transfer is
stable. The inner worker does the same. This gives three checks at distinct
trust boundaries without introducing a second document state model.

The worker serializes and awaits every chunk write. The proxy pauses or stops
reading stdout until the current decoded chunk has been fully written, bounds
its parser and pending write queue, and resumes only after drain. It never
buffers a whole output, forwards chunks over Node IPC, or drops frames. A stalled
write remains subject to the page/job deadline and cancellation path; queue or
stream overflow terminates the job.

NDJSON is selected for the inner boundary because stdin/stdout survive the SRT
wrappers on all target platforms. Node IPC remains limited to the trusted
parent/proxy boundary and is not passed into the sandbox.

## SRT Policy

The proxy uses the repository-pinned `@anthropic-ai/sandbox-runtime@0.0.76` via
its library API. An SRT upgrade is a security-sensitive change requiring policy,
packaging, protocol, and native tests before release.

The policy is constructed by Koala, not read from a user settings file:

```text
network.allowedDomains       = []
network.deniedDomains        = []
network.strictAllowlist      = true
network.allowUnixSockets     = []
network.allowAllUnixSockets  = false
network.allowLocalBinding    = false
network.allowMachLookup      = []
filesystem.allowRead         = audited loader roots + runtimeRoot + jobRoot
filesystem.denyRead          = platform broad-read roots
filesystem.allowWrite        = [jobRoot]
filesystem.denyWrite         = runtimeRoot + SRT persistent compatibility paths
filesystem.allowGitConfig    = false
enableWeakerNestedSandbox     = false
enableWeakerNetworkIsolation = false
allowAppleEvents             = false
allowPty                     = false
```

The runtime root, job root, and pending root must be absolute, canonical,
pairwise disjoint, non-link directories. The job and pending roots must be
siblings beneath the recorded private parent, and neither may contain another.
The pending root is deliberately absent from the SRT policy. The inner
bootstrap, worker,
bundled Tesseract, trained data, PDF.js assets, canvas JavaScript, and target-
native canvas binary must resolve beneath the verified runtime root. The proxy
and SRT assets must resolve beneath the trusted packaged sandbox-runtime root,
outside both the runtime and job trees.

`allowRead` is not a generic `PATH` expansion. It consists of:

- the verified runtime root;
- the private job root;
- the absolute Node/Electron executable used for the inner worker;
- target-specific immutable operating-system loader, shared-library, and device
  roots required by that executable and the attested native dependencies;
- pinned SRT helper paths needed by the selected platform.

The target-specific list is code-owned and tested. It does not include the user
home, project, application data, shell configuration, package-manager stores,
the Desktop source checkout, or arbitrary directories inherited from `PATH`.

On macOS and Linux, `denyRead` starts with `/` and the listed `allowRead` paths
are the only carve-outs. On Windows, the proxy enumerates every mounted local
volume visible to the sandbox account, denies read at each root, and adds
explicit read/execute grants only for the audited roots. Failure to enumerate,
stamp, or later revoke any root makes confinement unavailable. Network drives,
UNC/device paths, and volumes appearing after policy initialization are not
accessible job inputs or runtime roots.

SRT currently adds broad compatibility write paths. Koala must explicitly deny
its persistent defaults, including `/tmp/claude`, `/private/tmp/claude`,
`~/.npm/_logs`, and `~/.claude/debug`, where applicable. The effective wrapped
policy must be inspected in tests. On Windows the deny-write inventory also
covers the sandbox account profile and temp tree, public/shared writable roots,
the pending root, runtime, application resources, and the SRT assets. A version
or host whose effective rights cannot be reduced to the job root plus required
non-persistent devices is not release-compatible.

The proxy passes no ask callback, does not enable the log monitor as an
enforcement dependency, and requires `isSupportedPlatform()`, asset checks, and
strict dependency checks to pass. Linux seccomp warnings are treated as
unavailable. Violation reporting is diagnostic only and is never evidence by
itself that a denial occurred.

The wrapped command is fixed and host-authored. Protocol values and filesystem
paths are never concatenated into a shell command. Platform-specific launch
encoding receives only already verified absolute executable and worker paths and
has round-trip tests for spaces, quotes, percent syntax, ampersands, carets,
parentheses, and trailing separators. The returned descriptor is always spawned
with `shell: false`.

## Exact Environments

The trusted proxy receives a minimal broker environment required to start Node
and SRT. It may contain only the following host-derived keys when present and
valid for the platform:

```text
HOME
LANG
LC_ALL
LOCALAPPDATA
PATH
PATHEXT
PROGRAMDATA
SystemRoot
TEMP
TMP
TMPDIR
USERPROFILE
WINDIR
```

It also receives `KOALA_DOCUMENT_RUNTIME_PROXY_ASSETS_ROOT` as a validated
absolute packaged path and `ELECTRON_RUN_AS_NODE=1`. No other Koala variable is
inherited. The parent removes credential, cloud metadata, debug, tracing,
dynamic-loader, Node option, certificate, and inherited proxy variables before
launch. The broker may use `PATH` only for SRT's audited native dependency check;
the inner document command uses absolute paths.

SRT starts a tiny attested `worker/bootstrap.js` entrypoint that imports no
document or native dependency. The bootstrap clears its entire environment,
reconstructs exactly the following values, and then dynamically imports
`worker/worker.js`:

```text
DISABLE_SYSTEM_FONTS_LOAD=1
DOCUMENT_JOB_ROOT=<canonical job root>
DOCUMENT_RUNTIME_MANIFEST_SHA256=<verified lowercase SHA-256>
DOCUMENT_RUNTIME_ROOT=<canonical verified runtime root>
DOCUMENT_RUNTIME_TARGET=<exact six-target identifier>
ELECTRON_RUN_AS_NODE=1
LANG=C
LC_ALL=C
TEMP=<job root>/tmp
TMP=<job root>/tmp
TMPDIR=<job root>/tmp
TZ=UTC
```

On Windows only, it also sets `SystemRoot` and `WINDIR` to the same validated
absolute Windows system root. No other variable survives bootstrap, including
`PATH`, `HOME`, `USERPROFILE`, `COMSPEC`, `NODE_OPTIONS`, `LD_*`, `DYLD_*`,
`NAPI_RS_NATIVE_LIBRARY_PATH`, certificate overrides, cloud credentials, or
upper/lower-case proxy variables. SRT may inject private bootstrap variables to
construct its native wrapper; the worker removes them before loading PDF.js,
canvas, Tesseract code, or document bytes. Network denial relies on the native
policy, not on proxy environment variables.

Tesseract remains an inner-worker descendant and receives the existing still
narrower environment: `DISABLE_SYSTEM_FONTS_LOAD=1`, `LANG=C`, `LC_ALL=C`,
`OMP_NUM_THREADS=1`, `OMP_THREAD_LIMIT=1`, `TESSDATA_PREFIX` beneath the verified
runtime, job-local `TEMP`/`TMP`/`TMPDIR`, `TZ=UTC`, and Windows system-root keys
only when required.

## Runtime And Output Integrity

The parent and proxy each verify the same manifest digest. Verification occurs
before the proxy imports any runtime module and before SRT grants runtime read
access. The inner worker verifies the manifest again before loading PDF.js,
canvas, or Tesseract. A target substitution, digest mismatch, missing file,
unexpected file, mode mismatch, link, path escape, or architecture mismatch makes
the runtime unavailable.

The OS policy denies writes to the runtime root explicitly. Release packaging
must also install it without user write permission where the target platform
supports that mode. The manifest and detached attestation remain outside
document-controlled storage.

The parent never resolves, opens, stats, copies, or deletes a worker-reported
path. It accepts only the proxy-generated pending-relative path in a normal
`page-ready` or `ocr-result`, resolves it beneath the recorded pending root, and
opens it without following links after rechecking the pending-root and file
identity, bounded size, and expected digest metadata. The pending root is a
sibling of, not a child of, the sandbox-writable job root.

The current parent-side copy from `jobRoot/<worker outputPath>` into pending
staging is removed. There is no fallback that opens a worker path after the
sandbox exits or after an event. The proxy's streamed destination is the first
and only trusted-side copy.

For a rendered page, the caller may use the pending PNG and TSV only within the
scoped page callback. Before sending `release-page`, the parent closes all
handles, deletes both exact pending files, verifies their absence, and sends the
release. The proxy verifies those published destinations are absent before it
forwards release to the worker; the worker then removes its own page/TSV files
inside the job root. For standalone OCR, the parent reads and validates the TSV,
deletes it, and verifies absence before accepting completion. Failure to delete
or verify an expected pending output fails the job. No artifact or user-visible
success is durably published until proxy shutdown and verified deletion of both
per-job roots pass.

Audit and failure records may include curated codes, job/page/output IDs, output
kind, bounded byte counts, and SHA-256 where the audit policy permits it. They
must never contain `output-chunk.data`, decoded bytes, base64 payload fragments,
document text, worker source paths, pending host paths, or raw stderr. Output
payload frames stay entirely on the inner stdout/proxy boundary and never enter
Node IPC or general diagnostic logging.

## Cancellation And Hard Termination

Cancellation is idempotent and may begin from caller interruption, a page or job
deadline, output overflow, malformed transport, process error, unexpected exit,
or parent/proxy disconnect.

The shutdown order is:

1. The parent sends outer `cancel` once when IPC is connected.
2. The proxy aborts SRT wrapping or writes one document `CancelRequest` if the
   inner worker is running, closes further command admission, and starts the
   existing two-second cancellation grace.
3. The inner worker aborts render and output streaming, terminates the active
   Tesseract tree, removes generated page/TSV files, and emits `cancelled` when
   cooperative cleanup completes. The proxy closes and removes every partial or
   completed-but-unpublished pending file it created.
4. At grace expiry, transport overflow, or inner failure, the proxy hard-kills
   the complete inner process tree. POSIX uses a dedicated process group;
   Windows uses the SRT-owned Job Object and target-specific tree termination.
5. After confirmed inner-tree exit, the proxy calls
   `cleanupAfterCommand()` and awaits `reset()` with bounded deadlines.
6. If the proxy does not complete, the parent launcher terminates the proxy and
   every tracked descendant/helper, then waits for confirmed exits within a
   bounded deadline.
7. Only after process exit and SRT teardown does the parent delete and verify the
   job and pending roots. Published pending files remain parent-owned and are
   removed by its finalizer if scoped release did not already remove them.

The budgets are fixed: two seconds for cooperative cancellation, two seconds for
proxy-owned hard tree reaping, two seconds for command cleanup/reset, two seconds
for parent-owned proxy/tree reaping, and two seconds for per-job root deletion.
Normal completion uses the same two-second reset and deletion budgets. The
parent's overall cleanup watchdog is ten seconds from the start of shutdown and
kills the proxy when a synchronous SRT cleanup call blocks its event loop.

No successful result is returned when descendant exit, proxy exit, command
cleanup, reset, partial-output cleanup, or root deletion cannot be confirmed. A
best-effort kill call without observed exit is a cleanup failure. The proxy and
parent must close output handles and remove listeners, timers, stream references,
queues, digest state, and abort handlers on every terminal path.

The parent remains the final reaper because a proxy can crash before running its
finalizer. The proxy remains the primary SRT owner because only it owns the
singleton state and platform helper handles. Both layers use bounded operations;
neither waits forever for the other.

An unconfirmed SRT reset or platform-policy revocation marks the process-global
document runtime unhealthy. The parent rejects later jobs until a separately
implemented native reconciliation/probe passes or the sidecar restarts. A fresh
proxy is not treated as proof that stale ACL, proxy, or helper state was removed.

## Verified Per-Job Directory Deletion

The parent creates each job under a process-private parent directory that the
inner worker cannot modify. It records the canonical parent, random job and
pending child names, and all three filesystem identities before launch. The
sandbox receives access only to the job child, not to its parent or pending
sibling. The proxy receives both child paths but creates output files only under
the pending child.

Final deletion follows these rules:

1. Confirm that the proxy and tracked descendants have exited.
2. Re-check the parent identity and that both child entries are the original
   non-link directories. If either identity changed, do not recurse into the
   replacement; return a safe cleanup failure.
3. Remove the exact job and pending children recursively without following a
   replacement link.
4. Retry transient sharing violations only within a fixed two-second cleanup
   budget after SRT reset.
5. Verify `lstat(jobRoot)` and `lstat(pendingRoot)` report absence and the private
   parent's directory listing contains neither random child name.
6. Remove the private parent when it is empty and verify its absence.

Deletion errors are not swallowed. A completed render/OCR result remains
provisional until deletion passes. Failure records contain only the job ID and a
curated cleanup code; they do not contain paths or document content. Startup may
run a separately bounded stale-directory reconciliation for directories created
by this subsystem, but such reconciliation does not convert the original failed
job into success.

## Packaging And Resolution

The document-runtime build emits the small `worker/bootstrap.js` before the
existing `worker/worker.js`; both files are covered by the runtime manifest. The
OpenCode Node build adds a standalone
`sandbox-runtime/document-runtime-proxy.mjs` beside the existing generic sandbox
worker and packages the pinned SRT vendor assets once. Process isolation, not a
duplicate package copy, gives each proxy its own SRT singleton. The document
runtime continues to contain the inner worker and document-native dependencies.

Desktop development behavior is:

- `predev` and development `prebuild` build the OpenCode Node sidecar/proxies and
  the target-specific development document runtime.
- The development resolver selects the built proxy and explicit target runtime.
- An absolute document-runtime override remains development-only and still
  requires manifest verification.
- A missing proxy, SRT dependency, runtime, or strict native capability reports
  runtime unavailable. Development does not silently start the worker directly.

Desktop beta/production behavior is:

- `RUST_TARGET`, not build-host inference, selects the release artifact during
  staging.
- `extraResources` places the proxy plus SRT vendor assets and the document
  runtime outside `app.asar`.
- The document runtime stays bound to its detached trusted attestation and exact
  manifest digest.
- The packaged resolver accepts only absolute paths beneath
  `process.resourcesPath`, checks target architecture, and returns the verified
  runtime root, digest, release-ready state, proxy path, and SRT asset root.
- The Desktop main process strips inherited document-runtime/proxy variables and
  supplies only resolver-produced values to the sidecar, including
  `KOALA_DOCUMENT_RUNTIME_PROXY_PATH` and
  `KOALA_DOCUMENT_RUNTIME_PROXY_ASSETS_ROOT`.
- OpenCode constructs the production launcher only from those resolver-produced
  values. Environment overrides, source TypeScript, a system `srt`, a system
  Tesseract, `PATH`, downloads, and a direct worker launch are not production
  fallbacks.

The release build verifies that the proxy bundle, SRT Java agent, Linux seccomp
helper, Windows `srt-win`, inner bootstrap, document worker, native canvas
module, Tesseract, data, and licenses required for that target are present.
Signing/notarization and architecture checks recurse through both the
confinement and document runtime resources. A build-time direct engine probe may
check artifact integrity, but it does not substitute for the packaged smoke test
that runs the engine through the proxy and native policy.

## Threat Model

### In scope

- A malformed or adversarial PDF/image exploiting PDF.js, canvas, an image
  codec, Tesseract, or document-worker logic.
- A compromised inner process attempting to read project files, user data,
  credentials, configuration, other jobs, or application state.
- Attempts to modify the verified runtime, proxy, application resources, or host
  files outside the job root.
- DNS, TCP, UDP, loopback, local binding, Unix socket, and proxy-based egress
  attempts from the inner process or descendants.
- Forked or detached descendants surviving cancellation, timeout, worker exit,
  proxy failure, or parent interruption.
- Protocol confusion, version mismatch, job-ID substitution, out-of-order page
  reuse, malformed JSON/base64, control or payload flooding, duplicate or
  interleaved output transfers, digest substitution, diagnostics flooding, and
  output path escape.
- Environment-based native loader injection, proxy inheritance, credential
  inheritance, system-font discovery, system binary substitution, and shell
  metacharacter injection.
- Sensitive input, raster, TSV, partial transfer, or pending-output residue after
  a job.

### Out of scope

- Compromise of the trusted parent, trusted proxy bundle, release signing keys,
  detached attestation, operating-system kernel, administrator/root account, or
  SRT provisioning authority.
- Physical memory inspection, privileged host debugging, kernel side channels,
  and denial of service within accepted hard limits.
- Semantic safety of a document accepted and later published as an artifact;
  format validation remains a separate boundary.
- Network operations performed later by a trusted vision/model service. They do
  not run in the document sandbox.

## Platform Constraints

The release matrix remains macOS, Windows, and glibc Linux on x64 and arm64. A
target is enabled only when its packaged native test passes on that target.

### macOS

- SRT uses the platform Seatbelt wrapper and target-native signed binaries.
- The policy disables Apple Events, PTYs, local binding, arbitrary Unix sockets,
  and caller-added Mach services.
- Nested code signing, hardened-runtime compatibility, application verification,
  notarization, read/write denial probes, process-tree cleanup, and deletion must
  pass on both architectures.
- Any unavoidable SRT/OS service allowance must be recorded and reviewed as a
  target-specific exception; an implicit broad allowance is not accepted.

### Linux

- The release target is glibc Linux with bubblewrap, network namespace support,
  the pinned target seccomp helper, `socat`, and `ripgrep` dependencies available
  to the proxy.
- Weaker nested or network isolation is disabled. Missing seccomp support or a
  seccomp dependency warning makes the runtime unavailable.
- Ubuntu hosts require an AppArmor policy permitting the approved unprivileged
  user-namespace flow or an explicitly provisioned equivalent. A globally
  relaxed sysctl is not silently applied by the application.
- ELF architecture, interpreter, RPATH, dependency closure, executable modes,
  namespace denial, process-group cleanup, and deletion must pass on x64 and
  arm64.

### Windows

- SRT uses the target-native packaged `srt-win` executable, a dedicated
  `srt-sandbox` local account, per-session filesystem ACLs, and machine-wide WFP
  filters provisioned by an elevated one-time installer action.
- Runtime, job, pending, proxy, and system roots must be absolute local fixed-
  volume paths. UNC paths, device paths, alternate data streams, reparse points,
  and unsupported filesystems are rejected.
- The job-root grant is scoped to that directory. The sandbox account receives
  read/execute access to the verified runtime and audited system loader roots and
  modify access only to the job root.
- PE architecture, recursive signatures, ACL setup/revocation, WFP denial,
  Job-Object descendant ownership, handle release, sharing-violation retry, and
  deletion must pass on x64 and arm64.

Native capability tests that skip because a host lacks provisioning do not
satisfy a release gate.

## Tests And Acceptance Gates

### Contract and transport tests

- Round-trip every parent/proxy and worker message at protocol version 1.
- Reject unknown versions, fields, types, job IDs, paths, target substitutions,
  starts, continuations, duplicate launches, duplicate terminal messages, and
  every invalid state transition.
- Exercise 16-KiB line and unterminated-buffer, 512 control-frame, 1-MiB control
  aggregate, 10-KiB decoded chunk, per-output, dynamic cumulative payload,
  250-MiB live temporary, 64-KiB diagnostic, Node IPC message, and queue
  boundaries at exact limit and limit plus one.
- Exercise partial UTF-8, split lines, combined lines, malformed UTF-8, malformed
  JSON, noncanonical base64, blank lines, EOF without LF, backpressure,
  disconnect, and stream error.
- Reject duplicate IDs, starts, ends, chunks, missing chunks, short non-final
  chunks, sequence gaps, interleaving, trailing chunks, mismatched source paths,
  wrong output kind/page IDs, declared/event/actual byte disagreement, cumulative
  overflow, digest mismatch, and an output event before stable completion.
- Fuzz absolute, traversal, backslash, drive, UNC, device, ADS, NUL,
  non-normalized, wrong-prefix, and wrong-extension worker path fields; confirm
  neither proxy nor parent opens them.
- Confirm raw stderr, exceptions, host paths, environment values, base64 chunks,
  and document bytes cannot enter proxy messages, diagnostics, or audit records.

### Policy and environment tests

- Snapshot the exact Koala SRT configuration on each platform.
- Confirm the effective SRT write list contains no persistent path outside the
  job root and reviewed device exceptions.
- Seed canary credentials, proxy variables, loader variables, cloud metadata
  variables, `NODE_OPTIONS`, user paths, and shell variables in the parent; none
  may appear in the reconstructed worker environment.
- Confirm only the documented Windows system-root addition is platform-specific.
- Round-trip the fixed launch on paths containing spaces and every relevant shell
  metacharacter without interpolating protocol values.
- Confirm SRT dependency warnings that weaken policy return unavailable.

### Native hostile-process tests

Run from each packaged target with no system Tesseract available:

- read the staged input and verified runtime;
- create, read, and delete files beneath the job root;
- deny reads of project, home, credentials, sibling job, Desktop resources, and
  arbitrary temporary files;
- deny writes to the runtime, project, home, system temporary directories,
  application resources, and SRT compatibility directories;
- deny DNS, public/private IP TCP and UDP, loopback, local binding, Unix sockets,
  and inherited proxy routes;
- attempt runtime replacement, links/reparse points, path traversal, and output
  path substitution;
- fork grandchildren and a Tesseract-shaped child that ignore cooperative
  cancellation, then confirm tree exit;
- crash and disconnect the worker and proxy at each lifecycle phase;
- hold files open during cleanup and verify bounded failure rather than false
  success;
- cancel or crash before start, during every chunk position, after end, after
  stable close, and after event publication; confirm partial and pending output
  cleanup and no event publication for incomplete transfers;
- confirm the sandbox cannot discover or access the pending sibling and the
  parent never opens a worker-root output path;
- confirm SRT command cleanup and reset execute once and that no proxy is reused;
- confirm the job, pending, and private parent directories are absent after every
  clean, failed, cancelled, timed-out, overflowed, and crashed run.

### Existing document behavior

- Preserve real PDF.js/native-canvas rendering, real Tesseract TSV, image OCR,
  100/101-page boundaries, per-page pending-output deletion and release, output
  byte/digest checks, page order, per-page deadlines, whole-job deadlines, and
  two-job global concurrency.
- Run offline packaged probe/render/OCR fixtures after installation on all six
  targets.
- Confirm no document tool is registered when confinement availability fails.

### Packaging tests

- Verify development and packaged resolver behavior without source or `PATH`
  fallback.
- Inspect `extraResources` for the exact target proxy, SRT assets, runtime, and
  detached attestation outside `app.asar`.
- Reject wrong architecture, missing assets, modified files, stale digest,
  non-release manifests, unsupported filesystems, and untrusted overrides.
- Run recursive Windows signature checks, macOS nested signing/notarization
  checks, and Linux ELF/dependency/mode checks.

## Rollout

1. Add the browser-safe launch/control and strict output-transfer contracts plus
   bounded NDJSON transport with pure state-machine and hostile-stream tests.
2. Add the standalone one-job proxy and adapt the inner worker transport. Keep
   the default OpenCode service unavailable until a production launcher is
   supplied.
3. Implement target policies and native integration tests. A target remains
   unavailable until its real read, write, network, process-tree, reset, and
   deletion probes pass.
4. Add OpenCode build output and Desktop development resolution. Development
   jobs use the same proxy path and policy as packaged jobs.
5. Add beta/production resource staging, target selection, signatures,
   attestations, and installed-app smoke tests.
6. Enable document-runtime availability in packaged builds only for targets with
   complete artifacts and passing native gates.
7. Register OCR/document tools only after this gate and the remaining Phase 9B/9C
   engine, validation, audit, and artifact requirements pass.

Rollout is target-specific but never policy-specific: an unsupported target is
unavailable rather than switched to a weaker or direct launcher.

## External Release Blockers

- Authentic release-ready Tesseract 5.5.3 and Leptonica 1.87.0 builds for all six
  targets, with English/OSD data, pinned dependency closure, hashes, signatures,
  and complete licenses/notices.
- Release-ready target-native canvas/PDF.js artifacts and full packaged offline
  render/OCR evidence bound to each target and manifest digest.
- A selected Koala license and corrected complete distribution notices.
- A reviewed implementation of this proxy, launch/control protocol, strict
  policy, environment reconstruction, tree reaper, SRT cleanup/reset, and
  verified deletion path.
- Provisioned native test hosts for macOS x64/arm64, Windows x64/arm64, and Linux
  x64/arm64. Windows hosts need the elevated SRT account/WFP installation; Linux
  hosts need the approved bubblewrap/seccomp/AppArmor or user-namespace setup.
- Passing native read, write, network, descendant, cancellation, reset, deletion,
  packaging, signing, notarization, and installed-application tests on every
  shipping target. The current repository results do not satisfy this blocker.
- Security review of the pinned SRT research-preview version and every required
  platform exception. An SRT upgrade repeats that review and the native matrix.

No external blocker may be converted into a runtime fallback.

## Alternatives Rejected

### Launch the document worker directly

Rejected because process cleanup, path validation, manifest verification, and a
fixed environment do not provide an OS filesystem and network boundary after a
native parser compromise. The existing direct launcher remains fail-closed and
is replaced, not retained as a production fallback.

### Initialize SRT in the long-lived OpenCode parent

Rejected because `SandboxManager` is process-global and owns proxies, policy,
violation state, platform ACL state, and reset. Concurrent document jobs or the
generic command sandbox could share or overwrite singleton state, and a failed
reset would contaminate a long-lived trusted process.

### Reuse one long-lived document proxy

Rejected because per-job policy roots would require repeated global reset and
reinitialization, and stale SRT state or descendants could cross job boundaries.
One process per job aligns singleton lifetime, policy lifetime, and hard reaping.

### Let the document worker initialize its own sandbox

Rejected because worker startup and imports would occur before confinement, and
a compromised worker would own the code responsible for applying and removing
its policy.

### Reuse the generic `sandbox_execute` worker protocol

Rejected because that boundary accepts a command-oriented request, broader
runtime roots, model-facing output, and different lifecycle semantics. Document
jobs need a fixed executable, an attested read-only runtime, page handshakes,
large file-backed outputs, and no arbitrary command field.

### Put Node IPC directly through SRT

Rejected because inherited IPC handles and platform wrappers differ across
macOS, Linux, and Windows and unnecessarily expose a privileged channel to the
untrusted worker. Bounded NDJSON over standard streams is portable and easier to
fuzz and account.

### Use only a network proxy and filesystem validation

Rejected because environment proxy settings are bypassable and post-write path
checks occur after access. Empty network policy and filesystem policy must be
native process-tree controls, with validation retained as a second boundary.

### Use containers or virtual machines for the Desktop baseline

Rejected for this phase because they add a separate privileged installation,
image distribution, lifecycle, and cross-platform product model. The proxy
boundary remains replaceable if a future deployment chooses a stronger external
isolation provider.

### Depend on system-installed SRT or document engines

Rejected because target identity, versions, assets, licenses, signatures,
availability, and behavior would vary by host. Production uses pinned packaged
resources selected by the explicit target.

### Continue after cleanup or reset failure

Rejected because success would be reported while descendants, ACLs, proxy state,
or sensitive temporary files may remain. The operation fails closed and the next
job receives a fresh proxy and fresh directory.
