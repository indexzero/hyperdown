// Bundle (okf SPEC §13 store deliverable): multiwriter vault lifecycle on
// autobee — corestore in (writer cores derived under the §10 per-generation
// namespace), Autobee up, @auto-okf/core's deterministic apply wired
// through the ViewAdapter into autobee's apply — plus §8 governance op
// emission, vault-metadata pinning (§8 append-only constant + §10 generation
// chain), hyperswarm replication, and opt-in append backpressure.
// Pattern ancestor: vault-ld/store/lib/vault.js (patterns only, no code
// path shared — SPEC §0 copy-don't-depend).
//
// autobee contract, verified against the installed source of autobee@1.0.10
// (node_modules/autobee/{index.js,lib/*}; upstream README cross-checked at
// https://github.com/holepunchto/autobee 2026-07-13 — a STANDALONE
// multiwriter Hyperbee on hyperbee2 + hypercore 11; NO autobase):
// - `new Autobee(store, key, { apply, open, close, update, encryptionKey,
//   encrypted, keyPair, optimistic })`; `optimistic` defaults true
//   (index.js: `handlers.optimistic !== false`).
// - apply receives `(nodes, view, host)`; node = `{ key, value, length,
//   optimistic, timestamp, links, ... }` (lib/writers.js createNode), where
//   node.key is the WRITER core key — exactly the node shape core's apply
//   documents, so nodes pass through UNWRAPPED.
// - `view` is what the `open` handler returned: we return a ViewAdapter, so
//   core's apply sees the hyperbee2-flavored string-key surface it expects.
// - host (lib/apply-calls.js): `addWriter(key, { isIndexer = true, weight =
//   isIndexer ? 2 : 1 })` / `removeWriter(key)` / `ackWriter(key)` /
//   `removeable(key)` / `interrupt(reason)` / `createAnchor()` / `genesis`
//   — adapted below (HostAdapter) to pin the uniform topo weight.
// - instance: db.key, db.id, db.discoveryKey, db.local, db.view (read-only
//   snapshot), db.writable, db.isIndexer, append(buf|[bufs],{optimistic}),
//   update()/updated()/flush(), replicate(isInitiator|stream).
// - db.close() closes the corestore it was handed (index.js _close): we
//   hand it the per-generation namespace SESSION; the root corestore is closed
//   by Bundle.close() (corestore@7.11.0 index.js: closing a session never
//   closes the root; closing the root closes every session).
// - genesis: autobee auto-adds the first writer with full permissions
//   (index.js _processApplyBatch: `if (this.system.isGenesis())
//   this._host.addWriter(t.tip[0][0].key)` — DEFAULT opts, so isIndexer
//   true and weight 2), and for a creator the vault key IS the creator's
//   local writer key (lib/boot.js), so metadata.genesisKey === db.key on
//   every peer and core's §8 genesis indexer seeding agrees with autobee's.
//
// §8 optimistic onboarding, decided against autobee's optimistic reality
// (recorded in DEVIATIONS.md): nodes flagged optimistic are acked at the
// autobee DAG level (host.ackWriter) inside apply so the speculative batch
// anchors durably in autobee's system on every peer (index.js
// _optimisticBatch rolls the batch back unless the writer is in system
// after apply — deterministic: same apply, same nodes, same ack), while
// core's hold buffer (hold/ + flag/optimistic) remains the only VIEW-effect
// gate: a held op takes effect only when an indexer-authored AddWriter
// linearizes and core folds the hold range (§8).
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import Corestore from 'corestore'
import Autobee from 'autobee'
import Hyperswarm from 'hyperswarm'
import b4a from 'b4a'
import {
  createApply,
  encodeOp,
  decodeOp,
  makeTag,
  normalizeClock,
  strictlyPrecedes,
  keyspace as K,
  canonical
} from '@auto-okf/core'
import { ViewAdapter } from './view.js'
import { viewHash } from './hash.js'
import {
  METADATA_FILE,
  createMetadata,
  loadMetadata,
  saveMetadata,
  metadataHash,
  applyConfig,
  generationId,
  keyHex
} from './metadata.js'

