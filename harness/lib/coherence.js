// Independent I8 coherence checker (assignment S9: "write the checker as an
// independent reimplementation, not by calling the code under test").
//
// Given a full view dump ({ key: value }), rederives from n/* and ctx/t/*
// what idx/*, bl/*, fidx/*, hostidx/*, unmapped-idx/*, iri/* and scopeidx/*
// must contain, and reports every discrepancy. Nothing here imports
// @autovault-ld/core: escaping, byte forms and derivation rules are
// reimplemented from SPEC-FINAL §4/§9.2/§10.2 and the packages' READMEs.

// --- §4 keyspace escaping (reimplemented) ---
function esc(c) {
  return String(c).replace(/%/g, '%25').replace(/\//g, '%2F')
}
function escSubject(s) {
  const e = esc(s)
  if (e === 'hold') return '%68old'
  return e
}
function unesc(c) {
  return String(c).replace(/%([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
}
function splitKey(key) {
  return key.split('/').map(unesc)
}

// --- §10.2 canonical byte form (reimplemented) ---
function canonInt(v) {
  const m = /^([+-]?)0*(\d+)$/.exec(String(v))
  const sign = m[1] === '-' && m[2] !== '0' ? '-' : ''
  return sign + m[2]
}
function canonDouble(n) {
  if (Number.isNaN(n)) return 'NaN'
  if (n === Infinity) return 'INF'
  if (n === -Infinity) return '-INF'
  if (n === 0) return Object.is(n, -0) ? '-0.0E0' : '0.0E0'
  const m = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(n.toExponential())
  let frac = (m[3] || '0').replace(/0+$/, '')
  if (frac === '') frac = '0'
  return `${m[1]}${m[2]}.${frac}E${parseInt(m[4], 10)}`
}
function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']'
  return (
    '{' +
    Object.keys(v)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + stableStringify(v[k]))
      .join(',') +
    '}'
  )
}
function byteForm(v) {
  if (v === null || v === undefined) return 'z:'
  if (typeof v === 'boolean') return 'b:' + v
  if (typeof v === 'number') return Number.isInteger(v) ? 'n:' + canonInt(v) : 'n:' + canonDouble(v)
  if (typeof v === 'string') return 's:' + v.normalize('NFC')
  if (typeof v === 'object' && typeof v.ref === 'string') return 'r:' + v.ref
  if (typeof v === 'object' && 'value' in v) {
    return 'l:' + (v.datatype || '') + ':' + v.value + (v.lang ? '@' + v.lang : '')
  }
  return 'j:' + stableStringify(v)
}
function encodeName(s) {
  return encodeURIComponent(String(s).normalize('NFC'))
}

/**
 * @param {object} dump  full view dump { key: value }
 * @param {object} opts  { rootBase } (vault metadata constant)
 * @returns {string[]}   violations (empty = coherent)
 */
export function checkCoherence(dump, { rootBase = 'vault://data/' } = {}) {
  const violations = []

  // -- pass 1: collect per-subject state from n/* --
  const subjects = new Map() // s -> { base, deleted, mintedAs, fields: Map, hosts: Map }
  const terms = new Map() // term -> { def, scope, kind } from ctx/t/
  for (const [key, value] of Object.entries(dump)) {
    if (key.startsWith('ctx/t/')) {
      terms.set(splitKey(key)[2], value)
      continue
    }
    if (!key.startsWith('n/')) continue
    const segs = splitKey(key)
    const s = segs[1]
    if (key.startsWith('n/hold/')) continue // §8.2 reserved family
    let rec = subjects.get(s)
    if (!rec) {
      rec = { base: null, deleted: false, mintedAs: null, fields: new Map(), hosts: new Map() }
      subjects.set(s, rec)
    }
    const family = segs[2]
    if (family === 'base') rec.base = value
    else if (family === 'deleted') rec.deleted = true
    else if (family === 'mintedAs') rec.mintedAs = value
    else if (family === 'f') rec.fields.set(segs[3], value)
    else if (family === 'host') rec.hosts.set(segs[3], value)
  }

  const exists = (s) => {
    const r = subjects.get(s)
    return !!r && !!r.base && !r.deleted
  }
  const subjectIri = (s) => {
    const r = subjects.get(s)
    if (r && r.base) return r.base.iri
    return rootBase + encodeName(s)
  }
  const mintedIri = (s) => {
    const r = subjects.get(s)
    if (r && r.mintedAs) return r.mintedAs
    return rootBase + encodeName(s)
  }
  const predKey = (p) => {
    if (p === '@type') return '@type'
    const t = terms.get(p)
    if (t && t.def && typeof t.def['@id'] === 'string') return t.def['@id']
    return p
  }

  // -- pass 2: expected derived rows --
  const expIdx = new Set()
  const expBl = new Map() // key -> count
  const expFidx = new Set()
  const expUnmapped = new Set()
  const expHostIdx = new Set()
  const expIri = new Set()
  const expScopeIdx = new Set()

  for (const [s, rec] of subjects) {
    if (rec.base) {
      expIri.add(`iri/${esc(rec.base.iri)}/${escSubject(s)}`)
      if (rec.base.scope) expScopeIdx.add(`scopeidx/${esc(rec.base.scope)}/${escSubject(s)}`)
    }
    for (const k of rec.hosts.keys()) {
      expHostIdx.add(`hostidx/${esc(k)}/${escSubject(s)}`)
    }
    for (const [p, f] of rec.fields) {
      if (f.reg || f.els) expFidx.add(`fidx/${esc(p)}/${escSubject(s)}`)
      if (f.un) expUnmapped.add(`unmapped-idx/${esc(p)}/${escSubject(s)}`)
      if (rec.deleted) continue // §9.2 tombstone suppresses idx/bl
      const values = []
      if (f.reg) values.push(...f.reg.values)
      if (f.els) for (const [, e] of Object.entries(f.els).sort()) values.push(e.v)
      if (values.length === 0) continue
      const sIri = subjectIri(s)
      const pk = predKey(p)
      for (const v of values) {
        let oKey
        if (v !== null && typeof v === 'object' && typeof v.ref === 'string') {
          const target = v.ref
          const oIri = exists(target) ? subjectIri(target) : mintedIri(target)
          oKey = 'r:' + oIri
          const blKey = `bl/${escSubject(target)}/${escSubject(s)}/${esc(p)}`
          expBl.set(blKey, (expBl.get(blKey) || 0) + 1)
        } else {
          oKey = byteForm(v)
        }
        expIdx.add(`idx/spo/${esc(sIri)}/${esc(pk)}/${esc(oKey)}`)
        expIdx.add(`idx/pos/${esc(pk)}/${esc(oKey)}/${esc(sIri)}`)
        expIdx.add(`idx/osp/${esc(oKey)}/${esc(sIri)}/${esc(pk)}`)
      }
    }
  }

  // -- pass 3: compare with the actual dump --
  const families = [
    ['idx/', expIdx],
    ['fidx/', expFidx],
    ['unmapped-idx/', expUnmapped],
    ['hostidx/', expHostIdx],
    ['iri/', expIri],
    ['scopeidx/', expScopeIdx]
  ]
  for (const [prefix, expected] of families) {
    const actual = new Set(Object.keys(dump).filter((k) => k.startsWith(prefix)))
    for (const k of expected) {
      if (!actual.has(k)) violations.push(`missing ${k}`)
    }
    for (const k of actual) {
      if (!expected.has(k)) violations.push(`stray ${k}`)
    }
  }
  const actualBl = Object.keys(dump).filter((k) => k.startsWith('bl/'))
  for (const [k, count] of expBl) {
    if (!(k in dump)) violations.push(`missing ${k}`)
    else if (dump[k].count !== count) {
      violations.push(`count mismatch ${k}: expected ${count}, got ${dump[k].count}`)
    }
  }
  for (const k of actualBl) {
    if (!expBl.has(k)) violations.push(`stray ${k}`)
  }
  return violations
}
