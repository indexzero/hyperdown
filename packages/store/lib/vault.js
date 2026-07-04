// Vault (SPEC-FINAL §13, ported to autobee): multiwriter vault lifecycle —
// corestore in, Autobee up, @hyperwiki/core's deterministic apply wired
// through the ViewAdapter into autobee's apply — plus §8 op-emission
// helpers, vault-metadata pinning, and hyperswarm replication.
//
// autobee contract, verified against the installed source of autobee@1.0.10
// (node_modules/autobee/{index.js,lib/*}, upstream
// https://github.com/holepunchto/autobee — a STANDALONE multiwriter
// Hyperbee on hyperbee2 + hypercore 11):
// - `new Autobee(store, key, { apply, open, close, update, encryptionKey,
//   encrypted, keyPair, optimistic })`; `optimistic` defaults true.
// - apply receives `(nodes, view, host)`; node = `{ key, value, length }`
//   (+ `optimistic` flag; README "Apply" section), where node.key is the
//   WRITER core key — mapped below to core's expected
//   `{ from: { key }, value, length }` node shape.
// - `view` is what the `open` handler returned: we return a ViewAdapter, so
//   core's apply sees its documented get/put/del/createReadStream surface.
// - host: `addWriter(key, { isIndexer })` / `removeWriter(key)` /
//   `ackWriter(key)` / `removeable(key)` / `interrupt(reason)` /
//   `createAnchor()` / `genesis` (lib/apply-calls.js) — adapted below to
//   core's `addWriter(key, { indexer })` convention.
// - instance: db.key, db.discoveryKey, db.local, db.view (read-only
//   snapshot), db.writable, db.isIndexer, append(buf|[bufs],{optimistic}),
//   update()/updated()/flush(), replicate(isInitiator|stream).
// - db.close() closes the corestore it was handed (index.js _close): the
//   Vault therefore OWNS its corestore; pass a directory (preferred) or a
//   dedicated Corestore instance.
// - genesis: autobee auto-adds the first writer with full permissions
//   (index.js _processApplyBatch: `if (this.system.isGenesis())
//   host.addWriter(tip[0][0].key)`), and for a creator the vault key IS the
//   creator's local writer key (lib/boot.js), so metadata.genesisKey ===
//   db.key on every peer and core's §8.0 genesis indexer seeding agrees
//   with autobee's.
//
// §8.2 optimistic onboarding, decided against autobee's optimistic +
// ackWriter reality (recorded in DEVIATIONS.md): nodes flagged optimistic
// are acked at the autobee level (host.ackWriter) inside apply so the
// speculative batch anchors durably in autobee's system on every peer
// (deterministic: same apply, same nodes), while @hyperwiki/core's hold
// buffer (n/hold/ + flag/optimistic) remains the only VIEW-effect gate: a
// held op takes effect only when an in-log AddWriter from a confirmed
// indexer linearizes and core folds the hold range (§8.2).
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import Corestore from 'corestore'
import Autobee from 'autobee'
import Hyperswarm from 'hyperswarm'
import b4a from 'b4a'
import { createApply, encodeOp, makeTag, normalizeClock, keyspace as K, canonical } from '@hyperwiki/core'
import { ViewAdapter } from './view.js'
import { viewHash } from './hash.js'
import {
  METADATA_FILE,
  createMetadata,
  loadMetadata,
  saveMetadata,
  metadataHash,
  applyConfig,
  keyHex
} from './metadata.js'

// §3.2 ops whose opId tag the emission helpers auto-fill when absent.
const AUTO_TAG = new Set(['set-field', 'add-member', 'unset-field', 'delete-subject'])

