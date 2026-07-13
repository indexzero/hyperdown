// View adapter (SPEC-FINAL §13 store wiring): presents the classic
// get/put/del/createReadStream surface @hyperwiki/core's apply expects
// (documented in packages/core/README.md, "View-interface contract") over
// the hyperbee2-flavored view autobee hands apply.
//
// hyperbee2 surface, verified against the installed source
// (node_modules/hyperbee2/index.js, hyperbee2@^2.10.3, the version autobee
// 1.0.10 depends on; upstream https://github.com/holepunchto/hyperbee2):
// - `await bee.get(key)` — key is a Buffer (compared with b4a.compare);
//   resolves to `{ core, offset, seq, key, value }` or null, value a Buffer.
// - `bee.write()` — returns a WriteBatch (lib/write.js) with
//   `tryPut(key, value)` / `tryDelete(key)` / `await flush()`.
// - `bee.createReadStream(options)` — a RangeStream (lib/ranges.js) that
//   DOES support range iteration: `{ gt, gte, lt, lte, reverse, limit }`,
//   keys in byte order (b4a.compare), limit -1 = unlimited. This matches
//   core's contract exactly, so no consumption change in core is needed.
//
// Determinism: keys are UTF-8 encoded strings; values round-trip through
// JSON.stringify/JSON.parse, matching core's MemView (`valueEncoding:
// 'json'` semantics). JSON.stringify over objects apply constructs is
// deterministic for a given linearized prefix (same code path on every
// peer), so converged peers hold byte-identical view cores (I2).
import b4a from 'b4a'

function toBuf(key) {
  return b4a.from(String(key))
}

function encodeValue(value) {
  return b4a.from(JSON.stringify(value === undefined ? null : value))
}

function decodeValue(buf) {
  return JSON.parse(b4a.toString(buf))
}

export class ViewAdapter {
  constructor(bee) {
    this.bee = bee
  }

  /** True when the underlying bee accepts writes (apply's working view). */
  get writable() {
    return this.bee.writable === true
  }

  async get(key) {
    const node = await this.bee.get(toBuf(key))
    if (!node) return null
    return { seq: node.seq, key: String(key), value: decodeValue(node.value) }
  }

  async put(key, value) {
    const w = this.bee.write()
    w.tryPut(toBuf(key), encodeValue(value))
    await w.flush()
  }

  async del(key) {
    const w = this.bee.write()
    w.tryDelete(toBuf(key))
    await w.flush()
  }

  /**
   * Async iterable of `{ key: string, value: json }`, keys in UTF-8 byte
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
        yield { key: b4a.toString(node.key), value: decodeValue(node.value) }
      }
    })()
  }

  /** Plain object dump of a prefix (test/debug aid, mirrors MemView.dump). */
  async dump(prefix = '') {
    const out = {}
    const range = prefix ? { gte: prefix, lt: prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1) } : {}
    for await (const { key, value } of this.createReadStream(range)) {
      if (key.startsWith(prefix)) out[key] = value
    }
    return out
  }
}
