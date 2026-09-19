export * as DocumentRuntimeAttestation from "./attestation"

import { Schema } from "effect"
import { DocumentRuntimeManifest } from "./manifest"
import { DocumentRuntimeTarget } from "./target"

export const AttestationVersion = Schema.Literal(1)
export const ProductionProfileVersion = Schema.Literal(1)
export const SmokeEvidenceVersion = Schema.Literal(1)

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
export const SmokeEvidence = Schema.Struct({
  evidenceVersion: SmokeEvidenceVersion,
  target: DocumentRuntimeTarget.Target,
  manifestSha256: DocumentRuntimeManifest.Digest,
  tesseractVersion: Schema.Literal("5.5.3"),
  render: Schema.Literal("passed"),
  ocr: Schema.Literal("passed"),
  reportSha256: DocumentRuntimeManifest.Digest,
}).annotate({ identifier: "DocumentRuntimeAttestation.SmokeEvidence" })

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
