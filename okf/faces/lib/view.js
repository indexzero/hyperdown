// Read the view (SPEC §4) into the model that the faces project to disk.
// The same view gives the same model on every peer (I8, I9). Reads go
// through the store Bundle surface, `val(key)` and `scan(prefix)`, which
// JSON-decodes values. memViewReader adapts a MemView for tests.
import { keyspace as K } from '@auto-okf/core'

function newConcept(id) {
  return {
    id,
    type: undefined,
    created: undefined,
    deleted: false,
    path: undefined,
    ord: undefined,
    headHash: undefined,
    headText: '',
    fields: new Map() // key -> view record: { values, tag, writer } or { els, removed }
  }
}

/** The Set key of one (path, id) pathcollision entry. */
export function collisionKey(path, id) {
  return `${path}\u0000${id}`
}

/**
 * The concept model and the path-collision index of a view. Returns
 *   { concepts: Map<id, concept>, collisions: Set<collisionKey> }.
 * `concepts` includes the deleted ones. A concept is { id, type, created,
 * deleted, path, ord, headHash, headText, fields }.
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
        // A seed. The `type` register below wins.
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

  // SPEC §5: `type` is the first element of the register. meta.type is the
  // fallback for corrupt state.
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

/** Every `log/<ordinal>` record, in ascending ordinal. */
export async function readLog(reader) {
  const out = []
  for await (const { key, value } of reader.scan(K.logRoot())) {
    const ord = K.parseKey(key)[1]
    out.push({ ord, at: value && typeof value.at === 'number' ? value.at : 0, events: (value && value.events) || [] })
  }
  return out
}

/**
 * Adapt a core MemView to the { val, scan } reader surface, for tests
 * without the substrate. MemView keys and values are strings. Values are
 * JSON.
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
