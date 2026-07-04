// exportTurtle(vault, dir) — SPEC-FINAL §10: schema.ttl + data.ttl by
// range-scanning idx/spo, partitioned by the per-subject n/<s>/layer
// record (§10.1), byte-deterministic per §10.2 (canonical prefix, subject,
// predicate, object ordering; canonical literal lexical forms), vld:path
// emission per §10.4 (roundtrip flag; emitted iff the authored path
// differs from the reconstructable default), unmapped terms never emitted
// as triples (§10.3 — guaranteed structurally: apply indexes only mapped
// field state, so unmapped values never appear in idx/*).
//
// Turtle grammar reference: https://www.w3.org/TR/turtle/ (IRIREF forbids
// space, <>, ", {}, |, ^, `, \ and controls — those are %-encoded below;
// STRING_LITERAL_QUOTE escapes are emitted in fixed codepoint order per
// §10.2). vld: is Vault-LD's own namespace,
// https://github.com/The-Knowledge-Graph-Guys/vault-ld# (SPEC.md §5.4).
import { keyspace as K, canonical } from '@hyperwiki/core'
import { readVaultState, faceMetadata } from './state.js'
import { defaultRelPath } from './placement.js'
import { rootRegistry, atomicWrite } from './fsatomic.js'

const { nfc, byteForm, canonicalInteger, canonicalDouble, stableStringify } = canonical

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
const VLD_NS = 'https://github.com/The-Knowledge-Graph-Guys/vault-ld#'

// Standard prefixes (vault-ld §5.4 "standard @prefix headers"), emitted
// only when used; a DefineScope prefix of the same name overrides.
const WELL_KNOWN = {
  owl: 'http://www.w3.org/2002/07/owl#',
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
  skos: 'http://www.w3.org/2004/02/skos/core#',
  vld: VLD_NS,
  xsd: 'http://www.w3.org/2001/XMLSchema#'
}

const PN_LOCAL_OK = /^[A-Za-z_][A-Za-z0-9_.-]*$/

/**
 * Export the view as Turtle. Options:
 *   roundtrip  emit vld:path for notes off their reconstructable default
 *              (§10.4); omitted for query-only exports (default false)
 * Returns { schema: { path, triples }, data: { path, triples } }.
 */
