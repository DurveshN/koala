import { spawn } from "node:child_process"
import dns from "node:dns/promises"
import { open, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises"
import net from "node:net"
import dgram from "node:dgram"
import path from "node:path"

const mode = process.argv[2]
const jobRoot = process.env.DOCUMENT_JOB_ROOT
if (!jobRoot) process.exit(91)

if (mode === "descendant") {
  process.on("SIGTERM", () => undefined)
  process.on("SIGINT", () => undefined)
  setInterval(() => undefined, 1_000)
} else if (mode === "child") {
  process.on("SIGTERM", () => undefined)
  process.on("SIGINT", () => undefined)
  const grandchild = spawn(process.execPath, [import.meta.filename, "descendant"], {
    env: process.env,
    stdio: "ignore",
    windowsHide: true,
  })
  await writeFile(path.join(jobRoot, "descendants.json"), `${JSON.stringify({ child: process.pid, grandchild: grandchild.pid })}\n`)
  setInterval(() => undefined, 1_000)
} else {
  const config = JSON.parse(await readFile(path.join(jobRoot, "native-probes.json"), "utf8"))
  await writeFile(path.join(jobRoot, "worker-pid.json"), `${JSON.stringify({ worker: process.pid })}\n`, { flag: "wx" })
  const operation = config.mode === "output-substitution" ? "render" : "probe"
  send({ protocolVersion: 1, type: "started", jobID: config.jobID, operation })
  if (config.mode === "crash") process.exit(92)
  if (config.mode === "disconnect") {
    process.stdout.end()
    process.stdin.resume()
  } else if (config.mode === "output-substitution") {
    send({
      protocolVersion: 1,
      type: "output-start",
      jobID: config.jobID,
      outputID: "output_00000000-0000-4000-8000-000000000001",
      kind: "page-png",
      page: 1,
      pageID: "page_00000000-0000-4000-8000-000000000001",
      sourcePath: "../substitution.png",
      declaredBytes: 1,
    })
    process.stdin.resume()
  } else if (config.mode === "tree" || config.mode === "held-open" || config.mode === "interruption") {
    if (config.mode === "held-open") {
      const handle = await open(path.join(jobRoot, "held-open"), "w")
      await handle.write("held")
    }
    if (config.mode !== "interruption") {
      spawn(process.execPath, [import.meta.filename, "child"], {
        env: process.env,
        stdio: "ignore",
        windowsHide: true,
      })
    }
    process.on("SIGTERM", () => undefined)
    process.on("SIGINT", () => undefined)
    process.stdin.resume()
  } else {
    const checks = {
      jobRead: await canRead(path.join(jobRoot, "native-probes.json")),
      jobWrite: await canWriteAndRemove(path.join(jobRoot, "allowed-write")),
      runtimeRead: await canRead(path.join(process.env.DOCUMENT_RUNTIME_ROOT, "manifest.json")),
      projectReadDenied: !(await canRead(config.projectRead)),
      projectWriteDenied: !(await canWrite(config.projectWrite)),
      homeReadDenied: !(await canRead(config.homeRead)),
      homeWriteDenied: !(await canWrite(config.homeWrite)),
      credentialReadDenied: !(await canRead(config.credentialRead)),
      credentialWriteDenied: !(await canWrite(config.credentialWrite)),
      siblingReadDenied: !(await canRead(config.siblingRead)),
      siblingWriteDenied: !(await canWrite(config.siblingWrite)),
      pendingReadDenied: !(await canRead(config.pendingRead)),
      pendingWriteDenied: !(await canWrite(config.pendingWrite)),
      runtimeWriteDenied: !(await canWrite(config.runtimeWrite)),
      resourcesReadDenied: !(await canRead(config.resourcesRead)),
      resourcesWriteDenied: !(await canWrite(config.resourcesWrite)),
      systemTempReadDenied: !(await canRead(config.systemTempRead)),
      systemTempWriteDenied: !(await canWrite(config.systemTempWrite)),
      runtimeReplacementDenied: !(await canRename(config.runtimeRead, config.runtimeReplacement)),
      externalLinkReadDenied: await linkReadDenied(path.join(jobRoot, "external-link"), config.projectRead),
      dnsDenied: !(await canResolve()),
      publicTcpDenied: !(await canConnect("1.1.1.1", 53)),
      privateTcpDenied: !(await canConnect("10.255.255.1", 9)),
      loopbackTcpDenied: !(await canConnect("127.0.0.1", config.tcpPort)),
      publicUdpDenied: !(await canSendUdp("1.1.1.1", 53)),
      loopbackUdpDenied: !(await canSendUdp("127.0.0.1", config.udpPort)),
      tcpBindDenied: !(await canBindTcp()),
      udpBindDenied: !(await canBindUdp()),
      unixConnectDenied: process.platform === "win32" || !(await canConnectUnix(config.unixSocket)),
      unixBindDenied: process.platform === "win32" || !(await canBindUnix(path.join(jobRoot, "forbidden.sock"))),
      proxyEnvironmentAbsent: !Object.keys(process.env).some((key) => /^(?:http|https|all|no)_proxy$/i.test(key)),
      pendingEnvironmentAbsent: !Object.values(process.env).some((value) => value?.includes(config.pendingRoot)),
    }
    await writeFile(path.join(jobRoot, "native-results.json"), `${JSON.stringify(checks)}\n`, { flag: "wx" })
    if (Object.values(checks).some((value) => value !== true)) {
      send({
        protocolVersion: 1,
        type: "failure",
        jobID: config.jobID,
        code: "render-failed",
        stage: "render",
        retryable: false,
      })
    } else {
      send({
        protocolVersion: 1,
        type: "completed",
        jobID: config.jobID,
        operation: "probe",
        pagesProcessed: 0,
        temporaryBytes: 0,
      })
    }
    process.stdout.end()
  }
}

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

async function canRead(file) {
  return readFile(file).then(
    () => true,
    () => false,
  )
}

async function canWrite(file) {
  return writeFile(file, "denial-probe", { flag: "wx" }).then(
    () => true,
    () => false,
  )
}

async function canWriteAndRemove(file) {
  if (!(await canWrite(file))) return false
  return unlink(file).then(
    () => true,
    () => false,
  )
}

async function canRename(source, destination) {
  return rename(source, destination).then(
    () => true,
    () => false,
  )
}

async function linkReadDenied(link, target) {
  const created = await symlink(target, link, "file").then(
    () => true,
    () => false,
  )
  if (!created) return true
  const denied = !(await canRead(link))
  await unlink(link).catch(() => undefined)
  return denied
}

async function canResolve() {
  const resolver = new dns.Resolver()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolver.cancel()
      resolve(false)
    }, 750)
    resolver.resolve4("example.com").then(
      () => {
        clearTimeout(timer)
        resolve(true)
      },
      () => {
        clearTimeout(timer)
        resolve(false)
      },
    )
  })
}

