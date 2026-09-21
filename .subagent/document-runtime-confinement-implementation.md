# Document Runtime Confinement Implementation

## Scope

Phases 1 through 6 implement the protocol, bounded transport, document-only SRT
policy, one-job proxy, verified output handoff, coordinator cutover, and Desktop
packaging boundary described in
`document-runtime-confinement_plan.md`. This record adds the code-owned Phase 7
native evidence gates. It does not enable a document target or claim native
evidence that has not been produced.

## Native Gate

- `packages/opencode/test/document/confinement-native.test.ts` is skipped only
  when neither native opt-in variable is set. `KOALA_REQUIRE_DOCUMENT_CONFINEMENT=1`
  enters the suite and converts missing paths, target mismatch, absent SRT
  capability, or policy failure into a failed test.
- The hostile bootstrap runs through the exact built one-job proxy identified by
  the sandbox-runtime manifest and the real SRT manager. It is installed only
  into a copied test runtime whose modified
  bootstrap and manifest receive new SHA-256 values. The copied runtime is not
  represented as the authentic release runtime.
- Hostile probes cover allowed runtime/job reads and job writes; denied project,
  home, credential, sibling-job, pending-sibling, application-resource,
  runtime-write, and system-temporary access; DNS, public/private/loopback TCP,
  UDP, local binding, and Unix socket access; proxy-environment absence; and
  pending-root absence from the handoff environment.
- A cancellation fixture starts a child and grandchild that ignore cooperative
  termination. The test requires both PIDs to be absent after closure.
- Separate target-native runs exercise runtime replacement, external links,
  hostile output paths, worker crash, inner transport disconnect, held-open
  files, and parent interruption. Accepted runs require terminal, `closed`, IPC
  disconnect, clean proxy exit, and no command-cleanup/reset/termination failure.
  Repeated runs require distinct proxy PIDs; existing injected lifecycle tests
  retain the exact once-only cleanup/reset counters.
- The public `closed` event now reports tree containment, manager initialization,
  cleanup/reset call counts, and completion booleans. Accepted runs require one
  completed cleanup and reset. Valid pre-initialization rejection reports zero
  calls and false completion values.
- Every launch carries a random 256-bit receipt nonce. After containment and the
  teardown attempt, the proxy writes one exclusive canonical receipt below the
  verified pending root. The parent verifies root identity, file identity, exact
  bytes, nonce, payload digest, terminal category, and teardown fields after
  proxy exit. This same receipt permits bounded reconciliation after parent IPC
  loss.
- Native tests also kill the exact built proxy after worker startup and after
  hostile descendants exist. A trusted supervisor sweeps the recorded inner
  process group and verifies process and root absence. These cases are recorded
  only as `proxyCrashContained`; they do not claim cleanup/reset completion.
- Every private job, pending, and parent root is removed through the production
  verified root finalizer. The native report is created exclusively after all
  assertions pass.
- The unhealthy latch belongs to each `DocumentRuntime.layer(config)` service
  instance and is threaded through verification, job ownership, sessions,
  pending-output handling, and teardown. Reusing one layer retains poison across
  calls; independently created layers are isolated. The one layer retained by
  `makeGlobalNode` preserves process-global production behavior.
- Real PDF rendering and Tesseract OCR run separately through the production
  coordinator, authentic attested runtime, built proxy, and SRT assets. The test
  also exercises page release and cancellation.

## Desktop And Evidence

- `packages/desktop/scripts/document-runtime-smoke.ts` accepts only a DMG, NSIS
  installer, or AppImage. It mounts, installs, or extracts into owned temporary
  storage, derives the resource root from that installed layout, runs proxy
  probe/render/OCR/release/cancellation, checks root absence, and emits strict
  deterministic JSON. It has no checkout or unpacked-tree fallback. A hostile
  `PATH` Tesseract writes a marker if selected; any marker fails the smoke.
- Confinement evidence is a version-3 canonical subject in a version-1 Ed25519
  envelope. The subject binds runtime-manifest and detached-attestation bytes,
  proxy and sandbox-manifest digests, SRT/policy versions, release version,
  source commit, build identity, five report digests, and a key ID derived as
  SHA-256 over the issuer SPKI DER public key.
- The public key, release identity, native/smoke/signing/dependency reports,
  exact inventory, and envelope are package resources. Staging and packaged
  startup both decode them strictly, verify the Ed25519 signature, compare all
  bindings, and hash every inventoried file.