export async function exportTurtle(vault, dir, opts = {}) {
  if (typeof vault.update === 'function') await vault.update()
  const { realRoot } = await rootRegistry(dir)
  const meta = faceMetadata(vault)
  const state = opts.state || (await readVaultState(vault))

  // prefix table: well-known + declared scopes (declared wins)
  const prefixes = { ...WELL_KNOWN }
  for (const [, scope] of [...state.scopes.entries()].sort()) {
    if (scope && scope.prefix) prefixes[scope.prefix] = scope.base
  }

  // subject IRI -> subject state (layer partition + literal fidelity)
  const byIri = new Map()
  for (const name of [...state.subjects.keys()].sort()) {
    const s = state.subjects.get(name)
    if (s.base && s.base.iri && !byIri.has(s.base.iri)) byIri.set(s.base.iri, s)
  }

  // predKey -> term definition (core's predKey is def['@id'] when it is a
  // string, else the term itself), for §4.4-style '@type': '@id' coercion.
  const defByPred = new Map()
  for (const [term, rec] of state.terms) {
    if (!rec || !rec.def) continue
    const predKey = typeof rec.def['@id'] === 'string' ? rec.def['@id'] : term
    if (!defByPred.has(predKey)) defByPred.set(predKey, rec.def)
  }

  const ctx = { prefixes, rootBase: meta.rootBase, used: { schema: new Set(), data: new Set() } }

  // ---- the triples, from a pure range scan of idx/spo (§10.1) ----
  const rows = { schema: [], data: [] }
  for await (const { key } of vault.scan('idx/spo/')) {
    const segs = key.split('/').map(K.unesc)
    // idx/spo/<sIri>/<pred>/<oKey>
    const sIri = segs[2]
    const pred = segs[3]
    const oKey = segs[4]
    const subject = byIri.get(sIri)
    const layer = subject && subject.layer === 'schema' ? 'schema' : 'data'
    const def = defByPred.get(pred)
    const objSpec = renderObject(oKey, subject, pred, def, ctx, layer)
    if (objSpec === null) continue
    const predSpec = pred === '@type' ? { text: 'a', sort: RDF_TYPE } : renderPred(pred, ctx, layer)
    rows[layer].push({
      s: sIri,
      p: predSpec.sort,
      o: oKey,
      text: `<${escapeIri(sIri)}> ${predSpec.text} ${objSpec} .`
    })
  }

  // ---- vld:path roundtrip triples (§10.4) ----
  if (opts.roundtrip) {
    for (const name of [...state.subjects.keys()].sort()) {
      const s = state.subjects.get(name)
      if (s.deleted || !s.path || !s.base) continue
      const scope = s.base.scope
      const types = typeNamesOf(s)
      if (s.path.path === defaultRelPath(name, s.layer, scope, types)) continue
      const layer = s.layer === 'schema' ? 'schema' : 'data'
      ctx.used[layer].add('vld')
      rows[layer].push({
        s: s.base.iri,
        p: VLD_NS + 'path',
        o: byteForm(s.path.path + '.md'),
        text: `<${escapeIri(s.base.iri)}> vld:path ${turtleString(s.path.path + '.md')} .`
      })
    }
  }

  const out = {}
  for (const layer of ['schema', 'data']) {
    // §10.2 fixed ascending order: subject IRI bytes, predicate IRI bytes,
    // object §10.2 byte form.
    rows[layer].sort((a, b) => cmp(a.s, b.s) || cmp(a.p, b.p) || cmp(a.o, b.o))
    let doc = ''
    const used = [...ctx.used[layer]].sort()
    for (const p of used) doc += `@prefix ${p}: <${escapeIri(prefixes[p])}> .\n`
    if (used.length > 0 && rows[layer].length > 0) doc += '\n'
    for (const row of rows[layer]) doc += row.text + '\n'
    const rel = layer + '.ttl'
    await atomicWrite(realRoot, rel, Buffer.from(doc, 'utf8'))
    out[layer] = { path: rel, triples: rows[layer].length }
  }
  return out
}

function cmp(a, b) {
  const x = Buffer.from(String(a), 'utf8')
  const y = Buffer.from(String(b), 'utf8')
  return Buffer.compare(x, y)
}

function typeNamesOf(s) {
  const rec = s.fields.get('@type')
  const out = []
  if (rec && rec.els) {
    for (const el of Object.values(rec.els)) {
      const v = el.v
      out.push(v !== null && typeof v === 'object' && typeof v.ref === 'string' ? v.ref : String(v))
    }
  }
  return out
}

/**
 * Render a name that must be an IRI (predicate, type object, datatype):
 * a declared/well-known prefix yields a prefixed name (falling back to the
 * expanded <IRI> when the local part is not PN_LOCAL-safe); any other
 * 'scheme:rest' is treated as an absolute IRI verbatim; a bare name minted
 * under the data root (mirrors core's name-based minting).
 */
function renderIriName(name, ctx, layer) {
  const i = name.indexOf(':')
  if (i > 0) {
    const pfx = name.slice(0, i)
    const local = name.slice(i + 1)
    const nsIri = ctx.prefixes[pfx]
    if (nsIri !== undefined) {
      if (PN_LOCAL_OK.test(local)) {
        ctx.used[layer].add(pfx)
        return { text: `${pfx}:${local}`, sort: nsIri + local }
      }
      return { text: `<${escapeIri(nsIri + local)}>`, sort: nsIri + local }
    }
    return { text: `<${escapeIri(name)}>`, sort: name }
  }
  // §4.5-consistent fallback mint (matches core's encodeName so the same
  // name always yields the same IRI on every face).
  const iri = ctx.rootBase + encodeURIComponent(nfc(name))
  return { text: `<${escapeIri(iri)}>`, sort: iri }
}

function renderPred(pred, ctx, layer) {
  return renderIriName(pred, ctx, layer)
}

