import { DocumentSandboxProtocol } from "@koala-ai/core/document-runtime/sandbox-protocol"
import { DocumentRuntimeManifest } from "@koala-ai/core/document-runtime/manifest"
import { Schema } from "effect"
import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open } from "node:fs/promises"
import path from "node:path"
import { DocumentPendingRoot, type Evidence } from "./pending-root"

const MaxReceiptBytes = 4_096

export function relativePath(nonce: DocumentSandboxProtocol.ReceiptNonce) {
  return `.teardown-receipt-${nonce}.json`
}

export async function write(
  evidence: Evidence,
  payload: DocumentSandboxProtocol.TeardownReceiptPayload,
) {
  await DocumentPendingRoot.verify(evidence)
  const file = path.join(evidence.pendingRoot, relativePath(payload.receiptNonce))
  const body = Buffer.from(DocumentSandboxProtocol.teardownReceiptPayload(payload))
  if (body.byteLength > MaxReceiptBytes) throw new DocumentPendingRoot.EvidenceError("receipt-overflow")
  const receipt = {
    ...payload,
    receiptSha256: DocumentRuntimeManifest.Digest.make(createHash("sha256").update(body).digest("hex")),
  }
  const encoded = Buffer.from(DocumentSandboxProtocol.teardownReceipt(receipt))
  const handle = await open(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  let identity: { readonly dev: bigint; readonly ino: bigint } | undefined
  try {
    await handle.writeFile(encoded)
    await handle.sync()
    const info = await handle.stat({ bigint: true })
    if (!info.isFile() || info.size !== BigInt(encoded.byteLength)) {
      throw new DocumentPendingRoot.EvidenceError("receipt-write-mismatch")
    }
    identity = { dev: info.dev, ino: info.ino }
  } finally {
    await handle.close()
  }
  await DocumentPendingRoot.verify(evidence)
  const stable = await lstat(file, { bigint: true })
  if (!identity || stable.isSymbolicLink() || stable.dev !== identity.dev || stable.ino !== identity.ino) {
    throw new DocumentPendingRoot.EvidenceError("changed-teardown-receipt")
  }
  return receipt
}

export async function read(
  evidence: Evidence,
  nonce: DocumentSandboxProtocol.ReceiptNonce,
  expectedSha256?: string,
) {
  await DocumentPendingRoot.verify(evidence)
  const file = path.join(evidence.pendingRoot, relativePath(nonce))
  const before = await lstat(file, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1n || before.size > BigInt(MaxReceiptBytes)) {
    throw new DocumentPendingRoot.EvidenceError("invalid-teardown-receipt")
  }
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const bytes = await handle.readFile()
    const after = await handle.stat({ bigint: true })
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || bytes.byteLength !== Number(after.size)) {
      throw new DocumentPendingRoot.EvidenceError("changed-teardown-receipt")
    }
    const receipt = Schema.decodeUnknownSync(DocumentSandboxProtocol.TeardownReceipt)(
      JSON.parse(bytes.toString("utf8")),
      { onExcessProperty: "error" },
    )
    if (!bytes.equals(Buffer.from(DocumentSandboxProtocol.teardownReceipt(receipt)))) {
      throw new DocumentPendingRoot.EvidenceError("noncanonical-teardown-receipt")
    }
    if (receipt.receiptNonce !== nonce) throw new DocumentPendingRoot.EvidenceError("teardown-receipt-nonce-mismatch")
    const digest = createHash("sha256")
      .update(DocumentSandboxProtocol.teardownReceiptPayload(receipt))
      .digest("hex")
    if (receipt.receiptSha256 !== digest || (expectedSha256 !== undefined && expectedSha256 !== digest)) {
      throw new DocumentPendingRoot.EvidenceError("teardown-receipt-digest-mismatch")
    }
    await DocumentPendingRoot.verify(evidence)
    return receipt
  } finally {
    await handle.close()
  }
}

export function matchesClosed(
  receipt: DocumentSandboxProtocol.TeardownReceipt,
  closed: {
    readonly jobID: DocumentSandboxProtocol.TeardownReceipt["jobID"] | null
    readonly receiptNonce: DocumentSandboxProtocol.ReceiptNonce | null
    readonly receiptSha256: DocumentRuntimeManifest.Digest | null
    readonly terminalCategory: DocumentSandboxProtocol.TeardownReceiptPayload["terminalCategory"] | null
    readonly treeContained: boolean
    readonly managerInitialized: boolean
    readonly cleanupCalls: 0 | 1
    readonly cleanupCompleted: boolean
    readonly resetCalls: 0 | 1
    readonly resetCompleted: boolean
  },
) {
  return (
    closed.jobID === receipt.jobID &&
    closed.receiptNonce === receipt.receiptNonce &&
    closed.receiptSha256 === receipt.receiptSha256 &&
    closed.terminalCategory === receipt.terminalCategory &&
    closed.treeContained === receipt.treeContained &&
    closed.managerInitialized === receipt.managerInitialized &&
    closed.cleanupCalls === receipt.cleanupCalls &&
    closed.cleanupCompleted === receipt.cleanupCompleted &&
    closed.resetCalls === receipt.resetCalls &&
    closed.resetCompleted === receipt.resetCompleted
  )
}

export * as DocumentTeardownReceipt from "./teardown-receipt"