// §10: writer cores (and autobee's system/view cores) derive under this
// prefix + metadata.generation, so a writer keypair can never recur across
// generations even in a reused corestore directory.
const GENERATION_NS = 'okf/generation/'

// Defaults for the opt-in append backpressure (vault-ld M2 ancestry, the
// measured finding ported wholesale: a local-fold-only throttle is NOT
// enough — a fast writer's own fold stays cheap precisely because the
// drowning peers send little — hence the peer-ack watermark, which pins a
// writer to the fold progress its peers demonstrate through the §3 clocks
// their ops carry. ackTimeout bounds the wait so idle, silent or
// partitioned peers degrade a backpressured writer to ~maxInflight ops per
// ackTimeout instead of deadlocking it.
const DEFAULT_MAX_INFLIGHT = 1
const DEFAULT_ACK_TIMEOUT = 1500

export class Bundle extends EventEmitter {
  /**
   * @param {string|Corestore} storage directory (preferred: metadata is
   *   pinned to `<dir>/okf-vault.json`) or a dedicated Corestore the vault
   *   takes ownership of (metadata then lives in memory / the invite).
   * @param {object} [opts]
   *   key            vault key to join (Buffer or hex); omit to create/open
   *   metadata       invite metadata overrides (predecessorKey,
   *                  predecessorCheckpoint, limits, rate, schemaVersion, ...)
   *   encryptionKey  32-byte key for private vaults (end to end: writer
   *                  cores, system and view are encrypted at rest; autobee
   *                  persists the key in the local core's userData —
   *                  lib/boot.js — so a reopen needs no key)
   *   keyPair        custom signing key pair for the local writer
   *   swarm          a shared Hyperswarm instance for swarm()
   *   backpressure   opt-in append admission control: `true` or
   *                  `{ maxInflight, ackTimeout }` — every append() then
   *                  self-throttles to this writer's own fold AND its
   *                  peers' demonstrated fold progress (see append()).
   *                  Default: off (append is fire-at-caller-rate).
   */
  constructor(storage, opts = {}) {
    super()
    this.dir = typeof storage === 'string' ? storage : null
    this.store = this.dir ? new Corestore(this.dir) : storage
    this.db = null
    this.metadata = null
    this.generation = null
    this.swarmInstance = opts.swarm || null
    this._ownSwarm = false
    this._onConnection = null
    this._opts = opts
    this._coreApply = null
    this._applyBarrier = new Promise((resolve) => {
      this._applyBarrierResolve = resolve
    })
    this._nextSeq = 0
    this._foldedSeq = 0
    this._appendChain = Promise.resolve()
    this._backpressure = normalizeBackpressure(opts.backpressure)
    this._trackAcks = !!this._backpressure
    this._ackSeen = false // ever folded another writer's op (multiwriter)
    this._bestAck = 0 // max count of OUR ops any peer op's clock has cited
    this._ackWaiters = new Set()
    this._closing = false
    this._readying = null

    // §13 Vault API: writer governance namespace (thin over the §8 ops).
    this.writers = {
      add: (key, opts2) => this.addWriter(key, opts2),
      remove: (key) => this.removeWriter(key),
      setPolicy: (key, policy) => this.setWriterPolicy(key, policy)
    }
  }

  /** Create a brand-new vault (writes pinned metadata at init). */
  static async init(storage, opts = {}) {
    const vault = new Bundle(storage, opts)
    await vault.ready()
    return vault
  }

  /** Open a vault previously initialized/joined at `storage`. */
  static async open(storage, opts = {}) {
    const vault = new Bundle(storage, opts)
    await vault.ready()
    return vault
  }

