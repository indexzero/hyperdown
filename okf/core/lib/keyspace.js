// Copied from vault-ld/core/lib/keyspace.js at 046d37f; diverges freely —
// see okf/SPEC.md §0 copy-don't-depend. The escaping helpers (esc/unesc/
// pad/parseKey/range) are verbatim; the key families are rewritten for the
// auto-okf view keyspace (okf SPEC §4), which differs from vault-ld's.
//
// View keyspace codec (okf SPEC §4). Escaping is mandatory: naive string
// concatenation of user-controlled strings into keys is forbidden. Every
// user-controlled component ('%' and '/' escaped) round-trips losslessly,
// so a path named '../escape' or a field key named 'a/b' can never collide
// with, or escape into, another key family. Callers pass NFC-normalized
// strings (§3); this module does not normalize.
//
// Implementation resolutions where §4 is silent (code-comment scope per
// SPEC §0 rule 4):
// - `ord/global` holds the global apply ordinal (count of nodes linearized
//   so far) that §4 requires for `c/<id>/path`.ord and `log/<ordinal>`.
//   Bookkeeping like seen/: deterministic, in the I2 view hash, excluded
//   from materialize.
// - `pcl/<casefold(path)>/<id>` is the live path-claim index that lets
//   apply run the §7 casefold-collision recompute without a full scan of
//   c/. Like revbybase/ it is trivially co-derived from c/ (I8):
//   one row per live concept, keyed by the casefolded NFC form of its
//   current path.
// - `rate/indexer-ops` is the global accepted-indexer-op counter backing
//   the §8 token buckets; '-' cannot appear in a hex writer key, so the
//   row can never collide with `rate/<writerKey>`.

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

/** Fixed-width ordinal so ascending key order == numeric order. */
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

// --- c/ per-concept families (§4). Concept ids are lowercase hex (§6) and
// never need escaping, but are escaped anyway (defense in depth).
export const cMeta = (id) => `c/${esc(id)}/meta`
export const cField = (id, key) => `c/${esc(id)}/f/${esc(key)}`
export const cFieldPrefix = (id) => `c/${esc(id)}/f/`
export const cPath = (id) => `c/${esc(id)}/path`
export const cBody = (id) => `c/${esc(id)}/body`
export const cRev = (id, rev) => `c/${esc(id)}/rev/${esc(rev)}`
export const cRevPrefix = (id) => `c/${esc(id)}/rev/`
export const cPrefix = (id) => `c/${esc(id)}/`
export const cRoot = () => 'c/'

// --- base-keyed revision index (§4, M1 ancestry): one row per revision
// citing a non-null base, so same-base siblings are found in O(matches).
export const revByBase = (id, base, rev) => `revbybase/${esc(id)}/${esc(base)}/${esc(rev)}`
export const revByBasePrefix = (id, base) => `revbybase/${esc(id)}/${esc(base)}/`

// --- path/ current-holder index and the pcl/ claim index (§4, §7) ---
export const path = (p) => `path/${esc(p)}`
export const pathPrefix = () => 'path/'
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

// wantedrank/<inv-count>/<path>: inv-count = (MAX - count) as a 16-digit
// zero-padded decimal, MAX = 10^16 - 1, so an ascending scan yields
// most-wanted first (§4).
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
export const rateIndexerOps = () => 'rate/indexer-ops'
export const ordGlobal = () => 'ord/global'

// --- governance (§4, §8) ---
export const govWriter = (w) => `gov/writer/${w}`
export const govWriterPrefix = () => 'gov/writer/'
export const govRemoved = (w) => `gov/removed/${w}`
export const govPrefix = () => 'gov/'