export class Vault extends EventEmitter {
  /**
   * @param {string|Corestore} storage directory (preferred: metadata is
   *   pinned to `<dir>/vault-ld.json`) or a dedicated Corestore the vault
   *   takes ownership of (metadata then lives in memory / the invite).
   * @param {object} [opts]
   *   key            vault key to join (Buffer or hex); omit to create/open
   *   metadata       invite metadata overrides (rootBase, hostAllowlist,
   *                  rate, limits, schemaVersion, ...)
   *   encryptionKey  32-byte key for private vaults (end to end: writer
   *                  cores, system and view are encrypted at rest)
   *   keyPair        custom signing key pair for the local writer
   *   swarm          a shared Hyperswarm instance for joinSwarm()
   */
  constructor(storage, opts = {}) {
    super()
    this.dir = typeof storage === 'string' ? storage : null
    this.store = this.dir ? new Corestore(this.dir) : storage
    this.db = null
    this.metadata = null
    this.swarm = opts.swarm || null
    this._ownSwarm = false
    this._onConnection = null
    this._opts = opts
    this._coreApply = null
    this._applyBarrier = new Promise((resolve) => {
      this._applyBarrierResolve = resolve
    })
    this._nextSeq = 0
    this._readying = null
  }

  /** Create a brand-new vault (writes pinned metadata at init). */
  static async init(storage, opts = {}) {
    const vault = new Vault(storage, opts)
    await vault.ready()
    return vault
  }

  /** Open a vault previously initialized/joined at `storage`. */
  static async open(storage, opts = {}) {
    const vault = new Vault(storage, opts)
    await vault.ready()
    return vault
  }

  /** Join an existing vault by key (plus invite metadata/encryptionKey). */
  static async join(storage, key, opts = {}) {
    const vault = new Vault(storage, { ...opts, key })
    await vault.ready()
    return vault
  }

  ready() {
    if (!this._readying) this._readying = this._open()
    return this._readying
  }

  async _open() {
    try {
      return await this._openInner()
    } catch (err) {
      this._applyBarrierResolve()
      if (this.db) await this.db.close().catch(() => {})
      else if (this.dir) await this.store.close().catch(() => {})
      throw err
    }
  }

  async _openInner() {
    const metaPath = this.dir ? join(this.dir, METADATA_FILE) : null
    const stored = metaPath ? await loadMetadata(metaPath) : null
    const overrides = this._opts.metadata || null
    const optKeyHex = this._opts.key != null ? keyHex(this._opts.key) : null

    if (stored && optKeyHex && stored.genesisKey !== optKeyHex) {
      throw vaultError(
        'VAULT_KEY_MISMATCH',
        `storage is pinned to vault ${stored.genesisKey}, not ${optKeyHex}`
      )
    }

    // Reopen-from-disk: the apply config is known before the Autobee is
    // constructed, so replayed/reorged nodes fold under pinned metadata.
    if (stored) this._setApply(stored)

    const bootKey = stored ? b4a.from(stored.genesisKey, 'hex') : optKeyHex ? b4a.from(optKeyHex, 'hex') : null
    const encrypted =
      (stored ? stored.encrypted : false) ||
      (overrides ? overrides.encrypted === true : false) ||
      !!this._opts.encryptionKey

    this.db = new Autobee(this.store, bootKey, {
      apply: (nodes, view, host) => this._apply(nodes, view, host),
      // Both the read snapshot (db.view) and apply's working view go
      // through the adapter, so reads and apply share one surface.
      open: (bee) => new ViewAdapter(bee),
      encryptionKey: this._opts.encryptionKey || null,
      encrypted,
      keyPair: this._opts.keyPair,
      optimistic: true
    })
    this.db.on('error', (err) => this.emit('error', err))

    await this.db.ready()

    const vaultKeyHex = b4a.toString(this.db.key, 'hex')
    let meta = stored
    if (!meta) {
      meta = createMetadata({
        ...(overrides || {}),
        genesisKey: (overrides && overrides.genesisKey) || vaultKeyHex,
        encrypted
      })
      if (metaPath) await saveMetadata(metaPath, meta)
    } else if (overrides) {
      // A re-supplied invite must agree with the pinned document (I2:
      // metadata is convergence-relevant; silent divergence is the bug).
      const invited = createMetadata({
        ...overrides,
        genesisKey: overrides.genesisKey || meta.genesisKey,
        encrypted: overrides.encrypted === undefined ? meta.encrypted : overrides.encrypted
      })
      if (metadataHash(invited) !== metadataHash(meta)) {
        throw vaultError('VAULT_METADATA_MISMATCH', 'invite metadata differs from pinned metadata')
      }
    }
    if (meta.genesisKey !== vaultKeyHex) {
      throw vaultError(
        'VAULT_KEY_MISMATCH',
        `pinned genesisKey ${meta.genesisKey} does not match vault key ${vaultKeyHex}`
      )
    }

    this.metadata = meta
    if (!this._coreApply) this._setApply(meta)
    this._nextSeq = this.db.local.length
    return this
  }

