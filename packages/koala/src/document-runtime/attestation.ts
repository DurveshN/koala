export * as DocumentRuntimeAttestation from "./attestation"

import { Schema } from "effect"
import { DocumentRuntimeManifest } from "./manifest"
import { DocumentRuntimeTarget } from "./target"

export const AttestationVersion = Schema.Literal(1)
export const ProductionProfileVersion = Schema.Literal(1)
export const SmokeEvidenceVersion = Schema.Literal(1)
export const ConfinementEvidenceVersion = Schema.Literal(3)
export const ConfinementEnvelopeVersion = Schema.Literal(1)
export const ConfinementReportVersion = Schema.Literal(1)

const ExecutablePaths = Schema.Array(DocumentRuntimeManifest.RelativePath).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(DocumentRuntimeManifest.MaxFiles),
  Schema.makeFilter((paths) =>
    new Set(paths.map((value) => value.toLowerCase())).size === paths.length
      ? undefined
      : "Executable paths must be unique",
  ),
)

export interface Attestation extends Schema.Schema.Type<typeof Attestation> {}
export interface SmokeEvidence extends Schema.Schema.Type<typeof SmokeEvidence> {}
export interface ReleaseIdentity extends Schema.Schema.Type<typeof ReleaseIdentity> {}
export interface EvidenceBindings extends Schema.Schema.Type<typeof EvidenceBindings> {}
export interface SignedFileInventoryReport extends Schema.Schema.Type<typeof SignedFileInventoryReport> {}
export interface NativeTestReport extends Schema.Schema.Type<typeof NativeTestReport> {}
export interface PackagedSmokeReport extends Schema.Schema.Type<typeof PackagedSmokeReport> {}
export interface SigningReport extends Schema.Schema.Type<typeof SigningReport> {}
export interface DependencyReport extends Schema.Schema.Type<typeof DependencyReport> {}
export interface ConfinementEvidenceSubject extends Schema.Schema.Type<typeof ConfinementEvidenceSubject> {}
export interface ConfinementEvidenceEnvelope extends Schema.Schema.Type<typeof ConfinementEvidenceEnvelope> {}
export const SmokeEvidence = Schema.Struct({
  evidenceVersion: SmokeEvidenceVersion,
  target: DocumentRuntimeTarget.Target,
  manifestSha256: DocumentRuntimeManifest.Digest,
  tesseractVersion: Schema.Literal("5.5.3"),
  render: Schema.Literal("passed"),
  ocr: Schema.Literal("passed"),
  reportSha256: DocumentRuntimeManifest.Digest,
}).annotate({ identifier: "DocumentRuntimeAttestation.SmokeEvidence" })

const SafeIdentity = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
  Schema.makeFilter((value) =>
    value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value) ? undefined : "Invalid evidence identity",
  ),
)
const SourceCommit = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/))
const CanonicalBase64 = Schema.String.check(
  Schema.isMinLength(88),
  Schema.isMaxLength(88),
  Schema.isPattern(/^[A-Za-z0-9+/]{86}==$/),
)
const Passed = Schema.Literal("passed")

export const ReleaseIdentity = Schema.Struct({
  version: DocumentRuntimeManifest.Version,
  sourceCommit: SourceCommit,
  buildID: SafeIdentity,
}).annotate({ identifier: "DocumentRuntimeAttestation.ReleaseIdentity" })

const evidenceBindingFields = {
  reportVersion: ConfinementReportVersion,
  target: DocumentRuntimeTarget.Target,
  runtimeManifestSha256: DocumentRuntimeManifest.Digest,
  runtimeAttestationSha256: DocumentRuntimeManifest.Digest,
  proxySha256: DocumentRuntimeManifest.Digest,
  sandboxRuntimeManifestSha256: DocumentRuntimeManifest.Digest,
  policyVersion: Schema.Literal(1),
  release: ReleaseIdentity,
} as const

export const EvidenceBindings = Schema.Struct(evidenceBindingFields).annotate({
  identifier: "DocumentRuntimeAttestation.EvidenceBindings",
})

const inventoryFile = Schema.Struct({
  path: DocumentRuntimeManifest.RelativePath,
  sha256: DocumentRuntimeManifest.Digest,
  bytes: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  mode: DocumentRuntimeManifest.FileMode,
})

export const SignedFileInventoryReport = Schema.Struct({
  ...evidenceBindingFields,
  status: Passed,
  files: Schema.Array(inventoryFile).check(Schema.isMinLength(1), Schema.isMaxLength(DocumentRuntimeManifest.MaxFiles)),
}).annotate({ identifier: "DocumentRuntimeAttestation.SignedFileInventoryReport" })

const reportBindingFields = {
  ...evidenceBindingFields,
  signedFileInventorySha256: DocumentRuntimeManifest.Digest,
  status: Passed,
} as const

export const NativeTestReport = Schema.Struct({
  ...reportBindingFields,
  checks: Schema.Struct({
    allowedRuntimeAndJobOperations: Passed,
    deniedFilesystemReadsAndWrites: Passed,
    deniedDnsTcpUdpLoopbackBindAndSockets: Passed,
    childAndGrandchildReaping: Passed,
    cleanupAndResetCompletion: Passed,
    proxyNonreuse: Passed,
    replacementAndLinkAttacks: Passed,
    outputSubstitution: Passed,
    workerCrash: Passed,
    innerDisconnect: Passed,
    proxyCrashContained: Passed,
    heldOpenCleanup: Passed,
    parentDisconnectReconciled: Passed,
    systemTesseractUnused: Passed,
    jobPendingAndParentRootAbsence: Passed,
    authenticPdfRenderAndTesseractOcr: Passed,
  }),
}).annotate({ identifier: "DocumentRuntimeAttestation.NativeTestReport" })

