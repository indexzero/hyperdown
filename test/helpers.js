// Shared unit-test harness: drives the pure apply function directly with
// scripted op sequences (multi-process/autobase harness is a later phase).
import {
  createApply,
  encodeOp,
  makeTag,
  MemView,
  keyspace as K
} from '../packages/core/index.js'

export { K, makeTag, encodeOp }

export const GEN = Buffer.alloc(32, 0xaa) // genesis indexer (§8.0)
export const W1 = Buffer.alloc(32, 0x01)
export const W2 = Buffer.alloc(32, 0x02)
export const W3 = Buffer.alloc(32, 0x03)

export const hex = (b) => b.toString('hex')

/** Build a node the way autobase hands them to apply: { from: { key }, value }. */
export function n(writer, type, payload) {
  return { from: { key: writer }, value: encodeOp(type, payload) }
}

/** A raw (possibly garbage) node. */
export function rawNode(writer, buf) {
  return { from: { key: writer }, value: buf }
}

export function stubHost() {
  const host = {
    added: [],
    removed: [],
    acked: [],
    async addWriter(key, opts) {
      host.added.push([hex(key), opts])
    },
    async removeWriter(key) {
      host.removed.push(hex(key))
    },
    async ackWriter(key) {
      host.acked.push(hex(key))
    },
    removeable() {
      return true
    }
  }
  return host
}

/**
 * Apply `nodes` and return { view, host }. `batches` controls how the same
 * linearized sequence is chunked across apply() invocations (arrival-order
 * variance for I2/I3 while linearized order stays fixed).
 */
export async function run(nodes, { config = {}, view, host, batches } = {}) {
  view = view || new MemView()
  host = host || stubHost()
  const apply = createApply({ genesisKey: GEN, ...config })
  if (!batches) {
    await apply(nodes, view, host)
  } else {
    let i = 0
    for (const size of batches) {
      await apply(nodes.slice(i, i + size), view, host)
      i += size
    }
    if (i < nodes.length) await apply(nodes.slice(i), view, host)
  }
  return { view, host }
}

/** Prelude ops adding writers (issued by genesis). */
export function addWriters(...specs) {
  return specs.map(([key, indexer]) => n(GEN, 'add-writer', { key, indexer }))
}

/** Convenience: define an or-set term and an lww term in scope 'core'. */
export function defineSetTerm(term, iri = 'ex:' + term) {
  return n(GEN, 'define-term', {
    scope: 'core',
    term,
    def: { '@id': iri, '@container': '@set' }
  })
}

export function defineLwwTerm(term, iri = 'ex:' + term) {
  return n(GEN, 'define-term', { scope: 'core', term, def: { '@id': iri } })
}

/** The applied/rejected partition of a view (I10 stability checks). */
export function partition(view) {
  return {
    rejected: view.dump('flag/rejected/'),
    optimistic: Object.keys(view.dump('flag/optimistic/')),
    gov: view.dump('ctx/gov/'),
    hash: view.hash()
  }
}

/**
 * I8 coherence checker: rebuild the expected idx/* row set from n/* + ctx/*
 * state and compare with the actual idx/* contents.
 */
export async function checkIndexCoherence(view) {
  const all = view.dump('')
  const subjects = new Set()
  for (const key of Object.keys(all)) {
    if (!key.startsWith('n/')) continue
    const segs = K.parseKey(key)
    if (segs[1] === 'hold') continue
    subjects.add(segs[1])
  }

  const predKey = (p) => {
    if (p === '@type') return '@type'
    const t = all[K.ctxTerm(p)]
    return t && t.def && typeof t.def['@id'] === 'string' ? t.def['@id'] : p
  }
  const existsNow = (s) => all[K.nBase(s)] !== undefined && all[K.nDeleted(s)] === undefined
  const subjectIri = (s) =>
    all[K.nBase(s)] ? all[K.nBase(s)].iri : 'vault://data/' + encodeURIComponent(s)

  const { canonical } = await import('../packages/core/index.js')
  const expected = new Set()
  for (const s of subjects) {
    if (all[K.nDeleted(s)] !== undefined) continue
    const sIri = subjectIri(s)
    for (const key of Object.keys(all)) {
      if (!key.startsWith(K.nFieldPrefix(s))) continue
      const p = K.parseKey(key)[3]
      const rec = all[key]
      const values = []
      if (rec.reg) values.push(...rec.reg.values)
      if (rec.els) for (const e of Object.values(rec.els)) values.push(e.v)
      const pk = predKey(p)
      for (const v of values) {
        let oKey
        if (v !== null && typeof v === 'object' && typeof v.ref === 'string') {
          const t = v.ref
          const oIri = existsNow(t) ? subjectIri(t) : all[K.nMintedAs(t)]
          oKey = 'r:' + oIri
        } else {
          oKey = canonical.byteForm(v)
        }
        expected.add(K.idxSpo(sIri, pk, oKey))
        expected.add(K.idxPos(sIri, pk, oKey))
        expected.add(K.idxOsp(sIri, pk, oKey))
      }
    }
  }
  const actual = new Set(Object.keys(all).filter((k) => k.startsWith('idx/')))
  const missing = [...expected].filter((k) => !actual.has(k))
  const extra = [...actual].filter((k) => !expected.has(k))
  return { ok: missing.length === 0 && extra.length === 0, missing, extra }
}
