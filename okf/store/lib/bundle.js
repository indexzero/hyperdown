// Bundle: the lifecycle of one multiwriter vault on autobee. It wires the
// apply of @auto-okf/core into autobee through the ViewAdapter and emits
// the governance ops. It pins the vault metadata, replicates over
// hyperswarm and offers opt-in append backpressure. See SPEC §8, §10, §13.

// Nodes pass to core's apply unwrapped. An autobee node has the
// `{ key, value, length }` shape that core documents, and node.key is the
// writer core key. A grant gives no membership: only a gov/writer record
// does. Why okf relies on each autobee behaviour, with the source:
// okf/DEVIATIONS.md, "Substrate behaviour that okf relies on".
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
  keyHex,
  swarmKeyHex,
  swarmKeyList
} from './metadata.js'

// Writer cores, and autobee's system and view cores, derive under this
// prefix plus metadata.generation. So a writer key pair never recurs across
// generations in a reused corestore directory. See SPEC §10.
const GENERATION_NS = 'okf/generation/'

// swarm() announces a vault on sha256(SWARM_NAMESPACE ‖ db.discoveryKey),
// never on the bare discovery key.
const SWARM_NAMESPACE = 'auto-okf/2'

// The name of the swarm key pair. corestore's createKeyPair derives it
// from the primary key of the root store. So a peer keeps one swarm key
// across restarts and generations, apart from its writer keys.
const SWARM_KEY_NAME = 'auto-okf/swarm'

// hyperswarm bans each key that the firewall rejects and never collects
// the record, so a flood of fresh keys grows swarm.peers without a bound.
// _recordBan lifts the oldest ban past this count, and the firewall
// rejects that key again at its next attempt. 64 is hyperswarm's default
// maxPeers, so the table holds no more rejected peers than admitted ones.
const MAX_BANNED_PEERS = 64

// Defaults for the opt-in append backpressure (append()). A throttle on
// the local fold alone is not enough, because the fold of a fast writer
// stays cheap while the drowning peers send little. So the second gate
// waits on the fold progress that peer clocks prove, at most ackTimeout
// ms. A silent peer slows the writer but never deadlocks it.
const DEFAULT_MAX_INFLIGHT = 1
const DEFAULT_ACK_TIMEOUT = 1500

export class Bundle extends EventEmitter {
  /**
   * @param {string|Corestore} storage a directory, with the metadata pinned
   *   to `<dir>/okf-vault.json`, or a Corestore that the vault owns, with
   *   the metadata in memory
   * @param {object} [opts]
   *   key            the vault key to join (Buffer or hex). Omit it to create or open.
   *   metadata       invite metadata overrides (predecessorKey, limits, rate, ...)
   *   encryptionKey  32-byte key of a private vault. autobee persists it in
   *                  the userData of the local core, so a reopen needs no key.
   *   keyPair        the signing key pair of the local writer
   *   backpressure   `true` or `{ maxInflight, ackTimeout }`, see append(). Default: off.
   */
  constructor(storage, opts = {}) {
    super()
    this.dir = typeof storage === 'string' ? storage : null
    this.store = this.dir ? new Corestore(this.dir) : storage
    this.db = null
    this.metadata = null
    this.generation = null
    this.swarmInstance = null
    this._swarmKeyPair = null
    this._swarmTopic = null
    this._discovery = null
    this._onConnection = null
    this._onBan = null
    this._banned = new Set() // banned keys (hex), oldest first
    this._allowed = new Set() // the swarm keys (hex) that the firewall admits
    this._localAllow = new Set() // the keys (hex) of swarm({ allow }), this peer only
    this._revokedPeers = new Set() // revokePeer() keys (hex), out for the life of the Bundle
    this._allowChain = Promise.resolve() // serializes _refreshAllowlist()
    this._opts = opts
    this._coreApply = null
    this._applyBarrier = new Promise((resolve) => {
      this._applyBarrierResolve = resolve
    })
    this._nextSeq = 0 // the position of the next local node, see _nextPosition()
    this._foldedSeq = 0
    this._appendChain = Promise.resolve()
    this._appending = new Set() // every started append until it settles
    this._closedLength = null // see _lengthAfterClose()
    this._backpressure = normalizeBackpressure(opts.backpressure)
    this._trackAcks = !!this._backpressure
    this._ackSeen = false // true once an op of another writer folded
    this._bestAck = 0 // one past the highest own position that a peer clock cited
    this._ackWaiters = new Set()
    this._closing = false
    this._readying = null
    this._isIndexer = false // from gov/, see isIndexer

    this.writers = {
      add: (key, opts2) => this.addWriter(key, opts2),
      remove: (key) => this.removeWriter(key),
      setPolicy: (key, policy) => this.setWriterPolicy(key, policy)
    }
  }