/**
 * Render one object from its idx oKey plus the owning subject's field
 * state (the §10.2 byte form is a total-order key, not a parseable literal
 * carrier — datatypes may contain ':' — so literal fidelity comes from the
 * subject's stored values, looked up by byte form).
 */
function renderObject(oKey, subject, pred, def, ctx, layer) {
  if (oKey.startsWith('r:')) {
    return `<${escapeIri(oKey.slice(2))}>` // wiki-link ref: object IRI
  }
  const v = lookupValue(subject, pred, oKey)
  if (oKey.startsWith('s:')) {
    const str = typeof v === 'string' ? v : oKey.slice(2)
    if (pred === '@type' || (def && def['@type'] === '@id')) {
      // JSON-LD '@type': '@id' (and rdf:type itself): string values are
      // IRIs, not literals (vault-ld §4.4: `subClassOf: [..., sdo:Recipe]`).
      return renderIriName(str, ctx, layer).text
    }
    return turtleString(str)
  }
  if (oKey.startsWith('b:')) return oKey.slice(2) // 'true' | 'false'
  if (oKey.startsWith('n:')) {
    const num = typeof v === 'number' ? v : Number(oKey.slice(2))
    if (Number.isInteger(num) && Number.isSafeInteger(num)) return canonicalInteger(num)
    const lex = canonicalDouble(num)
    if (lex === 'NaN' || lex === 'INF' || lex === '-INF') {
      ctx.used[layer].add('xsd')
      return `${turtleString(lex)}^^xsd:double`
    }
    return lex
  }
  if (oKey.startsWith('l:')) {
    if (v === undefined || v === null || typeof v !== 'object' || !('value' in v)) return null
    if (v.lang) return `${turtleString(v.value)}@${v.lang}`
    if (v.datatype) {
      const dt = renderIriName(v.datatype, ctx, layer)
      return `${turtleString(v.value)}^^${dt.text}`
    }
    return turtleString(v.value)
  }
  if (oKey.startsWith('j:')) {
    // opaque canonical-JSON value: emitted as an rdf:JSON literal
    ctx.used[layer].add('rdf')
    return `${turtleString(v !== undefined ? stableStringify(v) : oKey.slice(2))}^^rdf:JSON`
  }
  // 'z:' (null) has no Turtle object form; the row is bookkeeping only.
  return null
}

function lookupValue(subject, pred, oKey) {
  if (!subject) return undefined
  for (const rec of subject.fields.values()) {
    if (rec.reg) {
      for (const v of rec.reg.values) if (byteForm(v) === oKey) return v
    }
    if (rec.els) {
      for (const el of Object.values(rec.els)) if (byteForm(el.v) === oKey) return el.v
    }
  }
  return undefined
}

/**
 * Turtle STRING_LITERAL_QUOTE with escapes applied in fixed codepoint
 * order (§10.2): \\ " \n \r \t, other C0/C1 controls as \uXXXX.
 */
export function turtleString(s) {
  let out = '"'
  for (const ch of String(s)) {
    const code = ch.codePointAt(0)
    if (ch === '\\') out += '\\\\'
    else if (ch === '"') out += '\\"'
    else if (ch === '\n') out += '\\n'
    else if (ch === '\r') out += '\\r'
    else if (ch === '\t') out += '\\t'
    else if (code < 0x20 || code === 0x7f) {
      out += '\\u' + code.toString(16).toUpperCase().padStart(4, '0')
    } else {
      out += ch
    }
  }
  return out + '"'
}

/** IRIREF-forbidden characters, percent-encoded (deterministic, UTF-8). */
export function escapeIri(iri) {
  let out = ''
  for (const ch of String(iri)) {
    const code = ch.codePointAt(0)
    if (code <= 0x20 || '<>"{}|^`\\'.includes(ch)) {
      const bytes = Buffer.from(ch, 'utf8')
      for (const b of bytes) out += '%' + b.toString(16).toUpperCase().padStart(2, '0')
    } else {
      out += ch
    }
  }
  return out
}
