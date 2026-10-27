// Deterministic apply: folds the linearized op stream into the view
// (okf SPEC §5–§8, plus the apply-time link/wanted maintenance of §9).
// Pattern ancestor: vault-ld/core/lib/apply.js (patterns only, no code path
// shared — SPEC §0 copy-don't-depend).
//
// Transport contract (SPEC §1, verified against the installed source of
// autobee@2.12.1): `apply(nodes, view, host)` (README.md:74,
// lib/apply-view.js:17-19) receives linearized writer nodes shaped
// { key, value, length, optimistic, ... } (lib/writers.js:808-829); the
// view is hyperbee2-flavored (get / write() batches with
// tryPut+tryDelete+flush / createReadStream — see memview.js for the
// verified surface); host exposes addWriter(key, { isIndexer, weight })
// and removeWriter(key) (lib/apply-calls.js:33, :49 — note the default
// weight is `isIndexer ? 2 : 1`, which is why §8 mandates an explicit
// weight). Core calls only addWriter. host.ackWriter is a deprecated no-op
// (README.md:224-227, lib/apply-calls.js:44-47).
//
// This module is PURE over (linearized prefix, config): no wall clock, no
// randomness, no map-iteration-order dependence (every write goes through
// stableStringify; every scan is byte-ordered), no reads of peer-local
// replication state (I1). `at` is copied from op payloads verbatim and
// never compared or ordered on.
//
// Per-writer ordinal (SPEC §3, AD4): the actual seq of a node is its
// position in its writer's core, node.length - 1. The transport documents
// node.length as the "position in the writer's core" (autobee@2.12.1
// README, Apply). autobee sets it to the core length after the node
// (lib/writers.js:571-579 for a replicated node, :332 and :748 for a local
// one). The position is unforgeable, the same on every peer and stable
// under reorders. seen/<W> holds the last folded position plus one. A node
// that never reaches apply still takes a position: autobee passes only the
// nodes with a non-empty value to apply (index.js:1444). So the seqs of a
// writer's ops can have gaps.
import { createHash } from 'node:crypto'
import * as K from './keyspace.js'
import { nfc, canonicalArray, valuesEqual, stableStringify } from './canonical.js'
import { revHash } from './revhash.js'
import {
  decodeOp,
  normalizeOpStrings,
  normalizeClock,
  makeTag,
  parseTag,
  GOVERNANCE_OPS
} from './ops.js'
import { extractLinks, dirOf } from './links.js'

// §3 default limits, exported so boundary layers (faces ingest, ADR-005)
// can preflight against the same values apply defends with — never a
// duplicated constant.
export const DEFAULT_LIMITS = Object.freeze({
  maxOpBytes: 65536,
  maxPathBytes: 1024,
  maxPathDepth: 64
})

const DEFAULTS = {
  // §3 limits: fixed check order, single recorded reason.
  limits: DEFAULT_LIMITS,
  // §8: defaultCeiling is the admitted-writer ceiling when no
  // SetWriterPolicy has set one (spec-silent; pinned here and in vault
  // metadata by the store package). It is the only rate setting.
  rate: { defaultCeiling: 1024 }
}

// §5: reserved field keys — identity and revision are never fields, tag
// mutations travel only as AddTag/RemTag (checked post-NFC, exact).
const RESERVED_FIELD_KEYS = new Set(['tags', '_id', '_rev'])

const ADOPTED_ID_RE = /^[0-9a-f]{2,128}$/
// §7: the conflicted-copy component pattern is reserved on every extension
// length ("any terminal hex run of 8 or more").
const CONFLICT_SUFFIX_RE = /\.conflict-[0-9a-f]{8,}$/

function keyHex(key) {
  if (key instanceof Uint8Array) return Buffer.from(key.buffer, key.byteOffset, key.byteLength).toString('hex')
  return String(key)
}

function keyBuf(key) {
  if (key instanceof Uint8Array) return Buffer.from(key.buffer, key.byteOffset, key.byteLength)
  return Buffer.from(String(key), 'hex')
}

/**
 * §3 (AD4): the 0-based position of a node in its writer's core. The
 * transport sets node.length to the core length after the node, so a node
 * without a positive integer length breaks the transport contract. That
 * throws, also out of containThrow, and autobee closes on a throw from
 * apply (README, append; index.js:669-690). It is never an op rejection.
 */
function positionOf(node) {
  const len = node.length
  if (!Number.isSafeInteger(len) || len < 1) {
    throw new TypeError(`node.length must be a positive integer, got ${len}`)
  }
  return len - 1
}

function u64le(n) {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(BigInt(n))
  return b
}