  /** Create a new vault and pin its metadata. */
  static async init(storage, opts = {}) {
    const vault = new Bundle(storage, opts)
    await vault.ready()
    return vault
  }

  /** Open a vault that init or join made at `storage`. */
  static async open(storage, opts = {}) {
    const vault = new Bundle(storage, opts)
    await vault.ready()
    return vault
  }

  /** Join a vault by key. opts carries the invite metadata and encryptionKey. */
  static async join(storage, key, opts = {}) {
    const vault = new Bundle(storage, { ...opts, key })
    await vault.ready()
    return vault
  }

  /**
   * The swarm key of a storage directory, also before it holds a vault. So
   * a fleet can collect each key before the creator writes the invite. Do
   * not call it on a directory that an open Bundle holds.
   */
  static async readSwarmKey(dir) {
    const store = new Corestore(dir)
    try {
      return (await store.createKeyPair(SWARM_KEY_NAME)).publicKey
    } finally {
      await store.close()
    }
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

    // Set the apply configuration before the Autobee exists, so replayed
    // nodes fold under the pinned metadata.
    if (stored) this._setApply(stored)

    // The generation is a function of predecessorKey alone. See SPEC §10.
    const predKey = stored
      ? stored.predecessorKey
      : (overrides && overrides.predecessorKey) ?? null
    this.generation = generationId(predKey)
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
      // db.view and the working view of apply share one surface.
      open: (bee) => new ViewAdapter(bee),
      // Runs after apply, once db.view holds the new state, so isIndexer
      // and the swarm firewall follow gov/.
      update: () => this._onViewUpdate(),
      encryptionKey: this._opts.encryptionKey || null,
      encrypted,
      keyPair: this._opts.keyPair,
      // The default is true. With false, autobee drops a node from a writer
      // it has not added before apply, so an outsider puts nothing into apply.
      optimistic: false,
      // The default is 2. Genesis stands at 0 like every writer that
      // HostAdapter grants.
      bootstrapWeight: 0,
      // Every peer folds every op through its own apply (I2, I3). autobee
      // otherwise adopts a view head that another writer stamped and skips
      // apply for the whole prefix.
      fastForward: false
      // ackThreshold stays at its default. Do not add an isTrusted or
      // mostRecentTrusted hook. autobee then appends acks, and an ack takes
      // a position in the local core between _nextPosition() and db.append.
    })
    this.db.on('error', (err) => this.emit('error', err))

    await this.db.ready()
    this._swarmTopic = swarmTopic(this.db.discoveryKey)
    this._swarmKeyPair = await this.store.createKeyPair(SWARM_KEY_NAME)

    const vaultKeyHex = b4a.toString(this.db.key, 'hex')
    // The vault key is the local writer key of the creator. The creator
    // lists its own swarm key in metadata.swarm.allow, so a joiner can dial
    // one peer before any fold, and binds it as swarm.genesis. See SPEC §8.
    const creator = b4a.equals(this.db.key, this.db.local.key)
    let meta = stored
    if (!meta) {
      meta = createMetadata(
        this._withOwnSwarmKey(creator, {
          ...(overrides || {}),
          genesisKey: (overrides && overrides.genesisKey) || vaultKeyHex,
          encrypted
        })
      )
      if (metaPath) await saveMetadata(metaPath, meta)
    } else if (overrides) {
      // A re-supplied invite must agree with the pinned document (I2).
      const invited = createMetadata(
        this._withOwnSwarmKey(creator, {
          ...overrides,
          genesisKey: overrides.genesisKey || meta.genesisKey,
          encrypted: overrides.encrypted === undefined ? meta.encrypted : overrides.encrypted
        })
      )
      if (metadataHash(invited) !== metadataHash(meta)) {
        // Every creator binds its swarm key. A pinned document without the
        // binding came from the vault key alone, so it lacks the swarm group
        // of the invite.
        if (meta.swarm.genesis === null && invited.swarm.genesis !== null) {
          throw vaultError(
            'VAULT_JOINED_WITHOUT_INVITE',
            'this directory joined without the invite, so its pinned metadata has no swarm group of the ' +
              'invite (metadata.swarm.genesis is null), and pinned metadata never changes; join again in a new ' +
              'directory with the invite (Bundle.join(dir, key, { metadata: invite }), or ' +
              '`auto-okf join <dir> <vault-key> --metadata <okf-vault.json>`)'
          )
        }
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
    await this._wakeWriters()
    // Fold what the cores hold, so the view is current when open resolves.
    await this.db.update()
    // The seq of the next op is its node's position in the local core,
    // not the fold progress of apply. See _nextPosition().
    this._nextSeq = this.db.local.length
    this._foldedSeq = this._nextSeq
    // A reopen applies nothing, so the update handler did not run.
    await this._refreshIndexer()
    return this
  }

  /**
   * Wake the writer of each gov/writer record. autobee restarts only the
   * system heads, so a peer that closed mid-heal stays behind until
   * somebody writes. A revoked writer wakes too: apply decides its later
   * ops. A key that only seen/ holds never wakes, because each wakeup opens
   * a core and a member can mint such keys without bound.
   */
  async _wakeWriters() {
    const self = b4a.toString(this.db.local.key, 'hex')
    const keys = []
    for await (const { key } of this.scan(K.govWriterPrefix())) {
      const writer = K.parseKey(key)[2]
      if (writer !== self) keys.push(b4a.from(writer, 'hex'))
    }
    await Promise.all(keys.map((key) => this.db.wakeup({ key, length: 0 })))
  }

  /** Refresh isIndexer and the firewall allowlist from gov/ after every fold. */
  async _onViewUpdate() {
    await this._refreshIndexer()
    if (this.swarmInstance) await this._refreshAllowlist()
  }

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

  /**
   * The metadata input with the creator's own swarm key in swarm.allow and
   * as swarm.genesis. Only the creator holds the swarm key of genesisKey,
   * so a supplied genesis that is another key fails VAULT_BAD_SWARM_GENESIS.
   */
  _withOwnSwarmKey(creator, input) {
    if (!creator) return input
    const swarm = input.swarm === undefined ? {} : input.swarm
    if (swarm === null || typeof swarm !== 'object' || Array.isArray(swarm)) return input
    const allow = swarm.allow === undefined ? [] : swarmKeyList(swarm.allow, 'metadata.swarm.allow')
    const own = b4a.toString(this._swarmKeyPair.publicKey, 'hex')
    if (swarm.genesis !== undefined && swarmKeyHex(swarm.genesis) !== own) {
      const given = swarmKeyHex(swarm.genesis)
      throw vaultError(
        'VAULT_BAD_SWARM_GENESIS',
        given === null
          ? 'metadata.swarm.genesis is not a swarm key (32 bytes or 64 hex characters)'
          : `metadata.swarm.genesis names ${given}, not the swarm key of the creator ${own}`
      )
    }
    return { ...input, swarm: { ...swarm, allow: allow.includes(own) ? allow : [...allow, own], genesis: own } }
  }

  // ---------- apply wiring (core apply over the autobee contract) ----------

  async _apply(nodes, view, host) {
    if (!this._coreApply) await this._applyBarrier
    if (!this._coreApply) throw vaultError('VAULT_NOT_OPEN', 'vault failed to open before apply')

    if (this._trackAcks) {
      for (const node of nodes) this._observeAck(node)
    }
    await this._coreApply(nodes, view, new HostAdapter(host))
    this._wakeAckWaiters()
  }

  /**
   * A folded remote op whose clock cites our writer at seq s proves that
   * the peer folded us through s. That is the ack that the second gate of
   * _admit() waits on. A peer cites us only once its view holds our
   * gov/writer record.
   */
  _observeAck(node) {
    if (!this.db || !this.db.local || b4a.equals(node.key, this.db.local.key)) return
    this._ackSeen = true
    const dec = decodeOp(Buffer.isBuffer(node.value) ? node.value : Buffer.from(node.value || []))
    if (!dec.ok || !dec.op) return // an undecodable op carries no ack
    const clock = normalizeClock(dec.op.clock)
    if (!clock) return
    const seq = clock[b4a.toString(this.db.local.key, 'hex')]
    // the entry is a position, the watermark is one past it
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

  /** The writer key of this peer, what an indexer passes to writers.add. */
  get localKey() {
    return this.db && this.db.local ? this.db.local.key : null
  }

  /**
   * The hyperswarm public key of this peer, stable across restarts. An
   * indexer passes it to writers.add as `swarmKey` or lists it in the invite.
   */
  get swarmKey() {
    return this._swarmKeyPair ? this._swarmKeyPair.publicKey : null
  }

  get writable() {
    return !!this.db && this.db.writable
  }

  /** okf authority from gov/ (SPEC §8), never autobee's isIndexer. */
  get isIndexer() {
    return this._isIndexer
  }

  /** The ViewAdapter over autobee's read-only view snapshot. */
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
   * Once close() begins, append() fails VAULT_CLOSED, and every earlier
   * append settles before close() resolves. In this order:
   * 1. autobee closes, with no wait for appends. A db.append can wait for a
   *    block that no peer sends, and only this close ends that wait.
   * 2. Every append settles (_append(), _durable()).
   * 3. The root corestore closes last: _lengthAfterClose() reads through it.
   */
  async close() {
    this._closing = true
    this._wakeAckWaiters() // release any append blocked in the ack gate
    await this._destroySwarm()
    if (this.db) await this.db.close() // step 1
    await Promise.all(this._appending) // step 2
    await this.store.close() // step 3
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

  /** Async iterable of `{ key, value }` (JSON-decoded) over a keyspace prefix. */
  scan(prefix) {
    const stream = this.db.view.createReadStream(K.range(prefix))
    return (async function* () {
      for await (const { key, value } of stream) {
        yield { key, value: JSON.parse(value) }
      }
    })()
  }

  /** Hash of a full scan of the view, byte-compatible with MemView.hash() of core (I2, I3). */
  async snapshotHash() {
    await this.update()
    return viewHash(this.db.view)
  }

  /** Alias for snapshotHash(). */
  hash() {
    return this.snapshotHash()
  }

  // ---------- op emission (SPEC §3, §8) ----------

  /**
   * Encode and append one op. Fills `clock` (clock()) and `at` (wall clock
   * ms, informational) when absent. Returns `{ seq, tag }` once the local
   * core holds the node (_durable()). `seq` is the node's position in
   * the local core, and `tag` is the opId that apply derives. Appends run
   * one at a time. The forged-clock rule of SPEC §8 pins the self entry of
   * each clock to the real position of its node.
   *
   * `backpressure` is off by default. `true` or `{ maxInflight, ackTimeout }`
   * gates the op on the own fold of this writer and on the fold that peer
   * clocks prove (_admit()). Pass `false` per op for bulk writing. Once
   * close() begins, a new append fails VAULT_CLOSED, and an earlier one
   * fails VAULT_CLOSED_BEFORE_DURABLE unless its node reached the core.
   */
  append(type, payload = {}, opts = {}) {
    if (this._closing) return Promise.reject(closedError())
    const run = this._appendChain.then(() => this._append(type, payload, opts))
    this._appendChain = run.then(
      () => {},
      () => {}
    )
    // The wait for the core runs outside the chain, so the next append takes
    // the next position while this node waits behind a missing link.
    const durable = run.then((res) => this._durable(res.seq).then(() => res))
    const settled = durable.then(
      () => this._appending.delete(settled),
      () => this._appending.delete(settled)
    )
    this._appending.add(settled)
    return durable
  }

  /**
   * Resolves once the local core holds position `seq`. A node that waits
   * behind a missing link stays in autobee's memory until a later drain
   * writes it. So the wait listens to the 'append' and 'close' events of
   * db.local. On 'close' it waits for autobee to close (_lengthAfterClose()),
   * because a flush that started before can still commit after.
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
   * The length of the local core once autobee has closed. A node that is
   * not in the core then never lands. Only the drain writes a pending node,
   * autobee's close runs no flush, and a reopen starts the writer at the
   * core length. So an append that fails VAULT_CLOSED_BEFORE_DURABLE wrote
   * nothing, and a retry writes the op once.
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

  /**
   * Once close() begins, an append hands autobee no node. It reads
   * _closing before it reads autobee, after the gates, and once more before
   * db.append with no await between. Each such exit is
   * VAULT_CLOSED_BEFORE_DURABLE. If autobee closes during db.append,
   * _durable() decides from the core length after the close.
   */
  async _append(type, payload, { backpressure } = {}) {
    await this.ready()
    let seq = null
    let buf
    try {
      this._assertOpen(seq) // an append queued behind one that close() cut
      this._assertWritable() // fail fast, before any gate waits
      const bp = backpressure === undefined ? this._backpressure : normalizeBackpressure(backpressure)
      this._nextSeq = this._nextPosition() // the gates count positions
      if (bp) {
        this._trackAcks = true
        await this._admit(bp)
      }
      seq = this._nextPosition()
      this._assertOpen(seq) // close() releases the gates
      // Once the view holds this writer's own revocation, apply on every
      // peer rejects its new ops as 'revoked'. Refuse instead of growing
      // the log.
      await this._guardRevoked(payload.clock, seq)
      const op = { ...payload }
      if (op.clock === undefined) op.clock = await this.clock(seq)
      if (op.at === undefined) op.at = Date.now() // informational only
      buf = encodeOp(type, op) // can throw on a bad payload, the seq is not burned yet
      // Again after the awaits above: a fold can take the grant away.
      this._assertWritable()
      this._assertOpen(seq) // no await from here to db.append
    } catch (err) {
      throw this._closing ? closedBeforeDurableError(seq) : err
    }
    // The seq moves only once autobee holds the node.
    try {
      await this.db.append(buf)
    } catch (err) {
      if (!this._closing) throw err
      // autobee closed during db.append, so _durable() decides
    }
    this._nextSeq = seq + 1
    return { seq, tag: makeTag(this.db.local.key, seq) }
  }

  /** Once close() begins, no append hands autobee a node (see _append()). */
  _assertOpen(seq) {
    if (this._closing) throw closedBeforeDurableError(seq)
  }

  /**
   * The position that the next local node takes in the local core. That is
   * the core length, or _nextSeq when a node waits behind a missing link
   * and the drain has not written it. The Bundle is the only writer of the
   * local core, its appends run one at a time, and okf never triggers
   * autobee's own ack append.
   */
  _nextPosition() {
    return Math.max(this.db.local.length, this._nextSeq)
  }

  /**
   * Refuse an append unless autobee has added this writer and not removed
   * it (db.writable). autobee's own append refuses only a removed writer.
   * A writer it never added fails the local flush with 'Not writable', and
   * autobee closes itself while the append resolves. It throws before the
   * seq moves.
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
    // gate 1: own fold
    if (this._nextSeq - this._foldedSeq >= bp.maxInflight) {
      const target = this._nextSeq
      await this.update()
      if (target > this._foldedSeq) this._foldedSeq = target
    }
    // gate 2: peer ack
    if (!this._ackSeen) return
    const deadline = Date.now() + bp.ackTimeout
    while (!this._closing && this._nextSeq - this._bestAck >= bp.maxInflight) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) return // slow down, do not deadlock
      await this._ackWait(remaining)
      if (this._closing) return
      // acks advance only when remote ops fold
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
   * The clock of an op: [[writerKeyHex, seq], ...]. Each entry is seen/<W>
   * minus one. The clock carries self and each writer with a gov/writer
   * record, and no other key. A revoked writer stays in it, because the
   * window test of SPEC §8 compares every entry. The self entry is `seq`,
   * the real position of the op, record or not.
   */
  async clock(seq = null) {
    const entries = new Map()
    const self = this.db && this.db.local ? b4a.toString(this.db.local.key, 'hex') : null
    if (this.db && this.db.view) {
      const writers = []
      for await (const { key } of this.scan(K.govWriterPrefix())) writers.push(K.parseKey(key)[2])
      if (self !== null && seq === null) writers.push(self)
      for (const w of writers) {
        const value = await this.val(K.seen(w))
        if (Number.isInteger(value) && value > 0) entries.set(w, value - 1)
      }
    }
    if (self !== null && seq !== null) entries.set(self, seq)
    return [...entries].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  }

  /**
   * Refuse a local append once `gov/removed/<self>` exists, with the rule
   * of apply. An op past `seqAtRemoval` is dead. Within the window only a
   * clock that strictly precedes the revocation clock survives.
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

  // Governance ops. apply accepts them only from an indexer. See SPEC §8.
  /**
   * `key`: the writer key, 32 bytes or 64 hex characters. Each governance
   * helper fails VAULT_BAD_WRITER_KEY on any other key before it appends.
   * `swarmKey` (optional): the swarm key of the writer, 32 bytes or 64 hex.
   * apply stores it on gov/writer/<key>, and the firewall of every peer
   * then admits it (swarm()).
   */
  addWriter(key, { indexer = false, swarmKey = null } = {}) {
    const writerKey = toKeyBuffer(key)
    if (!writerKey) return Promise.reject(badWriterKeyError())
    const payload = { key: writerKey, indexer }
    if (swarmKey !== null && swarmKey !== undefined) {
      const buf = swarmKeyBuffer(swarmKey)
      if (!buf) {
        return Promise.reject(
          vaultError('VAULT_BAD_SWARM_KEY', 'swarmKey must be 32 bytes or 64 hex characters')
        )
      }
      payload.swarmKey = buf
    }
    return this.append('add-writer', payload)
  }

  removeWriter(key) {
    const writerKey = toKeyBuffer(key)
    if (!writerKey) return Promise.reject(badWriterKeyError())
    return this.append('remove-writer', { key: writerKey })
  }

  /**
   * rateCeiling defaults to the ceiling of the pinned metadata, which open
   * loads, so a call before open waits for open as every append does.
   */
  async setWriterPolicy(key, { namespacePrefixes = [], rateCeiling } = {}) {
    const writerKey = toKeyBuffer(key)
    if (!writerKey) throw badWriterKeyError()
    if (!this.metadata) await this.ready()
    return this.append('set-writer-policy', {
      key: writerKey,
      namespacePrefixes,
      rateCeiling: rateCeiling ?? this.metadata.rate.defaultCeiling
    })
  }

  // Content ops, thin over append(). `backpressure` is the one append
  // option. The rest rides the payload.
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
   * Cites every tag that maps to `value` in the view of this writer. RemTag
   * removes observed tags, never by value alone. See SPEC §5.
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

  /** A direct replication stream. No firewall runs here: the caller chooses the peer. */
  replicate(isInitiatorOrStream) {
    return this.db.replicate(isInitiatorOrStream)
  }

  /**
   * Replicate over a private hyperswarm. The vault key is no capability to
   * connect: the swarm listens and dials with swarmKey, and its firewall
   * admits only the allowlist, on both sides. The allowlist is the union of
   * metadata.swarm.allow, the swarmKey of each gov/writer record and
   * `allow`. _refreshAllowlistOnce subtracts the bound key of each removed
   * writer and each key that revokePeer() cut, and runs after every fold.
   *
   * `opts`: exactly one DHT choice, or the call fails VAULT_SWARM_DHT.
   *   bootstrap  ['host:port' | { host, port }, ...]: the nodes of a
   *              private DHT, such as `auto-okf bootstrap` runs
   *   publicDht  true: the public DHT of hyperdht. Explicit opt-in.
   *   allow      swarm keys (32 bytes or 64 hex each) that this peer alone
   *              admits and dials, never written to the metadata. A joiner
   *              that reaches no peer of the invite passes the swarm key
   *              that its indexer hands it. A bad list fails VAULT_BAD_SWARM_ALLOW.
   *
   * The swarm joinPeers each listed key, so a fleet connects with no topic
   * announcement. It also joins sha256('auto-okf/2' ‖ db.discoveryKey) for
   * the writers that gov/writer admits later. leaveSwarm() and close() destroy
   * the swarm and clear the local list. A second call before leaveSwarm()
   * reuses the swarm and adds its `allow` to the local list.
   */
  async swarm({ bootstrap, allow, publicDht = false } = {}) {
    await this.ready()
    if (this._closing) throw closedError()
    const dht = swarmDhtOptions(bootstrap, publicDht)
    const local = allow === undefined ? [] : swarmKeyList(allow, 'allow')
    if (!this.swarmInstance) {
      // _allowed is empty or stale here. The refresh below fills it before
      // the swarm listens or dials.
      this.swarmInstance = new Hyperswarm({
        ...dht,
        keyPair: this._swarmKeyPair,
        firewall: (remotePublicKey) => !this._allows(remotePublicKey)
      })
    }
    const swarm = this.swarmInstance
    if (!this._onConnection) {
      this._onConnection = (conn) => {
        conn.on('error', () => {})
        // A key can leave the allowlist between the firewall and 'connection'.
        if (!this._allows(conn.remotePublicKey)) return conn.destroy()
        this.db.replicate(conn)
      }
      swarm.on('connection', this._onConnection)
    }
    if (!this._onBan) {
      this._onBan = (info) => this._recordBan(info)
      swarm.on('ban', this._onBan)
    }
    for (const hex of local) this._localAllow.add(hex)
    await this._refreshAllowlist()
    await swarm.listen()
    for (const key of this._listedPeers()) swarm.joinPeer(key)
    this._discovery = swarm.join(this._swarmTopic, { server: true, client: true })
    await this._discovery.flushed()
    return swarm
  }

  /** Destroy the swarm that swarm() made, with its topic and listed peers. */
  async leaveSwarm() {
    await this._destroySwarm()
  }

  /** destroy() leaves every topic, and the listed peers go with the swarm. */
  async _destroySwarm() {
    const swarm = this.swarmInstance
    if (!swarm) return
    this.swarmInstance = null
    this._discovery = null
    if (this._onConnection) {
      swarm.off('connection', this._onConnection)
      this._onConnection = null
    }
    if (this._onBan) {
      swarm.off('ban', this._onBan)
      this._onBan = null
    }
    this._banned.clear()
    this._localAllow.clear()
    await swarm.destroy()
  }

  /**
   * Cut a peer: take its swarm key out of the allowlist, destroy its
   * connections and leavePeer it. The key stays out for the life of this
   * Bundle, also when gov/writer or metadata.swarm.allow names it. The
   * other peers cut it when they fold the RemoveWriter or call revokePeer().
   */
  revokePeer(swarmKey) {
    const key = swarmKeyBuffer(swarmKey)
    if (!key) throw vaultError('VAULT_BAD_SWARM_KEY', 'swarmKey must be 32 bytes or 64 hex characters')
    const hex = b4a.toString(key, 'hex')
    this._revokedPeers.add(hex)
    this._evictPeer(hex)
  }

  /** The firewall test: true when the allowlist holds the remote key. */
  _allows(remotePublicKey) {
    return this._allowed.has(b4a.toString(remotePublicKey, 'hex'))
  }

  /** True when metadata.swarm.allow or the local list of swarm({ allow }) names the key. */
  _listed(hex) {
    return this.metadata.swarm.allow.includes(hex) || this._localAllow.has(hex)
  }

  /** The listed keys (see _listed()) that the allowlist holds, without self. */
  _listedPeers() {
    const self = b4a.toString(this._swarmKeyPair.publicKey, 'hex')
    const out = []
    for (const hex of new Set([...this.metadata.swarm.allow, ...this._localAllow])) {
      if (hex !== self && this._allowed.has(hex)) out.push(b4a.from(hex, 'hex'))
    }
    return out
  }

  /**
   * Read the allowlist again (see swarm()) and apply the difference to the
   * swarm. Serialized, so a slow run never puts back a list that a later
   * fold changed.
   */
  _refreshAllowlist() {
    const run = this._allowChain.then(() => this._refreshAllowlistOnce())
    this._allowChain = run.catch(() => {})
    return run
  }

  async _refreshAllowlistOnce() {
    if (this._closing || !this.db || !this.metadata) return
    const live = new Set()
    const removed = new Set()
    for await (const { key, value } of this.scan(K.govWriterPrefix())) {
      if (typeof value.swarmKey !== 'string') continue
      const writer = K.parseKey(key)[2]
      if ((await this.val(K.govRemoved(writer))) === undefined) live.add(value.swarmKey)
      else removed.add(value.swarmKey)
    }
    // The genesis record holds no swarm key, because apply seeds it from
    // the configuration alone. metadata.swarm.genesis binds the swarm key
    // of the creator instead, so a folded RemoveWriter of genesisKey cuts it.
    const { genesis } = this.metadata.swarm
    if (genesis !== null && (await this.val(K.govRemoved(this.metadata.genesisKey))) !== undefined) {
      removed.add(genesis)
    }
    // No await from here on, so a revokePeer() that ran during the reads
    // above is in _revokedPeers now.
    // Two gov/writer records can carry one swarm key. Subtract the key of a
    // removed writer from the whole union, so that a live second record
    // cannot keep the removed writer connected.
    const next = new Set(live)
    for (const hex of this.metadata.swarm.allow) next.add(hex)
    for (const hex of this._localAllow) next.add(hex)
    for (const hex of removed) next.delete(hex)
    for (const hex of this._revokedPeers) next.delete(hex)
    const prev = this._allowed
    this._allowed = next
    for (const hex of prev) if (!next.has(hex)) this._evictPeer(hex)
    for (const hex of next) if (!prev.has(hex)) this._allowPeer(hex)
  }

  /** Out of the allowlist: destroy the open connections and leavePeer. */
  _evictPeer(hex) {
    this._allowed.delete(hex)
    const swarm = this.swarmInstance
    if (!swarm) return
    const key = b4a.from(hex, 'hex')
    for (const conn of swarm.connections) {
      if (b4a.equals(conn.remotePublicKey, key)) conn.destroy()
    }
    swarm.leavePeer(key)
  }

  /**
   * Into the allowlist. hyperswarm rejects a banned key before the firewall
   * runs. So this unbans a peer that dialed before its admission folded
   * (PeerInfo.ban(false)) and looks the topic up again (discovery.refresh()).
   * The next refresh can be 10 minutes away.
   */
  _allowPeer(hex) {
    const swarm = this.swarmInstance
    if (!swarm) return
    this._banned.delete(hex)
    const info = swarm.peers.get(hex)
    if (info && info.banned) {
      info.ban(false)
      if (this._discovery) this._discovery.refresh().catch(() => {})
    }
    if (this._listed(hex) && hex !== b4a.toString(this.swarmKey, 'hex')) {
      swarm.joinPeer(b4a.from(hex, 'hex'))
    }
  }

  /**
   * The 'ban' handler (see MAX_BANNED_PEERS). Past the bound it lifts the
   * oldest ban with PeerInfo.ban(false) and frees the record with
   * leavePeer(). hyperswarm deletes a record that is not banned, queued,
   * explicit or waiting and has no connection.
   */
  _recordBan(info) {
    const swarm = this.swarmInstance
    if (!swarm) return
    const hex = b4a.toString(info.publicKey, 'hex')
    this._banned.delete(hex)
    this._banned.add(hex)
    for (const oldest of this._banned) {
      if (this._banned.size <= MAX_BANNED_PEERS) break
      this._banned.delete(oldest)
      const record = swarm.peers.get(oldest)
      if (!record || !record.banned) continue
      record.ban(false)
      swarm.leavePeer(record.publicKey)
    }
  }
}

/**
 * Adapts autobee's host to the one call that core's apply makes:
 * addWriter(key, { weight: 0 }). removeWriter is not exposed: revocation is
 * the clock rule of apply. See SPEC §8.
 */
class HostAdapter {
  constructor(host) {
    this.host = host
  }

  addWriter(key) {
    // Weight 0 for every writer, so autobee's default (isIndexer true,
    // weight 2) never applies. With bootstrapWeight: 0 genesis stands at 0
    // too. So no weight climbs, no resolved weight depends on the position
    // of a node, and nodes sort by timestamp then key. Returned, not
    // fire-and-forget: an un-awaited grant can miss autobee's system flush.
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

/** A 32-byte writer key from 32 bytes or 64 hex characters, else null. */
function toKeyBuffer(key) {
  return swarmKeyBuffer(key)
}

/** The Hyperswarm options of one DHT choice (see Bundle.swarm()). */
function swarmDhtOptions(bootstrap, publicDht) {
  const nodes = Array.isArray(bootstrap) ? bootstrap : null
  const valid =
    nodes !== null &&
    nodes.length > 0 &&
    nodes.every(
      (n) =>
        (typeof n === 'string' && n.length > 0) ||
        (n !== null && typeof n === 'object' && typeof n.host === 'string' && Number.isInteger(n.port))
    )
  if (publicDht === true && bootstrap === undefined) return {}
  if (publicDht !== true && valid) return { bootstrap: nodes }
  throw vaultError(
    'VAULT_SWARM_DHT',
    'swarm() needs exactly one DHT: bootstrap, a non-empty list of the nodes of a private DHT ' +
      "('host:port' or { host, port }), or publicDht: true, the public DHT of the commons"
  )
}

/** A 32-byte swarm key from 32 bytes or 64 hex characters, else null. */
function swarmKeyBuffer(key) {
  const hex = swarmKeyHex(key)
  return hex === null ? null : b4a.from(hex, 'hex')
}

function badWriterKeyError() {
  return vaultError('VAULT_BAD_WRITER_KEY', 'a writer key must be 32 bytes or 64 hex characters')
}

function closedError() {
  return vaultError('VAULT_CLOSED', 'the vault is closing or closed, so no new append starts')
}

/** `seq` is the position of the op, or null if close() cut it before it took one. */
function closedBeforeDurableError(seq) {
  const node = seq === null ? 'the node of the op' : `the node at position ${seq}`
  const err = vaultError(
    'VAULT_CLOSED_BEFORE_DURABLE',
    `the vault closed before ${node} reached the local core; the op is not written`
  )
  err.seq = seq
  return err
}

function vaultError(code, message) {
  const err = new Error(`${code}: ${message}`)
  err.code = code
  return err
}
