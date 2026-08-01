// Writer process (okf harness §1: "real processes, not in-process fakes").
// One OS process per writer, its own Corestore directory, driven by the
// controller over the child_process fork IPC channel. Replication never
// touches public DHT infra: every link dials the controller's fault-proxy
// hub over local TCP (see hub.js).
//
// This is the vault-ld harness writer retargeted to speak the auto-okf op
// vocabulary over a REAL @auto-okf/store Bundle (autobee + corestore on
// disk). The command surface is unchanged (init/join/open, call/append/
// appendRaw, hash, dump, link/unlink for pause/resume replication, crash =
// SIGKILL, restart = respawn) — only the imported store/faces and the op
// helpers differ.
import net from 'node:net'
import { Bundle } from '../../store/index.js'
import { materialize, createIngestWatcher, wanted, compact } from '../../faces/index.js'

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
    attach(await Bundle.init(dir, metadata ? { metadata } : {}))
    return info()
  },

  async join({ dir, key, metadata }) {
    attach(await Bundle.join(dir, key, metadata ? { metadata } : {}))
    return info()
  },

  async open({ dir }) {
    attach(await Bundle.open(dir))
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

  /**
   * §3 op append. The auto-okf tag/opId is a HEX STRING (writerKeyHex ‖
   * seqHex), not a Buffer — pass it through verbatim (the minting
   * create-concept's tag is the concept _id the scenarios track).
   */
  async append({ type, payload = {}, optimistic = false }) {
    const res = await vault.append(type, reviveBuffers(payload), { optimistic })
    return { seq: res.seq, tag: res.tag ?? null }
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
    // A full dump must be an UNBOUNDED scan: K.range('') would miss most of
    // the keyspace, so scan the whole view when prefix is empty.
    const out = {}
    if (prefix === '') {
      for await (const { key, value } of vault.view.createReadStream({})) {
        out[key] = JSON.parse(value)
      }
    } else {
      for await (const { key, value } of vault.scan(prefix)) out[key] = value
    }
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

  /** S9: project the OKF face; returns the materialize report. */
  async materialize({ dir, opts = {} }) {
    return sanitize(await materialize(vault, dir, opts))
  },

  /** wanted/ ranked demand index. */
  async wanted() {
    return sanitize(await wanted(vault))
  },

  /**
   * One-shot ingest scan of a face dir; records every op the watcher emits
   * (and forwards it to the vault). Returns the recorded op list.
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

  /**
   * S9 generation cycle: materialize the live bundle, spin up a FRESH vault at
   * `vaultDir`, ingest the bundle back with _id adoption, then adopt the new
   * (open) vault as this writer's vault. Returns the new vault's key so a
   * second peer can join it. Any live replication links must be torn down by
   * the controller before this is called.
   */
  async compact({ toDir, vaultDir, force = false }) {
    for (const { socket, stream } of links.values()) {
      socket.destroy()
      stream.destroy()
    }
    links.clear()
    const res = await compact(vault, { toDir, vaultDir, initBundle: Bundle.init, force })
    const old = vault
    attach(res.vault)
    await old.close()
    // The new vault's generation chain: a fresh peer MUST join with these
    // overrides so it derives the SAME §10 per-generation namespace (else its
    // writer cores derive under 'root' and it cannot converge).
    return {
      key: vault.keyHex,
      localKey: hex(vault.localKey),
      generation: res.generation,
      predecessorKey: res.predecessorKey ?? null,
      predecessorCheckpoint: sanitize(res.predecessorCheckpoint ?? null)
    }
  },

  async stats() {
    const mem = process.memoryUsage()
    return { rss: mem.rss, heapUsed: mem.heapUsed, external: mem.external }
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
