const { randomUUID } = require("node:crypto")
const { mkdir, rm, writeFile } = require("node:fs/promises")
const path = require("node:path")

const commands = []
let waiter

process.on("message", (message) => {
  if (waiter) {
    const resolve = waiter
    waiter = undefined
    resolve(message)
    return
  }
  commands.push(message)
})

function next() {
  const command = commands.shift()
  if (command) return Promise.resolve(command)
  return new Promise((resolve) => (waiter = resolve))
}

function send(event) {
  return new Promise((resolve) => process.send(event, resolve))
}

async function main() {
  const request = await next()
  if (
    process.env.AWS_SECRET_ACCESS_KEY ||
    process.env.ELECTRON_RUN_AS_NODE !== "1" ||
    process.env.DISABLE_SYSTEM_FONTS_LOAD !== "1"
  ) {
    process.send({
      protocolVersion: 1,
      type: "failure",
      jobID: request.jobID,
      code: process.env.AWS_SECRET_ACCESS_KEY
        ? "invalid-request"
        : process.env.PATH
          ? "protocol-mismatch"
          : "runtime-unavailable",
      stage: "worker",
      retryable: false,
    })
    return process.disconnect()
  }
  await send({ protocolVersion: 1, type: "started", jobID: request.jobID, operation: request.type })
  if (request.type === "probe") {
    await send({
      protocolVersion: 1,
      type: "completed",
      jobID: request.jobID,
      operation: "probe",
      pagesProcessed: 0,
      temporaryBytes: 0,
    })
    return process.disconnect()
  }
  if (request.type === "ocr") {
    await mkdir(path.join(process.env.DOCUMENT_JOB_ROOT, "ocr"), { recursive: true })
    const outputPath = `ocr/page-${request.page}-ocr_${randomUUID()}.tsv`
    const body = Buffer.from("level\tpage_num\ttext\n1\t1\tfixture\n")
    await writeFile(path.join(process.env.DOCUMENT_JOB_ROOT, ...outputPath.split("/")), body)
    await send({
      protocolVersion: 1,
      type: "ocr-result",
      jobID: request.jobID,
      page: request.page,
      pageID: request.pageID,
      resultID: `ocr_${randomUUID()}`,
      outputPath,
      tsvBytes: body.byteLength,
      temporaryBytes: body.byteLength,
    })
    await send({
      protocolVersion: 1,
      type: "completed",
      jobID: request.jobID,
      operation: "ocr",
      pagesProcessed: 1,
      temporaryBytes: body.byteLength,
    })
    return process.disconnect()
  }

  await mkdir(path.join(process.env.DOCUMENT_JOB_ROOT, "pages"), { recursive: true })
  await mkdir(path.join(process.env.DOCUMENT_JOB_ROOT, "ocr"), { recursive: true })
  for (let page = request.startPage; page < request.startPage + request.pageCount; page++) {
    const pageID = `page_${randomUUID()}`
    const pageOutput = `pages/page-${page}-${pageID}.png`
    const png = Buffer.from("fixture-png")
    await writeFile(path.join(process.env.DOCUMENT_JOB_ROOT, ...pageOutput.split("/")), png)
    await send({
      protocolVersion: 1,
      type: "page-ready",
      jobID: request.jobID,
      page,
      pageID,
      outputPath: pageOutput,
      dimensions: { width: 10, height: 10 },
      pngBytes: png.byteLength,
      temporaryBytes: png.byteLength,
    })
    const ocr = await next()
    if (ocr.type === "cancel") return process.disconnect()
    const ocrOutput = `ocr/page-${page}-ocr_${randomUUID()}.tsv`
    const tsv = Buffer.from(`level\tpage_num\ttext\n1\t${page}\tfixture\n`)
    await writeFile(path.join(process.env.DOCUMENT_JOB_ROOT, ...ocrOutput.split("/")), tsv)
    await send({
      protocolVersion: 1,
      type: "ocr-result",
      jobID: request.jobID,
      page,
      pageID,
      resultID: `ocr_${randomUUID()}`,
      outputPath: ocrOutput,
      tsvBytes: tsv.byteLength,
      temporaryBytes: png.byteLength + tsv.byteLength,
    })
    const release = await next()
    if (release.type === "cancel") return process.disconnect()
    await Promise.all([
      rm(path.join(process.env.DOCUMENT_JOB_ROOT, ...pageOutput.split("/")), { force: true }),
      rm(path.join(process.env.DOCUMENT_JOB_ROOT, ...ocrOutput.split("/")), { force: true }),
    ])
  }
  await send({
    protocolVersion: 1,
    type: "completed",
    jobID: request.jobID,
    operation: "render",
    pagesProcessed: request.pageCount,
    temporaryBytes: 0,
  })
  process.disconnect()
}

main().catch(() => process.exit(1))
