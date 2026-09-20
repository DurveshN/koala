import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { DocumentRuntimeAttestation } from "./attestation"

const digest = "0123456789abcdef".repeat(4)

describe("DocumentRuntimeAttestation", () => {
  test("round trips a detached production trust input", () => {
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
      confinementEvidence: {
        evidenceVersion: 1,
        target: "x86_64-pc-windows-msvc",
        runtimeManifestSha256: digest,
        proxySha256: digest,
        sandboxRuntimeManifestSha256: digest,
        srtVersion: "0.0.76",
        policyVersion: 1,
        nativeTestReportSha256: digest,
        packagedSmokeReportSha256: digest,
        signingReportSha256: digest,
        signedFileInventorySha256: digest,
        dependencyReportSha256: digest,
      },
    } as const
    const decoded = Schema.decodeUnknownSync(DocumentRuntimeAttestation.Attestation)(input)
    expect(Schema.encodeSync(DocumentRuntimeAttestation.Attestation)(decoded)).toEqual(input)
  })

  test("rejects duplicate executable paths and malformed digests", () => {
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
      executables: ["bin/tesseract.exe", "BIN/TESSERACT.EXE"],
    }
    expect(() => Schema.decodeUnknownSync(DocumentRuntimeAttestation.Attestation)(input)).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(DocumentRuntimeAttestation.Attestation)({
        ...input,
        executables: ["bin/tesseract.exe"],
        manifestSha256: "0".repeat(63),
      }),
    ).toThrow()
  })

  test("rejects malformed confinement evidence", () => {
    expect(() =>
      Schema.decodeUnknownSync(DocumentRuntimeAttestation.Attestation)({
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
        confinementEvidence: {
          evidenceVersion: 2,
          target: "x86_64-pc-windows-msvc",
          runtimeManifestSha256: digest,
          proxySha256: digest,
          sandboxRuntimeManifestSha256: digest,
          srtVersion: "0.0.76",
          policyVersion: 1,
          nativeTestReportSha256: digest,
          packagedSmokeReportSha256: digest,
          signingReportSha256: digest,
          signedFileInventorySha256: digest,
          dependencyReportSha256: digest,
        },
      }),
    ).toThrow()
  })
})
