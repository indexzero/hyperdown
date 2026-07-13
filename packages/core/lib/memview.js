// In-memory view implementing the Hyperbee surface `apply` uses:
// get/put/del + createReadStream({ gt, gte, lt, lte, reverse, limit }).
//
// API shape verified against https://github.com/holepunchto/hyperbee README:
//   await db.put(key, [value]) / const { seq, key, value } = await db.get(key)
//   await db.del(key) / db.createReadStream([range], [options]) with
//   gt/gte/lt/lte range properties and reverse/limit options.
//
// Keys sort in UTF-8 byte order (Hyperbee is byte-ordered over its binary
// key encoding), not UTF-16 code-unit order, so ordering here matches a
// Hyperbee view with utf-8 keys. Values round-trip through JSON, matching
// valueEncoding: 'json'.
import { createHash } from 'node:crypto'

function byteCompare(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

export class MemView {
  constructor() {
    this._map = new Map()
  }

  get size() {
    return this._map.size
  }

  async get(key) {
    if (!this._map.has(key)) return null
    return { seq: 0, key, value: JSON.parse(this._map.get(key)) }
  }

  async put(key, value) {
    this._map.set(key, JSON.stringify(value === undefined ? null : value))
  }

  async del(key) {
    this._map.delete(key)
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
      for (const key of keys) yield { key, value: JSON.parse(map.get(key)) }
    })()
  }

  /** I2/I3 verification: hash of a full range scan (§12 I2). */
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

  /** Plain object dump (test aid). */
  dump(prefix = '') {
    const out = {}
    for (const k of this.sortedKeys()) {
      if (k.startsWith(prefix)) out[k] = JSON.parse(this._map.get(k))
    }
    return out
  }
}
