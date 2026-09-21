import { afterAll, describe, expect, test } from "bun:test"
import { DocumentRuntimeProtocol } from "@koala-ai/core/document-runtime/protocol"
import { DocumentSandboxProtocol } from "@koala-ai/core/document-runtime/sandbox-protocol"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DocumentJobRoot } from "@/document/job-root"
import { DocumentTeardownReceipt } from "@/document/teardown-receipt"

const roots: string[] = []

afterAll(async () => {
  await Promise.all(
    roots.map(async (root) => {
      if (process.platform !== "win32") await chmod(root, 0o700).catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    }),
  )
})

describe("document teardown receipt", () => {
  test("writes exclusively and verifies nonce, identity, payload digest, and teardown state", async () => {
    const root = await createRoot()
    const payload = completePayload()
    const receipt = await DocumentTeardownReceipt.write(evidence(root), payload)
    expect(await DocumentTeardownReceipt.read(evidence(root), payload.receiptNonce, receipt.receiptSha256)).toEqual(
      receipt,
    )
    await expect(DocumentTeardownReceipt.write(evidence(root), payload)).rejects.toThrow()
  })

  test("rejects changed receipt bytes and expected digest substitution", async () => {
    const root = await createRoot()
    const payload = completePayload()
    const receipt = await DocumentTeardownReceipt.write(evidence(root), payload)
    const file = path.join(root.pending, DocumentTeardownReceipt.relativePath(payload.receiptNonce))
    await writeFile(file, `${await readFile(file, "utf8")} `)
    await expect(DocumentTeardownReceipt.read(evidence(root), payload.receiptNonce)).rejects.toThrow()
    await rm(file)
    const rewritten = await DocumentTeardownReceipt.write(evidence(root), payload)
    await expect(DocumentTeardownReceipt.read(evidence(root), payload.receiptNonce, "0".repeat(64))).rejects.toThrow()
    expect(rewritten.receiptSha256).toBe(receipt.receiptSha256)
  })
})

async function createRoot() {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "document-receipt-test-"))
  roots.push(temporaryRoot)
  return DocumentJobRoot.create({ temporaryRoot })
}

function evidence(root: DocumentJobRoot.Root) {
  return {
    parentRoot: root.parent,
    parentIdentity: root.parentIdentity,
    parentMode: root.parentMode ?? null,
    pendingRoot: root.pending,
    pendingRootIdentity: root.pendingIdentity,
  }
}

function completePayload(): DocumentSandboxProtocol.TeardownReceiptPayload {
  return {
    protocolVersion: 1,
    type: "teardown-receipt",
    jobID: DocumentRuntimeProtocol.JobID.make("job_00000000-0000-4000-8000-000000000001"),
    receiptNonce: DocumentSandboxProtocol.ReceiptNonce.make("a".repeat(64)),
    terminalCategory: "completed",
    treeContained: true,
    managerInitialized: true,
    cleanupCalls: 1,
    cleanupCompleted: true,
    resetCalls: 1,
    resetCompleted: true,
  }
}
