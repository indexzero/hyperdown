// In-memory view with the hyperbee2 surface that apply uses (SPEC §1):
// `get(key)` returns { key, value } or null, `write()` returns a batch
// with `tryPut`, `tryDelete` and `flush`, and `createReadStream` takes
// { gt, gte, lt, lte, reverse, limit }. Keys sort in UTF-8 byte order, as
// in hyperbee2, not in UTF-16 code unit order. Values are strings.
import { createHash } from 'node:crypto'

function byteCompare(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

function toStr(v) {
  return Buffer.isBuffer(v) ? v.toString('utf8') : String(v)
}

class MemWriteBatch {
  constructor(view) {
    this._view = view
    this._ops = []
    this._closed = false
  }

  tryPut(key, value) {
    if (this._closed) throw new Error('Batch closed')
    this._ops.push({ put: true, key: toStr(key), value: toStr(value) })
  }

  tryDelete(key) {
    if (this._closed) throw new Error('Batch closed')
    this._ops.push({ put: false, key: toStr(key) })
  }

  async flush() {
    if (this._closed) throw new Error('Batch closed')
    this._closed = true
    for (const op of this._ops) {
      if (op.put) this._view._map.set(op.key, op.value)
      else this._view._map.delete(op.key)
    }
    this._ops = []
  }
}

export class MemView {
  constructor() {
    this._map = new Map()
  }

  get size() {
    return this._map.size
  }

  async get(key) {
    const k = toStr(key)
    if (!this._map.has(k)) return null
    return { seq: 0, key: k, value: this._map.get(k) }
  }

  write() {
    return new MemWriteBatch(this)
  }

  sortedKeys() {
    return [...this._map.keys()].sort(byteCompare)
  }

  createReadStream(rangeOpts = {}, opts = {}) {
    const { gt, gte, lt, lte, reverse = false, limit = -1 } = { ...rangeOpts, ...opts }
    let keys = this.sortedKeys().filter((k) => {
      if (gt !== undefined && byteCompare(k, gt) <= 0) return false
      if (gte !== undefined && byteCompare(k, gte) < 0) return false
      if (lt !== undefined && byteCompare(k, lt) >= 0) return false
      if (lte !== undefined && byteCompare(k, lte) > 0) return false
      return true
    })
    if (reverse) keys.reverse()
    if (limit >= 0) keys = keys.slice(0, limit)
    const map = this._map
    return (async function* () {
      for (const key of keys) yield { key, value: map.get(key) }
    })()
  }

  /** Hash of a full range scan, for the I2 and I3 checks. */
  hash() {
    const h = createHash('sha256')
    for (const k of this.sortedKeys()) {
      h.update(k)
      h.update('\x00')
      h.update(this._map.get(k))
      h.update('\n')
    }
    return h.digest('hex')
  }

  /** Plain object dump with JSON-decoded values, a test aid. */
  dump(prefix = '') {
    const out = {}
    for (const k of this.sortedKeys()) {
      if (k.startsWith(prefix)) {
        const raw = this._map.get(k)
        try {
          out[k] = JSON.parse(raw)
        } catch {
          out[k] = raw
        }
      }
    }
    return out
  }
}
