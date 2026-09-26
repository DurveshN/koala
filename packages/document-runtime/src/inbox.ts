import { watch, type FSWatcher } from "node:fs"
import { readFile, rename, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { Readable, Writable } from "node:stream"

// srt-win consumes the sandboxed child's stdin for its own launch handshake and never forwards the
// broker's stdin, so on Windows the proxy hands NDJSON frames to the worker through files inside
// the job root instead. Frames are written whole (temporary file plus rename) and read in sequence.
export const InboxDirectoryName = "inbox"
const CloseSentinel = "close"
const PollIntervalMs = 100

export function inboxFileName(sequence: number) {
  return `${String(sequence).padStart(8, "0")}.ndjson`
}

/** Worker side: a byte stream of the frames the parent drops into the inbox, ending at the close sentinel. */
export function createInboxReadable(directory: string): Readable {
  let next = 1
  let scanning = false
  let finished = false
  let watcher: FSWatcher | undefined
  const readable = new Readable({
    read() {
      void scan()
    },
    // transport.close() destroys the input; the timer and watcher must go with it or the worker
    // process never exits and the proxy waits for a child close that never comes.
    destroy(error, callback) {
      release()
      callback(error)
    },
  })
  const release = () => {
    if (finished) return
    finished = true
    clearInterval(timer)
    watcher?.close()
  }
  const finish = (error?: Error) => {
    if (finished) return
    release()
    if (error) readable.destroy(error)
    else readable.push(null)
  }
  const scan = async () => {
    if (scanning || finished) return
    scanning = true
    try {
      while (!finished) {
        const frame = await readFile(path.join(directory, inboxFileName(next))).catch(() => undefined)
        if (frame) {
          if (next === 1) process.stderr.write("document worker: first inbox frame received\n")
          next++
          readable.push(frame)
          continue
        }
        const closed = await stat(path.join(directory, CloseSentinel)).then(
          () => true,
          () => false,
        )
        if (closed) finish()
        break
      }
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)))
    } finally {
      scanning = false
    }
  }
  try {
    watcher = watch(directory, () => void scan())
    watcher.on("error", () => undefined)
  } catch {
    // Polling below still delivers frames when the directory cannot be watched.
  }
  const timer = setInterval(() => void scan(), PollIntervalMs)
  return readable
}

/** Parent side: each NDJSON frame becomes one sequence-numbered file; `end()` writes the close sentinel. */
export function createInboxWritable(directory: string): Writable {
  let sequence = 0
  let pending = Buffer.alloc(0)
  const store = async (frame: Buffer) => {
    sequence++
    const final = path.join(directory, inboxFileName(sequence))
    const temporary = `${final}.tmp`
    await writeFile(temporary, frame, { flag: "wx", mode: 0o600 })
    await rename(temporary, final)
  }
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      pending = Buffer.concat([pending, chunk])
      const frames: Buffer[] = []
      for (let index = pending.indexOf(0x0a); index >= 0; index = pending.indexOf(0x0a)) {
        frames.push(pending.subarray(0, index + 1))
        pending = pending.subarray(index + 1)
      }
      frames
        .reduce((chain, frame) => chain.then(() => store(frame)), Promise.resolve())
        .then(() => callback(), callback)
    },
    final(callback) {
      const rest = pending.byteLength > 0 ? store(Buffer.concat([pending, Buffer.from("\n")])) : Promise.resolve()
      rest
        .then(() => writeFile(path.join(directory, CloseSentinel), "", { flag: "wx", mode: 0o600 }))
        .then(() => callback(), callback)
    },
  })
}
