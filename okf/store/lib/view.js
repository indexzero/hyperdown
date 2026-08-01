// View adapter (okf SPEC §13 store wiring): presents the hyperbee2-flavored
// surface @auto-okf/core's apply consumes (get / write() batches with
// tryPut+tryDelete+flush / createReadStream — the surface MemView documents
// and the unit suite runs against) over the real hyperbee2 view autobee
// hands apply, converting string keys/values to buffers at the boundary.
//
// hyperbee2 surface, verified against the installed source
// (node_modules/hyperbee2@2.10.3, the version autobee 1.0.10 depends on;
// upstream https://github.com/holepunchto/hyperbee2):
// - `await bee.get(key)` — key MUST be a Buffer (index.js get() binary-
//   searches with b4a.compare); resolves to a finalized key pointer
//   `{ seq, key, value, ... }` or null, value a Buffer.
// - `bee.write()` — returns a WriteBatch (lib/write.js) with
//   `tryPut(key, value)` / `tryDelete(key)` / `await flush()`; keys and
//   values are buffers.
// - `bee.createReadStream(options)` — a RangeStream (lib/ranges.js) that
//   DOES support range iteration: `{ gt, gte, lt, lte, reverse, limit }`,
//   keys in byte order (b4a.compare), limit -1 = unlimited. This matches
//   core's MemView contract exactly (classic hyperbee's richer
//   createReadStream signature is NOT assumed anywhere).
//
// Determinism (I1/I2): keys are UTF-8 encoded strings; values pass through
// VERBATIM as UTF-8 — core's apply writes stableStringify JSON strings, so
// the bytes a converged peer holds are exactly the bytes MemView holds for
// the same linearized prefix, and viewHash (hash.js) equals MemView.hash().
import b4a from 'b4a'

function toBuf(x) {
  return b4a.isBuffer(x) ? x : b4a.from(String(x))
}

function toStr(x) {
  return typeof x === 'string' ? x : b4a.toString(x)
}

class WriteBatchAdapter {
  constructor(batch) {
    this.batch = batch
  }

  tryPut(key, value) {
    this.batch.tryPut(toBuf(key), toBuf(value))
  }

  tryDelete(key) {
    this.batch.tryDelete(toBuf(key))
  }

  flush() {
    return this.batch.flush()
  }
}

export class ViewAdapter {
  constructor(bee) {
    this.bee = bee
  }

  /**
   * `{ seq, key: string, value: string } | null` — value is the raw stored
   * JSON string (core's Tx.val JSON-parses it; Bundle.val does too).
   */
  async get(key) {
    const node = await this.bee.get(toBuf(key))
    if (!node) return null
    return { seq: node.seq, key: toStr(key), value: toStr(node.value) }
  }

  write() {
    return new WriteBatchAdapter(this.bee.write())
  }

  /**
   * Async iterable of `{ key: string, value: string }`, keys in UTF-8 byte
   * order. Accepts the same (rangeOpts, opts) split MemView does — core
   * always calls it with a single `{ gte, lt }` object (K.range(prefix)).
   */
  createReadStream(rangeOpts = {}, opts = {}) {
    const o = { ...rangeOpts, ...opts }
    const range = {}
    for (const bound of ['gt', 'gte', 'lt', 'lte']) {
      if (o[bound] !== undefined) range[bound] = toBuf(o[bound])
    }
    if (o.reverse) range.reverse = true
    if (o.limit !== undefined && o.limit >= 0) range.limit = o.limit
    const stream = this.bee.createReadStream(range)
    return (async function* () {
      for await (const node of stream) {
        yield { key: toStr(node.key), value: toStr(node.value) }
      }
    })()
  }

  /** Plain object dump of a prefix, values JSON-decoded (mirrors MemView.dump). */
  async dump(prefix = '') {
    const out = {}
    const range = prefix
      ? {
          gte: prefix,
          lt: prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)
        }
      : {}
    for await (const { key, value } of this.createReadStream(range)) {
      if (!key.startsWith(prefix)) continue
      try {
        out[key] = JSON.parse(value)
      } catch {
        out[key] = value
      }
    }
    return out
  }
}
