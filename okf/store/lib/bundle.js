// Bundle (okf SPEC §13 store deliverable): multiwriter vault lifecycle on
// autobee — corestore in (writer cores derived under the §10 per-generation
// namespace), Autobee up, @auto-okf/core's deterministic apply wired
// through the ViewAdapter into autobee's apply — plus §8 governance op
// emission, vault-metadata pinning (§8 append-only constant + §10 generation
// chain), hyperswarm replication, and opt-in append backpressure.
// Pattern ancestor: vault-ld/store/lib/vault.js (patterns only, no code
// path shared — SPEC §0 copy-don't-depend).
//
// autobee contract, verified against the source of autobee@2.12.1 (index.js,
// lib/*; first verified against 1.0.10 on 2026-07-13, re-verified for 2.12.1
// on 2026-10-23 — a STANDALONE multiwriter Hyperbee on hyperbee2 2.20 +
// hypercore 11; NO autobase), on corestore 7.16:
// - `new Autobee(store, key, { apply, open, close, update, encryptionKey,
//   encrypted, keyPair, optimistic, fastForward, ackThreshold,
//   bootstrapWeight, ... })`. `optimistic` defaults to true (index.js:95,
//   README.md:81). `bootstrapWeight` defaults to 2 (index.js:49) and is not
//   in the README. The Bundle sets `optimistic: false`, `fastForward:
//   false` and `bootstrapWeight: 0` (see the constructor call).
//   `ackThreshold` stays at its default of 32 (index.js:30, :134).
// - apply receives `(nodes, view, host)`, and only nodes with a non-empty
//   value (index.js _applyBatch); node = `{ key, value, length, optimistic,
//   timestamp, links, weight, witness, approvals, ... }` (lib/writers.js
//   createNode), where node.key is the WRITER core key — exactly the node
//   shape core's apply documents, so nodes pass through UNWRAPPED.
// - `view` is what the `open` handler returned: we return a ViewAdapter, so
//   core's apply sees the hyperbee2-flavored string-key surface it expects.
// - host (lib/apply-calls.js): `addWriter(key, { isIndexer = true, weight =
//   isIndexer ? 2 : 1 })` / `removeWriter(key)` / `ackWriter()` (a no-op
//   in v2) / `removeable(key)` / `interrupt(reason)` /
//   `createAnchor(key, length)` / `genesis` — adapted below (HostAdapter),
//   which exposes only addWriter, and always at weight 0.
// - instance: db.key, db.id, db.discoveryKey, db.local, db.view (read-only
//   snapshot), db.writable, db.isIndexer, append(buf|[bufs]) (the Bundle
//   never asks for an optimistic node), update()/updated()/flush(),
//   replicate(isInitiator|stream). db.isIndexer means a ceiling (maxWeight)
//   of 2 or more (lib/writers.js:352-354, :532), so it is always false
//   here: Bundle.isIndexer reads gov/ instead.
// - db.close() closes the corestore it was handed (index.js _close): we
//   hand it the per-generation namespace SESSION; the root corestore is closed
//   by Bundle.close() (corestore index.js _close: closing a session never
//   closes the root; closing the root closes every session).
// - genesis: autobee adds the bootstrap writer on its first node at
//   `bootstrapWeight` (index.js:1411-1413). The Bundle passes 0, so genesis
//   stands at weight 0 like every other writer (see HostAdapter). For a
//   creator the vault key IS the creator's local writer key (lib/boot.js),
//   so metadata.genesisKey === db.key on every peer and core's §8 genesis
//   indexer seeding agrees with autobee's.
//
// Admission comes before the first write. With `optimistic: false`,
// autobee applies a node only from a writer it has added, or from a removed
// writer that a later node still links (index.js:1357-1364). It drops any
// other node before _applyBatch: the node reaches no apply, its approvals
// add no writer (index.js:1432-1441), and the system records nothing. A
// plain node from a writer autobee has not added stops earlier, in that
// writer's _next (lib/writers.js:613-615). autobee still reads such a node,
// checks its links and resolves its weight before the drop
// (lib/writers.js:177-206, :547-618), and an outsider still reaches the
// wakeup protocol (G44, which the owner accepted as a residual).
// So a joiner writes only after an indexer's AddWriter op has linearized
// and core has granted its key (HostAdapter). Until then db.writable is
// false (index.js:196-198, lib/writers.js:208-216), and append() refuses
// with VAULT_NOT_WRITABLE (see _assertWritable). core still has its hold/
// buffer. Only a key that autobee added without an okf grant (a member
// forged an approval that names it) can put an op there now.
import { createHash } from 'node:crypto'
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

