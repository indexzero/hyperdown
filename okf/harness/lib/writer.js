// The writer process: one OS process per writer, with its own corestore
// directory. The controller drives it over the child_process fork IPC
// channel. Every replication link dials the controller's fault proxy over
// local TCP (hub.js), never the DHT.
import net from 'node:net'
import { Bundle } from '../../store/index.js'
import { materialize, createIngestWatcher, wanted, importFace } from '../../faces/index.js'

let vault = null
const links = new Map() // linkId -> { socket, stream }
const errors = [] // the 'error' events that the vault emitted

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

/** Turn { __hex } markers back into Buffers. The inverse of sanitize. */
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

  /** Call any vault method. Buffers travel as { __hex } in both directions. */
  async call({ method, args = [] }) {
    const out = await vault[method](...args.map(reviveBuffers))
    return sanitize(out)
  },

  /**
   * The tag is a hex string, not a Buffer, so it passes as is. For a
   * minting create-concept the tag is the `_id` of the concept.
   */
  async append({ type, payload = {} }) {
    const res = await vault.append(type, reviveBuffers(payload))
    return { seq: res.seq, tag: res.tag ?? null }
  },

  /**
   * Append raw bytes without the op encoder. Like Bundle.append, it refuses
   * a writer that autobee has not added. A plain append from such a writer
   * closes autobee.
   */
  async appendRaw({ hexBytes }) {
    if (!vault.writable) throw new Error('VAULT_NOT_WRITABLE: appendRaw before admission')
    await vault.db.append(Buffer.from(hexBytes, 'hex'))
    return true
  },

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
    // An empty prefix must scan the whole view. vault.scan('') uses
    // K.range(''), which misses most of the keyspace.
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

  /** Dial the fault proxy and pipe a replication stream through it. */
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

  async materialize({ dir, opts = {} }) {
    return sanitize(await materialize(vault, dir, opts))
  },

  async wanted() {
    return sanitize(await wanted(vault))
  },

  /** One ingest scan of a bundle directory. Returns the ops that the watcher appended. */
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
   * Materialize into `faceDir`, then import that bundle into a fresh vault
   * at `vaultDir` with `_id` adoption. The new vault becomes this writer's
   * vault. Returns its key so that a second peer can join it. The
   * controller must tear down the replication links first. See SPEC §10.
   */
  async generation({ faceDir, vaultDir }) {
    for (const { socket, stream } of links.values()) {
      socket.destroy()
      stream.destroy()
    }
    links.clear()
    await materialize(vault, faceDir)
    const res = await importFace(Bundle.init, faceDir, vaultDir, { metadata: vault.metadata, predecessorKey: vault.keyHex })
    const old = vault
    attach(res.vault)
    await old.close()
    // A joiner must put predecessorKey in its invite metadata. Otherwise
    // its writer cores derive under 'root', not under the generation
    // namespace, and it cannot converge.
    return {
      key: vault.keyHex,
      localKey: hex(vault.localKey),
      generation: res.generation,
      predecessorKey: vault.metadata.predecessorKey
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
