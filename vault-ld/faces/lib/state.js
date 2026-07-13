// Read-side walk of the §4 view keyspace into per-subject face state.
//
// The faces package never writes the view: the view is written only by
// apply folding ops (SPEC-FINAL §9.3 "no component writes n/ directly").
// Everything here consumes the read surface a @autovault-ld/store Vault
// exposes — `scan(prefix)` (async iterable of { key, value }) and
// `val(key)` — or any object with the same shape (core's MemView wrapped
// accordingly works too).
//
// Key parsing note: `n/hold/<W>/<ord>` is the one reserved family under
// n/ (§8.2). The keyspace codec re-escapes a subject literally named
// 'hold' to '%68old' (vault-ld/core/lib/keyspace.js), so the RAW second
// segment distinguishes the reserved family ('hold') from the subject
// ('%68old'); both unescape to the display name 'hold'.
import { keyspace as K } from '@autovault-ld/core'

const DEFAULT_ROOT_BASE = 'vault://data/'
const DEFAULT_HOST_ALLOWLIST = ['tags', 'aliases', 'cssclasses']

/** Vault-metadata constants the faces need (core README table). */
export function faceMetadata(vault) {
  const meta = (vault && vault.metadata) || {}
  return {
    rootBase: meta.rootBase || DEFAULT_ROOT_BASE,
    hostAllowlist: meta.hostAllowlist || DEFAULT_HOST_ALLOWLIST
  }
}

function emptySubject(name) {
  return {
    name,
    fields: new Map(), // term -> { reg?, els?, un? } (§4 field record)
    host: new Map(), // key -> { value, tag }
    revs: new Map(), // revHash -> { base, text, writer, at }
    head: undefined, // n/<s>/body
    layer: undefined, // 'schema' | 'data'
    base: undefined, // { scope, base, iri }
    path: undefined, // { path, scope, tag, writer }
    id: undefined, // { iri, tag, writer }
    deleted: false,
    mintedAs: undefined
  }
}

/**
 * Walk `n/` and `ctx/` (§9.1) into:
 *   {
 *     subjects: Map<name, subjectState>,   // only real subjects (have n/<s>/base)
 *     terms:    Map<term, { def, scope, kind }>,   // composed ctx/t lookup
 *     scopes:   Map<scope, { base, prefix }>,      // ctx/scope declarations
 *     defs:     Map<scope, Map<term, def>>         // ctx/d per-scope defs
 *   }
 * Bookkeeping families (n/hold/, seen/, rate/, ctx/gov/, idx/, flag/, ...)
 * are excluded from the walk per §8.2 ("excluded from materialize/export
 * walks — it is bookkeeping").
 */
export async function readVaultState(vault) {
  const subjects = new Map()
  const byRaw = new Map() // raw escaped subject segment -> state

  for await (const { key, value } of vault.scan('n/')) {
    const raw = key.split('/')
    if (raw[1] === 'hold') continue // reserved §8.2 hold buffer, not a subject
    const name = K.unesc(raw[1])
    let s = byRaw.get(raw[1])
    if (!s) {
      s = emptySubject(name)
      byRaw.set(raw[1], s)
    }
    const family = raw[2]
    switch (family) {
      case 'f':
        s.fields.set(K.unesc(raw[3]), value)
        break
      case 'host':
        s.host.set(K.unesc(raw[3]), value)
        break
      case 'rev':
        s.revs.set(K.unesc(raw[3]), value)
        break
      case 'body':
        s.head = value
        break
      case 'layer':
        s.layer = value
        break
      case 'base':
        s.base = value
        break
      case 'path':
        s.path = value
        break
      case 'id':
        s.id = value
        break
      case 'deleted':
        s.deleted = true
        break
      case 'mintedAs':
        s.mintedAs = value
        break
      default:
        break // unknown family: forward-compat, ignore
    }
  }

  // Only rows with an n/<s>/base record are subjects (mirrors core's
  // exists()); dangling-target mintedAs rows are not notes (§7).
  for (const s of byRaw.values()) {
    if (s.base !== undefined) subjects.set(s.name, s)
  }

  const terms = new Map()
  const scopes = new Map()
  const defs = new Map()
  for await (const { key, value } of vault.scan('ctx/')) {
    const raw = key.split('/')
    if (raw[1] === 'gov') continue // governance records are not context (§4)
    if (raw[1] === 't') {
      terms.set(K.unesc(raw[2]), value)
    } else if (raw[1] === 'scope') {
      scopes.set(K.unesc(raw[2]), value)
    } else if (raw[1] === 'd') {
      const scope = K.unesc(raw[2])
      if (!defs.has(scope)) defs.set(scope, new Map())
      defs.get(scope).set(K.unesc(raw[3]), value)
    }
  }

  return { subjects, terms, scopes, defs }
}

/**
 * The declared keyword alias for '@type' / '@id' (vault-ld §4.3: a tool
 * that generates the Markdown face SHOULD write the aliased spelling when
 * one is declared). Deterministic pick: lexicographically smallest alias.
 */
export function keywordAlias(terms, keyword) {
  const kind = keyword === '@type' ? 'type-alias' : 'id-alias'
  let best = null
  for (const [term, rec] of terms) {
    if (rec && rec.kind === kind && (best === null || term < best)) best = term
  }
  return best
}

/** Field values of a subject's '@type' element set, as plain names. */
export function typeNames(subject) {
  const rec = subject && subject.fields.get('@type')
  const out = []
  if (rec && rec.els) {
    for (const el of Object.values(rec.els)) {
      const v = el.v
      out.push(v !== null && typeof v === 'object' && typeof v.ref === 'string' ? v.ref : String(v))
    }
  }
  return out
}
