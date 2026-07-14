// Read the auto-okf view (okf SPEC §4 keyspace) into a structured model the
// faces project onto disk. Pure projection of a converged view: the same
// view yields the same model on every peer (I8/I9). Reads go through the
// store Vault surface (`val(key)`, `scan(prefix)` — @auto-okf/store), which
// JSON-decodes values; a MemView is adapted by memViewReader() below for
// off-substrate tests.
import { keyspace as K } from '@auto-okf/core'

/** Fresh per-concept accumulator. */
function newConcept(id) {
  return {
    id,
    type: undefined, // resolved emit type (§5: first element of the register)
    created: undefined,
    deleted: false,
    path: undefined,
    ord: undefined,
    headHash: undefined,
    headText: '',
    fields: new Map() // key -> raw view record ({ values, tag, writer } | { els, removed })
  }
}

/** Stable Set membership key for a (path, id) pathcollision entry (§7). */
export function collisionKey(path, id) {
  return `${path}\u0000${id}`
}

/**
 * Build the concept model + path-collision index from a view. Returns:
 *   {
 *     concepts: Map<id, concept>,   // ALL concepts incl. tombstoned
 *     collisions: Set<"path id">  // §7 pathcollision losers
 *   }
 * A concept: { id, type, created, deleted, path, ord, headHash, headText,
 *              fields }.
 */
export async function readView(reader) {
  const concepts = new Map()
  const revText = new Map() // id -> Map<revHash, text>

  for await (const { key, value } of reader.scan(K.cRoot())) {
    const segs = K.parseKey(key) // ['c', id, kind, ...]
    if (segs[0] !== 'c' || segs.length < 3) continue
    const id = segs[1]
    let c = concepts.get(id)
    if (!c) {
      c = newConcept(id)
      concepts.set(id, c)
    }
    switch (segs[2]) {
      case 'meta':
        c.created = value.created
        c.deleted = value.deleted != null
        // meta.type is a bookkeeping copy (§5); the register is authoritative,
        // but seed from meta so a corrupt/missing register still has a value.
        if (c.type === undefined) c.type = value.type
        break
      case 'path':
        c.path = value.path
        c.ord = value.ord
        break
      case 'body':
        c.headHash = value // stored as the revHash string
        break
      case 'f':
        c.fields.set(segs[3], value)
        break
      case 'rev': {
        let m = revText.get(id)
        if (!m) {
          m = new Map()
          revText.set(id, m)
        }
        m.set(segs[3], value && typeof value.text === 'string' ? value.text : '')
        break
      }
      default:
        break
    }
  }

  // §5: `type` materializes as the first element of the c/<id>/f/type
  // register when present; meta.type is only the corrupt-state fallback.
  for (const c of concepts.values()) {
    const rec = c.fields.get('type')
    if (rec && Array.isArray(rec.values) && rec.values.length > 0) {
      c.type = rec.values[0]
    }
    if (c.headHash !== undefined) {
      const m = revText.get(c.id)
      c.headText = (m && m.get(c.headHash)) || ''
    }
  }

  const collisions = new Set()
  for await (const { key } of reader.scan(K.flagPrefix('pathcollision'))) {
    const segs = K.parseKey(key) // ['flag', 'pathcollision', path, id]
    if (segs.length >= 4) collisions.add(collisionKey(segs[2], segs[3]))
  }

  return { concepts, collisions }
}

/** Read every `log/<ordinal>` record in ascending ordinal order (§9). */
export async function readLog(reader) {
  const out = []
  for await (const { key, value } of reader.scan(K.logRoot())) {
    const ord = K.parseKey(key)[1]
    out.push({ ord, at: value && typeof value.at === 'number' ? value.at : 0, events: (value && value.events) || [] })
  }
  return out
}

/**
 * Adapt a core MemView to the { val, scan } reader surface readView/readLog
 * (and wanted) expect — for off-substrate determinism tests. Keys/values in
 * MemView are strings; values are JSON.
 */
export function memViewReader(view) {
  return {
    async val(key) {
      const node = await view.get(key)
      return node ? JSON.parse(node.value) : undefined
    },
    async *scan(prefix) {
      const { gte, lt } = K.range(prefix)
      for await (const { key, value } of view.createReadStream({ gte, lt })) {
        yield { key: Buffer.isBuffer(key) ? key.toString('utf8') : String(key), value: JSON.parse(value) }
      }
    }
  }
}