  _setApply(meta) {
    this._coreApply = createApply(applyConfig(meta))
    this._applyBarrierResolve()
  }

  // ---------- apply wiring (core apply over the autobee contract) ----------

  async _apply(nodes, view, host) {
    if (!this._coreApply) await this._applyBarrier
    if (!this._coreApply) throw vaultError('VAULT_NOT_OPEN', 'vault failed to open before apply')

    const wrapped = []
    for (const node of nodes) {
      if (node.optimistic) {
        // §8.2 port (see header + DEVIATIONS.md): DAG-level ack so the
        // speculative batch persists; view effects stay held by core.
        await host.ackWriter(node.key)
      }
      wrapped.push({ from: { key: node.key }, value: node.value, length: node.length })
    }
    await this._coreApply(wrapped, view, new HostAdapter(host))
  }

  // ---------- identity / lifecycle ----------

  get key() {
    return this.db ? this.db.key : null
  }

  get keyHex() {
    return this.db && this.db.key ? b4a.toString(this.db.key, 'hex') : null
  }

  get discoveryKey() {
    return this.db ? this.db.discoveryKey : null
  }

  /** This peer's writer key (what an indexer passes to addWriter). */
  get localKey() {
    return this.db && this.db.local ? this.db.local.key : null
  }

  get writable() {
    return !!this.db && this.db.writable
  }

  get isIndexer() {
    return !!this.db && this.db.isIndexer
  }

  get encryptionKey() {
    return this.db ? this.db.encryptionKey : null
  }

  /** Read surface: the ViewAdapter over autobee's read-only view snapshot. */
  get view() {
    return this.db.view
  }

  update() {
    return this.db.update()
  }

  updated() {
    return this.db.updated()
  }

  flush() {
    return this.db.flush()
  }

  async close() {
    if (this.swarm && this._onConnection) {
      this.swarm.off('connection', this._onConnection)
      this._onConnection = null
    }
    if (this._ownSwarm) {
      await this.swarm.destroy()
      this.swarm = null
      this._ownSwarm = false
    }
    if (this.db) await this.db.close() // closes the corestore too (autobee _close)
  }

  // ---------- reads ----------

  /** `{ key, value } | null` from the view (value JSON-decoded). */
  get(key) {
    return this.db.view.get(key)
  }

  /** Value at `key`, or `undefined`. */
  async val(key) {
    const node = await this.db.view.get(key)
    return node ? node.value : undefined
  }

  /** Async iterable over a §4 keyspace prefix (e.g. 'n/', 'flag/'). */
  scan(prefix) {
    return this.db.view.createReadStream(K.range(prefix))
  }

  /** I2/I3 store-level check: hash of a full range scan of the view. */
  async hash() {
    await this.update()
    return viewHash(this.db.view)
  }

  // ---------- §8 op emission ----------

  /**
   * Encode and append one §3.2 op. Fills the common `clock` field (§3.2:
   * the writer's observed vector clock at append time — derived from the
   * autobee DAG heads, the autobee equivalent of the spec-blessed
   * `base.heads()` source) and, for ops that carry one, the opId
   * `tag = writerKey || seq` (§3.2), unless the caller supplied them.
   * Returns `{ seq, tag }`.
   */
  async append(type, payload = {}, { optimistic = false } = {}) {
    await this.ready()
    // §8.3 app-level containment (see DEVIATIONS.md §13(d)): once this
    // peer's own revocation record is in the view, any new local op is
    // uniformly rejected 'revoked' by every peer's apply — refuse the
    // append instead of growing the log with dead ops.
    await this._guardRevoked(payload.clock)
    const seq = this._nextSeq++
    const op = { ...payload }
    if (op.clock === undefined) op.clock = this.clock(seq)
    if (AUTO_TAG.has(type) && op.tag === undefined) op.tag = makeTag(this.db.local.key, seq)
    const buf = encodeOp(type, op)
    await this.db.append(buf, { optimistic })
    return { seq, tag: op.tag || null }
  }

