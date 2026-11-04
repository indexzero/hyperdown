// Copied from vault-ld/core/lib/keyspace.js at 046d37f. It diverges freely
// (SPEC §0, copy-don't-depend).
//
// Escaping is mandatory. Every user-controlled component round-trips with
// '%' and '/' escaped, so a path named '../escape' or a field key named
// 'a/b' can never collide with, or escape into, another key family.
// Callers must pass NFC strings (SPEC §3). No function here normalizes.

/** Escape one user-controlled key component. */
export function esc(component) {
  return String(component).replace(/%/g, '%25').replace(/\//g, '%2F')
}

/** Inverse of esc. */
export function unesc(component) {
  return String(component).replace(/%([0-9A-Fa-f]{2})/g, (_, h) =>
    String.fromCharCode(parseInt(h, 16))
  )
}

/** Fixed-width ordinal, so ascending key order is numeric order. */
export function pad(ord) {
  return String(ord).padStart(12, '0')
}

/** Split a key into raw segments and unescape each user component. */
export function parseKey(key) {
  return key.split('/').map(unesc)
}

/** Inclusive prefix scan range. An escaped component holds no raw '/',
 * and '0' is the code point after '/'. */
export function range(prefix) {
  return { gte: prefix, lt: prefix.slice(0, -1) + '0' }
}

// --- c/ per-concept families (§4). A concept id is lowercase hex (§6) and
// needs no escaping. It is escaped anyway, as defense in depth.
export const cMeta = (id) => `c/${esc(id)}/meta`
export const cField = (id, key) => `c/${esc(id)}/f/${esc(key)}`
export const cFieldPrefix = (id) => `c/${esc(id)}/f/`
export const cPath = (id) => `c/${esc(id)}/path`
export const cBody = (id) => `c/${esc(id)}/body`
export const cRev = (id, rev) => `c/${esc(id)}/rev/${esc(rev)}`
export const cRevPrefix = (id) => `c/${esc(id)}/rev/`
export const cPrefix = (id) => `c/${esc(id)}/`
export const cRoot = () => 'c/'

// --- revisions by base (§4): one row per revision that cites a non-null
// base, so same-base siblings are found in O(matches).
export const revByBase = (id, base, rev) => `revbybase/${esc(id)}/${esc(base)}/${esc(rev)}`
export const revByBasePrefix = (id, base) => `revbybase/${esc(id)}/${esc(base)}/`

// --- path/ current-holder index and the pcl/ claim index (§4, §7) ---
export const path = (p) => `path/${esc(p)}`
export const pathPrefix = () => 'path/'
// The live path-claim index of the §7 collision recompute, a key outside
// §4. Derived from c/ (I8): one row per live concept, keyed by the
// casefold of its current path.
export const pcl = (cfPath, id) => `pcl/${esc(cfPath)}/${esc(id)}`
export const pclPrefix = (cfPath) => `pcl/${esc(cfPath)}/`

// --- link graph (§4, §9) ---
export const link = (fromId, toPath) => `link/${esc(fromId)}/${esc(toPath)}`
export const linkPrefix = (fromId) => `link/${esc(fromId)}/`
export const bl = (toId, fromId) => `bl/${esc(toId)}/${esc(fromId)}`
export const blPrefix = (toId) => `bl/${esc(toId)}/`
export const wanted = (p, fromId) => `wanted/${esc(p)}/${esc(fromId)}`
export const wantedPrefix = (p) => `wanted/${esc(p)}/`
export const wantedRoot = () => 'wanted/'

// wantedrank/<inv-count>/<path>: inv-count is MAX - count as a 16-digit
// zero-padded decimal, MAX = 10^16 - 1, so an ascending scan yields the
// most wanted first (§4).
const WANTED_MAX = 10n ** 16n - 1n
export function invCount(count) {
  return String(WANTED_MAX - BigInt(count)).padStart(16, '0')
}
export const wantedRank = (count, p) => `wantedrank/${invCount(count)}/${esc(p)}`
export const wantedRankRoot = () => 'wantedrank/'

// --- log/ narration records (§4, §9) ---
export const log = (ordinal) => `log/${pad(ordinal)}`
export const logRoot = () => 'log/'

// --- flag/ families (§4) ---
export const flag = (family, ...comps) => `flag/${family}/` + comps.map(esc).join('/')
export const flagPrefix = (family, ...comps) =>
  `flag/${family}/` + comps.map(esc).join('/') + (comps.length ? '/' : '')
export const flagRejected = (w, seq) => `flag/rejected/${w}/${pad(seq)}`

// --- bookkeeping (§4) ---
export const seen = (w) => `seen/${w}`
export const seenPrefix = () => 'seen/'
export const rate = (w) => `rate/${w}`
// The global accepted-indexer-op counter of the §8 token buckets. Not in
// §4. '-' cannot appear in a hex writer key, so the row can never collide
// with `rate/<writerKey>`.
export const rateIndexerOps = () => 'rate/indexer-ops'
// The global apply ordinal that §4 needs for `c/<id>/path`.ord and
// `log/<ordinal>`. Not in §4. Like seen/, it is in the I2 view hash and
// excluded from materialize.
export const ordGlobal = () => 'ord/global'

// --- governance (§4, §8) ---
export const govWriter = (w) => `gov/writer/${w}`
export const govWriterPrefix = () => 'gov/writer/'
export const govRemoved = (w) => `gov/removed/${w}`
export const govPrefix = () => 'gov/'