export const PackagedSmokeReport = Schema.Struct({
  ...reportBindingFields,
  installedRuntimeAttestationSha256: DocumentRuntimeManifest.Digest,
  operations: Schema.Struct({
    proxyProbe: Passed,
    pdfRender: Passed,
    tesseractOcr: Passed,
    release: Passed,
    cancellation: Passed,
    rootCleanup: Passed,
    systemTesseractUnused: Passed,
    installedLayout: Passed,
  }),
}).annotate({ identifier: "DocumentRuntimeAttestation.PackagedSmokeReport" })

export const SigningReport = Schema.Struct({
  ...reportBindingFields,
  files: Schema.Array(
    Schema.Struct({
      path: DocumentRuntimeManifest.RelativePath,
      sha256: DocumentRuntimeManifest.Digest,
      signature: Passed,
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(DocumentRuntimeManifest.MaxFiles)),
}).annotate({ identifier: "DocumentRuntimeAttestation.SigningReport" })

export const DependencyReport = Schema.Struct({
  ...reportBindingFields,
  entries: Schema.Array(
    Schema.Struct({
      path: DocumentRuntimeManifest.RelativePath,
      sha256: DocumentRuntimeManifest.Digest,
      architecture: DocumentRuntimeTarget.Architecture,
      closure: Passed,
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(DocumentRuntimeManifest.MaxDependencies)),
}).annotate({ identifier: "DocumentRuntimeAttestation.DependencyReport" })

const confinementEvidenceSubjectFields = {
  evidenceVersion: ConfinementEvidenceVersion,
  target: DocumentRuntimeTarget.Target,
  runtimeManifestSha256: DocumentRuntimeManifest.Digest,
  runtimeAttestationSha256: DocumentRuntimeManifest.Digest,
  proxySha256: DocumentRuntimeManifest.Digest,
  sandboxRuntimeManifestSha256: DocumentRuntimeManifest.Digest,
  srtVersion: Schema.Literal("0.0.76"),
  policyVersion: Schema.Literal(1),
  release: ReleaseIdentity,
  nativeTestReportSha256: DocumentRuntimeManifest.Digest,
  packagedSmokeReportSha256: DocumentRuntimeManifest.Digest,
  signingReportSha256: DocumentRuntimeManifest.Digest,
  signedFileInventorySha256: DocumentRuntimeManifest.Digest,
  dependencyReportSha256: DocumentRuntimeManifest.Digest,
  issuerKeyID: DocumentRuntimeManifest.Digest,
} as const

export const ConfinementEvidenceSubject = Schema.Struct(confinementEvidenceSubjectFields).annotate({
  identifier: "DocumentRuntimeAttestation.ConfinementEvidenceSubject",
})

export const ConfinementEvidenceEnvelope = Schema.Struct({
  envelopeVersion: ConfinementEnvelopeVersion,
  algorithm: Schema.Literal("Ed25519"),
  keyID: DocumentRuntimeManifest.Digest,
  subject: ConfinementEvidenceSubject,
  signature: CanonicalBase64,
}).annotate({ identifier: "DocumentRuntimeAttestation.ConfinementEvidenceEnvelope" })

export function confinementEvidenceSubject(input: ConfinementEvidenceSubject) {
  return `${JSON.stringify({
    evidenceVersion: input.evidenceVersion,
    target: input.target,
    runtimeManifestSha256: input.runtimeManifestSha256,
    runtimeAttestationSha256: input.runtimeAttestationSha256,
    proxySha256: input.proxySha256,
    sandboxRuntimeManifestSha256: input.sandboxRuntimeManifestSha256,
    srtVersion: input.srtVersion,
    policyVersion: input.policyVersion,
    release: {
      version: input.release.version,
      sourceCommit: input.release.sourceCommit,
      buildID: input.release.buildID,
    },
    nativeTestReportSha256: input.nativeTestReportSha256,
    packagedSmokeReportSha256: input.packagedSmokeReportSha256,
    signingReportSha256: input.signingReportSha256,
    signedFileInventorySha256: input.signedFileInventorySha256,
    dependencyReportSha256: input.dependencyReportSha256,
    issuerKeyID: input.issuerKeyID,
  })}\n`
}

export const Attestation = Schema.Struct({
  attestationVersion: AttestationVersion,
  profileVersion: ProductionProfileVersion,
  target: DocumentRuntimeTarget.Target,
  manifestSha256: DocumentRuntimeManifest.Digest,
  runtimeVersion: DocumentRuntimeManifest.Version,
  components: Schema.Array(DocumentRuntimeManifest.Component).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(DocumentRuntimeManifest.MaxComponents),
  ),
  dependencies: Schema.Array(DocumentRuntimeManifest.Dependency).check(
    Schema.isMaxLength(DocumentRuntimeManifest.MaxDependencies),
  ),
  executables: ExecutablePaths,
  smokeEvidence: Schema.optionalKey(SmokeEvidence),
}).annotate({ identifier: "DocumentRuntimeAttestation.Attestation" })