// The swarm namespace of this protocol. swarm() announces a vault on
// sha256(SWARM_NAMESPACE ‖ db.discoveryKey), never on the bare discovery
// key, so a peer that announces on another topic never finds the vault.
const SWARM_NAMESPACE = 'auto-okf/2'

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
    this._swarmTopic = null
    this._ownSwarm = false
    this._onConnection = null
    this._opts = opts
    this._coreApply = null
    this._applyBarrier = new Promise((resolve) => {
      this._applyBarrierResolve = resolve
    })
    this._nextSeq = 0 // §3 (AD4): the position of the next local node, see _nextPosition()
    this._foldedSeq = 0
    this._appendChain = Promise.resolve()
    this._appending = new Set() // every started append until it settles (see append())
    this._closedLength = null // see _lengthAfterClose()
    this._backpressure = normalizeBackpressure(opts.backpressure)
    this._trackAcks = !!this._backpressure
    this._ackSeen = false // ever folded another writer's op (multiwriter)
    this._bestAck = 0 // 1 + the highest position of ours that a peer op's clock has cited
    this._ackWaiters = new Set()
    this._closing = false
    this._readying = null
    this._isIndexer = false // okf authority from gov/ (see isIndexer)

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
      // Called after apply once db.view holds the new state (README
      // `update (view, changes)`; index.js:1051-1058), so isIndexer
      // follows gov/ as closely as db.writable follows autobee.
      update: () => this._refreshIndexer(),
      encryptionKey: this._opts.encryptionKey || null,
      encrypted,
      keyPair: this._opts.keyPair,
      // No optimistic nodes from writers autobee has not added. With this
      // false (read at index.js:95, where the default is true), autobee
      // drops such a node before _applyBatch (index.js:1357-1364), so an
      // outsider puts no op and no approval into apply (AD2). A writer
      // writes only after an indexer's AddWriter has linearized and core
      // granted it (HostAdapter). See the header.
      optimistic: false,
      // Weight 0 for every writer: autobee adds genesis on its first node
      // at this weight (index.js:1411-1413), not at the default 2
      // (index.js:49). HostAdapter grants every other writer at 0.
      bootstrapWeight: 0,
      // I2/I3: every peer folds every op through its own apply under the
      // pinned config. autobee@2 would otherwise fast-forward onto a view
      // head another writer stamped, trusting every writer by default
      // (lib/trusted.js), and skip apply for the whole prefix.
      fastForward: false
      // ackThreshold stays at its default. A threshold ack needs a head
      // that is not trusted (index.js:1303-1305), and with no isTrusted or
      // mostRecentTrusted hook every key is trusted (lib/trusted.js:30-32),
      // so autobee appends no ack at any threshold. An ack takes a
      // position in the local core, so it shifts no seq (§3, AD4), unless
      // it lands while _append waits between _nextPosition() and
      // db.append. A trust hook would make that window real.
    })
    this.db.on('error', (err) => this.emit('error', err))

    await this.db.ready()
    this._swarmTopic = swarmTopic(this.db.discoveryKey)

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
    // Fold what the cores already hold, so the view is current when open
    // resolves.
    await this.db.update()
    // §3, §8 forged-clock (AD4): the next op's seq is the position its node
    // takes in the local core, which starts at the core's length. It does
    // not depend on how far apply has folded the local core (G10).
    this._nextSeq = this.db.local.length
    this._foldedSeq = this._nextSeq
    // A reopen applies nothing, so the update handler has not run yet.
    await this._refreshIndexer()
    return this
  }

  /**
   * isIndexer from okf authority: gov/writer/<self> with indexer: true and
   * no gov/removed/<self> in db.view. That is core apply's live-indexer
   * rule (core/lib/apply.js:442). Only then does a new governance op from
   * this writer pass the revocation and issuer checks of core apply
   * (core/lib/apply.js:370-383).
   */
  async _refreshIndexer() {
    if (this._closing || !this.db || !this.db.local) return
    const self = b4a.toString(this.db.local.key, 'hex')
    const rec = await this.val(K.govWriter(self))
    const removed = await this.val(K.govRemoved(self))
    this._isIndexer = !!rec && rec.indexer === true && removed === undefined
  }

  _setApply(meta) {
    this._coreApply = createApply(applyConfig(meta))
    this._applyBarrierResolve()
  }

  // ---------- apply wiring (core apply over the autobee contract) ----------

  async _apply(nodes, view, host) {
    if (!this._coreApply) await this._applyBarrier
    if (!this._coreApply) throw vaultError('VAULT_NOT_OPEN', 'vault failed to open before apply')

    if (this._trackAcks) {
      for (const node of nodes) this._observeAck(node)
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
    // okf clocks carry 0-based positions (§3); the watermark is the next one.
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

  /**
   * okf authority (§8), never autobee's isIndexer: refreshed from gov/
   * after every view update and at open (_refreshIndexer).
   */
  get isIndexer() {
    return this._isIndexer
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

  /**
   * No append starts once close() begins: append() refuses with
   * VAULT_CLOSED. Every append that started before close() settles before
   * close() resolves (G11):
   * - First each one hands its node to autobee (the append chain). autobee's
   *   close sets _interrupting (index.js:392), and the drain then pulls in
   *   no more local nodes (index.js:797, :1580). So a db.append still in
   *   flight would resolve with its node only in memory.
   * - Then autobee closes. An append whose node is still not in the local
   *   core then fails VAULT_CLOSED_BEFORE_DURABLE, and its op is not
   *   written (see _durable() and _lengthAfterClose()). close() does not
   *   wait for such a node.
   */
  async close() {
    this._closing = true
    this._wakeAckWaiters() // release any append blocked in the ack gate
    await this._appendChain // settles, it never rejects (see append())
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
    await Promise.all(this._appending) // before the root store closes
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
   * family (each writer's last folded position plus one, §3), sorted by
   * writer key.
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
   * `clock` (the writer's observed vector clock — the last folded position
   * of each writer in okf's view, self entry pinned to this op's own seq
   * per the §8 forged-clock rule, see clock()) and `at` (informational
   * wall-clock ms, §3). Returns `{ seq, tag }` — `seq` is the position of
   * the op's node in the local core (§3), and `tag` is the §3 opId apply
   * will derive (`writerKey || seq`), which for a minting `create-concept`
   * is the concept's `_id`. It resolves only once the local core holds the
   * node (T10, see _durable()).
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
   *
   * Close (G11): an append that starts after close() begins fails with
   * VAULT_CLOSED. close() waits for every append that started before it.
   *
   * The chain serializes the appends only until autobee holds each node.
   * The wait for the local core runs outside it, so the next append can
   * take the next position while a node waits behind a missing link.
   */
  append(type, payload = {}, opts = {}) {
    if (this._closing) return Promise.reject(closedError())
    const run = this._appendChain.then(() => this._append(type, payload, opts))
    this._appendChain = run.then(
      () => {},
      () => {}
    )
    const durable = run.then((res) => this._durable(res.seq).then(() => res))
    const settled = durable.then(
      () => this._appending.delete(settled),
      () => this._appending.delete(settled)
    )
    this._appending.add(settled)
    return durable
  }

  /**
   * Resolves once the local core holds position `seq` (T10). A plain
   * db.append resolves with the drain that writes its node to the core, so
   * this mostly resolves at once. A node that waits behind an earlier local
   * node that links a missing block stays in autobee's memory
   * (lib/writers.js:624-631) until a later drain writes it. The wait listens
   * to the documented hypercore events of db.local (the local writer
   * Hypercore, autobee README): 'append' for a new length, and 'close'.
   * The local writer appends through db.local itself (lib/writers.js:19,
   * :37, :785). No timer polls.
   *
   * On 'close' the wait decides only once autobee has closed (see
   * _lengthAfterClose()). A flush that started before db.local closed can
   * still commit after it (hypercore index.js:1151, lib/session-state.js:
   * 683-785), and the closed session then gets no 'append'.
   */
  _durable(seq) {
    const local = this.db.local
    if (local.length > seq) return Promise.resolve()
    return new Promise((resolve, reject) => {
      let waiting = true
      const onAppend = () => {
        if (local.length > seq) done(null)
      }
      const onClose = () => {
        local.off('append', onAppend)
        this._lengthAfterClose().then(
          (length) => done(length > seq ? null : closedBeforeDurableError(seq)),
          done
        )
      }
      const done = (err) => {
        if (!waiting) return
        waiting = false
        local.off('append', onAppend)
        local.off('close', onClose)
        if (err) reject(err)
        else resolve()
      }
      local.on('append', onAppend)
      local.once('close', onClose)
      if (!local.readable) onClose() // it closed before the wait began
    })
  }

  /**
   * The length of the local core once autobee has closed, read from storage
   * through the root corestore, which the Bundle closes last. A node that
   * is not in the core then never lands, also not after a reopen:
   * - It lives only in the writer's pending list (lib/writers.js:732-755).
   * - Writer.flush is the only code that writes it to the core
   *   (lib/writers.js:768-789). It runs only from the drain (index.js:824,
   *   :1578-1597, lib/writers.js:137-147).
   * - autobee's close calls no flush. It closes the writers and db.local,
   *   and then awaits the drain in flight (index.js:391-452, :424, :439,
   *   :446).
   * - A reopen starts the writer with no pending node, at the core length
   *   (lib/writers.js:329-331).
   * - A node that waits behind a missing link never reached apply, so no
   *   view or system state holds it (lib/writers.js:556-631).
   * So an append that fails VAULT_CLOSED_BEFORE_DURABLE wrote nothing, and
   * a retry writes the op once.
   */
  _lengthAfterClose() {
    if (!this._closedLength) {
      this._closedLength = this.db.close().then(async () => {
        const core = this.store.get({ key: this.db.local.key, active: false })
        try {
          await core.ready()
          return core.length
        } finally {
          await core.close()
        }
      })
    }
    return this._closedLength
  }

  async _append(type, payload, { backpressure } = {}) {
    await this.ready()
    this._assertWritable() // fail fast, before any gate waits
    const bp = backpressure === undefined ? this._backpressure : normalizeBackpressure(backpressure)
    this._nextSeq = this._nextPosition() // the gates count positions
    if (bp) {
      this._trackAcks = true
      await this._admit(bp)
    }
    const seq = this._nextPosition()
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
    // Again after the awaits above: a fold can take the grant away.
    this._assertWritable()
    // Appends are serialized (append()), so the seq moves only once
    // autobee holds the node. A plain append: autobee runs with
    // optimistic: false.
    await this.db.append(buf)
    this._nextSeq = seq + 1
    return { seq, tag: makeTag(this.db.local.key, seq) }
  }

  /**
   * §3, §8 forged-clock (AD4): the position that the next local node takes
   * in the local core (db.local, documented). autobee gives a new local
   * node the core length plus the count of local nodes it has not yet
   * written to the core (lib/writers.js:332, :748). The Bundle is the only
   * writer of the local core, and its appends are serialized (append()):
   * - A plain db.append resolves with the drain that applies its node and
   *   writes it to the core (index.js:1575, :633-645, :766-831, :824;
   *   lib/writers.js:137-147, :768-789). So the core length counts every
   *   earlier node.
   * - The drain cannot write a node that waits behind an earlier local
   *   node, such as a node of the local core that a reopen cannot fold yet
   *   because it links a node that is not in the system (lib/writers.js:
   *   602-605, :673-723). Then the core length is behind, and _nextSeq,
   *   one past the seq of the last append, holds the position.
   * - autobee's only other local append is the empty ack
   *   (index.js:1297-1314, :1312). okf's configuration never triggers it.
   *   A threshold ack needs a head that is not trusted (index.js:1305,
   *   :1316-1330), and with no trust hook every key is trusted
   *   (lib/trusted.js:30-32). The ack after a reindex needs a system or
   *   view core below manifest version 3 (index.js:693, :707, :738-751),
   *   and this release creates both at version 3 (index.js:213-221).
   */
  _nextPosition() {
    return Math.max(this.db.local.length, this._nextSeq)
  }

  /**
   * Refuse an append unless autobee has added this writer and not
   * removed it: `db.writable` (autobee index.js:196-198, lib/writers.js:
   * 208-216). autobee's own append refuses only a removed writer
   * (index.js:1531-1533). A writer it never added gets past that, fails
   * the local flush with 'Not writable' (lib/writers.js:633-638), and
   * autobee closes itself while the append resolves (index.js:669-690,
   * G12). This check throws before the seq moves and before anything
   * reaches the local core.
   */
  _assertWritable() {
    if (this.db.writable) return
    const self = b4a.toString(this.db.local.key, 'hex')
    const err = vaultError(
      'VAULT_NOT_WRITABLE',
      `local writer ${self} is not writable yet; an indexer must admit it with add-writer (§8)`
    )
    err.writerKey = self
    throw err
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
   * The §3 clock payload: [[writerKeyHex, seq], ...] (0-based positions),
   * sorted by key. Every entry comes from okf's view: seen/<W> is W's last
   * folded position plus one (§3, AD4), so the entry is that position. A
   * remove-writer's clock cites the target's last folded position (§8:
   * `seqAtRemoval` derives from exactly this entry), in the same unit as
   * the seq of every op (G8). No entry comes from substrate state that the
   * view has not folded.
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

  // Content-op conveniences (thin over append()). `backpressure` is the
  // one append option; everything else rides the payload.
  createConcept(path, type, opts = {}) {
    const { backpressure, id, ...rest } = opts
    return this.append(
      'create-concept',
      { path, type, ...(id !== undefined ? { id } : {}), ...rest },
      { backpressure }
    )
  }

  setField(id, key, value, opts = {}) {
    const { backpressure, ...rest } = opts
    return this.append('set-field', { id, key, value, ...rest }, { backpressure })
  }

  addTag(id, value, opts = {}) {
    const { backpressure, ...rest } = opts
    return this.append('add-tag', { id, value, ...rest }, { backpressure })
  }

  /**
   * §5 citation contract: computes and cites EVERY tag currently mapped to
   * `value` in this writer's resolved view (client libraries compute this
   * set — RemTag removes by observed tokens, never by value alone).
   */
  async remTag(id, value, opts = {}) {
    if (this._closing) throw closedError() // before the reads, as append() does
    await this.update()
    const v = canonical.nfc(String(value))
    const rec = await this.val(K.cField(id, 'tags'))
    const els = (rec && rec.els) || {}
    const tags = Object.keys(els)
      .filter((t) => els[t] === v)
      .sort()
    const { backpressure, ...rest } = opts
    return this.append('rem-tag', { id, value: v, tags, ...rest }, { backpressure })
  }

  setBody(id, base, text, opts = {}) {
    const { backpressure, ...rest } = opts
    return this.append('set-body', { id, base, text, ...rest }, { backpressure })
  }

  setPath(id, path, opts = {}) {
    const { backpressure, ...rest } = opts
    return this.append('set-path', { id, path, ...rest }, { backpressure })
  }

  deleteConcept(id, opts = {}) {
    const { backpressure, ...rest } = opts
    return this.append('delete-concept', { id, ...rest }, { backpressure })
  }

  undeleteConcept(id, opts = {}) {
    const { backpressure, ...rest } = opts
    return this.append('undelete-concept', { id, ...rest }, { backpressure })
  }

  resolveConflict(id, keep, opts = {}) {
    const { backpressure, supersede = [], text, ...rest } = opts
    return this.append(
      'resolve-conflict',
      { id, keep, supersede, ...(text !== undefined ? { text } : {}), ...rest },
      { backpressure }
    )
  }

  // ---------- replication ----------

  /** Direct replication stream (autobee: store.replicate + wakeup wiring). */
  replicate(isInitiatorOrStream) {
    return this.db.replicate(isInitiatorOrStream)
  }

  /**
   * Join the vault's auto-okf/2 topic on hyperswarm,
   * sha256('auto-okf/2' ‖ db.discoveryKey); every connection is fed to
   * db.replicate. Pass a shared swarm here or in the constructor,
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
    const discovery = this.swarmInstance.join(this._swarmTopic, { server: true, client: true })
    await discovery.flushed()
    return this.swarmInstance
  }

  /** Leave the topic that swarm() joined. */
  async leaveSwarm() {
    if (!this.swarmInstance) return
    await this.swarmInstance.leave(this._swarmTopic)
    if (this._onConnection) {
      this.swarmInstance.off('connection', this._onConnection)
      this._onConnection = null
    }
  }
}

/**
 * Adapts autobee's host (lib/apply-calls.js) to the one call @auto-okf/core's
 * apply makes — addWriter(key, { isIndexer, weight }) — only ever for
 * governance ops that passed the §8 authority check.
 * autobee's positional removeWriter is deliberately NOT exposed: §8
 * revocation is decided purely by core's in-log clock rule.
 */
class HostAdapter {
  constructor(host) {
    this.host = host
  }

  addWriter(key) {
    // WEIGHT 0 FOR EVERY WRITER. Core passes { isIndexer, weight: 1 } (§8's
    // literal grant). This adapter overrides both and grants { weight: 0 }.
    // With `bootstrapWeight: 0` (the constructor call), genesis stands at 0
    // too. What that means on autobee@2.12.1:
    // - The grant records the key at weight 0 with ceiling (maxWeight) 0
    //   (lib/apply-calls.js:33-41, lib/system.js:66-92). isIndexer only
    //   selects the default weight (lib/apply-calls.js:33), so the adapter
    //   does not pass it. A grant at 0 opens no promotion request
    //   (lib/system.js:78, lib/promotions.js:111-113).
    // - Order: nodes sort by weight, then timestamp, then writer key, then
    //   length (lib/topo.js:168-179). Every weight is 0, so nodes sort by
    //   timestamp, then key.
    // - No approval: an append collects approvals only when its writer has
    //   a standing above 0 (index.js:1250-1255, :1555). The standing is the
    //   writer's current weight (index.js:1223-1226, lib/witness.js:8-12).
    // - No witness: an append cites one only when the writer's grant hint
    //   is heavier than its current weight (index.js:1546-1553). A grant
    //   through this host sets no hint (lib/system.js:76-77: no anchor).
    // - No climb: a witness raises a weight only when the approver it cites
    //   has a standing of at least the claimed weight (lib/witness.js:19-51).
    //   Genesis qualifies only up to bootstrapWeight (lib/witness.js:47),
    //   and every other writer stands at 0, so no claim above 0 verifies.
    // So no resolved weight depends on a node's position (the G1 livelock
    // mechanism). autobee's isIndexer is always false (see the header), and
    // Bundle.isIndexer reads gov/.
    //
    // A member can still forge a node with approvals. autobee then adds
    // each named key at weight 0, because the carrier's weight caps the
    // grant (index.js:1432-1441, lib/system.js:75). okf membership still
    // comes only from gov/, which core decides.
    //
    // Returned, not fire-and-forget: core awaits it, and an un-awaited
    // grant can miss autobee's system flush.
    return this.host.addWriter(key, { weight: 0 })
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

/** The 32-byte hyperswarm topic of a vault: sha256(SWARM_NAMESPACE ‖ discoveryKey). */
function swarmTopic(discoveryKey) {
  return createHash('sha256').update(SWARM_NAMESPACE).update(discoveryKey).digest()
}

function toKeyBuffer(key) {
  return b4a.from(keyHex(key), 'hex')
}

function closedError() {
  return vaultError('VAULT_CLOSED', 'the vault is closing or closed, so no new append starts')
}

function closedBeforeDurableError(seq) {
  const err = vaultError(
    'VAULT_CLOSED_BEFORE_DURABLE',
    `the vault closed before the node at position ${seq} reached the local core; the op is not written`
  )
  err.seq = seq
  return err
}

function vaultError(code, message) {
  const err = new Error(`${code}: ${message}`)
  err.code = code
  return err
}