  /** Join an existing vault by key (plus invite metadata/encryptionKey). */
  static async join(storage, key, opts = {}) {
    const vault = new Bundle(storage, { ...opts, key })
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
      await this.store.close().catch(() => {})
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

    // §10: the per-generation namespace is derivable before the Autobee exists —
    // it is a pure function of the (stored or invited) predecessor fields.
    const predKey = stored
      ? stored.predecessorKey
      : (overrides && overrides.predecessorKey) ?? null
    const predCp = stored
      ? stored.predecessorCheckpoint
      : (overrides && overrides.predecessorCheckpoint) ?? null
    this.generation = generationId(predKey, predCp)
    const session = this.store.namespace(GENERATION_NS + this.generation)

    const bootKey = stored
      ? b4a.from(stored.genesisKey, 'hex')
      : optKeyHex
        ? b4a.from(optKeyHex, 'hex')
        : null
    const encrypted =
      (stored ? stored.encrypted : false) ||
      (overrides ? overrides.encrypted === true : false) ||
      !!this._opts.encryptionKey

    this.db = new Autobee(session, bootKey, {
      apply: (nodes, view, host) => this._apply(nodes, view, host),
      // Both the read snapshot (db.view) and apply's working view go
      // through the adapter, so reads and apply share one surface.
      open: (bee) => new ViewAdapter(bee),
      encryptionKey: this._opts.encryptionKey || null,
      encrypted,
      keyPair: this._opts.keyPair,
      // §8 optimistic onboarding needs every optimistic node to reach
      // apply; autobee@2 still defaults this to true but marks it a TODO
      // to flip, so it stays explicit.
      optimistic: true,
      // I2/I3: every peer folds every op through its own apply under the
      // pinned config. autobee@2 would otherwise fast-forward onto a view
      // head another writer stamped, trusting every writer by default
      // (lib/trusted.js), and skip apply for the whole prefix.
      fastForward: false
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
    this._foldedSeq = this._nextSeq
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

    for (const node of nodes) {
      if (node.optimistic) {
        // §8 port (see header + DEVIATIONS.md): DAG-level ack so the
        // speculative batch persists; view effects stay held by core.
        await host.ackWriter(node.key)
      }
      if (this._trackAcks) this._observeAck(node)
    }
    // autobee nodes already have the { key, value, length } shape core's
    // apply documents — no wrapping.
    await this._coreApply(nodes, view, new HostAdapter(host))
    this._wakeAckWaiters()
  }

  /**
   * Backpressure bookkeeping: a folded remote op whose §3 clock cites OUR
   * writer at seq s proves that peer had linearized us through op s when it
   * appended — the peer-fold acknowledgment append()'s admission control
   * waits on. Only runs once backpressure has been used (`_trackAcks`), so
   * the default path never pays the extra decode.
   */
  _observeAck(node) {
    if (!this.db || !this.db.local || b4a.equals(node.key, this.db.local.key)) return
    this._ackSeen = true
    const dec = decodeOp(Buffer.isBuffer(node.value) ? node.value : Buffer.from(node.value || []))
    if (!dec.ok || !dec.op) return // poison/undecodable ops carry no ack
    const clock = normalizeClock(dec.op.clock)
    if (!clock) return
    const seq = clock[b4a.toString(this.db.local.key, 'hex')]
    // okf clocks carry 0-based seqs; the watermark is in op-count units.
    if (typeof seq === 'number' && seq + 1 > this._bestAck) this._bestAck = seq + 1
  }

  _wakeAckWaiters() {
    for (const wake of this._ackWaiters) wake()
    this._ackWaiters.clear()
  }

  // ---------- identity / lifecycle ----------

  /** The vault key as a z-base-32 id string (autobee db.id). */
  get id() {
    return this.db ? this.db.id : null
  }

  get key() {
    return this.db ? this.db.key : null
  }

  get keyHex() {
    return this.db && this.db.key ? b4a.toString(this.db.key, 'hex') : null
  }

  get discoveryKey() {
    return this.db ? this.db.discoveryKey : null
  }

  /** This peer's writer key (what an indexer passes to writers.add). */
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
    this._closing = true
    this._wakeAckWaiters() // release any append blocked in the ack gate
    if (this.swarmInstance && this._onConnection) {
      this.swarmInstance.off('connection', this._onConnection)
      this._onConnection = null
    }
    if (this._ownSwarm) {
      await this.swarmInstance.destroy()
      this.swarmInstance = null
      this._ownSwarm = false
    }
    // db.close() closes the generation SESSION (autobee _close); the root
    // corestore — which the Bundle owns either way — closes after it.
    if (this.db) await this.db.close()
    await this.store.close()
  }

  // ---------- reads ----------

  /** `{ key, value } | null` from the view (value JSON-decoded). */
  async get(key) {
    const node = await this.db.view.get(key)
    if (!node) return null
    return { key: node.key, value: JSON.parse(node.value) }
  }

  /** Value at `key`, or `undefined`. */
  async val(key) {
    const node = await this.db.view.get(key)
    return node ? JSON.parse(node.value) : undefined
  }

  /** Async iterable of `{ key, value }` (JSON-decoded) over a §4 prefix. */
  scan(prefix) {
    const stream = this.db.view.createReadStream(K.range(prefix))
    return (async function* () {
      for await (const { key, value } of stream) {
        yield { key, value: JSON.parse(value) }
      }
    })()
  }

  /**
   * I2/I3 store-level check: hash of a full range scan of the view —
   * byte-compatible with core MemView.hash(), so a substrate view and a
   * unit-suite view of the same linearized prefix compare directly.
   */
  async snapshotHash() {
    await this.update()
    return viewHash(this.db.view)
  }

  /** Alias for snapshotHash() (vault-ld test-harness parity). */
  hash() {
    return this.snapshotHash()
  }

  /**
   * §10 checkpoint material for the NEXT generation's metadata:
   * `{ viewHash, writerLengths }` — writerLengths from the view's seen/
   * family (the §3 per-writer ordinal source), sorted by writer key.
   */
  async checkpoint() {
    const vh = await this.snapshotHash()
    const writerLengths = []
    for await (const { key, value } of this.scan(K.seenPrefix())) {
      writerLengths.push([K.parseKey(key)[1], value])
    }
    writerLengths.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    return { viewHash: vh, writerLengths }
  }

  // ---------- §3/§8 op emission ----------

  /**
   * Encode and append one §3 op. Fills the common fields when absent:
   * `clock` (the writer's observed vector clock — the folded seen/ counts
   * merged with the autobee DAG heads, self entry pinned to this op's own
   * seq per the §8 forged-clock rule) and `at` (informational wall-clock
   * ms, §3). Returns `{ seq, tag }` — `tag` is the §3 opId apply will
   * derive (`writerKey || seq`), which for a minting `create-concept` is
   * the concept's `_id`.
   *
   * Appends are internally serialized (one at a time): the §8 forged-clock
   * rule pins each op's self-clock entry to its actual local position, so
   * two interleaved async appends must not race the seq assignment.
   *
   * Backpressure (opt-in): with no option, append is fire-at-caller-rate —
   * a sustained fast writer can outrun every peer's fold and starve them
   * (vault-ld M2). Pass `{ backpressure: true }` (or `{ maxInflight,
   * ackTimeout }`), or configure the vault with `{ backpressure }`, and
   * append() runs two admission gates before issuing the op, both on the
   * same `maxInflight` watermark:
   *
   * 1. own fold — if `maxInflight` of this writer's ops are outstanding
   *    beyond its last awaited fold, await `update()` (folds the full
   *    linearized DAG, remote ops included), so the writer never builds a
   *    local append-vs-apply backlog;
   * 2. peer acknowledgment — if `maxInflight` of this writer's ops are
   *    beyond the highest seq of OUR ops any peer op's §3 clock has cited
   *    (i.e. beyond what any peer has demonstrably folded), wait for fresh
   *    acks, at most `ackTimeout` ms. Skipped until the vault has folded
   *    another writer's op (single-writer vaults never wait); on timeout
   *    the op is admitted anyway, so silent/partitioned peers degrade
   *    throughput to ~maxInflight per ackTimeout rather than deadlocking
   *    the writer. Disable per-op (`backpressure: false`) for deliberate
   *    offline/bulk writing.
   */
  append(type, payload = {}, opts = {}) {
    const run = this._appendChain.then(() => this._append(type, payload, opts))
    this._appendChain = run.then(
      () => {},
      () => {}
    )
    return run
  }

  async _append(type, payload, { optimistic = false, backpressure } = {}) {
    await this.ready()
    const bp = backpressure === undefined ? this._backpressure : normalizeBackpressure(backpressure)
    if (bp) {
      this._trackAcks = true
      await this._admit(bp)
    }
    const seq = this._nextSeq
    // §8 app-level containment: once this peer's own revocation record is
    // in the view, any new local op is uniformly rejected 'revoked' by
    // every peer's apply — refuse the append instead of growing the log
    // with dead ops. (Mirrors core's exact rule: actual-seq cross-check
    // first, claimed-clock strict precedence second.)
    await this._guardRevoked(payload.clock, seq)
    const op = { ...payload }
    if (op.clock === undefined) op.clock = await this.clock(seq)
    if (op.at === undefined) op.at = Date.now() // §3: informational only
    const buf = encodeOp(type, op) // may throw on a bad payload: seq not yet burned
    this._nextSeq = seq + 1
    await this.db.append(buf, { optimistic })
    return { seq, tag: makeTag(this.db.local.key, seq) }
  }

  /** The two admission gates (see append()). */
  async _admit(bp) {
    // gate 1: own fold — never run more than maxInflight ops ahead of the
    // writer's own last awaited fold
    if (this._nextSeq - this._foldedSeq >= bp.maxInflight) {
      const target = this._nextSeq
      await this.update()
      if (target > this._foldedSeq) this._foldedSeq = target
    }
    // gate 2: peer acknowledgment — never run more than maxInflight ops
    // ahead of what some peer's op clock proves that peer has folded
    if (!this._ackSeen) return
    const deadline = Date.now() + bp.ackTimeout
    while (!this._closing && this._nextSeq - this._bestAck >= bp.maxInflight) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) return // degrade instead of deadlocking (see append())
      await this._ackWait(remaining)
      if (this._closing) return
      // fold whatever arrived: acks only advance when remote ops fold
      await this.update()
    }
  }

  /** Resolves on the next applied batch (or after ms). */
  _ackWait(ms) {
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer)
        this._ackWaiters.delete(wake)
        resolve()
      }
      const timer = setTimeout(wake, ms)
      this._ackWaiters.add(wake)
    })
  }

  /**
   * The §3 clock payload: [[writerKeyHex, seq], ...] (0-based seqs),
   * sorted by key. Entries merge two observation sources:
   * - the view's seen/ family — the complete per-writer fold counts, so a
   *   remove-writer's clock always cites the target's observed position
   *   (§8: `seqAtRemoval` derives from exactly this entry);
   * - the autobee DAG heads (db.system.heads), which can run ahead of the
   *   committed view snapshot between drains.
   * The self entry is pinned to `seq`, the op's own 0-based position: §8's
   * forged-clock rule rejects any op whose claimed self entry differs from
   * its actual seq.
   */
  async clock(seq = null) {
    const entries = new Map()
    if (this.db && this.db.view) {
      for await (const { key, value } of this.scan(K.seenPrefix())) {
        const w = K.parseKey(key)[1]
        if (Number.isInteger(value) && value > 0) entries.set(w, value - 1)
      }
    }
    const heads = (this.db && this.db.system && this.db.system.heads) || []
    for (const h of heads) {
      if (!h.length) continue
      const w = b4a.toString(h.key, 'hex')
      const s = h.length - 1
      if ((entries.get(w) ?? -1) < s) entries.set(w, s)
    }
    if (this.db && this.db.local) {
      const self = b4a.toString(this.db.local.key, 'hex')
      if (seq !== null) entries.set(self, seq)
    }
    return [...entries].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  }

  /**
   * §8 revocation containment, app-level (autobee's positional teardown is
   * never used — see DEVIATIONS.md): refuse a local append once
   * `gov/removed/<self>` exists, mirroring core's apply rule exactly —
   * an op whose actual seq exceeds `seqAtRemoval` is dead regardless of
   * its claimed clock; within the window, only a caller-crafted clock that
   * strictly precedes the revocation clock survives.
   */
  async _guardRevoked(clock, seq) {
    if (!this.db || !this.db.local) return
    const self = b4a.toString(this.db.local.key, 'hex')
    const removed = await this.val(K.govRemoved(self))
    if (removed === undefined) return
    if (seq <= removed.seqAtRemoval && clock !== undefined) {
      const c = normalizeClock(clock)
      if (c && strictlyPrecedes(c, removed.clock)) return // apply accepts it
    }
    throw vaultError('VAULT_REVOKED', `local writer ${self} has been removed (§8)`)
  }

  // Governance ops (§8: apply rejects these unless the ISSUER is a
  // confirmed indexer at the op's linearized position; revocation is
  // causal — core's clock rule — never host.removeWriter).
  addWriter(key, { indexer = false } = {}) {
    return this.append('add-writer', { key: toKeyBuffer(key), indexer })
  }

  removeWriter(key) {
    return this.append('remove-writer', { key: toKeyBuffer(key) })
  }

  /** rateCeiling is a required wire uint; defaults to the metadata ceiling. */
  setWriterPolicy(key, { namespacePrefixes = [], rateCeiling } = {}) {
    return this.append('set-writer-policy', {
      key: toKeyBuffer(key),
      namespacePrefixes,
      rateCeiling: rateCeiling ?? this.metadata.rate.defaultCeiling
    })
  }

  // Content-op conveniences (thin over append()). `optimistic` and
  // `backpressure` are append options; everything else rides the payload.
  createConcept(path, type, opts = {}) {
    const { optimistic, backpressure, id, ...rest } = opts
    return this.append(
      'create-concept',
      { path, type, ...(id !== undefined ? { id } : {}), ...rest },
      { optimistic, backpressure }
    )
  }

  setField(id, key, value, opts = {}) {
    const { optimistic, backpressure, ...rest } = opts
    return this.append('set-field', { id, key, value, ...rest }, { optimistic, backpressure })
  }

  addTag(id, value, opts = {}) {
    const { optimistic, backpressure, ...rest } = opts
    return this.append('add-tag', { id, value, ...rest }, { optimistic, backpressure })
  }

  /**
   * §5 citation contract: computes and cites EVERY tag currently mapped to
   * `value` in this writer's resolved view (client libraries compute this
   * set — RemTag removes by observed tokens, never by value alone).
   */
  async remTag(id, value, opts = {}) {
    await this.update()
    const v = canonical.nfc(String(value))
    const rec = await this.val(K.cField(id, 'tags'))
    const els = (rec && rec.els) || {}
    const tags = Object.keys(els)
      .filter((t) => els[t] === v)
      .sort()
    const { optimistic, backpressure, ...rest } = opts
    return this.append('rem-tag', { id, value: v, tags, ...rest }, { optimistic, backpressure })
  }

  setBody(id, base, text, opts = {}) {
    const { optimistic, backpressure, ...rest } = opts
    return this.append('set-body', { id, base, text, ...rest }, { optimistic, backpressure })
  }

  setPath(id, path, opts = {}) {
    const { optimistic, backpressure, ...rest } = opts
    return this.append('set-path', { id, path, ...rest }, { optimistic, backpressure })
  }

  deleteConcept(id, opts = {}) {
    const { optimistic, backpressure, ...rest } = opts
    return this.append('delete-concept', { id, ...rest }, { optimistic, backpressure })
  }

  undeleteConcept(id, opts = {}) {
    const { optimistic, backpressure, ...rest } = opts
    return this.append('undelete-concept', { id, ...rest }, { optimistic, backpressure })
  }

  resolveConflict(id, keep, opts = {}) {
    const { optimistic, backpressure, supersede = [], text, ...rest } = opts
    return this.append(
      'resolve-conflict',
      { id, keep, supersede, ...(text !== undefined ? { text } : {}), ...rest },
      { optimistic, backpressure }
    )
  }

  // ---------- replication ----------

  /** Direct replication stream (autobee: store.replicate + wakeup wiring). */
  replicate(isInitiatorOrStream) {
    return this.db.replicate(isInitiatorOrStream)
  }

  /**
   * Join the vault's discovery key on hyperswarm; every connection is fed
   * to db.replicate. Pass a shared swarm here or in the constructor,
   * otherwise the vault creates (and owns) one. Returns the swarm.
   */
  async swarm(swarm = null) {
    await this.ready()
    if (swarm) this.swarmInstance = swarm
    if (!this.swarmInstance) {
      this.swarmInstance = new Hyperswarm()
      this._ownSwarm = true
    }
    if (!this._onConnection) {
      this._onConnection = (conn) => {
        conn.on('error', () => {})
        this.db.replicate(conn)
      }
      this.swarmInstance.on('connection', this._onConnection)
    }
    const discovery = this.swarmInstance.join(this.db.discoveryKey, { server: true, client: true })
    await discovery.flushed()
    return this.swarmInstance
  }

  async leaveSwarm() {
    if (!this.swarmInstance) return
    await this.swarmInstance.leave(this.db.discoveryKey)
    if (this._onConnection) {
      this.swarmInstance.off('connection', this._onConnection)
      this._onConnection = null
    }
  }
}

