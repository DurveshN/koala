import { createHash, randomUUID } from "node:crypto"
import { lstat, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

let launch
let mode = "success"
let page
let pagePath
let tsvPath
let terminal = false
let sending = Promise.resolve()

process.on("message", (message) => {
  sending = sending.then(() => handle(message)).catch(() => process.exit(1))
})

async function handle(message) {
  if (message.type === "launch") {
    if (launch) return fail("protocol-mismatch", "transport")
    launch = message
    mode = JSON.parse(await readFile(path.join(message.runtimeRoot, "manifest.json"), "utf8")).components[0]
      .sourceRevision
    await send({ protocolVersion: 1, type: "accepted", jobID: launch.jobID })
    if (mode === "reset-failure") return fail("reset-failed", "reset")
    if (mode === "root-identity-failure") return fail("root-identity-failed", "worker")
    if (mode === "parser-failure") {
      await event({ protocolVersion: 1, type: "started", jobID: launch.jobID, operation: launch.start.type })
      await event({
        protocolVersion: 1,
        type: "failure",
        jobID: launch.jobID,
        code: "render-failed",
        stage: "render",
        retryable: false,
      })
      terminal = true
      return close()
    }
    if (mode === "invalid-outer") {
      return send({ protocolVersion: 1, type: "event", jobID: launch.jobID, event: started(), extra: "canary" })
    }
    if (mode === "wrong-order") {
      return event(completed())
    }
    if (mode === "wrong-job") {
      return event({ ...started(), jobID: "job_00000000-0000-4000-8000-000000000099" })
    }
    if (mode === "crash") return process.exit(1)
    if (mode === "hang") return
    await event(started())
    if (launch.start.type === "probe") return complete()
    if (launch.start.type === "ocr") {
      const body = Buffer.from(mode === "oversize-output" ? "oversized" : `fixture\t${launch.start.page}\n`)
      tsvPath = `output-${randomUUID()}.tsv`
      await writeFile(path.join(launch.pendingRoot, tsvPath), body)
      const sha256 = createHash("sha256").update(body).digest("hex")
      await event({
        protocolVersion: 1,
        type: "ocr-result",
        jobID: launch.jobID,
        page: launch.start.page,
        pageID: launch.start.pageID,
        resultID: `ocr_${randomUUID()}`,
        outputPath: tsvPath,
        outputID: outputID(),
        outputSha256: sha256,
        tsvBytes: mode === "oversize-output" ? 1 : body.byteLength,
        temporaryBytes: body.byteLength,
      })
      return complete()
    }
    return ready(launch.start.startPage)
  }

  if (!launch || terminal) return
  if (message.type === "cancel") {
    await event({ protocolVersion: 1, type: "cancelled", jobID: launch.jobID })
    terminal = true
    return close()
  }
  if (message.type !== "command") return fail("protocol-mismatch", "transport")
  if (message.command.type === "ocr" && page !== undefined) {
    const body = Buffer.from(`fixture\t${page}\n`)
    tsvPath = `output-${randomUUID()}.tsv`
    await writeFile(path.join(launch.pendingRoot, tsvPath), body)
    return event({
      protocolVersion: 1,
      type: "ocr-result",
      jobID: launch.jobID,
      page,
      pageID: message.command.pageID,
      resultID: `ocr_${randomUUID()}`,
      outputPath: tsvPath,
      outputID: outputID(),
      outputSha256: createHash("sha256").update(body).digest("hex"),
      tsvBytes: body.byteLength,
      temporaryBytes: body.byteLength + 3,
    })
  }
  if (message.command.type !== "release-page" || page === undefined) return fail("protocol-mismatch", "transport")
  if (pagePath && (await exists(path.join(launch.pendingRoot, pagePath)))) return fail("protocol-mismatch", "transport")
  if (tsvPath && (await exists(path.join(launch.pendingRoot, tsvPath)))) return fail("protocol-mismatch", "transport")
  if (page === launch.start.startPage + launch.start.pageCount - 1) return complete()
  return ready(page + 1)
}

async function ready(nextPage) {
  page = nextPage
  const pageID = `page_${randomUUID()}`
  pagePath = `output-${randomUUID()}${mode === "wrong-output-extension" ? ".tsv" : ".png"}`
  const body = Buffer.from("png")
  await writeFile(path.join(launch.pendingRoot, pagePath), body)
  await event({
    protocolVersion: 1,
    type: "page-ready",
    jobID: launch.jobID,
    page,
    pageID,
    outputPath: pagePath,
    outputID: outputID(),
    outputSha256: createHash("sha256").update(body).digest("hex"),
    dimensions: { width: 12, height: 8 },
    pngBytes: 3,
    temporaryBytes: 3,
  })
}

async function complete() {
  await event(completed())
  terminal = true
  await close()
}

function started() {
  return { protocolVersion: 1, type: "started", jobID: launch.jobID, operation: launch.start.type }
}

function completed() {
  return {
    protocolVersion: 1,
    type: "completed",
    jobID: launch.jobID,
    operation: launch.start.type,
    pagesProcessed: launch.start.type === "probe" ? 0 : launch.start.type === "render" ? launch.start.pageCount : 1,
    temporaryBytes:
      launch.start.type === "ocr" && tsvPath
        ? mode === "oversize-output"
          ? 1
          : Buffer.byteLength(`fixture\t${launch.start.page}\n`)
        : 0,
  }
}

function event(value) {
  return send({ protocolVersion: 1, type: "event", jobID: launch.jobID, event: value })
}

async function fail(code, stage) {
  if (terminal) return
  terminal = true
  await send({ protocolVersion: 1, type: "failure", jobID: launch?.jobID ?? null, code, stage, retryable: false })
  await close()
}

async function close() {
  await send({ protocolVersion: 1, type: "closed", jobID: launch?.jobID ?? null })
  await new Promise((resolve) => process.disconnect(resolve))
  await new Promise((resolve) => setTimeout(resolve, 10))
  process.exit(0)
}

function send(value) {
  return new Promise((resolve, reject) => {
    if (!process.send) return reject(new Error("ipc-unavailable"))
    process.send(value, (error) => (error ? reject(error) : resolve()))
  })
}

function outputID() {
  return mode === "duplicate-output-id"
    ? "output_00000000-0000-4000-8000-000000000001"
    : `output_${randomUUID()}`
}

function exists(value) {
  return lstat(value).then(
    () => true,
    () => false,
  )
}