async function canConnect(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port })
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(value)
    }
    const timer = setTimeout(() => finish(false), 750)
    socket.once("connect", () => finish(true))
    socket.once("error", () => finish(false))
  })
}

async function canConnectUnix(socketPath) {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath)
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(value)
    }
    const timer = setTimeout(() => finish(false), 750)
    socket.once("connect", () => finish(true))
    socket.once("error", () => finish(false))
  })
}

async function canSendUdp(host, port) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4")
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket.close()
      } catch {}
      resolve(value)
    }
    const timer = setTimeout(() => finish(false), 750)
    socket.once("error", () => finish(false))
    socket.send(Buffer.from("koala"), port, host, (error) => finish(!error))
  })
}

async function canBindTcp() {
  return new Promise((resolve) => {
    const server = net.createServer()
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (server.listening) server.close(() => resolve(value))
      else resolve(value)
    }
    const timer = setTimeout(() => finish(false), 750)
    server.once("error", () => finish(false))
    server.listen(0, "127.0.0.1", () => finish(true))
  })
}

async function canBindUdp() {
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4")
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket.close()
      } catch {}
      resolve(value)
    }
    const timer = setTimeout(() => finish(false), 750)
    socket.once("error", () => finish(false))
    socket.bind(0, "127.0.0.1", () => finish(true))
  })
}

async function canBindUnix(socketPath) {
  await rm(socketPath, { force: true })
  return new Promise((resolve) => {
    const server = net.createServer()
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (server.listening) server.close(() => resolve(value))
      else resolve(value)
    }
    const timer = setTimeout(() => finish(false), 750)
    server.once("error", () => finish(false))
    server.listen(socketPath, () => finish(true))
  })
}
