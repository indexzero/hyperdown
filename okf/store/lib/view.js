// The view that core's apply folds over, with the surface that MemView
// documents: get, write() with tryPut, tryDelete and flush, and
// createReadStream. autobee hands apply its hyperbee2 view (2.20.1 under
// autobee@2.12.1) through the `open` handler (autobee lib/apply-view.js,
// ApplyView.open). Values pass through as UTF-8 with no change, so
// viewHash equals MemView.hash() (I1, I2).
import b4a from 'b4a'

function toBuf(x) {
  return b4a.isBuffer(x) ? x : b4a.from(String(x))
}

function toStr(x) {
  return typeof x === 'string' ? x : b4a.toString(x)
}

// hyperbee2 write() returns a WriteBatch (lib/write.js): buffer keys and values.
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
   * `{ seq, key: string, value: string } | null`. value is the raw stored
   * JSON string. The caller parses it (core's Tx.val, Bundle.val). hyperbee2
   * get(key) needs a Buffer key, because it compares with b4a.compare.
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
   * An async iterable of `{ key: string, value: string }`, keys in UTF-8
   * byte order. It takes the (rangeOpts, opts) split of MemView. core calls
   * it with one `{ gte, lt }` object (K.range(prefix)). hyperbee2's
   * RangeStream (lib/ranges.js) takes `{ gt, gte, lt, lte, reverse, limit }`
   * in byte order, limit -1 for no limit. Do not assume the richer
   * createReadStream of classic hyperbee.
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

  /** A plain object of one prefix, values JSON-decoded, like MemView.dump. */
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
