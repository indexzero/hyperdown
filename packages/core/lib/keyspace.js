// View keyspace codec (SPEC-FINAL §4).
//
// Escaping is mandatory: naive string concatenation of user-controlled
// subjects into keys is forbidden (§4). Every user-controlled component
// ('%' and '/' escaped) round-trips losslessly, so a subject named
// '../escape' or 'a/b' can never collide with, or escape into, another key
// family (§9.4 keyspace containment). Callers pass NFC-normalized strings
// (§3.1); this module does not normalize.
//
// Layout ambiguity resolutions (recorded in DEVIATIONS.md):
// - §4 places user scopes at ctx/<scope>/<term> alongside the reserved
//   families ctx/scope/ and ctx/gov/. We store user term definitions under
//   ctx/d/<scope>/<term> and the composed per-term lookup under
//   ctx/t/<term> so a scope literally named 'scope' or 'gov' cannot collide.
// - §4 places the hold buffer at n/hold/<W>/<seq> in the same position as
//   user subjects; a subject whose escaped form is exactly 'hold' is
//   re-escaped to '%68old' ('%68' decodes to 'h'), which round-trips and can
//   never be produced by escaping any other subject.

const RESERVED_UNDER_N = new Set(['hold'])

/** Escape one user-controlled key component. */
export function esc(component) {
  return String(component).replace(/%/g, '%25').replace(/\//g, '%2F')
}

/** Inverse of esc (also decodes the reserved-name '%68old' form). */
export function unesc(component) {
  return String(component).replace(/%([0-9A-Fa-f]{2})/g, (_, h) =>
    String.fromCharCode(parseInt(h, 16))
  )
}

function escSubject(s) {
  const e = esc(s)
  if (RESERVED_UNDER_N.has(e)) return '%' + e.charCodeAt(0).toString(16).padStart(2, '0') + e.slice(1)
  return e
}

/** Fixed-width per-writer ordinal so ascending key order == numeric order (§8.2). */
export function pad(ord) {
  return String(ord).padStart(12, '0')
}

/** Split a key into raw segments and unescape each user component. */
export function parseKey(key) {
  return key.split('/').map(unesc)
}

/** Inclusive prefix scan range. Works because escaped components contain no
 * raw '/'; '0' is the code point after '/'. */
export function range(prefix) {
  return { gte: prefix, lt: prefix.slice(0, -1) + '0' }
}

// --- n/ per-subject families (§4) ---
export const nField = (s, p) => `n/${escSubject(s)}/f/${esc(p)}`
export const nFieldPrefix = (s) => `n/${escSubject(s)}/f/`
export const nBody = (s) => `n/${escSubject(s)}/body`
export const nRev = (s, rev) => `n/${escSubject(s)}/rev/${esc(rev)}`
export const nRevPrefix = (s) => `n/${escSubject(s)}/rev/`
export const nLayer = (s) => `n/${escSubject(s)}/layer`
export const nBase = (s) => `n/${escSubject(s)}/base`
export const nPath = (s) => `n/${escSubject(s)}/path`
export const nId = (s) => `n/${escSubject(s)}/id`
export const nDeleted = (s) => `n/${escSubject(s)}/deleted`
export const nHost = (s, k) => `n/${escSubject(s)}/host/${esc(k)}`
export const nHostPrefix = (s) => `n/${escSubject(s)}/host/`
export const nMintedAs = (s) => `n/${escSubject(s)}/mintedAs`
export const nSubjectPrefix = (s) => `n/${escSubject(s)}/`
// hold buffer (§8.2): reserved family under n/, writer key is hex (never escapes)
export const nHold = (w, ord) => `n/hold/${w}/${pad(ord)}`
export const nHoldPrefix = (w) => `n/hold/${w}/`

// --- bookkeeping families (outside ctx/, like seen/; §8.2, DEVIATIONS.md) ---
export const seen = (w) => `seen/${w}`
export const rate = (w) => `rate/${w}`
export const rateIndexerOps = () => 'rate/indexer-ops' // '-' cannot appear in a hex writer key
export const gpos = () => 'gseq/pos'
export const iriIdx = (iri, s) => `iri/${esc(iri)}/${escSubject(s)}`
export const iriIdxPrefix = (iri) => `iri/${esc(iri)}/`
export const fidx = (term, s) => `fidx/${esc(term)}/${escSubject(s)}`
export const fidxPrefix = (term) => `fidx/${esc(term)}/`
export const hostIdx = (k, s) => `hostidx/${esc(k)}/${escSubject(s)}`
export const hostIdxPrefix = (k) => `hostidx/${esc(k)}/`
export const scopeIdx = (scope, s) => `scopeidx/${esc(scope)}/${escSubject(s)}`
export const scopeIdxPrefix = (scope) => `scopeidx/${esc(scope)}/`
// Base-keyed revision index (§6 conflict detection): one row per revision
// citing a NON-null base, so same-base concurrency is found in O(matches)
// instead of a full n/<s>/rev/* scan (review finding M1). Null-base
// revisions cite no base and are never indexed (they raise no mutual
// conflicts). Bookkeeping family like seen/ and fidx/: written
// deterministically by apply (so it participates in the I2/I3 full-range
// view hash) but excluded from materialize/export, which scan only n/,
// ctx/ and idx/spo/.
export const revByBase = (s, base, rev) => `revbybase/${escSubject(s)}/${esc(base)}/${esc(rev)}`
export const revByBasePrefix = (s, base) => `revbybase/${escSubject(s)}/${esc(base)}/`

// --- ctx/ (§4; layout resolution above) ---
export const ctxDef = (scope, term) => `ctx/d/${esc(scope)}/${esc(term)}`
export const ctxTerm = (term) => `ctx/t/${esc(term)}`
export const ctxScope = (scope) => `ctx/scope/${esc(scope)}`
export const govWriter = (w) => `ctx/gov/writer/${w}`
export const govClock = (w) => `ctx/gov/clock/${w}`
export const govRemoved = (w) => `ctx/gov/removed/${w}`
export const govPrefix = () => 'ctx/gov/'

// --- triple permutation indexes and backlinks (§4) ---
export const idxSpo = (sIri, p, oKey) => `idx/spo/${esc(sIri)}/${esc(p)}/${esc(oKey)}`
export const idxPos = (sIri, p, oKey) => `idx/pos/${esc(p)}/${esc(oKey)}/${esc(sIri)}`
export const idxOsp = (sIri, p, oKey) => `idx/osp/${esc(oKey)}/${esc(sIri)}/${esc(p)}`
export const bl = (target, source, term) => `bl/${escSubject(target)}/${escSubject(source)}/${esc(term)}`
export const blPrefix = (target) => `bl/${escSubject(target)}/`

// --- unmapped reverse index (§10.3) ---
export const unmappedIdx = (term, s) => `unmapped-idx/${esc(term)}/${escSubject(s)}`
export const unmappedIdxPrefix = (term) => `unmapped-idx/${esc(term)}/`

// --- flag/ families (§4) ---
export const flag = (family, ...comps) => `flag/${family}/` + comps.map(esc).join('/')
export const flagPrefix = (family, ...comps) =>
  `flag/${family}/` + comps.map(esc).join('/') + (comps.length ? '/' : '')
export const flagRejected = (w, ord) => `flag/rejected/${w}/${pad(ord)}`
export const flagOptimistic = (w, ord) => `flag/optimistic/${w}/${pad(ord)}`
