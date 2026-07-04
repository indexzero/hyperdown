// Writer process (assignment §1: "real processes, not in-process fakes").
// One OS process per writer, its own Corestore directory, driven by the
// controller over the child_process fork IPC channel. Replication never
// touches public DHT infra: every link dials the controller's fault-proxy
// hub over local TCP (see hub.js).
//
// Command surface (assignment §1): append(op) [via `call`/`append`/
// `appendRaw`], pause/resume-replication [via `link`/`unlink` — races are
// stimulated by construction], snapshot-view-hash [`hash`], crash [SIGKILL
// from the controller], restart [controller respawns with `open`].
import net from 'node:net'
import { readdirSync } from 'node:fs'
import { Vault } from '../../packages/store/index.js'
import { materialize, exportTurtle, createIngestWatcher } from '../../packages/faces/index.js'

let vault = null
const links = new Map() // linkId -> { socket, stream }
const errors = [] // forwarded autobee/vault 'error' events (e.g. revocation teardown)

process.on('uncaughtException', (err) => {
  errors.push(`uncaught: ${err.stack || err}`)
  process.stderr.write(`[writer ${process.pid}] uncaught: ${err.stack || err}\n`)
})
process.on('unhandledRejection', (err) => {
  errors.push(`unhandled: ${(err && err.stack) || err}`)
  process.stderr.write(`[writer ${process.pid}] unhandled: ${(err && err.stack) || err}\n`)
})

function hex(buf) {
  return buf ? Buffer.from(buf).toString('hex') : null
}

/** Rehydrate { __hex: '...' } markers into Buffers (op payloads). */
function reviveBuffers(v) {
  if (v === null || typeof v !== 'object') return v
  if (typeof v.__hex === 'string') return Buffer.from(v.__hex, 'hex')
  if (Array.isArray(v)) return v.map(reviveBuffers)
  const out = {}
  for (const [k, val] of Object.entries(v)) out[k] = reviveBuffers(val)
  return out
}

function attach(v) {
  vault = v
  vault.on('error', (err) => {
    errors.push(String((err && err.message) || err))
  })
}

const handlers = {
  async init({ dir, metadata }) {
    attach(await Vault.init(dir, metadata ? { metadata } : {}))
    return info()
  },

  async join({ dir, key }) {
    attach(await Vault.join(dir, key))
    return info()
  },

  async open({ dir }) {
    attach(await Vault.open(dir))
    return info()
  },

  async info() {
    return info()
  },

  /** Generic vault method call: call {method, args}. Buffers as {__hex}. */
  async call({ method, args = [] }) {
    const out = await vault[method](...args.map(reviveBuffers))
    return sanitize(out)
  },

  async append({ type, payload = {}, optimistic = false }) {
    const res = await vault.append(type, reviveBuffers(payload), { optimistic })
    return { seq: res.seq, tag: res.tag ? hex(res.tag) : null }
  },

  /** Poison-op path: append raw bytes, bypassing the op encoder. */
  async appendRaw({ hexBytes, optimistic = false }) {
    await vault.db.append(Buffer.from(hexBytes, 'hex'), { optimistic })
    return true
  },

  /** snapshot-view-hash: full ordered range scan, single hash. */
  async hash() {
    return vault.hash()
  },

  async update() {
    await vault.update()
    return true
  },

  async val({ key }) {
    return sanitize(await vault.val(key))
  },

  async dump({ prefix = '' }) {
    // NOTE: vault.scan('') would use K.range('') = { gte: '', lt: '0' } and
    // miss most of the keyspace; a full dump must be an unbounded scan.
    const out = {}
    const it = prefix === '' ? vault.view.createReadStream({}) : vault.scan(prefix)
    for await (const { key, value } of it) out[key] = value
    return out
  },

  /** Dial the fault-proxy hub and pipe a replication stream through it. */
  async link({ linkId, port, side }) {
    if (links.has(linkId)) throw new Error(`link exists: ${linkId}`)
    const socket = net.connect(port, '127.0.0.1')
    socket.setNoDelay(true)
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })
    socket.write(JSON.stringify({ link: linkId, side }) + '\n')
    const stream = vault.replicate(side === 0)
    stream.on('error', () => {})
    socket.on('error', () => {})
    stream.pipe(socket).pipe(stream)
    const entry = { socket, stream }
    links.set(linkId, entry)
    socket.once('close', () => {
      stream.destroy()
      if (links.get(linkId) === entry) links.delete(linkId)
    })
    return true
  },

  async unlink({ linkId }) {
    const entry = links.get(linkId)
    if (!entry) return false
    entry.socket.destroy()
    entry.stream.destroy()
    links.delete(linkId)
    return true
  },

  async errors() {
    return errors.slice()
  },

  /** S8: project the Markdown face; returns the materialize report. */
  async materialize({ dir }) {
    return sanitize(await materialize(vault, dir))
  },

  /** S8: Turtle export into dir (schema.ttl + data.ttl). */
  async exportTurtle({ dir, opts = {} }) {
    return sanitize(await exportTurtle(vault, dir, opts))
  },

  /**
   * S8: one-shot ingest scan of a face dir; records every op the watcher
   * emits (and forwards it to the vault). Returns the recorded op list.
   */
  async ingest({ dir }) {
    const recorded = []
    const w = await createIngestWatcher(vault, dir, {
      watch: false,
      append: async (type, payload) => {
        recorded.push({ type, payload: sanitize(payload) })
        return vault.append(type, payload)
      }
    })
    try {
      await w.scan()
    } finally {
      await w.close()
    }
    return recorded
  },

  async stats() {
    let fds = -1
    try {
      fds = readdirSync('/dev/fd').length
    } catch {}
    const mem = process.memoryUsage()
    return { rss: mem.rss, heapUsed: mem.heapUsed, external: mem.external, fds }
  },

  async close() {
    for (const { socket, stream } of links.values()) {
      socket.destroy()
      stream.destroy()
    }
    links.clear()
    if (vault) await vault.close()
    vault = null
    return true
  },

  async exit() {
    setImmediate(() => process.exit(0))
    return true
  }
}

function info() {
  return {
    keyHex: vault.keyHex,
    localKey: hex(vault.localKey),
    writable: vault.writable,
    isIndexer: vault.isIndexer,
    pid: process.pid
  }
}

/** JSON-safe: Buffers -> { __hex } so values survive the IPC channel. */
function sanitize(v) {
  if (v === undefined) return null
  if (v === null || typeof v !== 'object') return v
  if (Buffer.isBuffer(v)) return { __hex: v.toString('hex') }
  if (Array.isArray(v)) return v.map(sanitize)
  const out = {}
  for (const [k, val] of Object.entries(v)) out[k] = sanitize(val)
  return out
}

process.on('message', async ({ id, cmd, args }) => {
  const handler = handlers[cmd]
  try {
    if (!handler) throw new Error(`unknown command: ${cmd}`)
    const value = await handler(args || {})
    process.send({ id, ok: true, value })
  } catch (err) {
    process.send({ id, ok: false, error: String((err && err.stack) || err) })
  }
})

process.send({ ready: true, pid: process.pid })