/**
 * Adapts autobee's host (lib/apply-calls.js) to the calls @auto-okf/core's
 * apply makes — addWriter(key, { isIndexer, weight }) and ackWriter(key) —
 * only ever for governance ops that passed the §8 authority check.
 * autobee's positional removeWriter is deliberately NOT exposed: §8
 * revocation is decided purely by core's in-log clock rule.
 */
class HostAdapter {
  constructor(host) {
    this.host = host
  }

  addWriter(key) {
    // UNIFORM TOPO WEIGHT (deviation from §8's literal `weight: 1`,
    // recorded in DEVIATIONS.md): autobee@1.0.10's linearization
    // comparators disagree for concurrent nodes of unequal weight
    // (lib/topo.js: isOrderedBefore() breaks the walk on
    // `node.weight < link.weight` while cmp() sorts higher weight first),
    // and autobee's GENESIS auto-add uses the DEFAULT weight 2 (index.js
    // _processApplyBatch → apply-calls.js `weight = isIndexer ? 2 : 1`,
    // isIndexer defaulting true) — uncontrollable from apply. §8's
    // substance is the UNIFORM weight; pinning it at 2 (the genesis value)
    // is the only uniform choice autobee 1.0.x permits, and is the
    // vault-ld harness-proven resolution. The indexer bit is dropped at
    // this level by autobee itself (apply-calls.js passes only weight to
    // system.addWriter); §8 governance authority is decided from gov/ by
    // core, never from autobee state. (Core passes { isIndexer, weight: 1 };
    // both are overridden here, which is the entire point of this adapter.)
    return this.host.addWriter(key, { isIndexer: true, weight: 2 })
  }

  ackWriter(key) {
    return this.host.ackWriter(key)
  }
}

/** `true` | `{ maxInflight, ackTimeout }` | falsy → normalized | null. */
function normalizeBackpressure(bp) {
  if (!bp) return null
  if (bp === true) return { maxInflight: DEFAULT_MAX_INFLIGHT, ackTimeout: DEFAULT_ACK_TIMEOUT }
  const n = Number(bp.maxInflight)
  const t = Number(bp.ackTimeout)
  return {
    maxInflight: Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_MAX_INFLIGHT,
    ackTimeout: Number.isFinite(t) && t >= 0 ? t : DEFAULT_ACK_TIMEOUT
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