  /**
   * The §3.2 clock payload: [[writerKeyHex, seq], ...], sorted. `seq` is
   * the local seq of the op being appended, when called for one: §8.3's
   * consumer reads a writer's own entry as "delivered through this op"
   * (the I10 unit convention), so the self entry must count the op itself
   * (seq + 1) — the DAG heads alone give the length *before* the op, which
   * a RemoveWriter that never saw the op can dominate, wrongly accepting a
   * racing op everywhere.
   */
  clock(seq = null) {
    const heads = (this.db && this.db.system && this.db.system.heads) || []
    const entries = new Map(heads.map((h) => [b4a.toString(h.key, 'hex'), h.length]))
    if (seq !== null && this.db && this.db.local) {
      const self = b4a.toString(this.db.local.key, 'hex')
      entries.set(self, Math.max(entries.get(self) || 0, seq + 1))
    }
    return [...entries].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  }

  /**
   * §8.3 revocation containment, app-level (replaces autobee's positional
   * "Not writable" teardown — see DEVIATIONS.md §13(d)): refuse a local
   * append once `ctx/gov/removed/<self>` exists and the op's clock does
   * not causally precede the recorded revocation. A store-emitted clock
   * always carries this op's own new position, which the revocation cannot
   * have observed, so any default-clock append from a revoked writer is
   * refused; a caller-crafted clock is judged by core's exact §8.3 rule.
   */
  async _guardRevoked(clock) {
    if (!this.db || !this.db.local) return
    const self = b4a.toString(this.db.local.key, 'hex')
    const removed = await this.val(K.govRemoved(self))
    if (removed === undefined) return
    if (clock !== undefined) {
      const c = normalizeClock(clock)
      if (c) {
        const entries = Object.entries(c)
        const dominated =
          entries.length > 0 &&
          entries.every(([w, s]) => removed[w] !== undefined && s <= removed[w])
        if (dominated) return // causally precedes the revocation: apply accepts it
      }
    }
    throw vaultError('VAULT_REVOKED', `local writer ${self} has been removed (§8.3)`)
  }

  // Governance ops (§8.0: apply rejects these unless the ISSUER is a
  // confirmed indexer at the op's linearized position).
  addWriter(key, { indexer = false } = {}) {
    return this.append('add-writer', { key: toKeyBuffer(key), indexer })
  }

  removeWriter(key) {
    return this.append('remove-writer', { key: toKeyBuffer(key) })
  }

  setWriterPolicy(key, { namespacePrefixes = [], rateCeiling }) {
    return this.append('set-writer-policy', {
      key: toKeyBuffer(key),
      namespacePrefixes,
      rateCeiling
    })
  }

  pruneRevisions(s, before) {
    return this.append('prune-revisions', { s, before })
  }

  // Content-op conveniences (thin over append()).
  setField(s, p, o, opts = {}) {
    const { optimistic, ...rest } = opts
    return this.append('set-field', { s, p, o, ...rest }, { optimistic })
  }

  addMember(s, p, o, opts = {}) {
    const { optimistic, ...rest } = opts
    return this.append('add-member', { s, p, o, ...rest }, { optimistic })
  }