- `document-runtime-evidence.ts` verifies canonical trusted inputs, creates an
  exact candidate resource layout, inventories regular non-link files, invokes
  explicit trusted signing/dependency reporters, strictly decodes their output,
  writes the issuance request, passes every typed report and the runtime
  attestation to an explicit external issuer, and verifies the returned
  envelope. It has no signing key, local issuer, runtime download, or report
  fallback.
- The inventory includes the issuer public key and release identity but excludes
  reports and the envelope to avoid a self-digest cycle. The signed subject binds
  all report bytes and the complete detached runtime-attestation bytes.
- Final release staging creates a fresh direct child under an explicit canonical
  staging parent. Existing destinations are rejected without deletion; failed
  copies are removed only when the originally created filesystem identity still
  matches.

## Publish Gate

The six-target Desktop matrix now requires target-native host equality before
building evidence. Windows ARM64 uses the self-hosted labels `Windows`, `ARM64`,
and `koala-document-confinement`; an x64 Windows runner cannot satisfy that job.
Release-only steps build an unavailable candidate package, install or mount it,
run native and smoke gates, obtain and verify external evidence, create a fresh
final staging tree, then build and install the final package. The final smoke
derives runtime, sandbox, attestation, reports, and public key only from the
installed artifact and verifies its signature and inventory. Non-release builds
use the development channel and carry no release evidence.

## Current Status

Non-native tests validate the versioned evidence shape, deterministic subject,
host-equality check, inventory behavior, absence of a local issuer fallback,
packaged smoke report, and all existing document/proxy/policy behavior. The
native test remains skipped in ordinary development.

No native pass is recorded. On the current Windows x64 development host,
required mode fails closed before execution because no staged package-resource
root is present and no reviewed Windows loader/Job Object/ACL-reset/WFP evidence
has been provisioned. Stock SRT `0.0.76` remains insufficient for the approved
Windows teardown requirement.

Observed non-native verification on 2026-09-21:

- Koala: 568 tests passed; typecheck passed.
- Document Runtime: 82 tests passed, 2 existing symlink-capability tests skipped;
  build, typecheck, and generated bootstrap/worker syntax checks passed.
- OpenCode document/sandbox regressions: 216 tests passed, 1 Phase 7 native test
  skipped in ordinary mode; typecheck, Node build, and proxy syntax check passed.
- Runtime order-isolation stress passed seeds 1701, 2903, and 4219 with
  `--randomize --rerun-each 3`; each seed completed 48 runs.
- Desktop focused gate/staging/package tests: 47 passed and 1 platform-capability
  test skipped; typecheck and production build passed.
- Required native mode failed on the absent packaged-resource input instead of
  skipping. The explicit Windows ARM64 check also rejected this x64 host.
- No native or production evidence files were issued.
- The publish workflow parsed successfully with the local Python YAML parser.

## External Inputs

- Authentic release-ready Tesseract `5.5.3`, Leptonica `1.87.0`, English/OSD
  tessdata, PDF.js, and target-native canvas artifacts for all six targets.
- Complete exact dependency and license inventories for every native artifact,
  including the unresolved Koala license decision.
- Canonical per-target release-runtime roots and independently prepared base
  attestations supplied through the six target-specific workflow variables.
- An Ed25519 issuer public key in SPKI DER form at the absolute path configured by
  `KOALA_DOCUMENT_CONFINEMENT_ISSUER_PUBLIC_KEY`. Its private key is not stored in
  this repository or package.
- Provisioned native x64/ARM64 macOS, Windows, and glibc Linux runners. Windows
  requires the sandbox account, WFP setup, reviewed loader inventory, owned Job
  Object evidence, and conclusive ACL reset/reconciliation. Linux requires the
  pinned seccomp helper, bubblewrap, socat, ripgrep, and approved user-namespace
  provisioning.
- Trusted absolute signing-report and dependency-report executables that inspect
  the exact candidate/final resources and emit deterministic reports.
- A trusted absolute independent issuer executable. The issuer must validate the
  canonical request, base attestation, resource tree, and every typed report,
  then return the detached Ed25519 envelope; repository code does not self-issue
  it.
- A trusted package-signature verifier for Linux AppImage releases. Windows uses
  Authenticode verification and macOS uses `codesign` plus Gatekeeper before
  installed smoke.
- Platform signing/notarization identities and credentials. Final release
  publication also requires the repeated packaged reports to match the issued
  evidence exactly.
