import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { DocumentRuntimeAttestation } from "./attestation"

const digest = "0123456789abcdef".repeat(4)
const release = { version: "1.2.3", sourceCommit: "a".repeat(40), buildID: "github-123-1" } as const
const bindings = {
  reportVersion: 1 as const,
  target: "x86_64-pc-windows-msvc" as const,
  runtimeManifestSha256: digest,
  runtimeAttestationSha256: digest,
  proxySha256: digest,
  sandboxRuntimeManifestSha256: digest,
  policyVersion: 1 as const,
  release,
}

describe("DocumentRuntimeAttestation", () => {
  test("round trips a detached production trust input without self-asserted confinement evidence", () => {
    const input = {
      attestationVersion: 1,
      profileVersion: 1,
      target: "x86_64-pc-windows-msvc",
      manifestSha256: digest,
      runtimeVersion: "0.1.0",
      components: [
        {
          name: "tesseract",
          version: "5.5.3",
          sourceRevision: "v5.5.3",
          sourceSha256: digest,
          licenseFiles: ["licenses/tesseract/LICENSE"],
        },
      ],
      dependencies: [],
      executables: ["bin/tesseract.exe"],
      smokeEvidence: {
        evidenceVersion: 1,
        target: "x86_64-pc-windows-msvc",
        manifestSha256: digest,
        tesseractVersion: "5.5.3",
        render: "passed",
        ocr: "passed",
        reportSha256: digest,
      },
    } as const
    const decoded = Schema.decodeUnknownSync(DocumentRuntimeAttestation.Attestation)(input)
    expect(Schema.encodeSync(DocumentRuntimeAttestation.Attestation)(decoded)).toEqual(input)
  })

  test("decodes strict typed reports with common release and inventory bindings", () => {
    const inventory = Schema.decodeUnknownSync(DocumentRuntimeAttestation.SignedFileInventoryReport)({
      ...bindings,
      status: "passed",
      files: [{ path: "sandbox-runtime/document-runtime-proxy.mjs", sha256: digest, bytes: 1, mode: 0o644 }],
    })
    const native = Schema.decodeUnknownSync(DocumentRuntimeAttestation.NativeTestReport)({
      ...bindings,
      signedFileInventorySha256: digest,
      status: "passed",
      checks: {
        allowedRuntimeAndJobOperations: "passed",
        deniedFilesystemReadsAndWrites: "passed",
        deniedDnsTcpUdpLoopbackBindAndSockets: "passed",
        childAndGrandchildReaping: "passed",
        cleanupAndResetCompletion: "passed",
        proxyNonreuse: "passed",
        replacementAndLinkAttacks: "passed",
        outputSubstitution: "passed",
        workerCrash: "passed",
        innerDisconnect: "passed",
        proxyCrashContained: "passed",
        heldOpenCleanup: "passed",
        parentDisconnectReconciled: "passed",
        systemTesseractUnused: "passed",
        jobPendingAndParentRootAbsence: "passed",
        authenticPdfRenderAndTesseractOcr: "passed",
      },
    })
    expect(inventory.status).toBe("passed")
    expect(native.release).toEqual(release)
    expect(() =>
      Schema.decodeUnknownSync(DocumentRuntimeAttestation.NativeTestReport)({
        ...native,
        status: "skipped",
      }),
    ).toThrow()
  })

  test("renders one deterministic signed subject and rejects malformed envelopes", () => {
    const subject = Schema.decodeUnknownSync(DocumentRuntimeAttestation.ConfinementEvidenceSubject)({
      evidenceVersion: 3,
      target: bindings.target,
      runtimeManifestSha256: digest,
      runtimeAttestationSha256: digest,
      proxySha256: digest,
      sandboxRuntimeManifestSha256: digest,
      srtVersion: "0.0.76",
      policyVersion: 1,
      release,
      nativeTestReportSha256: digest,
      packagedSmokeReportSha256: digest,
      signingReportSha256: digest,
      signedFileInventorySha256: digest,
      dependencyReportSha256: digest,
      issuerKeyID: digest,
    })
    const encoded = DocumentRuntimeAttestation.confinementEvidenceSubject(subject)
    expect(encoded.endsWith("\n")).toBe(true)
    expect(encoded).toBe(DocumentRuntimeAttestation.confinementEvidenceSubject(subject))
    expect(encoded).toContain(`"runtimeAttestationSha256":"${digest}"`)
    expect(encoded).toContain('"buildID":"github-123-1"')
    expect(() =>
      Schema.decodeUnknownSync(DocumentRuntimeAttestation.ConfinementEvidenceEnvelope)({
        envelopeVersion: 1,
        algorithm: "Ed25519",
        keyID: digest,
        subject,
        signature: "not-base64",
      }),
    ).toThrow()
    expect(
      Schema.decodeUnknownSync(DocumentRuntimeAttestation.ConfinementEvidenceEnvelope)({
        envelopeVersion: 1,
        algorithm: "Ed25519",
        keyID: digest,
        subject,
        signature: Buffer.alloc(64).toString("base64"),
      }).keyID.toString(),
    ).toBe(digest)
  })

  test("requires every signed subject property and every release identity property", () => {
    const subject = {
      evidenceVersion: 3,
      target: "x86_64-pc-windows-msvc",
      runtimeManifestSha256: digest,
      runtimeAttestationSha256: digest,
      proxySha256: digest,
      sandboxRuntimeManifestSha256: digest,
      srtVersion: "0.0.76",
      policyVersion: 1,
      release,
      nativeTestReportSha256: digest,
      packagedSmokeReportSha256: digest,
      signingReportSha256: digest,
      signedFileInventorySha256: digest,
      dependencyReportSha256: digest,
      issuerKeyID: digest,
    }
    for (const key of Object.keys(subject)) {
      const mutated = { ...subject } as Record<string, unknown>
      delete mutated[key]
      expect(() =>
        Schema.decodeUnknownSync(DocumentRuntimeAttestation.ConfinementEvidenceSubject)(mutated, {
          onExcessProperty: "error",
        }),
      ).toThrow()
    }
    for (const key of Object.keys(release)) {
      const changed = { ...release } as Record<string, unknown>
      delete changed[key]
      expect(() =>
        Schema.decodeUnknownSync(DocumentRuntimeAttestation.ConfinementEvidenceSubject)(
          { ...subject, release: changed },
          { onExcessProperty: "error" },
        ),
      ).toThrow()
    }
  })
})
