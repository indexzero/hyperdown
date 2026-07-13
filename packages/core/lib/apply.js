// Deterministic apply: folds the linearized op stream into the view
// (SPEC-FINAL §5–§8, plus the apply-time parts of §9.2/§9.4/§10.1/§10.3).
//
// Autobase contract (verified against https://github.com/holepunchto/autobase
// README, "Views" and "apply" sections): `apply(nodes, view, host)` receives
// linearized writer nodes; each node has `value`, `from` (writer info with
// `.key`) and `length`. "it is important that ... the `view` argument is the
// only data structure being update[d] and that its fully deterministic. If
// any external data structures are used, these updates will not be correctly
// undone." Accordingly this module is pure over (linearized prefix, config):
// no wall clock, no randomness, no reads of peer-local replication state
// such as signedLength or heads() (§8.3, I1).
//
// The autobase README documents no per-writer sequence/index on the apply
// node (only `value`, `from`, `length` are described), so per §8.2/§8.4
// option (b) we maintain the per-writer seen-count `seen/<W>` — incremented
// for every node from W regardless of disposition — as the single ordinal
// source for n/hold/, flag/rejected/, and flag/optimistic/. Recorded in
// DEVIATIONS.md.
//
// POLICY-EPOCH CAVEAT (§5.7): merge policy is read from ctx/ at apply time,
// so a reorg that moves a DefineTerm relative to dependent field ops can
// change the merged result. This is still deterministic — any two nodes with
// the same linearized log produce identical views — but is semantically
// surprising; writers can pin the kind they resolved against with `ctxKind`.
import * as K from './keyspace.js'
import {
  nfc,
  nfcByteLength,
  canonicalValue,
  canonicalArray,
  byteForm,
  valuesEqual,
  valueDepth,
  sortValues
} from './canonical.js'
import { revHash, rawHashHex } from './revhash.js'
import {
  decodeOp,
  normalizeOpStrings,
  normalizeClock,
  makeTag,
  tagHex,
  parseTag,
  opToJson,
  opFromJson,
  GOVERNANCE_OPS
} from './ops.js'

const DEFAULTS = {
  rootBase: 'vault://data/',
  // §5.6: default allowlist is exactly the three keys named in vault-ld §4.3.
  hostAllowlist: ['tags', 'aliases', 'cssclasses'],
  rate: { tokensPerIndexerOp: 1, capacity: 1024, holdMax: 64 },
  limits: { maxSubjectBytes: 1024, maxOpBytes: 65536, maxDepth: 64 }
}

// §10.1 recognized schema meta-types (priority (2) of the layer rule).
const META_TYPES = new Set([
  'owl:Ontology',
  'owl:Class',
  'owl:ObjectProperty',
  'owl:DatatypeProperty',
  'rdfs:Class',
  'rdf:Property',
  'skos:ConceptScheme',
  'skos:Concept'
])

// §6: audit flags manually clearable via ClearFlag; every other family is
// structural and rejects with reason 'flag-not-clearable'.
const CLEARABLE_FLAGS = new Set([
  'clobber',
  'staletag',
  'epoch',
  'govoverride',
  'danglingretarget',
  'undelete',
  'writeafterdelete',
  'kindcollapse',
  'linkambiguous',
  'unsafepath',
  'noscope'
])

// flag families whose first component is a subject (for the §8.6 namespace
// check applied to ClearFlag ops).
const SUBJECT_FIRST_FLAGS = new Set([
  'clobber',
  'staletag',
  'epoch',
  'kindmismatch',
  'kindcollapse',
  'undelete',
  'writeafterdelete',
  'linkambiguous',
  'unsafepath',
  'noscope',
  'danglingretarget',
  'conflict',
  'unmapped'
])

function keyHex(key) {
  return Buffer.isBuffer(key) ? key.toString('hex') : String(key)
}

function keyBuf(key) {
  return Buffer.isBuffer(key) ? key : Buffer.from(key, 'hex')
}

/** vault-ld §4.5: percent-encoding applied after NFC normalization (§3.1). */
function encodeName(s) {
  return encodeURIComponent(nfc(s))
}

function isRef(v) {
  return v !== null && typeof v === 'object' && typeof v.ref === 'string'
}

/** Path safety (§9.4, apply side): lexical containment only, pure. */
export function isSafePath(path) {
  const p = nfc(String(path))
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false
  if (/^[A-Za-z]:/.test(p)) return false
  const segs = p.split('/')
  for (const seg of segs) {
    if (seg === '' || seg === '..') return false
  }
  return true
}

/** §8.6 prefix matching on path segments after NFC; byte-prefix forbidden. */
export function namespaceMatches(prefixes, subject) {
  if (!Array.isArray(prefixes) || prefixes.length === 0) return true // empty => unrestricted
  const s = nfc(subject)
  for (const p0 of prefixes) {
    const p = nfc(p0)
    if (s === p || s.startsWith(p + '/')) return true
  }
  return false
}

/** Canonical JSON-LD term-definition normalization for §5.5 structural equality. */
export function normalizeTermDef(def) {
  if (def === null || def === undefined) return null
  if (typeof def === 'string') return { '@id': def }
  if (typeof def === 'object' && !Array.isArray(def)) {
    if ('@id' in def && def['@id'] === null) return null // JSON-LD null mapping removes the term
    const out = {}
    for (const k of Object.keys(def).sort()) out[k] = def[k]
    return out
  }
  return { '@value': def }
}

function structEq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

function termKindOf(norm) {
  if (norm === null) return 'unmapped'
  const id = norm['@id']
  if (id === '@type') return 'type-alias'
  if (id === '@id') return 'id-alias'
  if (norm['@container'] === '@set') return 'set'
  return 'lww'
}

/**
 * Create the deterministic apply function for a vault.
 * config: {
 *   genesisKey,            // Buffer|hex: initial indexer (§8.0 genesis)
 *   rootBase,              // data-namespace @base (vault metadata constant)
 *   hostAllowlist,         // §5.6, pinned in vault metadata
 *   rate: { tokensPerIndexerOp: R, capacity: C, holdMax: H_max },  // §8.5/§8.2
 *   limits: { maxSubjectBytes, maxOpBytes, maxDepth }              // §8.4
 * }
 */
export function createApply(config = {}) {
  const cfg = {
    ...DEFAULTS,
    ...config,
    rate: { ...DEFAULTS.rate, ...(config.rate || {}) },
    limits: { ...DEFAULTS.limits, ...(config.limits || {}) }
  }
  if (!cfg.genesisKey) throw new TypeError('config.genesisKey is required (§8.0 genesis)')
  cfg.genesisKey = keyHex(cfg.genesisKey)
  cfg.hostAllowlist = cfg.hostAllowlist.map(nfc)

  return async function apply(nodes, view, host) {
    const a = new Applier(cfg, view, host)
    await a.ensureGenesis()
    for (const node of nodes) {
      await a.applyNode(node)
    }
  }
}