  /**
   * §5.3 citation contract: computes and cites EVERY element-tag currently
   * mapped to `value` in this writer's resolved view (client libraries MUST
   * compute this set, not accept a caller subset).
   */
  async remMember(s, p, value, opts = {}) {
    await this.update()
    const rec = await this.val(K.nField(canonical.nfc(String(s)), canonical.nfc(String(p))))
    const els = (rec && rec.els) || {}
    const target = canonical.canonicalValue(value)
    const tags = []
    for (const [tagH, el] of Object.entries(els)) {
      if (canonical.valuesEqual(el.v, target)) tags.push(b4a.from(tagH, 'hex'))
    }
    const { optimistic, ...rest } = opts
    return this.append('rem-member', { s, p, tags, ...rest }, { optimistic })
  }

  setBody(s, base, text, opts = {}) {
    const { optimistic, ...rest } = opts
    return this.append('set-body', { s, base, text, ...rest }, { optimistic })
  }

  defineTerm(scope, term, def, opts = {}) {
    const { optimistic, ...rest } = opts
    return this.append('define-term', { scope, term, def, ...rest }, { optimistic })
  }

  defineScope(scope, base, prefix, opts = {}) {
    const { optimistic, ...rest } = opts
    return this.append('define-scope', { scope, base, prefix, ...rest }, { optimistic })
  }

  // ---------- replication ----------

  /** Direct replication stream (autobee: store.replicate + wakeup wiring). */
  replicate(isInitiatorOrStream) {
    return this.db.replicate(isInitiatorOrStream)
  }

  /**
   * Join the vault's discovery key on hyperswarm; every connection is fed
   * to db.replicate. Pass a shared swarm here or in the constructor,
   * otherwise the vault creates (and owns) one.
   */
  async joinSwarm(swarm = null) {
    await this.ready()
    if (swarm) this.swarm = swarm
    if (!this.swarm) {
      this.swarm = new Hyperswarm()
      this._ownSwarm = true
    }
    if (!this._onConnection) {
      this._onConnection = (conn) => {
        conn.on('error', () => {})
        this.db.replicate(conn)
      }
      this.swarm.on('connection', this._onConnection)
    }
    const discovery = this.swarm.join(this.db.discoveryKey, { server: true, client: true })
    await discovery.flushed()
    return this.swarm
  }

  async leaveSwarm() {
    if (!this.swarm) return
    await this.swarm.leave(this.db.discoveryKey)
    if (this._onConnection) {
      this.swarm.off('connection', this._onConnection)
      this._onConnection = null
    }
  }
}

/**
 * Adapts autobee's host (lib/apply-calls.js: addWriter(key, { isIndexer,
 * weight }), removeWriter, ackWriter, removeable, interrupt, createAnchor)
 * to the surface @hyperwiki/core's apply invokes: addWriter(key,
 * { indexer }) — only ever for governance ops that passed the §8.0
 * authority check. autobee's positional removeWriter is deliberately NOT
 * exposed: §8.3 revocation is decided purely by core's in-log clock rule
 * (DEVIATIONS.md §13(d); review finding B1).
 */
class HostAdapter {
  constructor(host) {
    this.host = host
  }

  addWriter(key, { indexer = false } = {}) {
    // UNIFORM TOPO WEIGHT (recorded in DEVIATIONS.md): autobee@1.0.10's
    // linearization comparators disagree for concurrent nodes of unequal
    // weight (lib/topo.js: isOrderedBefore() breaks the walk on
    // `node.weight < link.weight` while cmp() sorts higher weight first),
    // so peers that saw concurrent indexer/non-indexer (weight 2/1) nodes
    // in different arrival orders keep divergent linearizations — fatal for
    // I2 under core's order-sensitive apply. All writers therefore get
    // weight 2 (the genesis auto-add weight); the indexer bit still rides
    // along for autobee's indexer bookkeeping, and §8.0 governance
    // authority is decided from ctx/gov by core, never from autobee state.
    return this.host.addWriter(key, { isIndexer: indexer, weight: 2 })
  }

  ackWriter(key) {
    return this.host.ackWriter(key)
  }
}

function toKeyBuffer(key) {
  return b4a.from(keyHex(key), 'hex')
}

function vaultError(code, message) {
  const err = new Error(`${code}: ${message}`)
  err.code = code
  return err
}