function byteCompare(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

/** Informational timestamp (§3): never rejected, garbage → epoch 0. */
function atOf(op) {
  const v = op.at
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0
}

/**
 * Path normalization (§7): NFC, forward-slash, no `.md` suffix stored.
 * One trailing `.md` is stripped case-insensitively so a path authored
 * with the emitted-file suffix maps onto the same claim (resolution where
 * the spec is silent on apply-side `.md` handling; ingest strips too).
 */
export function normalizePath(p) {
  const s = nfc(String(p))
  return s.replace(/\.md$/i, '')
}

/**
 * Casefolded comparison form for reservation and collision checks (§7):
 * NFC + default casefolding (approximated by toLowerCase over the NFC
 * form, deterministic per ECMA-262 — locale-independent).
 */
export function casefoldPath(p) {
  return nfc(String(p)).toLowerCase()
}

/**
 * Path validation (§7). Returns null when valid, else the fixed rejection
 * reason: 'unsafe-path' (escapes the bundle root / absolute / empty or
 * dot segments) or 'reserved-path' (terminal component casefolding to
 * 'index'/'log' per OKF §3.1, or the conflicted-copy suffix pattern).
 */
export function validatePath(p) {
  if (p === '' || p.startsWith('/') || p.includes('\\') || /^[A-Za-z]:/.test(p)) {
    return 'unsafe-path'
  }
  const segs = p.split('/')
  for (const seg of segs) {
    if (seg === '' || seg === '.' || seg === '..') return 'unsafe-path'
  }
  const terminal = segs[segs.length - 1]
  const cf = casefoldPath(terminal)
  if (cf === 'index' || cf === 'log') return 'reserved-path'
  if (CONFLICT_SUFFIX_RE.test(terminal)) return 'reserved-path'
  return null
}

/** §8 namespace governance: path-segment prefix matching after NFC (empty
 * prefix list = unrestricted). Byte-prefix matching is forbidden. */
export function namespaceMatches(prefixes, path) {
  if (!Array.isArray(prefixes) || prefixes.length === 0) return true
  const s = nfc(String(path))
  for (const p0 of prefixes) {
    const p = nfc(String(p0))
    if (s === p || s.startsWith(p + '/')) return true
  }
  return false
}

/**
 * Vector-clock strict precedence (§8 revocation): c < r iff every entry of
 * c is ≤ r's entry AND the clocks differ (some r entry exceeds c's, or r
 * observes a writer c does not).
 */
export function strictlyPrecedes(c, r) {
  let strict = false
  for (const [k, v] of Object.entries(c)) {
    const rv = r[k]
    if (rv === undefined || v > rv) return false
    if (v < rv) strict = true
  }
  if (!strict) {
    for (const k of Object.keys(r)) {
      if (!(k in c)) return true
    }
    return false
  }
  return true
}

function arraysEq(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (!valuesEqual(a[i], b[i])) return false
  return true
}

function decodeValue(v) {
  if (v == null) return undefined
  const s = v instanceof Uint8Array ? Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('utf8') : String(v)
  return JSON.parse(s)
}

const DEL = Symbol('del')

/**
 * Read-your-writes overlay over the hyperbee2 view surface. apply buffers
 * every put/del here and flushes once per node through a view.write()
 * batch (tryPut/tryDelete/flush), so intra-node reads observe intra-node
 * writes without relying on unflushed-batch semantics of the store.
 * Values are serialized with stableStringify so map-iteration order never
 * reaches the view (I1).
 */
class Tx {
  constructor(view) {
    this.view = view
    this.o = new Map()
  }

  async val(key) {
    if (this.o.has(key)) {
      const v = this.o.get(key)
      return v === DEL ? undefined : JSON.parse(v)
    }
    const node = await this.view.get(key)
    if (!node) return undefined
    return decodeValue(node.value)
  }

  put(key, value) {
    this.o.set(key, stableStringify(value === undefined ? null : value))
  }

  del(key) {
    this.o.set(key, DEL)
  }

  /** Byte-ordered prefix scan merging the overlay with the view. */
  async scanAll(prefix) {
    const { gte, lt } = K.range(prefix)
    const merged = new Map()
    for await (const e of this.view.createReadStream({ gte, lt })) {
      const k = Buffer.isBuffer(e.key) ? e.key.toString('utf8') : String(e.key)
      merged.set(k, decodeValue(e.value))
    }
    for (const [k, v] of this.o) {
      if (!k.startsWith(prefix)) continue
      if (v === DEL) merged.delete(k)
      else merged.set(k, JSON.parse(v))
    }
    return [...merged.entries()]
      .sort((a, b) => byteCompare(a[0], b[0]))
      .map(([key, value]) => ({ key, value }))
  }

  async flush() {
    if (this.o.size === 0) return
    const b = this.view.write()
    for (const [k, v] of this.o) {
      if (v === DEL) b.tryDelete(k)
      else b.tryPut(k, v)
    }
    await b.flush()
    this.o.clear()
  }
}

/**
 * Create the deterministic apply function for a vault.
 * config: {
 *   genesisKey,   // Buffer|hex: the vault creator's key, first indexer (§8)
 *   limits: { maxOpBytes, maxPathBytes, maxPathDepth },      // §3
 *   rate:   { defaultCeiling }                               // §8
 * }
 */
export function createApply(config = {}) {
  const cfg = {
    ...config,
    limits: { ...DEFAULTS.limits, ...(config.limits || {}) },
    rate: { ...DEFAULTS.rate, ...(config.rate || {}) }
  }
  if (!cfg.genesisKey) throw new TypeError('config.genesisKey is required (§8 genesis)')
  cfg.genesisKey = keyHex(cfg.genesisKey)

  return async function apply(nodes, view, host) {
    for (const node of nodes) {
      const tx = new Tx(view)
      const a = new Applier(cfg, tx, host)
      try {
        await a.ensureGenesis()
        await a.applyNode(node)
        await tx.flush()
      } catch (err) {
        // §3 (I1/I10): apply MUST NOT throw — a single hand-crafted op must
        // never halt every peer's fold. The partial tx is discarded (its
        // buffered writes never reach the view), then a FRESH tx records a
        // deterministic per-op rejection (seen/ + ord/ + flag/rejected,
        // reason 'apply-error'). Same node, same throw point, same
        // containment on every peer, so the applied/rejected partition and
        // the I2 view hash stay replay-stable. This is the last-resort net;
        // the op handlers above reject cleanly (their own reasons) for every
        // input we have found reachable.
        const tx2 = new Tx(view)
        const a2 = new Applier(cfg, tx2, host)
        await a2.containThrow(node)
        await tx2.flush()
      }
    }
  }
}

class Applier {
  constructor(cfg, tx, host) {
    this.cfg = cfg
    this.tx = tx
    this.host = host
    this.events = [] // log/ narration accumulator for this node (§4, §9)
    this.at = 0
  }

  val(key) {
    return this.tx.val(key)
  }

  put(key, value) {
    this.tx.put(key, value)
  }

  delKey(key) {
    this.tx.del(key)
  }

  scanAll(prefix) {
    return this.tx.scanAll(prefix)
  }

  // ---------- genesis (§8) ----------
  async ensureGenesis() {
    const w = this.cfg.genesisKey
    if ((await this.val(K.govWriter(w))) === undefined && (await this.val(K.govRemoved(w))) === undefined) {
      this.put(K.govWriter(w), { indexer: true, namespacePrefixes: [], rateCeiling: null })
    }
  }

  // ---------- per-node pipeline (§3, §8) ----------
  async applyNode(node) {
    const W = keyHex(node.key)
    const raw = Buffer.isBuffer(node.value) ? node.value : Buffer.from(node.value || [])

    // Global apply position: incremented once per node, so every
    // path-claim ord and log/ key is unique and monotone in linearization
    // (§4 `ord`; see keyspace.js `ord/global`).
    this.pos = ((await this.val(K.ordGlobal())) ?? 0) + 1
    this.put(K.ordGlobal(), this.pos)

    // §3 (AD4): the node's actual seq is its position in its writer's
    // core. seen/<W> becomes the last position plus one, for EVERY node
    // regardless of disposition.
    const seq = positionOf(node)
    this.put(K.seen(W), seq + 1)

    // §3 fixed-order checks; the FIRST violated records the single reason.
    if (raw.length > this.cfg.limits.maxOpBytes) return this.reject(W, seq, 'oversize-op')
    const dec = decodeOp(raw)
    if (!dec.ok) return this.reject(W, seq, dec.reason) // unknown-msgid | undecodable
    const op = normalizeOpStrings(dec.op)
    const type = dec.type
    this.at = atOf(op)

    // §8 (AD7): every AddWriter op that core folds grants its key at the
    // substrate, whether core accepts or rejects the op below. The grant
    // comes right after the decode and before every check that can reject
    // the op, because those checks read the op's linearized position, and
    // a reorder can flip their outcome (G9b). The grant reads the op bytes
    // alone, so it is the same on every peer in every order, and a reorder
    // can never undo it. okf membership still comes only from gov/.
    if (type === 'add-writer') await this.grant(op.key)

    // §3 post-decode limits, fixed order: path bytes, then depth.
    if (typeof op.path === 'string') {
      if (Buffer.byteLength(op.path, 'utf8') > this.cfg.limits.maxPathBytes) {
        return this.reject(W, seq, 'oversize-path')
      }
      if (op.path.split('/').length > this.cfg.limits.maxPathDepth) {
        return this.reject(W, seq, 'depth-exceeded')
      }
    }

    // §8: every op carries its writer's observed clock; the claimed
    // self-entry must equal the actual seq, the node's unforgeable
    // position (§3). A clock carries self and the writers with a
    // gov/writer record in its issuer's view (§8, T12). No rule here needs
    // an entry for any other writer.
    const clock = normalizeClock(op.clock)
    if (!clock || (clock[W] ?? -1) !== seq) return this.reject(W, seq, 'forged-clock')

    // §8 causal revocation, never positional. The strict-precedence test
    // compares every entry. A writer that the op's clock cites and the
    // revocation clock omits fails it, so two views that disagree on an
    // admission can reject an op in the window, never admit one.
    const removed = await this.val(K.govRemoved(W))
    if (removed !== undefined) {
      if (seq > removed.seqAtRemoval) return this.reject(W, seq, 'revoked')
      if (!strictlyPrecedes(clock, removed.clock)) return this.reject(W, seq, 'revoked')
    }

    const writerRec = await this.val(K.govWriter(W))

    if (GOVERNANCE_OPS.has(type)) {
      // §8: governance requires an indexer issuer at the op's linearized
      // position. The AddWriter grant above does not depend on it, and
      // host.removeWriter is never called.
      if (!writerRec || writerRec.indexer !== true) {
        return this.reject(W, seq, 'policy-governance')
      }
      if (!(await this.takeToken(W, writerRec))) return this.reject(W, seq, 'policy-rate')
      const res = await this.applyGovernance(type, op, W, seq)
      if (res && res.rejected) return this.reject(W, seq, res.reason)
      await this.accepted(W)
      return this.writeLog(this.pos)
    }

    // §8: a writer's ops take effect only once an indexer's AddWriter has
    // admitted it. A content op from a key with no gov/writer record is
    // rejected here. It never reaches the content pipeline, and it takes no
    // rate token. The governance branch above runs first, so a governance
    // op from such a key keeps the reason 'policy-governance'.
    if (!writerRec) return this.reject(W, seq, 'not-a-writer')

    if (!(await this.takeToken(W, writerRec))) return this.reject(W, seq, 'policy-rate')
    const res = await this.contentPipeline(type, op, W, seq, writerRec)
    if (res && res.rejected) return this.reject(W, seq, res.reason)
    await this.accepted(W)
    return this.writeLog(this.pos)
  }

  /**
   * §8 (AD7): the substrate grant of an AddWriter op. The weight is an
   * explicit 0, so autobee's `isIndexer ? 2 : 1` default never applies
   * (lib/apply-calls.js:33), and isIndexer is not passed: it only selects
   * that default. Only a 32-byte key is granted. autobee copies the key
   * into a fixed 34-byte system key (lib/encoding.js:64-69), so a shorter
   * key would leave uninitialized bytes there, and a longer one throws.
   * The check reads the op bytes alone, so it is the same on every peer.
   */
  async grant(key) {
    if (!this.host || !this.host.addWriter) return
    if (!(key instanceof Uint8Array) || key.byteLength !== 32) return
    await this.host.addWriter(keyBuf(key), { weight: 0 })
  }

  async reject(W, seq, reason) {
    // §3: rejections land in flag/rejected/<writerKey>/<seq>, never throw,
    // and never mutate c/ (I10).
    this.put(K.flagRejected(W, seq), { reason })
  }

  /**
   * §3 last-resort containment: an op whose handling threw is reduced to a
   * deterministic rejection. Re-derives the per-node ord from the
   * (unmutated, because the throwing tx was discarded) view so ordinals stay
   * monotone and identical on every peer, takes the seq from the node's
   * position (AD4), then records flag/rejected. Pure over the linearized
   * prefix — no clock, no randomness (I1).
   */
  async containThrow(node) {
    const W = keyHex(node.key)
    const pos = ((await this.val(K.ordGlobal())) ?? 0) + 1
    this.put(K.ordGlobal(), pos)
    const seq = positionOf(node)
    this.put(K.seen(W), seq + 1)
    this.put(K.flagRejected(W, seq), { reason: 'apply-error' })
  }

  async accepted(W) {
    // §8: every writer's bucket gains 1 token per accepted op authored by
    // any (live) indexer — tracked as a global counter, folded into each
    // bucket lazily by takeToken.
    const rec = await this.val(K.govWriter(W))
    if (rec && rec.indexer === true && (await this.val(K.govRemoved(W))) === undefined) {
      const n = (await this.val(K.rateIndexerOps())) ?? 0
      this.put(K.rateIndexerOps(), n + 1)
    }
  }

  writeLog(nodePos) {
    if (this.events.length === 0) return
    this.put(K.log(nodePos), { at: this.at, events: this.events })
    this.events = []
  }

  // ---------- token bucket (§8) ----------
  capacityFor(writerRec) {
    if (Number.isInteger(writerRec.rateCeiling)) return writerRec.rateCeiling
    return this.cfg.rate.defaultCeiling
  }

  async takeToken(W, writerRec) {
    const cap = this.capacityFor(writerRec)
    const indexerOps = (await this.val(K.rateIndexerOps())) ?? 0
    // §8: buckets start full: at admission (opAddWriter writes the
    // record), and for the genesis indexer at its first op.
    const rec = (await this.val(K.rate(W))) ?? { tokens: cap, seenIndexerOps: indexerOps }
    const delta = indexerOps - (rec.seenIndexerOps ?? 0)
    rec.tokens = Math.min(cap, (rec.tokens ?? cap) + delta)
    rec.seenIndexerOps = indexerOps
    if (rec.tokens <= 0) {
      this.put(K.rate(W), rec)
      return false
    }
    rec.tokens -= 1
    this.put(K.rate(W), rec)
    return true
  }

  // ---------- governance ops (§8) ----------
  async applyGovernance(type, op, W, seq) {
    switch (type) {
      case 'add-writer':
        return this.opAddWriter(op)
      case 'remove-writer':
        return this.opRemoveWriter(op)
      case 'set-writer-policy':
        return this.opSetWriterPolicy(op)
    }
  }

  async opAddWriter(op) {
    const target = keyHex(op.key)
    const existing = await this.val(K.govWriter(target))
    const rec = {
      indexer: op.indexer === true,
      namespacePrefixes: existing ? existing.namespacePrefixes : [],
      rateCeiling: existing ? existing.rateCeiling : null
    }
    this.put(K.govWriter(target), rec)
    // Re-admission clears a prior revocation record so the writer's new
    // ops pass the §8 clock rule (resolution where the spec is silent;
    // vault-ld ancestry).
    if ((await this.val(K.govRemoved(target))) !== undefined) {
      this.delKey(K.govRemoved(target))
    }
    // The substrate grant already happened in applyNode (AD7), before any
    // check that can reject this op.
    // §8: bucket starts full at admission.
    const indexerOps = (await this.val(K.rateIndexerOps())) ?? 0
    this.put(K.rate(target), { tokens: this.capacityFor(rec), seenIndexerOps: indexerOps })
    return null
  }

  async opRemoveWriter(op) {
    const target = keyHex(op.key)
    const targetRec = await this.val(K.govWriter(target))
    const alreadyRemoved = (await this.val(K.govRemoved(target))) !== undefined
    if (targetRec && targetRec.indexer === true && !alreadyRemoved) {
      // §8: a RemoveWriter that would leave zero indexers is rejected — a
      // vault can never become permanently ungovernable.
      let others = 0
      for (const { key, value } of await this.scanAll(K.govWriterPrefix())) {
        const k = K.parseKey(key)[2]
        if (k === target || value.indexer !== true) continue
        if ((await this.val(K.govRemoved(k))) === undefined) others++
      }
      if (others === 0) return { rejected: true, reason: 'policy-governance' }
    }
    const clock = normalizeClock(op.clock) ?? {}
    // §8: seqAtRemoval = the revocation clock's entry for the removed
    // writer, the last position of it that the remover had folded (§3);
    // absent entry → -1, so every target seq is post-revocation. The entry
    // is absent when the remover folded none of the target's ops, or when
    // the target had no gov/writer record in the remover's view (§8, T12).
    // In the second case -1 rejects the same ops as the last folded
    // position: each op of the target that the remover folded is a causal
    // ancestor of this node and sorts before it, and each op of the target
    // that sorts after it has a higher position.
    this.put(K.govRemoved(target), { clock, seqAtRemoval: clock[target] ?? -1 })
    // §8 "causal, in-band, never positional": host.removeWriter is
    // deliberately NOT called — every node must keep linearizing on every
    // peer so the clock rule runs uniformly (vault-ld B1 ancestry).
    return null
  }

  async opSetWriterPolicy(op) {
    const target = keyHex(op.key)
    const existing = await this.val(K.govWriter(target))
    // Policy on a non-writer would confirm an unadmitted key; reject
    // (resolution where the spec is silent; vault-ld ancestry).
    if (!existing) return { rejected: true, reason: 'policy-governance' }
    this.put(K.govWriter(target), {
      indexer: existing.indexer,
      namespacePrefixes: (op.namespacePrefixes || []).map(nfc),
      rateCeiling: op.rateCeiling
    })
    return null
  }

  // ---------- content ops (§5–§7) ----------
  async contentPipeline(type, op, W, seq, writerRec) {
    switch (type) {
      case 'create-concept':
        return this.opCreateConcept(op, W, seq, writerRec)
      case 'set-field':
        return this.opSetField(op, W, seq, writerRec)
      case 'add-tag':
        return this.opAddTag(op, W, seq, writerRec)
      case 'rem-tag':
        return this.opRemTag(op, W, seq, writerRec)
      case 'set-body':
        return this.opSetBody(op, W, seq, writerRec)
      case 'set-path':
        return this.opSetPath(op, W, seq, writerRec)
      case 'delete-concept':
        return this.opDeleteConcept(op, W, seq, writerRec)
      case 'undelete-concept':
        return this.opUndeleteConcept(op, W, seq, writerRec)
      case 'resolve-conflict':
        return this.opResolveConflict(op, W, seq, writerRec)
      default:
        return { rejected: true, reason: 'unknown-msgid' }
    }
  }

  /**
   * §6 policy anchor: mutation ops are policy-checked against the
   * concept's CURRENT path, never an op-claimed path. Returns a rejection
   * or null, plus the concept meta via out-param convention.
   */
  async requireConcept(op, writerRec) {
    const meta = await this.val(K.cMeta(op.id))
    if (meta === undefined) {
      // Mutating an id the vault has never seen: rejected (reason is a
      // resolution where the spec is silent — only CreateConcept creates).
      return { rejected: true, reason: 'unknown-id' }
    }
    const pathRec = await this.val(K.cPath(op.id))
    if (!namespaceMatches(writerRec.namespacePrefixes, pathRec ? pathRec.path : '')) {
      return { rejected: true, reason: 'policy-namespace' }
    }
    return { meta, pathRec }
  }

  /** §8: a write landing on a tombstoned concept flags, never blocks (I4). */
  writeAfterDelete(meta, id, tag) {
    if (meta.deleted != null) {
      this.put(K.flag('writeafterdelete', id, tag), { deletedBy: meta.deleted })
    }
  }

  async opCreateConcept(op, W, seq, writerRec) {
    const tag = makeTag(W, seq)
    // Fixed intra-op check order (pinned here; §3 pins only the limits):
    // empty-type → path validity → namespace policy → id rules.
    const type = op.type
    if (typeof type !== 'string' || type === '') {
      // §5: an empty `type` state must be unreachable through accepted ops.
      return { rejected: true, reason: 'empty-type' }
    }
    const path = normalizePath(op.path)
    const bad = validatePath(path)
    if (bad) return { rejected: true, reason: bad }
    // Creation has no current path yet; its claimed path becomes current
    // at this position, so policy checks it (§6).
    if (!namespaceMatches(writerRec.namespacePrefixes, path)) {
      return { rejected: true, reason: 'policy-namespace' }
    }

    let id
    if (op.id == null) {
      // §6 mint: the creating op's tag — or the squat-proof fallback.
      id = tag
      if ((await this.val(K.cMeta(id))) !== undefined) {
        const squatted = id
        const keyRaw = Buffer.from(W, 'hex')
        for (let k = 1n; ; k++) {
          const h = createHash('sha256')
          h.update(keyRaw)
          h.update(u64le(seq))
          h.update(u64le(k))
          const cand = h.digest('hex')
          if ((await this.val(K.cMeta(cand))) === undefined) {
            id = cand
            break
          }
        }
        // §6 N1: creation by a genuine writer always succeeds; the squat is
        // a permanent audit record.
        this.put(K.flag('squat', squatted, tag), { minted: id })
      }
    } else {
      // §6 adopt.
      id = op.id
      if (!ADOPTED_ID_RE.test(id)) return { rejected: true, reason: 'bad-id' }
      if ((await this.val(K.cMeta(id))) !== undefined) {
        // §6 seen-id rule: creation never updates.
        return { rejected: true, reason: 'duplicate-id' }
      }
      const risk = await this.mintCollisionRisk(id)
      if (risk) return { rejected: true, reason: 'mint-collision-risk' }
    }

    this.put(K.cMeta(id), { type, created: tag })
    // §5: CreateConcept.type seeds the c/<id>/f/type register at the
    // create's linearized position.
    this.put(K.cField(id, 'type'), { values: [type], tag, writer: W })
    this.put(K.cPath(id), { path, tag, ord: this.pos })
    await this.enterClaim(id, path)
    this.events.push({ kind: 'create', id, path })
    return null
  }

  /**
   * §6: mint ids are `writerKey || seq` (both public, hence predictable),
   * so adopting an id shaped like a current/former/seen writer's future
   * mint — or exactly equal to a 64-hex writer key — is rejected. seen/<W>
   * is W's last folded position plus one (§3), so every future op of W, and
   * so every future mint, has a seq at or above it.
   */
  async mintCollisionRisk(id) {
    if (id.length === 64) return this.writerKnown(id)
    if (id.length < 64) return false
    const prefix = id.slice(0, 64)
    if (!(await this.writerKnown(prefix))) return false
    const suffix = id.slice(64)
    // Mint-shaped = minimal lowercase hex (no leading zeros); a
    // non-minimal suffix can never be produced by a mint.
    if (!/^(0|[1-9a-f][0-9a-f]*)$/.test(suffix)) return false
    const seqVal = BigInt('0x' + suffix)
    const nextPosition = BigInt((await this.val(K.seen(prefix))) ?? 0)
    return seqVal >= nextPosition
  }

  async writerKnown(k) {
    if ((await this.val(K.govWriter(k))) !== undefined) return true
    if ((await this.val(K.govRemoved(k))) !== undefined) return true
    if ((await this.val(K.seen(k))) !== undefined) return true
    return false
  }

  async opSetField(op, W, seq, writerRec) {
    const r = await this.requireConcept(op, writerRec)
    if (r.rejected) return r
    const tag = makeTag(W, seq)
    const key = op.key
    if (RESERVED_FIELD_KEYS.has(key)) {
      // §5 (M4): tags mutate only via AddTag/RemTag; _id/_rev are never fields.
      return { rejected: true, reason: 'reserved-key' }
    }
    // §5: SetField.value is wire type `json` (arbitrary JSON). Canonicalizing
    // a typed literal with a bad lexical (e.g. { value: 'abc', datatype:
    // 'xsd:integer' }) throws inside canonicalArray — contain it as a clean
    // rejection so a crafted value can never halt apply (§3; I1/I10).
    let values
    try {
      values = canonicalArray(op.value)
    } catch {
      return { rejected: true, reason: 'bad-value' }
    }
    if (key === 'type' && (values.length === 0 || (values.length === 1 && values[0] === ''))) {
      // §5 (N4): an empty type state is unreachable through accepted ops.
      return { rejected: true, reason: 'empty-type' }
    }
    this.writeAfterDelete(r.meta, op.id, tag)
    const rec = await this.val(K.cField(op.id, key))
    if (rec && rec.writer !== W && !arraysEq(rec.values, values)) {
      // §5 / I4: a cross-writer supersession with a different value is
      // auditable, never silent.
      this.put(K.flag('clobber', op.id, key, tag), {
        superseded: { writer: rec.writer, tag: rec.tag, values: rec.values },
        by: tag
      })
    }
    // LWW-array register under linearization (§5): empty array = empty
    // state (key omitted at materialize), the register row remains.
    this.put(K.cField(op.id, key), { values, tag, writer: W })
    return null
  }

  async opAddTag(op, W, seq, writerRec) {
    const r = await this.requireConcept(op, writerRec)
    if (r.rejected) return r
    const tag = makeTag(W, seq)
    this.writeAfterDelete(r.meta, op.id, tag)
    const rec = (await this.val(K.cField(op.id, 'tags'))) ?? { els: {}, removed: {} }
    rec.els[tag] = op.value
    this.put(K.cField(op.id, 'tags'), rec)
    return null
  }

  async opRemTag(op, W, seq, writerRec) {
    const r = await this.requireConcept(op, writerRec)
    if (r.rejected) return r
    const tag = makeTag(W, seq)
    const value = op.value
    this.writeAfterDelete(r.meta, op.id, tag)
    const rec = (await this.val(K.cField(op.id, 'tags'))) ?? { els: {}, removed: {} }
    rec.removed = rec.removed || {}
    for (const t of op.tags || []) {
      if (Object.prototype.hasOwnProperty.call(rec.els, t) && rec.els[t] === value) {
        // §5 SU-Set: remove exactly the cited observed tokens.
        delete rec.els[t]
        const set = rec.removed[value] || []
        if (!set.includes(t)) {
          set.push(t)
          set.sort()
        }
        rec.removed[value] = set
      } else if ((rec.removed[value] || []).includes(t)) {
        // §5: citing an already-removed token is a silent no-op (benign
        // concurrent removes never flag).
      } else {
        // §5: a never-observed citation is ignored for effect, audited once.
        this.put(K.flag('staletag', op.id, value, t), { by: tag })
      }
    }
    this.put(K.cField(op.id, 'tags'), rec)
    return null
  }

  async opSetBody(op, W, seq, writerRec) {
    const r = await this.requireConcept(op, writerRec)
    if (r.rejected) return r
    const tag = makeTag(W, seq)
    let base = op.base == null ? null : String(op.base).toLowerCase()
    if (base !== null && !/^[0-9a-f]{64}$/.test(base)) {
      // A base that is not even hash-shaped can never key a revision;
      // rejected (resolution where §5 is silent — well-formed unknown
      // hashes follow the fabricated-ancestry rule below).
      return { rejected: true, reason: 'bad-base' }
    }
    this.writeAfterDelete(r.meta, op.id, tag)
    const head = await this.val(K.cBody(op.id))
    // §5 base discipline: null base while a head exists cites that head —
    // the only flag-free fresh start is the concept's first revision.
    if (base === null && head !== undefined) base = head
    const baseKnown = base === null || (await this.val(K.cRev(op.id, base))) !== undefined
    const text = nfc(op.text)
    const rh = revHash(base, text)
    if ((await this.val(K.cRev(op.id, rh))) === undefined) {
      // `at` in the rev record is the op's informational timestamp (§4).
      this.put(K.cRev(op.id, rh), { base, text, writer: W, at: this.at })
      if (base !== null) this.put(K.revByBase(op.id, base, rh), true)
    }
    if (!baseKnown) {
      // §5 (M5): fabricated ancestry is stored, flagged against the head
      // position, and never becomes head until ResolveConflict selects it.
      this.put(K.flag('conflict', op.id, head === undefined ? '-' : head, rh), { base })
      return null
    }
    if (base !== null) {
      // §5: same-non-null-base siblings — both retained, exactly one flag
      // per pair, found via revbybase/ in O(matches) (M1 ancestry).
      for (const { key } of await this.scanAll(K.revByBasePrefix(op.id, base))) {
        const sib = K.parseKey(key)[3]
        if (sib === rh) continue
        const [a, b] = [sib, rh].sort()
        this.put(K.flag('conflict', op.id, a, b), { base })
      }
    }
    if (head !== rh) {
      this.put(K.cBody(op.id), rh) // head pointer is LWW under linearization
      await this.recomputeOutbound(op.id)
    }
    return null
  }

  async opResolveConflict(op, W, seq, writerRec) {
    const r = await this.requireConcept(op, writerRec)
    if (r.rejected) return r
    const tag = makeTag(W, seq)
    const keep = String(op.keep).toLowerCase()
    if ((await this.val(K.cRev(op.id, keep))) === undefined) {
      return { rejected: true, reason: 'bad-resolve' }
    }
    const cited = new Set([keep])
    for (const s0 of op.supersede || []) {
      const s = String(s0).toLowerCase()
      if ((await this.val(K.cRev(op.id, s))) === undefined) {
        return { rejected: true, reason: 'bad-resolve' }
      }
      cited.add(s)
    }
    // §5: valid only while at least one cited flag is open — replayed or
    // racing resolves reject; the first valid resolve wins by
    // linearization.
    const openCited = []
    for (const { key } of await this.scanAll(K.flagPrefix('conflict', op.id))) {
      const segs = K.parseKey(key)
      const a = segs[3]
      const b = segs[4]
      if ((a === '-' || cited.has(a)) && cited.has(b)) openCited.push(key)
    }
    if (openCited.length === 0) return { rejected: true, reason: 'bad-resolve' }

    this.writeAfterDelete(r.meta, op.id, tag)
    let newHead = keep
    if (op.text != null) {
      // §5: apply synthesizes one revision with base = keep.
      const text = nfc(op.text)
      const rh = revHash(keep, text)
      if ((await this.val(K.cRev(op.id, rh))) === undefined) {
        this.put(K.cRev(op.id, rh), { base: keep, text, writer: W, at: this.at })
        this.put(K.revByBase(op.id, keep, rh), true)
      }
      // The synthesized revision is an ordinary §5 revision: a concurrent
      // edit already citing `keep` is a true sibling of it and flags.
      for (const { key } of await this.scanAll(K.revByBasePrefix(op.id, keep))) {
        const sib = K.parseKey(key)[3]
        if (sib === rh) continue
        const [a, b] = [sib, rh].sort()
        this.put(K.flag('conflict', op.id, a, b), { base: keep })
      }
      newHead = rh
    }
    const prevHead = await this.val(K.cBody(op.id))
    this.put(K.cBody(op.id), newHead)
    for (const key of openCited) this.delKey(key)
    this.events.push({ kind: 'resolve', id: op.id, keep: newHead })
    if (prevHead !== newHead) await this.recomputeOutbound(op.id)
    return null
  }

  async opSetPath(op, W, seq, writerRec) {
    const r = await this.requireConcept(op, writerRec)
    if (r.rejected) return r
    const tag = makeTag(W, seq)
    const path = normalizePath(op.path)
    const bad = validatePath(path)
    if (bad) return { rejected: true, reason: bad }
    this.writeAfterDelete(r.meta, op.id, tag)
    const cur = r.pathRec
    if (cur && cur.path !== path) {
      let curWriter = null
      try {
        curWriter = parseTag(cur.tag).writer
      } catch {}
      if (curWriter !== W) {
        // §7: rename + concurrent rename → linearization winner, loser
        // recorded (the <tag> component keeps this key unique even against
        // a frontmatter field literally named 'path').
        this.put(K.flag('clobber', op.id, 'path', tag), {
          superseded: { tag: cur.tag, path: cur.path },
          by: tag
        })
      }
    }
    const live = r.meta.deleted == null
    this.put(K.cPath(op.id), { path, tag, ord: this.pos })
    if (live) {
      if (cur) await this.dropClaim(op.id, cur.path)
      await this.enterClaim(op.id, path)
      if (cur && cur.path !== path) {
        this.events.push({ kind: 'rename', id: op.id, from: cur.path, to: path })
      }
      // §9: a SetPath re-runs resolution of the concept's own
      // relative-form edges.
      await this.recomputeOutbound(op.id)
    }
    return null
  }

  async opDeleteConcept(op, W, seq, writerRec) {
    const r = await this.requireConcept(op, writerRec)
    if (r.rejected) return r
    const tag = makeTag(W, seq)
    const meta = r.meta
    if (meta.deleted != null) return null // already tombstoned: idempotent
    meta.deleted = tag
    this.put(K.cMeta(op.id), meta)
    // §8: the concept disappears from path/ (and materialize); bytes and
    // _id remain.
    if (r.pathRec) await this.dropClaim(op.id, r.pathRec.path)
    await this.recomputeOutbound(op.id)
    this.events.push({ kind: 'delete', id: op.id })
    return null
  }

  async opUndeleteConcept(op, W, seq, writerRec) {
    const r = await this.requireConcept(op, writerRec)
    if (r.rejected) return r
    const tag = makeTag(W, seq)
    // §8: permanent audit record.
    this.put(K.flag('undelete', op.id, tag), {})
    const meta = r.meta
    if (meta.deleted == null) return null
    delete meta.deleted
    this.put(K.cMeta(op.id), meta)
    if (r.pathRec) {
      // The restored claim re-enters at THIS position (fresh ord): a
      // concept that vacated by deletion cannot evict an interim holder
      // (§7 first-wins; resolution where the spec is silent on undelete
      // ordinal semantics).
      this.put(K.cPath(op.id), { path: r.pathRec.path, tag: r.pathRec.tag, ord: this.pos })
      await this.enterClaim(op.id, r.pathRec.path)
    }
    await this.recomputeOutbound(op.id)
    this.events.push({ kind: 'undelete', id: op.id })
    return null
  }

  // ---------- path claims and collisions (§7) ----------
  async dropClaim(id, oldPath) {
    this.delKey(K.pcl(casefoldPath(oldPath), id))
    this.delKey(K.flag('pathcollision', oldPath, id))
    await this.recomputeGroup(casefoldPath(oldPath), [oldPath])
  }

  async enterClaim(id, path) {
    this.put(K.pcl(casefoldPath(path), id), { path, ord: this.pos })
    await this.recomputeGroup(casefoldPath(path), [path])
  }

  /**
   * §7 collision recompute for one casefold group: for every exact path,
   * the live claim with the lowest ord holds path/<p> (first-wins — a
   * squatter cannot evict); across the whole casefold group, every claim
   * but the group winner carries flag/pathcollision/<its path>/<id>,
   * cleared here the moment its claim ceases to collide.
   */
  async recomputeGroup(cf, touchedExactPaths = []) {
    const claims = []
    for (const { key, value } of await this.scanAll(K.pclPrefix(cf))) {
      claims.push({ id: K.parseKey(key)[2], path: value.path, ord: value.ord })
    }
    const byPath = new Map()
    for (const c of claims) {
      if (!byPath.has(c.path)) byPath.set(c.path, [])
      byPath.get(c.path).push(c)
    }
    const exactPaths = new Set([...byPath.keys(), ...touchedExactPaths])
    for (const p of [...exactPaths].sort((a, b) => byteCompare(a, b))) {
      const cs = byPath.get(p) || []
      let winner = null
      for (const c of cs) if (winner === null || c.ord < winner.ord) winner = c
      await this.setExactHolder(p, winner ? winner.id : null)
    }
    if (claims.length > 0) {
      let gw = claims[0]
      for (const c of claims) if (c.ord < gw.ord) gw = c
      for (const c of claims) {
        const flagKey = K.flag('pathcollision', c.path, c.id)
        if (c.id === gw.id) {
          this.delKey(flagKey)
        } else {
          const existed = (await this.val(flagKey)) !== undefined
          this.put(flagKey, { against: gw.id })
          if (!existed) {
            this.events.push({ kind: 'pathcollision', id: c.id, path: c.path, against: gw.id })
          }
        }
      }
    }
  }

  /**
   * Maintain path/<p> plus the §9 late-binding link resolution: edges into
   * a vacated path demote from bl/ back to wanted/; edges into a newly
   * occupied path promote (I8 is the definition).
   */
  async setExactHolder(p, newId) {
    const cur = await this.val(K.path(p))
    const next = newId === null ? undefined : newId
    if (cur === next) return
    if (cur !== undefined) {
      for (const { key } of await this.scanAll(K.blPrefix(cur))) {
        const from = K.parseKey(key)[2]
        if ((await this.val(K.link(from, p))) !== undefined) {
          this.delKey(key)
          await this.addWanted(p, from)
        }
      }
    }
    if (next !== undefined) {
      this.put(K.path(p), next)
      const ws = await this.scanAll(K.wantedPrefix(p))
      for (const { key } of ws) {
        const from = K.parseKey(key)[2]
        this.delKey(key)
        this.put(K.bl(next, from), true)
      }
      if (ws.length > 0) this.updateRank(p, ws.length, 0)
    } else {
      this.delKey(K.path(p))
    }
  }

  // ---------- link graph maintenance (§9 apply-time, I8) ----------
  /**
   * Recompute one concept's outbound edges from its current head text and
   * path: link/ rows, bl/ for resolved targets, wanted/ (+ rank) for
   * unresolved ones. A dead or pathless or bodyless concept has no edges.
   */
  async recomputeOutbound(id) {
    const meta = await this.val(K.cMeta(id))
    const live = meta !== undefined && meta.deleted == null
    let targets = new Set()
    if (live) {
      const headHash = await this.val(K.cBody(id))
      const pathRec = await this.val(K.cPath(id))
      if (headHash !== undefined && pathRec) {
        const rev = await this.val(K.cRev(id, headHash))
        if (rev) targets = extractLinks(rev.text, dirOf(pathRec.path))
      }
    }
    const old = new Map()
    for (const { key } of await this.scanAll(K.linkPrefix(id))) {
      old.set(K.parseKey(key)[2], key)
    }
    for (const [t, key] of old) {
      if (targets.has(t)) continue
      this.delKey(key)
      const holder = await this.val(K.path(t))
      if (holder !== undefined && (await this.val(K.bl(holder, id))) !== undefined) {
        this.delKey(K.bl(holder, id))
      } else {
        await this.removeWanted(t, id)
      }
    }
    for (const t of [...targets].sort((a, b) => byteCompare(a, b))) {
      if (old.has(t)) continue
      this.put(K.link(id, t), true)
      const holder = await this.val(K.path(t))
      if (holder !== undefined) {
        this.put(K.bl(holder, id), true)
      } else {
        // §9: an unresolved target goes to wanted/ — the ranked demand
        // index — and NEVER to flag/ (I4: demand is not loss).
        await this.addWanted(t, id)
      }
    }
  }

  async wantedCount(p) {
    return (await this.scanAll(K.wantedPrefix(p))).length
  }

  async addWanted(p, from) {
    if ((await this.val(K.wanted(p, from))) !== undefined) return
    const before = await this.wantedCount(p)
    this.put(K.wanted(p, from), true)
    this.updateRank(p, before, before + 1)
  }

  async removeWanted(p, from) {
    if ((await this.val(K.wanted(p, from))) === undefined) return
    const before = await this.wantedCount(p)
    this.delKey(K.wanted(p, from))
    this.updateRank(p, before, before - 1)
  }

  /** §4: wantedrank/ is rewritten on referrer-count change. */
  updateRank(p, oldCount, newCount) {
    if (oldCount > 0) this.delKey(K.wantedRank(oldCount, p))
    if (newCount > 0) this.put(K.wantedRank(newCount, p), newCount)
  }
}