class Applier {
  constructor(cfg, view, host) {
    this.cfg = cfg
    this.view = view
    this.host = host
  }

  // ---------- small view helpers ----------
  async val(key) {
    const node = await this.view.get(key)
    return node ? node.value : undefined
  }

  async *scan(prefix) {
    for await (const entry of this.view.createReadStream(K.range(prefix))) yield entry
  }

  async scanAll(prefix) {
    const out = []
    for await (const e of this.scan(prefix)) out.push(e)
    return out
  }

  // ---------- genesis (§8.0) ----------
  async ensureGenesis() {
    const w = this.cfg.genesisKey
    if ((await this.val(K.govWriter(w))) === undefined) {
      await this.view.put(K.govWriter(w), {
        indexer: true,
        namespacePrefixes: [],
        rateCeiling: null
      })
    }
  }

  // ---------- per-node pipeline (§8) ----------
  async applyNode(node) {
    const W = keyHex(node.from.key)
    const raw = Buffer.isBuffer(node.value) ? node.value : Buffer.from(node.value || [])

    // global linearized position (bookkeeping for §5.5 or-set collapse order)
    this.gpos = ((await this.val(K.gpos())) || 0) + 1
    await this.view.put(K.gpos(), this.gpos)

    // per-writer seen-count ordinal (§8.2 option (b)): incremented for EVERY
    // node from W — applied, held, or rejected — outside ctx/ so rejected ops
    // never mutate ctx/ (I10).
    const ord = ((await this.val(K.seen(W))) || 0) + 1
    await this.view.put(K.seen(W), ord)

    // §8.4 fixed-order limit checks; the FIRST violated determines the reason.
    if (raw.length > this.cfg.limits.maxOpBytes) {
      return this.reject(W, ord, raw, 'oversize-op')
    }
    const dec = decodeOp(raw)
    if (!dec.ok) return this.reject(W, ord, raw, dec.reason) // unknown-msgid | undecodable
    const op = normalizeOpStrings(dec.op)
    const type = dec.type
    if (valueDepth(op) > this.cfg.limits.maxDepth) {
      return this.reject(W, ord, raw, 'depth-exceeded')
    }
    if (typeof op.s === 'string' && nfcByteLength(op.s) > this.cfg.limits.maxSubjectBytes) {
      return this.reject(W, ord, raw, 'oversize-subject')
    }

    // §8.3 causal revocation, judged solely from op-embedded clocks.
    const removed = await this.val(K.govRemoved(W))
    if (removed !== undefined) {
      const clock = normalizeClock(op.clock)
      if (!clock || !this.clockDominatedBy(clock, removed)) {
        return this.reject(W, ord, raw, 'revoked')
      }
    }

    const writerRec = await this.val(K.govWriter(W))

    if (GOVERNANCE_OPS.has(type)) {
      // §8.0 issuing-writer authority check at the op's linearized position.
      if (!writerRec || writerRec.indexer !== true) {
        return this.reject(W, ord, raw, 'policy-governance')
      }
      if (!(await this.takeToken(W, writerRec))) {
        return this.reject(W, ord, raw, 'policy-rate')
      }
      const res = await this.applyGovernance(type, op, W, ord)
      if (res && res.rejected) return this.reject(W, ord, raw, res.reason)
      return this.accepted(W, ord)
    }

    if (!writerRec) {
      // §8.2 optimistic hold path: never mutate n/ (other than n/hold/),
      // ctx/, or idx/ for an unconfirmed writer. Rate check at hold time.
      if (!(await this.takeToken(W, null))) {
        return this.reject(W, ord, raw, 'policy-rate')
      }
      const rrec = (await this.val(K.rate(W))) || {}
      const held = rrec.held || 0
      if (held >= this.cfg.rate.holdMax) {
        return this.reject(W, ord, raw, 'policy-rate') // H_max cap (§8.2)
      }
      await this.view.put(K.nHold(W, ord), {
        type,
        op: opToJson(op),
        raw: raw.toString('hex'),
        ord
      })
      await this.view.put(K.flagOptimistic(W, ord), { type })
      rrec.held = held + 1
      await this.view.put(K.rate(W), rrec)
      return
    }

    if (!(await this.takeToken(W, writerRec))) {
      return this.reject(W, ord, raw, 'policy-rate')
    }

    const res = await this.contentPipeline(type, op, W, ord, writerRec)
    if (res && res.rejected) return this.reject(W, ord, raw, res.reason)
    return this.accepted(W, ord)
  }

  async contentPipeline(type, op, W, ord, writerRec) {
    // §8.6 namespace governance (path-segment prefix matching).
    const nsSubject = this.subjectForNamespace(type, op)
    if (nsSubject !== null && !namespaceMatches(writerRec.namespacePrefixes, nsSubject)) {
      return { rejected: true, reason: 'policy-namespace' }
    }
    return this.applyContent(type, op, W, ord)
  }

  subjectForNamespace(type, op) {
    if (typeof op.s === 'string') return op.s
    if (type === 'clear-flag' && typeof op.flagKey === 'string') {
      const segs = K.parseKey(op.flagKey)
      if (segs[0] === 'flag' && SUBJECT_FIRST_FLAGS.has(segs[1]) && segs.length > 2) {
        return segs[2]
      }
    }
    return null
  }

  async accepted(W, ord) {
    // ctx/gov/clock/<W>: per-writer max-seq vector of applied ops (§8.3).
    const cur = (await this.val(K.govClock(W))) || 0
    if (ord > cur) await this.view.put(K.govClock(W), ord)
    // §8.5: token buckets replenish on accepted ops from indexer writers.
    const rec = await this.val(K.govWriter(W))
    if (rec && rec.indexer === true) {
      const n = (await this.val(K.rateIndexerOps())) || 0
      await this.view.put(K.rateIndexerOps(), n + 1)
    }
  }

  async reject(W, ord, raw, reason) {
    // Writer/seq-keyed, requires no successful decode (§8.4). Never mutates
    // n/ (other than bookkeeping), ctx/, or idx/ (I10).
    await this.view.put(K.flagRejected(W, ord), { reason, rawHashHex: rawHashHex(raw) })
  }

  /** §8.3: op accepted after revocation iff its clock ≤ the recorded clock. */
  clockDominatedBy(clock, removedClock) {
    const entries = Object.entries(clock)
    if (entries.length === 0) return false // empty clock == missing (§8.3, DEVIATIONS.md)
    for (const [w, seq] of entries) {
      const bound = removedClock[w]
      if (bound === undefined || seq > bound) return false
    }
    return true
  }

  // ---------- rate token bucket (§8.5) ----------
  capacityFor(writerRec) {
    const c = this.cfg.rate.capacity
    if (writerRec && Number.isInteger(writerRec.rateCeiling)) {
      return Math.min(c, writerRec.rateCeiling) // policy may only tighten (§8.5)
    }
    return c
  }

  async takeToken(W, writerRec) {
    const cap = this.capacityFor(writerRec)
    const indexerOps = (await this.val(K.rateIndexerOps())) || 0
    const rec = (await this.val(K.rate(W))) || { tokens: cap, seenIndexerOps: indexerOps }
    const delta = indexerOps - (rec.seenIndexerOps || 0)
    rec.tokens = Math.min(cap, (rec.tokens ?? cap) + delta * this.cfg.rate.tokensPerIndexerOp)
    rec.seenIndexerOps = indexerOps
    if (rec.tokens <= 0) {
      await this.view.put(K.rate(W), rec)
      return false
    }
    rec.tokens -= 1
    await this.view.put(K.rate(W), rec)
    return true
  }

  // ---------- governance ops (§8.0–§8.6) ----------
  async applyGovernance(type, op, W, ord) {
    switch (type) {
      case 'add-writer':
        return this.opAddWriter(op)
      case 'remove-writer':
        return this.opRemoveWriter(op)
      case 'set-writer-policy':
        return this.opSetWriterPolicy(op, W, ord)
      case 'prune-revisions':
        return this.opPruneRevisions(op)
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
    await this.view.put(K.govWriter(target), rec)
    // Re-admission clears a prior revocation record (DEVIATIONS.md).
    if ((await this.val(K.govRemoved(target))) !== undefined) {
      await this.view.del(K.govRemoved(target))
    }
    // host.addWriter only ever invoked for governance ops that passed §8.0.
    // https://github.com/holepunchto/autobase README: await host.addWriter(key, { indexer })
    if (this.host && this.host.addWriter) {
      await this.host.addWriter(keyBuf(op.key), { indexer: rec.indexer })
    }
    await this.foldHeld(target)
    return null
  }

  async opRemoveWriter(op) {
    const target = keyHex(op.key)
    const clock = normalizeClock(op.clock) || {}
    const confirmed = (await this.val(K.govWriter(target))) !== undefined
    // §8.3: record the RemoveWriter node's own observed clock.
    await this.view.put(K.govRemoved(target), clock)
    if (!confirmed) {
      // §8.2: a revoked, never-acked writer's speculative ops never take effect.
      for (const { key } of await this.scanAll(K.nHoldPrefix(target))) {
        await this.view.del(key)
      }
      for (const { key } of await this.scanAll(`flag/optimistic/${target}/`)) {
        await this.view.del(key)
      }
      const rrec = await this.val(K.rate(target))
      if (rrec) {
        rrec.held = 0
        await this.view.put(K.rate(target), rrec)
      }
    }
    // https://github.com/holepunchto/autobase README: host.removeWriter throws
    // if the writer cannot be removed (last indexer); host.removeable guards.
    if (this.host && this.host.removeWriter) {
      if (!this.host.removeable || this.host.removeable(keyBuf(op.key))) {
        await this.host.removeWriter(keyBuf(op.key))
      }
    }
    return null
  }

  async opSetWriterPolicy(op, W, ord) {
    const target = keyHex(op.key)
    const existing = await this.val(K.govWriter(target))
    // Policy on a non-writer would confirm an unadmitted key; reject
    // (resolution recorded in DEVIATIONS.md).
    if (!existing) return { rejected: true, reason: 'policy-governance' }
    if (existing.policySet) {
      await this.view.put(K.flag('govoverride', target), {
        prev: { namespacePrefixes: existing.namespacePrefixes, rateCeiling: existing.rateCeiling },
        by: makeTag(W, ord).toString('hex')
      })
    }
    await this.view.put(K.govWriter(target), {
      indexer: existing.indexer, // §8.6: preserves the record's indexer bit
      namespacePrefixes: (op.namespacePrefixes || []).map(nfc),
      // §8.5: an explicit policy may only tighten below the default.
      rateCeiling: Math.min(this.cfg.rate.capacity, op.rateCeiling),
      policySet: true
    })
    return null
  }

  async opPruneRevisions(op) {
    const s = op.s
    const head = await this.val(K.nBody(s))
    const protectedRevs = new Set([head, op.before])
    // revisions referenced by an open flag/conflict are not prunable (§11).
    for (const { key } of await this.scanAll(K.flagPrefix('conflict', s))) {
      const segs = K.parseKey(key)
      protectedRevs.add(segs[3])
      protectedRevs.add(segs[4])
    }
    // walk the ancestor chain of `before`
    let cur = (await this.val(K.nRev(s, op.before)))?.base || null
    while (cur) {
      const rec = await this.val(K.nRev(s, cur))
      if (rec === undefined) break
      const parent = rec.base || null
      if (!protectedRevs.has(cur)) await this.view.del(K.nRev(s, cur))
      cur = parent
    }
    return null
  }

  // §8.2: fold the hold buffer at the ack's linearized position, ascending seq.
  async foldHeld(W) {
    const writerRec = await this.val(K.govWriter(W))
    for (const { key, value } of await this.scanAll(K.nHoldPrefix(W))) {
      const op = normalizeOpStrings(opFromJson(value.op))
      const res = await this.contentPipeline(value.type, op, W, value.ord, writerRec)
      if (res && res.rejected) {
        await this.reject(W, value.ord, Buffer.from(value.raw, 'hex'), res.reason)
      } else {
        await this.accepted(W, value.ord)
      }
      await this.view.del(key)
      await this.view.del(K.flagOptimistic(W, value.ord))
    }
    const rrec = await this.val(K.rate(W))
    if (rrec) {
      rrec.held = 0
      await this.view.put(K.rate(W), rrec)
    }
  }

  // ---------- content ops ----------
  async applyContent(type, op, W, ord) {
    switch (type) {
      case 'set-field':
        return this.opSetField(op, W, ord)
      case 'add-member':
        return this.opAddMember(op, W, ord)
      case 'rem-member':
        return this.opRemMember(op, W, ord)
      case 'unset-field':
        return this.opUnsetField(op, W, ord)
      case 'set-body':
        return this.opSetBody(op, W, ord)
      case 'set-path':
        return this.opSetPath(op, W, ord)
      case 'delete-subject':
        return this.opDeleteSubject(op, W, ord)
      case 'resolve-conflict':
        return this.opResolveConflict(op, W, ord)
      case 'clear-flag':
        return this.opClearFlag(op)
      case 'define-term':
        return this.opDefineTerm(op, W, ord)
      case 'define-scope':
        return this.opDefineScope(op, W, ord)
      default:
        return { rejected: true, reason: 'unknown-msgid' }
    }
  }

  opTag(op, W, ord) {
    return op.tag ? tagHex(op.tag) : makeTag(W, ord).toString('hex')
  }

  /**
   * Resolve a term's kind at this linearized position (§5.1, §5.8 keywords
   * first, §5.6 host allowlist).
   */
  async resolveTerm(p) {
    if (p === '@type') return { kind: 'type' }
    if (p === '@id') return { kind: 'id' }
    const t = await this.val(K.ctxTerm(p))
    if (t) {
      if (t.kind === 'type-alias') return { kind: 'type' }
      if (t.kind === 'id-alias') return { kind: 'id' }
      return { kind: t.kind, def: t.def, scope: t.scope }
    }
    if (this.cfg.hostAllowlist.includes(p)) return { kind: 'host' }
    return { kind: 'unmapped' }
  }

  /** §5.7 kind pinning: returns { applyKind, epoch } */
  pinKind(resolvedKind, ctxKind) {
    if (ctxKind !== 'scalar' && ctxKind !== 'set') return { applyKind: resolvedKind, epoch: false }
    const cited = ctxKind === 'scalar' ? 'lww' : 'set'
    if (cited === resolvedKind) return { applyKind: resolvedKind, epoch: false }
    return { applyKind: cited, epoch: true }
  }

  async epochFlag(s, p, tag, citedKind, resolvedKind) {
    await this.view.put(K.flag('epoch', s, p, tag), {
      citedKind,
      applyKind: resolvedKind
    })
  }

  async kindMismatch(s, p, tag, detail) {
    // §5.2 "reject": leaves flag/kindmismatch, never mutates n/, ctx/, idx/.
    await this.view.put(K.flag('kindmismatch', s, p, tag), detail || {})
    return null
  }

  async opSetField(op, W, ord) {
    const { s, p } = op
    const tag = this.opTag(op, W, ord)
    const route = await this.resolveTerm(p)

    if (route.kind === 'id') return this.writeId(op, W, ord, tag)
    if (route.kind === 'type') return this.kindMismatch(s, p, tag, { op: 'set-field', kind: 'or-set' })
    if (route.kind === 'host') {
      await this.touchSubject(s, tag, op.clock)
      await this.view.put(K.nHost(s, p), { value: canonicalValue2(op.o), tag })
      await this.view.put(K.hostIdx(p, s), true)
      return null
    }

    const { applyKind, epoch } = this.pinKind(route.kind, op.ctxKind)
    if (epoch) await this.epochFlag(s, p, tag, op.ctxKind, route.kind)

    if (applyKind === 'set') {
      return this.kindMismatch(s, p, tag, { op: 'set-field', kind: 'or-set' })
    }

    await this.touchSubject(s, tag, op.clock)
    if (applyKind === 'unmapped') {
      await this.accumulateUnmapped(s, p, Array.isArray(op.o) ? op.o : [op.o], tag)
      return null
    }

    // lww register write (§5.1): value is a canonical array (possibly len 1).
    const values = canonicalArray(op.o)
    await this.setFieldRecord(s, p, async (rec) => {
      if (rec.reg && rec.reg.writer !== W && !arraysEq(rec.reg.values, values)) {
        // §5.4: cross-writer LWW supersession is surfaced, not silent.
        await this.view.put(K.flag('clobber', s, p, tag), {
          superseded: { writer: rec.reg.writer, tag: rec.reg.tag, values: rec.reg.values },
          by: tag
        })
      }
      rec.reg = { values, tag, writer: W }
    })
    return null
  }

  async opAddMember(op, W, ord) {
    const { s, p } = op
    const tag = this.opTag(op, W, ord)
    const route = await this.resolveTerm(p)

    if (route.kind === 'id') return this.kindMismatch(s, p, tag, { op: 'add-member', kind: 'lww' })
    if (route.kind === 'type') {
      await this.touchSubject(s, tag, op.clock)
      await this.setFieldRecord(s, '@type', (rec) => {
        rec.els = rec.els || {}
        rec.els[tag] = { v: canonicalValue2(op.o), pos: this.gpos }
      })
      await this.recomputeLayerBase(s)
      return null
    }
    if (route.kind === 'host') {
      // Host keys have no tag semantics; accumulate dedup (DEVIATIONS.md).
      await this.touchSubject(s, tag, op.clock)
      const cur = (await this.val(K.nHost(s, p))) || { value: [], tag }
      const list = Array.isArray(cur.value) ? cur.value : [cur.value]
      const merged = canonicalArray([...list, op.o])
      await this.view.put(K.nHost(s, p), { value: merged, tag })
      await this.view.put(K.hostIdx(p, s), true)
      return null
    }

    const { applyKind, epoch } = this.pinKind(route.kind, op.ctxKind)
    if (epoch) await this.epochFlag(s, p, tag, op.ctxKind, route.kind)

    if (applyKind === 'lww') {
      return this.kindMismatch(s, p, tag, { op: 'add-member', kind: 'lww' })
    }
    await this.touchSubject(s, tag, op.clock)
    if (applyKind === 'unmapped') {
      await this.accumulateUnmapped(s, p, [op.o], tag)
      return null
    }
    // OR-set add (§5.1): concurrent adds union under distinct tags.
    await this.setFieldRecord(s, p, (rec) => {
      rec.els = rec.els || {}
      rec.els[tag] = { v: canonicalValue2(op.o), pos: this.gpos }
    })
    return null
  }

  async opRemMember(op, W, ord) {
    const { s, p } = op
    const synth = makeTag(W, ord).toString('hex')
    const cited = (op.tags || []).map(tagHex)
    const route = await this.resolveTerm(p)

    if (route.kind === 'id') return this.kindMismatch(s, p, synth, { op: 'rem-member', kind: 'lww' })
    if (route.kind === 'host') return null // host keys: no tag semantics (DEVIATIONS.md)

    const isType = route.kind === 'type'
    let applyKind = isType ? 'set' : route.kind
    if (!isType) {
      const pin = this.pinKind(route.kind, op.ctxKind)
      if (pin.epoch) await this.epochFlag(s, p, synth, op.ctxKind, route.kind)
      applyKind = pin.applyKind
    }

    if (applyKind === 'lww') {
      return this.kindMismatch(s, p, synth, { op: 'rem-member', kind: 'lww' })
    }
    if (applyKind === 'unmapped') {
      // §5.2: no-op + flag/unmapped
      await this.view.put(K.flag('unmapped', s, p), { op: 'rem-member' })
      return null
    }

    const field = isType ? '@type' : p
    await this.setFieldRecord(s, field, async (rec) => {
      // §5.3 citation contract: remove exactly the cited tags that are
      // present; absent cited tags are ignored for effect but audited once.
      for (const t of cited) {
        if (rec.els && Object.prototype.hasOwnProperty.call(rec.els, t)) {
          delete rec.els[t]
        } else {
          await this.view.put(K.flag('staletag', s, field, t), { by: synth })
        }
      }
      if (rec.els && Object.keys(rec.els).length === 0) delete rec.els
    })
    if (isType) await this.recomputeLayerBase(s)
    return null
  }

  async opUnsetField(op, W, ord) {
    const { s, p } = op
    const tag = this.opTag(op, W, ord)
    const route = await this.resolveTerm(p)

    if (route.kind === 'id') {
      const cur = await this.val(K.nId(s))
      if (cur && cur.writer !== W) {
        await this.view.put(K.flag('clobber', s, '@id', tag), {
          superseded: { writer: cur.writer, tag: cur.tag, values: [cur.iri] },
          by: tag
        })
      }
      if (cur) {
        await this.view.del(K.nId(s))
        await this.recomputeLayerBase(s)
      }
      return null
    }
    if (route.kind === 'type') return this.kindMismatch(s, p, tag, { op: 'unset-field', kind: 'or-set' })
    if (route.kind === 'host') {
      await this.view.del(K.nHost(s, p))
      await this.view.del(K.hostIdx(p, s))
      return null
    }

    const { applyKind, epoch } = this.pinKind(route.kind, op.ctxKind)
    if (epoch) await this.epochFlag(s, p, tag, op.ctxKind, route.kind)

    if (applyKind === 'set') {
      return this.kindMismatch(s, p, tag, { op: 'unset-field', kind: 'or-set' })
    }
    if (applyKind === 'unmapped') {
      // removal is the defining resolution for the unmapped state (§6, §5.2;
      // resolution recorded in DEVIATIONS.md)
      await this.setFieldRecord(s, p, (rec) => {
        delete rec.un
      })
      return null
    }
    // lww: clear the register / remove field state (§5.2, §9.2).
    await this.setFieldRecord(s, p, async (rec) => {
      if (rec.reg && rec.reg.writer !== W) {
        await this.view.put(K.flag('clobber', s, p, tag), {
          superseded: { writer: rec.reg.writer, tag: rec.reg.tag, values: rec.reg.values },
          by: tag
        })
      }
      delete rec.reg
    })
    return null
  }

  async writeId(op, W, ord, tag) {
    const s = op.s
    const iri = typeof op.o === 'string' ? nfc(op.o) : null
    // vault-ld §4.5: explicit id MUST be a full absolute IRI, used verbatim.
    if (!iri || !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(iri)) {
      return { rejected: true, reason: 'bad-id' }
    }
    const cur = await this.val(K.nId(s))
    if (cur && cur.writer !== W && cur.iri !== iri) {
      await this.view.put(K.flag('clobber', s, '@id', tag), {
        superseded: { writer: cur.writer, tag: cur.tag, values: [cur.iri] },
        by: tag
      })
    }
    // The declared IRI must be in place BEFORE subject creation so the §7
    // takeover check sees the declared (different) IRI, not the default mint.
    await this.view.put(K.nId(s), { iri, tag, writer: W })
    await this.touchSubject(s, tag, op.clock)
    await this.recomputeLayerBase(s)
    return null
  }

  async opSetBody(op, W, ord) {
    const s = op.s
    const base = op.base ? String(op.base).toLowerCase() : null
    if (base !== null) {
      if (!/^[0-9a-f]{64}$/.test(base)) return { rejected: true, reason: 'garbage-base' }
      if ((await this.val(K.nRev(s, base))) === undefined) {
        return { rejected: true, reason: 'garbage-base' }
      }
    }
    const tag = makeTag(W, ord).toString('hex')
    await this.touchSubject(s, tag, op.clock)
    const text = nfc(op.text)
    const rh = revHash(base, text)
    const existed = (await this.val(K.nRev(s, rh))) !== undefined
    if (!existed) {
      // `at` is the writer's per-writer ordinal — deterministic, never wall
      // clock (I1). §4 names the field but does not define its source.
      await this.view.put(K.nRev(s, rh), { base, text, writer: W, at: ord })
    }
    const head = await this.val(K.nBody(s))

    // §6: two revisions citing the same base are true concurrency.
    const conflictPairs = new Set()
    for (const { key, value } of await this.scanAll(K.nRevPrefix(s))) {
      const revId = K.parseKey(key)[3]
      if (revId === rh) continue
      if ((value.base || null) === base) {
        const [a, b] = [revId, rh].sort()
        await this.view.put(K.flag('conflict', s, a, b), { base })
        conflictPairs.add(a + '/' + b)
      }
    }

    if (head !== undefined && head !== rh) {
      const headRev = await this.val(K.nRev(s, head))
      const [a, b] = [head, rh].sort()
      const pairConflicted =
        conflictPairs.has(a + '/' + b) ||
        (await this.val(K.flag('conflict', s, a, b))) !== undefined
      // §5.4 applied to the body head pointer: cross-writer supersession
      // without a shared-base conflict is clobber-flagged. Building on the
      // current head (base === head) is clean succession, not supersession.
      if (headRev && headRev.writer !== W && base !== head && !pairConflicted) {
        await this.view.put(K.flag('clobber', s, 'body', tag), {
          superseded: { writer: headRev.writer, rev: head },
          by: tag
        })
      }
    }
    await this.view.put(K.nBody(s), rh) // head pointer is LWW under linearization
    return null
  }

  async opResolveConflict(op, W, ord) {
    const s = op.s
    const keep = String(op.keep).toLowerCase()
    if ((await this.val(K.nRev(s, keep))) === undefined) {
      return { rejected: true, reason: 'garbage-base' }
    }
    let head = keep
    if (op.text != null) {
      const text = nfc(op.text)
      head = revHash(keep, text)
      if ((await this.val(K.nRev(s, head))) === undefined) {
        await this.view.put(K.nRev(s, head), { base: keep, text, writer: W, at: ord })
      }
    }
    await this.view.put(K.nBody(s), head)
    // clear every flag/conflict/<s>/<a>/<b> with {a,b} ⊆ {keep} ∪ supersede (§6)
    const setK = new Set([keep, ...(op.supersede || []).map((x) => String(x).toLowerCase())])
    for (const { key } of await this.scanAll(K.flagPrefix('conflict', s))) {
      const segs = K.parseKey(key)
      if (setK.has(segs[3]) && setK.has(segs[4])) await this.view.del(key)
    }
    return null
  }

  async opClearFlag(op) {
    const flagKey = op.flagKey
    const segs = K.parseKey(String(flagKey))
    if (segs[0] !== 'flag' || !CLEARABLE_FLAGS.has(segs[1])) {
      // §6: structural flags are cleared only by their defining resolution.
      return { rejected: true, reason: 'flag-not-clearable' }
    }
    await this.view.del(String(flagKey))
    return null
  }

  async opSetPath(op, W, ord) {
    const s = op.s
    if (!isSafePath(op.path)) {
      // §9.4: apply rejects a SetPath whose value escapes root.
      return { rejected: true, reason: 'unsafe-path' }
    }
    const tag = this.opTag(op, W, ord)
    await this.touchSubject(s, tag, op.clock)
    const cur = await this.val(K.nPath(s))
    if (cur && cur.writer !== W && cur.path !== nfc(op.path)) {
      await this.view.put(K.flag('clobber', s, 'path', tag), {
        superseded: { writer: cur.writer, tag: cur.tag, values: [cur.path] },
        by: tag
      })
    }
    await this.view.put(K.nPath(s), {
      path: nfc(op.path),
      scope: op.scope != null ? nfc(op.scope) : null,
      tag,
      writer: W
    })
    await this.recomputeLayerBase(s)
    return null
  }

  async opDeleteSubject(op, W, ord) {
    const s = op.s
    const tag = this.opTag(op, W, ord)
    await this.view.put(K.nDeleted(s), { tag })
    // §9.2: tombstone suppresses the subject from idx/* and bl/* while
    // retaining field state and body revisions until pruned.
    for (const { key } of await this.scanAll(K.nFieldPrefix(s))) {
      const p = K.parseKey(key)[3]
      await this.setFieldRecord(s, p, () => {})
    }
    return null
  }

  // ---------- define-term / define-scope (§5.5, §10.1, §10.3) ----------
  async opDefineTerm(op, W, ord) {
    const { scope, term } = op
    const norm = normalizeTermDef(op.def)
    if (norm && norm['@container'] !== undefined && norm['@container'] !== '@set') {
      return { rejected: true, reason: 'unsupported-container' } // §5.1: @list is a non-goal
    }
    const existing = await this.val(K.ctxTerm(term))
    const newKind = termKindOf(norm)

    if (existing && structEq(existing.def, norm)) {
      // identical redeclarations are idempotent and MUST NOT flag (§5.5)
      await this.view.put(K.ctxDef(scope, term), norm)
      return null
    }
    if (existing) {
      // §5.5: flag only on *differing* redefinitions
      await this.view.put(K.flag('shadow', scope, term), {
        prevScope: existing.scope,
        by: makeTag(W, ord).toString('hex')
      })
    }
    await this.view.put(K.ctxDef(scope, term), norm)
    if (norm === null) {
      await this.view.del(K.ctxTerm(term))
    } else {
      await this.view.put(K.ctxTerm(term), { def: norm, scope, kind: newKind })
    }

    const prevKind = existing
      ? existing.kind
      : this.cfg.hostAllowlist.includes(term)
        ? 'host'
        : 'unmapped'
    if (prevKind !== newKind) {
      await this.migrateTermKind(term, prevKind, newKind, W, ord)
    }
    return null
  }

  /** §5.5 kind-change migration + §10.3 backfill + §5.6 host promotion. */
  async migrateTermKind(term, prevKind, newKind, W, ord) {
    const synth = makeTag(W, ord).toString('hex')
    if (newKind === 'type-alias' || newKind === 'id-alias' || prevKind === 'type-alias' || prevKind === 'id-alias') {
      return // alias transitions carry no field-state migration (DEVIATIONS.md)
    }

    if (prevKind === 'host' && (newKind === 'lww' || newKind === 'set')) {
      // §5.6 promotion: migrate every n/<s>/host/<term> into n/<s>/f/<term>.
      for (const { key } of await this.scanAll(K.hostIdxPrefix(term))) {
        const s = K.parseKey(key)[2]
        const hostRec = await this.val(K.nHost(s, term))
        if (hostRec === undefined) continue
        const values = canonicalArray(hostRec.value)
        await this.setFieldRecord(s, term, (rec) => {
          if (newKind === 'lww') {
            rec.reg = { values, tag: synth, writer: W }
          } else {
            rec.els = rec.els || {}
            values.forEach((v, i) => {
              rec.els[synth + '-' + i] = { v, pos: this.gpos }
            })
          }
        })
        await this.view.del(K.nHost(s, term))
        await this.view.del(key)
      }
    }

    if (prevKind === 'unmapped' && (newKind === 'lww' || newKind === 'set')) {
      // §10.3 backfill: bounded range scan over unmapped-idx/<term>/*.
      for (const { key } of await this.scanAll(K.unmappedIdxPrefix(term))) {
        const s = K.parseKey(key)[2]
        await this.setFieldRecord(s, term, (rec) => {
          const items = (rec.un && rec.un.items) || []
          if (newKind === 'lww') {
            rec.reg = {
              values: canonicalArray(items.map((it) => it.v)),
              tag: synth,
              writer: W
            }
          } else {
            rec.els = rec.els || {}
            items.forEach((it, i) => {
              rec.els[it.tag || synth + '-' + i] = { v: it.v, pos: this.gpos }
            })
          }
          delete rec.un // clears flag/unmapped + unmapped-idx via central maintenance
        })
      }
    }

    if (prevKind === 'lww' && newKind === 'set') {
      // §5.5 lww→or-set: register values become element-map entries under a
      // synthetic tag derived from the DefineTerm op (index-suffixed for
      // uniqueness; recorded in DEVIATIONS.md).
      for (const { key } of await this.scanAll(K.fidxPrefix(term))) {
        const s = K.parseKey(key)[2]
        await this.setFieldRecord(s, term, (rec) => {
          if (!rec.reg) return
          rec.els = rec.els || {}
          rec.reg.values.forEach((v, i) => {
            rec.els[synth + '-' + i] = { v, pos: this.gpos }
          })
          delete rec.reg
        })
      }
    }

    if (prevKind === 'set' && newKind === 'lww') {
      // §5.5 or-set→lww: the element greatest in linearized order wins;
      // lossy collapse is audited via flag/kindcollapse.
      for (const { key } of await this.scanAll(K.fidxPrefix(term))) {
        const s = K.parseKey(key)[2]
        await this.setFieldRecord(s, term, async (rec) => {
          if (!rec.els) return
          const entries = Object.entries(rec.els)
          if (entries.length === 0) return
          entries.sort((x, y) => {
            if (x[1].pos !== y[1].pos) return x[1].pos - y[1].pos
            const bf = byteForm(x[1].v) < byteForm(y[1].v) ? -1 : byteForm(x[1].v) > byteForm(y[1].v) ? 1 : 0
            if (bf !== 0) return bf
            return x[0] < y[0] ? -1 : 1
          })
          const [winTag, win] = entries[entries.length - 1]
          rec.reg = { values: [win.v], tag: winTag, writer: safeTagWriter(winTag) || W }
          if (entries.length > 1) {
            await this.view.put(K.flag('kindcollapse', s, term), {
              collapsedFrom: entries.length,
              keptTag: winTag
            })
          }
          delete rec.els
        })
      }
    }

    if ((prevKind === 'lww' || prevKind === 'set') && newKind === 'unmapped') {
      // mapped→unmapped: values are preserved verbatim, never dropped (§5.6).
      for (const { key } of await this.scanAll(K.fidxPrefix(term))) {
        const s = K.parseKey(key)[2]
        await this.setFieldRecord(s, term, (rec) => {
          const items = []
          if (rec.reg) for (const v of rec.reg.values) items.push({ v, tag: rec.reg.tag })
          if (rec.els) {
            for (const [t, e] of Object.entries(rec.els).sort()) items.push({ v: e.v, tag: t })
          }
          if (items.length) rec.un = { items: dedupItems(items) }
          delete rec.reg
          delete rec.els
        })
      }
    }
  }

  async opDefineScope(op, W, ord) {
    const scope = op.scope
    const rec = { base: nfc(op.base), prefix: nfc(op.prefix) }
    const existing = await this.val(K.ctxScope(scope))
    if (existing && !structEq(existing, rec)) {
      // redefinition follows §5.5 shadowing rules; '@base' is the synthetic
      // term component for the scope declaration itself.
      await this.view.put(K.flag('shadow', scope, '@base'), {
        prev: existing,
        by: makeTag(W, ord).toString('hex')
      })
    }
    await this.view.put(K.ctxScope(scope), rec)
    // rebind subjects governed by this scope (§10.1: re-evaluated only by
    // ops that change its inputs — this is such an op).
    for (const { key } of await this.scanAll(K.scopeIdxPrefix(scope))) {
      const s = K.parseKey(key)[2]
      await this.recomputeLayerBase(s)
    }
    return null
  }

  // ---------- unmapped accumulation (§5.2, §5.6) ----------
  async accumulateUnmapped(s, p, rawValues, tag) {
    await this.setFieldRecord(s, p, (rec) => {
      const items = (rec.un && rec.un.items) || []
      for (const v of rawValues) items.push({ v: canonicalValue2(v), tag })
      rec.un = { items: dedupItems(items) }
    })
    // flag write is explicit per the §5.2 table (central maintenance keeps
    // the reverse index in step)
    await this.view.put(K.flag('unmapped', s, p), {})
  }

  // ---------- subject lifecycle (§7, §9.2, §10.1) ----------
  async exists(s) {
    if ((await this.val(K.nDeleted(s))) !== undefined) return false
    return (await this.val(K.nBase(s))) !== undefined
  }

  async subjectIri(s) {
    const base = await this.val(K.nBase(s))
    if (base) return base.iri
    return this.cfg.rootBase + encodeName(s)
  }

  async touchSubject(s, opTagHex, opClock) {
    const del = await this.val(K.nDeleted(s))
    if (del !== undefined) {
      // §9.2: a later op re-creating a deleted subject clears the tombstone.
      await this.view.del(K.nDeleted(s))
      await this.view.put(K.flag('undelete', s), { by: opTagHex })
      // concurrent (deletion unobserved per the op clock) → also audited
      const clock = normalizeClock(opClock)
      if (!clock || !clockCovers(clock, del.tag)) {
        await this.view.put(K.flag('writeafterdelete', s, opTagHex), { deletedBy: del.tag })
      }
      for (const { key } of await this.scanAll(K.nFieldPrefix(s))) {
        const p = K.parseKey(key)[3]
        await this.setFieldRecord(s, p, () => {}) // restore suppressed rows
      }
    }
    if ((await this.val(K.nBase(s))) === undefined) {
      await this.createSubject(s)
    }
  }

  async createSubject(s) {
    await this.recomputeLayerBase(s)
    // §7 takeover: the target of previously-dangling refs now exists.
    const dang = await this.val(K.flag('dangling', s))
    if (dang !== undefined) {
      const iri = await this.subjectIri(s)
      if (dang.mintedAs === iri) {
        // same-IRI takeover: clear the flag and reuse the IRI
        await this.view.del(K.flag('dangling', s))
        await this.view.del(K.nMintedAs(s))
      } else {
        // different-IRI takeover: rewrite referring triples, never merge
        const referrers = await this.scanAll(K.blPrefix(s))
        for (const { key } of referrers) {
          const segs = K.parseKey(key)
          const source = segs[2]
          const term = segs[3]
          await this.setFieldRecord(source, term, () => {}) // reindex → new IRI
          await this.view.put(K.flag('danglingretarget', source, term, s), {
            from: dang.mintedAs,
            to: iri
          })
        }
        await this.view.del(K.flag('dangling', s))
        await this.view.del(K.nMintedAs(s))
      }
    }
  }

  /** §10.1 layer + scope binding + IRI minting for a subject. */
  async recomputeLayerBase(s) {
    const pathRec = await this.val(K.nPath(s))
    const typeField = await this.val(K.nField(s, '@type'))
    const types = []
    if (typeField && typeField.els) {
      for (const e of Object.values(typeField.els)) {
        types.push(isRef(e.v) ? e.v.ref : String(e.v))
      }
    }

    let layer
    if (pathRec) {
      const top = pathRec.path.split('/')[0]
      layer = top === 'Ontologies' || top === 'Vocabularies' ? 'schema' : 'data'
    } else {
      layer = types.some((t) => META_TYPES.has(t)) ? 'schema' : 'data'
    }

    let scope = null
    if (pathRec && pathRec.scope) {
      scope = pathRec.scope
    } else {
      // rule (b): the scope defining the subject's @type terms, when unambiguous
      const scopes = new Set()
      for (const t of types) {
        const def = await this.val(K.ctxTerm(t))
        if (def && def.scope) scopes.add(def.scope)
      }
      if (scopes.size === 1) scope = [...scopes][0]
    }

    if (layer === 'schema' && !scope) {
      await this.view.put(K.flag('noscope', s), {})
      // noscope demotion applies to PATHLESS subjects only (§10.1)
      if (!pathRec) layer = 'data'
    }

    let baseIri = this.cfg.rootBase
    if (scope) {
      const scopeRec = await this.val(K.ctxScope(scope))
      if (scopeRec) baseIri = scopeRec.base
    }
    const declared = await this.val(K.nId(s))
    const iri = declared ? declared.iri : baseIri + encodeName(s)

    const prev = await this.val(K.nBase(s))
    await this.view.put(K.nLayer(s), layer)
    await this.view.put(K.nBase(s), { scope, base: baseIri, iri })

    // scope reverse index for §10.1 rebinding on DefineScope
    if (prev && prev.scope && prev.scope !== scope) {
      await this.view.del(K.scopeIdx(prev.scope, s))
    }
    if (scope) await this.view.put(K.scopeIdx(scope, s), true)

    if (!prev || prev.iri !== iri) {
      await this.updateIriMapping(s, prev ? prev.iri : null, iri)
    }
  }

  async updateIriMapping(s, oldIri, newIri) {
    if (oldIri) await this.view.del(K.iriIdx(oldIri, s))
    // §5.8: two subjects minting-or-declaring the same IRI collide; never merge.
    const others = await this.scanAll(K.iriIdxPrefix(newIri))
    await this.view.put(K.iriIdx(newIri, s), true)
    if (others.some(({ key }) => K.parseKey(key)[2] !== s)) {
      const subjects = new Set(others.map(({ key }) => K.parseKey(key)[2]))
      subjects.add(s)
      await this.view.put(K.flag('idcollision', newIri), { subjects: [...subjects].sort() })
    }
    if (oldIri && oldIri !== newIri) {
      // re-key this subject's own triples (I8) …
      for (const { key } of await this.scanAll(K.nFieldPrefix(s))) {
        const p = K.parseKey(key)[3]
        await this.setFieldRecord(s, p, () => {})
      }
      // … and every referring triple (bl/ is the referrer index, §7)
      for (const { key } of await this.scanAll(K.blPrefix(s))) {
        const segs = K.parseKey(key)
        await this.setFieldRecord(segs[2], segs[3], () => {})
      }
    }
  }

  // ---------- field records and index maintenance (§4, I8) ----------
  async setFieldRecord(s, p, mutate) {
    const key = K.nField(s, p)
    const rec = (await this.val(key)) || {}
    await mutate(rec)
    await this.reindexField(s, p, rec)
    const empty = !rec.reg && !rec.els && !rec.un
    if (empty) {
      await this.view.del(key)
    } else {
      await this.view.put(key, rec)
    }
    // reverse indexes: fidx for mapped state (kind migrations, §5.5),
    // unmapped-idx + flag/unmapped lifecycle for unmapped state (§10.3)
    if (rec.reg || rec.els) {
      await this.view.put(K.fidx(p, s), true)
    } else {
      await this.view.del(K.fidx(p, s))
    }
    if (rec.un) {
      await this.view.put(K.unmappedIdx(p, s), true)
    } else {
      await this.view.del(K.unmappedIdx(p, s))
      await this.view.del(K.flag('unmapped', s, p))
    }
  }

  async predKey(p) {
    if (p === '@type') return '@type'
    const t = await this.val(K.ctxTerm(p))
    if (t && t.def && typeof t.def['@id'] === 'string') return t.def['@id']
    return p
  }

  async reindexField(s, p, rec) {
    const old = rec.ix || { rows: [], bl: [], dang: [] }
    for (const rowKey of old.rows) await this.view.del(rowKey)
    for (const [target] of old.bl) await this.view.del(K.bl(target, s, p))
    for (const target of old.dang) await this.dangDecr(target)

    const deleted = (await this.val(K.nDeleted(s))) !== undefined
    const values = []
    if (!deleted) {
      if (rec.reg) values.push(...rec.reg.values)
      if (rec.els) {
        for (const [, e] of Object.entries(rec.els).sort()) values.push(e.v)
      }
    }

    if (values.length === 0) {
      delete rec.ix
      return
    }

    const sIri = await this.subjectIri(s)
    const pKey = await this.predKey(p)
    const rows = new Set()
    const blCounts = new Map()
    const dangTargets = new Set()

    for (const v of sortValues(values)) {
      let oKey
      if (isRef(v)) {
        const target = v.ref
        let oIri
        if (await this.exists(target)) {
          oIri = await this.subjectIri(target)
          // §9.2 link ambiguity: >1 non-deleted subject minting-or-declaring
          // the target IRI, and no path qualifier on the link
          if (!target.includes('/')) {
            const holders = await this.scanAll(K.iriIdxPrefix(oIri))
            if (holders.length > 1) {
              await this.view.put(K.flag('linkambiguous', s, p, target), {})
            }
          }
        } else {
          oIri = await this.mintDangling(target)
          dangTargets.add(target)
        }
        oKey = 'r:' + oIri
        blCounts.set(target, (blCounts.get(target) || 0) + 1)
      } else {
        oKey = byteForm(v)
      }
      rows.add(K.idxSpo(sIri, pKey, oKey))
      rows.add(K.idxPos(sIri, pKey, oKey))
      rows.add(K.idxOsp(sIri, pKey, oKey))
    }

    for (const rowKey of rows) await this.view.put(rowKey, true)
    for (const [target, count] of blCounts) {
      await this.view.put(K.bl(target, s, p), { count })
    }
    for (const target of dangTargets) await this.dangIncr(target)

    rec.ix = {
      rows: [...rows].sort(),
      bl: [...blCounts.entries()].sort(),
      dang: [...dangTargets].sort()
    }
  }

  // §7: dangling refs mint in the DATA namespace (root @base) regardless of
  // the referrer's scope, coalesced per target with a referrer count.
  async mintDangling(target) {
    let minted = await this.val(K.nMintedAs(target))
    if (minted === undefined) {
      minted = this.cfg.rootBase + encodeName(target)
      await this.view.put(K.nMintedAs(target), minted)
    }
    return minted
  }

  async dangIncr(target) {
    const minted = await this.mintDangling(target)
    const cur = await this.val(K.flag('dangling', target))
    await this.view.put(K.flag('dangling', target), {
      count: ((cur && cur.count) || 0) + 1,
      mintedAs: minted
    })
  }

  async dangDecr(target) {
    const cur = await this.val(K.flag('dangling', target))
    if (cur === undefined) return
    if (cur.count <= 1) {
      await this.view.del(K.flag('dangling', target))
      // keep n/<target>/mintedAs only while referenced
      if (!(await this.exists(target))) await this.view.del(K.nMintedAs(target))
    } else {
      await this.view.put(K.flag('dangling', target), { ...cur, count: cur.count - 1 })
    }
  }
}

// ---------- pure helpers ----------
function canonicalValue2(v) {
  return Array.isArray(v) ? v.map(canonicalValue) : canonicalValue(v)
}

function arraysEq(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (!valuesEqual(a[i], b[i])) return false
  return true
}

/** dedup by NFC byte form, keeping the first-in-linearized-order tag (§5.6). */
function dedupItems(items) {
  const byKey = new Map()
  for (const it of items) {
    const k = byteForm(it.v)
    if (!byKey.has(k)) byKey.set(k, it)
  }
  return [...byKey.values()].sort((a, b) => {
    const x = byteForm(a.v)
    const y = byteForm(b.v)
    return x < y ? -1 : x > y ? 1 : 0
  })
}

function clockCovers(clock, eventTagHex) {
  try {
    const { writer, seq } = parseTag(eventTagHex)
    return (clock[writer] || 0) >= seq
  } catch {
    return false
  }
}

function safeTagWriter(t) {
  try {
    return parseTag(t).writer
  } catch {
    return null
  }
}
