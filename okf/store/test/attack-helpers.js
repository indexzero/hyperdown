// The attacker toolkit of the substrate attack suite and the writer tests.
// The attacker is a malicious client, never a modified autobee. Each forged
// node is a legal oplog node, and every peer that reads it runs stock
// autobee. No helper changes the autobee of a victim. watchApply wraps the
// apply handler of okf, not autobee.
import { mkdir, appendFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { encodeOp } from '../../core/index.js'
import { Bundle, K, tmpDir, pair, until, sleep, converged } from './helpers.js'

export { Bundle, K, tmpDir, pair, until, sleep, converged }

// A test-only deep require, for forgeRawNode alone. The oplog codec of the
// pinned release encodes the block that forgeRawNode writes. Nothing in the
// product imports it. A victim decodes the block with the same codec
// (`encoding.decodeOplog` in autobee `Writer._next`).
const abRequire = createRequire(new URL('../package.json', import.meta.url))
const abEncoding = abRequire('autobee/lib/encoding.js')

// Keys are Buffers here (corestore and hypercore on node).
export const hex = (k) => Buffer.from(k).toString('hex')

/**
 * Forge the next local append of `v`, one append only. `over` sets any of
 * `approvals`, `witness`, `timestamp`, `links`, `optimistic` and `hash`. An
 * absent field keeps the honest value.
 *
 * `hash: null` enables a reorder. autobee appends a node at the tip with no
 * sort (`prepareBatch`) when its hash equals the system hash of the
 * receiver. It must also link every head.
 */
export function forgeNext(v, over = {}) {
  const w = v.db.writers
  const orig = w.appendLocal
  w.appendLocal = function (value, t, batch, links, optimistic, witness, approvals, hash, drift) {
    w.appendLocal = orig
    return orig.call(
      this,
      value,
      'timestamp' in over ? over.timestamp : t,
      batch,
      'links' in over ? over.links : links,
      'optimistic' in over ? over.optimistic : optimistic,
      'witness' in over ? over.witness : witness,
      'approvals' in over ? over.approvals : approvals,
      'hash' in over ? over.hash : hash,
      drift
    )
  }
}

/**
 * Append one forged node as the client of an outsider, a Bundle that no
 * indexer admitted. The Bundle refuses its appends (VAULT_NOT_WRITABLE), so
 * this helper calls `db.append(buf, { optimistic: true })` itself. `over`
 * forges node fields through forgeNext. Returns the length of the outsider
 * core once it holds the node: the attack length of the positive control.
 *
 * No peer hears of the core by itself. The outsider never applies its own
 * node (`_bumpPendingWriters`), so no peer couples the core to the wakeup
 * protocol (`Writer.update`). A test must send it with announce().
 *
 * An outsider writes one node, and no more (`Writer._next`). A node whose
 * witness or links cite a writer outside the outsider's system is
 * never written (`Writer._isLinked`). In both cases this helper throws.
 */
export async function outsiderAppend(v, path, over = {}) {
  const self = hex(v.db.local.key)
  const before = v.db.local.length
  const op = encodeOp('create-concept', {
    path,
    type: 'note',
    clock: [[self, before]],
    at: Date.now()
  })
  forgeNext(v, over)
  await v.db.append(op, { optimistic: true })
  if (!(await until(async () => v.db.local.length > before, 5000, 20))) {
    throw new Error(`OUTSIDER_NODE_UNWRITTEN: the outsider core stays at length ${before}`)
  }
  return v.db.local.length
}

/**
 * Write ONE raw oplog block to the core that `v` owns, and return the new
 * core length. `over` sets any of `approvals`, `witness`, `links`,
 * `timestamp`, `hash`, `optimistic` and `value`.
 *
 * This is the adversary of SECURITY_MODEL.md "The adversaries": a client
 * that appends arbitrary bytes to its own core. It runs no part of the
 * drain of autobee, so two gates of a wrapped `appendLocal` do not apply.
 * The local flush gate refuses a node whose links are missing
 * (`Writer._next`). The drain order folds a local node before it flushes it
 * (`_bumpPendingWriters`, then `_flushLocal`). A block written here is
 * durable first, whatever the fold does to the sender.
 *
 * A receiver decodes the block with stock autobee (`encoding.decodeOplog`).
 */
export async function forgeRawNode(v, over = {}) {
  await v.db.local.ready()
  const self = hex(v.db.local.key)
  const before = v.db.local.length
  const value =
    over.value ||
    encodeOp('create-concept', {
      path: `raw/${hex(randomBytes(6))}`,
      type: 'note',
      clock: [[self, before]],
      at: Date.now()
    })
  await v.db.local.append(
    abEncoding.encodeOplog({
      version: abEncoding.OPLOG_VERSION,
      timestamp: 'timestamp' in over ? over.timestamp : Date.now(),
      links: over.links ?? [],
      batch: { start: 0, end: 0 },
      views: null,
      trusted: null,
      witness: over.witness ?? null,
      approvals: over.approvals ?? null,
      optimistic: over.optimistic ?? false,
      value,
      hash: over.hash ?? null,
      weightHint: 0,
      drift: 0
    })
  )
  return v.db.local.length
}

/**
 * Send one wakeup announce of `entries` from `from` to its paired peers, as
 * a modified client can. A receiver hints every announced key
 * (autobee-wakeup `onannounce`). Returns true when a non-pending wakeup
 * peer took it.
 */
export async function announce(from, entries, ms = 15000) {
  const session = from.db._wakeup._session
  if (!session) return false
  return until(
    async () => {
      const peers = (session.topic.peers || []).filter((x) => !x.pending)
      if (peers.length === 0) return false
      for (const peer of peers) session.announce(peer, entries)
      return true
    },
    ms,
    50
  )
}

/**
 * True when the corestore of `v` holds the first `length` blocks of the core
 * `key`: the outsider's node reached the victim. This is the positive
 * control of an outsider attack. It must never create a missing core, or
 * the probe itself adds a core to the victim.
 */
export async function holds(v, key, length = 1) {
  const core = v.store.get({ key, createIfMissing: false })
  try {
    await core.ready()
    return core.contiguousLength >= length
  } catch {
    return false
  } finally {
    await core.close().catch(() => {})
  }
}

/**
 * True when the corestore of `v` has a stored core for `key`, with or
 * without blocks. After a reopen this tells a test that an announced writer
 * core persisted. Call it only for a core that the test expects. hypercore
 * rejects a missing core with STORAGE_EMPTY, and that rejection can also
 * surface outside this call.
 */
export async function storedCore(v, key) {
  const core = v.store.get({ key, createIfMissing: false })
  try {
    await core.ready()
    return true
  } catch {
    return false
  } finally {
    await core.close().catch(() => {})
  }
}

/**
 * The per-peer positive control. Poll until each peer `[name, vault]` holds
 * the first `length` blocks of each attack core `{ key, length }`. Returns
 * `{ <name>: true | false }`. A peer that reads false never got the attack
 * nodes, so a test asserts every entry true before it asserts no effect. A
 * length below 1 is no attack, so every entry then reads false.
 *
 * Each poll updates the peer under a deadline, so a stalled peer does not
 * stall this check. The stall is a result that the test asserts by itself.
 */
export async function deliveredTo(peers, cores, ms = 20000) {
  const out = Object.fromEntries(peers.map(([name]) => [name, false]))
  if (!cores.every(({ length }) => length >= 1)) return out
  await until(
    async () => {
      for (const [name, v] of peers) {
        if (out[name]) continue
        await timed(() => v.update(), 5000)
        let all = true
        for (const { key, length } of cores) if (!(await holds(v, key, length))) all = false
        out[name] = all
      }
      return Object.values(out).every(Boolean)
    },
    ms,
    50
  )
  return out
}

/**
 * Record the writer key (hex) of every node that autobee hands to the apply
 * of okf on `v`. It wraps the apply handler of the Bundle (`_apply` in
 * store/lib/bundle.js), never autobee. Returns the live Set.
 */
export function watchApply(v) {
  const writers = new Set()
  const orig = v._apply
  v._apply = function (nodes, view, host) {
    for (const node of nodes) writers.add(hex(node.key))
    return orig.call(this, nodes, view, host)
  }
  return writers
}

// Bundle re-emits the `error` event of autobee, and an EventEmitter 'error'
// with no listener crashes the process. An attack that closes the autobee
// of a peer must be a recorded result, not a dead test run.
const ERRORS = new WeakMap()

/** Attach an error sink to a vault. Returns the vault. */
export function quiet(v) {
  const errs = []
  ERRORS.set(v, errs)
  v.on('error', (e) => errs.push(e && e.message ? e.message : String(e)))
  return v
}

/** Every error a vault emitted since `quiet()`. */
export const errorsOf = (v) => ERRORS.get(v) || []

/** The system record of autobee for one writer key, or null. */
export async function sys(v, key) {
  await v.update()
  const r = await v.db.system.get(key)
  return r ? { weight: r.weight, maxWeight: r.maxWeight, isRemoved: r.isRemoved } : null
}

/**
 * Every node in the linearized order of `v` (autobee `replay`), as
 * `{ writer, length, weight, approvals, witness }`. `weight` is the resolved
 * weight that autobee pinned for the node. `approvals` and `witness` say
 * whether the node carries the field.
 */
export async function linearized(v) {
  await v.update()
  const nodes = await v.db.replay()
  return nodes
    .filter((n) => n !== null)
    .map((n) => ({
      writer: hex(n.key),
      length: n.length,
      weight: n.weight,
      approvals: !!(n.approvals && n.approvals.length),
      witness: !!n.witness
    }))
}

/** The linearized nodes of `v` that carry approvals or a witness. */
export async function carriers(v) {
  return (await linearized(v)).filter((n) => n.approvals || n.witness)
}

/**
 * Bound any step. Resolves `{ status: 'ok' | 'TIMEOUT' | 'ERROR', ms,
 * value, error }`. A stall or a crash is then a RESULT, never a hung test.
 */
export async function timed(fn, ms, label = '') {
  const t0 = Date.now()
  let timer = null
  const bomb = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ status: 'TIMEOUT' }), ms)
  })
  try {
    const out = await Promise.race([
      Promise.resolve()
        .then(fn)
        .then(
          (value) => ({ status: 'ok', value }),
          (error) => ({ status: 'ERROR', error: error && error.message ? error.message : error })
        ),
      bomb
    ])
    return { ...out, ms: Date.now() - t0, label }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * autobee counters of one vault. The wakeup flood is measured in `opened`
 * and `active`.
 */
export function coreStats(v) {
  return {
    undos: v.db.stats.undos,
    applies: v.db.stats.applies,
    opened: v.db.stats.writersOpened,
    closed: v.db.stats.writersClosed,
    active: v.db.writers.active.size
  }
}

/** Bytes on disk under `dir`, recursively. The storage metric of the wakeup flood. */
export async function duBytes(dir) {
  let total = 0
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) total += await duBytes(p)
    else total += (await stat(p)).size
  }
  return total
}

/** `n` fresh 32-byte keys that belong to nobody, each with a length. */
export function freshKeys(n, length = 1) {
  const out = []
  for (let i = 0; i < n; i++) out.push({ key: randomBytes(32), length })
  return out
}

/**
 * Milliseconds for `n` appends plus folds on one vault: the latency metric
 * of the wakeup flood. Each append is one honest op through the Bundle.
 */
export async function timeAppends(v, label, n = 20) {
  const t0 = performance.now()
  for (let i = 0; i < n; i++) {
    await v.createConcept(`bench/${label}/${i}`, 'note')
    await v.update()
  }
  return Math.round(performance.now() - t0)
}

/**
 * Record one attack result. It goes to the diagnostics of the test as
 * `ATTACK-RESULT {json}`, and to the JSON-lines file at `$OKF_ATTACK_RECORD`
 * when that is set.
 */
export async function record(t, attack, data) {
  const line = JSON.stringify({ attack, ...data })
  t.diagnostic(`ATTACK-RESULT ${line}`)
  if (process.env.OKF_ATTACK_RECORD) {
    await mkdir(dirname(process.env.OKF_ATTACK_RECORD), { recursive: true })
    await appendFile(process.env.OKF_ATTACK_RECORD, line + '\n')
  }
}

/**
 * Close a vault, open the same directory again, and time one update. A peer
 * that cannot reopen, or whose first fold after a reopen never returns, is
 * bricked.
 */
export async function reopenCheck(vault, dir, ms = 20000) {
  const first = await timed(() => vault.close(), ms, 'close')
  if (first.status !== 'ok') return { status: first.status, ms: first.ms, update: null, error: 'close' }
  const out = await timed(async () => {
    const again = quiet(await Bundle.open(dir))
    const upd = await timed(() => again.update(), ms, 'reopen-update')
    const hash = upd.status === 'ok' ? await again.snapshotHash() : null
    // A bricked peer can also hang in close(): bound that too.
    const closed = await timed(() => again.close(), ms, 'reopen-close')
    return { update: upd.status, updateMs: upd.ms, hash, close: closed.status, errors: errorsOf(again) }
  }, ms * 2)
  return { status: out.status, ms: out.ms, ...(out.value || {}), error: out.error }
}

/**
 * Run this file as a child process with `args`, kill it after `ms`, and
 * parse the `CHILD-RESULT {json}` line it prints. Resolves `{ code,
 * signal, ms, result, stderrTail }`, so a crash or a heap exhaustion is a
 * RESULT and never takes the test runner down.
 */
export function runChild(args, ms) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...args], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    const t0 = Date.now()
    const timer = setTimeout(() => child.kill('SIGKILL'), ms)
    child.stdout.on('data', (d) => {
      stdout += d
    })
    child.stderr.on('data', (d) => {
      stderr += d
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      const line = stdout.split('\n').find((l) => l.startsWith('CHILD-RESULT '))
      resolve({
        code,
        signal,
        ms: Date.now() - t0,
        result: line ? JSON.parse(line.slice('CHILD-RESULT '.length)) : null,
        stderrTail: stderr.split('\n').filter(Boolean).slice(-4).join(' | ')
      })
    })
  })
}

// ---------------------------------------------------------------------------
// Child-process entry point. A peer that applies an approval at weight W
// builds one Set entry and one digest slot per tier (autobee
// `Promotions.flushPending`). At W = 1e9 that exhausts the heap, so the
// huge-approval tests spawn this file and read the JSON line it prints:
//
//   node okf/test/attack-helpers.js huge-approval <arm> <weight>
//
// `arm` selects the attacker:
// - `outsider`: a Bundle that no indexer admitted.
// - `member`: an admitted key, appending through autobee.
// - `member-raw`: the same key, through a client that writes the block to
//   its own core and folds nothing.
// ---------------------------------------------------------------------------
async function childHugeApprovalOutsider(weight) {
  const rss = () => Math.round(process.memoryUsage().rss / 1048576)
  const out = { weight, rssStart: rss() }
  const a = quiet(await Bundle.init(await tmpDir('g2-a'))) // the victim
  const s = quiet(await Bundle.join(await tmpDir('g2-s'), a.key)) // the outsider
  const applied = { a: watchApply(a), s: watchApply(s) }
  const unpair = pair(a, s)
  const named = randomBytes(32)
  const sHex = hex(s.localKey)
  try {
    const { tag } = await a.createConcept('seed', 'note')
    out.synced = await until(async () => (await s.update(), (await s.val(K.cMeta(tag))) !== undefined), 20000)
    const hash0 = await converged([a, s], 20000)
    out.hash0 = hash0
    const forged = await timed(async () => {
      const length = await outsiderAppend(s, 'carrier', { approvals: [{ key: named, weight }] })
      if (!(await announce(s, [{ key: s.localKey, length }]))) throw new Error('announce found no peer')
      return length
    }, 30000)
    out.forgedAppend = forged.status
    out.forgedError = forged.error ?? null
    out.delivered = await deliveredTo(
      [
        ['a', a],
        ['s', s]
      ],
      [{ key: s.localKey, length: forged.status === 'ok' ? forged.value : 0 }]
    )
    await sleep(1000)
    out.peers = {}
    for (const [name, v] of [['a', a], ['s', s]]) {
      const row = await timed(async () => {
        const upd = await timed(() => v.update(), 20000)
        const hash = upd.status === 'ok' ? await timed(() => v.snapshotHash(), 20000) : { status: 'SKIPPED' }
        return {
          update: upd.status,
          hash: hash.status !== 'ok' ? hash.status : hash.value === hash0 ? 'unchanged' : 'CHANGED',
          applied: applied[name].has(sHex),
          seen: (await v.val(K.seen(sHex))) !== undefined,
          namedInSystem: (await v.db.system.get(named)) !== null,
          outsiderInSystem: (await v.db.system.get(s.localKey)) !== null
        }
      }, 60000)
      out.peers[name] = row.status === 'ok' ? row.value : { status: row.status, error: row.error ?? null }
    }
  } catch (err) {
    out.error = err && err.message ? err.message : String(err)
  } finally {
    out.rssEnd = rss()
    out.errors = { victim: errorsOf(a), outsider: errorsOf(s) }
    unpair()
    out.closed = (
      await timed(async () => {
        await s.close().catch(() => {})
        await a.close().catch(() => {})
      }, 30000)
    ).status
    console.log(`CHILD-RESULT ${JSON.stringify(out)}`)
  }
}

/**
 * The member arm. An indexer admitted the carrier, so autobee added it and
 * its plain nodes reach `_applyBatch` on every peer. okf cannot filter the
 * approvals on such a node: autobee applies them before apply runs.
 *
 * A member folds its own node (`_bumpPendingWriters`) before the drain
 * flushes it (`_flushLocal`), so the first peer to pay is the attacker.
 */
async function childHugeApprovalMember(weight) {
  const rss = () => Math.round(process.memoryUsage().rss / 1048576)
  const out = { arm: 'member', weight, rssStart: rss() }
  const a = quiet(await Bundle.init(await tmpDir('g2m-a'))) // genesis, the victim
  const b = quiet(await Bundle.join(await tmpDir('g2m-b'), a.key)) // the member
  const named = randomBytes(32) // the key the forged approval names
  const unpair = pair(a, b)
  try {
    const { tag } = await a.createConcept('seed', 'note')
    out.synced = await until(async () => (await b.update(), (await b.val(K.cMeta(tag))) !== undefined), 20000)
    await a.writers.add(b.localKey, { indexer: false })
    out.memberWritable = await until(async () => (await b.update(), b.writable), 20000)
    out.hash0 = await converged([a, b], 20000)

    // the attack: the next node of the member approves a key at `weight`
    forgeNext(b, { approvals: [{ key: named, weight }] })
    const append = await timed(() => b.createConcept('carrier', 'note'), 120000)
    out.forgedAppend = append.status
    out.forgedError = append.error ?? null
    out.rssAfterAppend = rss()

    // Did the forged node leave the attacker's core, and did the
    // victim fold it? Both reads run under a deadline, because either peer
    // can be down by now.
    const len = await timed(() => b.db.local.length, 5000)
    out.memberCoreLength = len.status === 'ok' ? len.value : null
    out.delivered =
      out.memberCoreLength > 0
        ? await deliveredTo([['a', a]], [{ key: b.localKey, length: out.memberCoreLength }], 10000)
        : { a: false }
    // How long the victim takes to fold the forged approval into its own
    // system. A node that never left the attacker's core cannot be
    // folded, so that case is recorded and not waited on.
    const fold = out.delivered.a
      ? await timed(
          () =>
            until(
              async () => {
                await a.update()
                return (await a.db.system.get(named)) !== null
              },
              30000,
              50
            ),
          45000
        )
      : { status: 'NOT-DELIVERED', value: false, ms: null }
    out.victimFolded = fold.status === 'ok' && fold.value === true
    out.victimFoldMs = fold.ms
    out.victimState = await timed(async () => {
      const upd = await timed(() => a.update(), 20000)
      return {
        update: upd.status,
        hash: upd.status === 'ok' ? ((await a.snapshotHash()) === out.hash0 ? 'unchanged' : 'CHANGED') : 'SKIPPED',
        namedInSystem: (await a.db.system.get(named)) !== null,
        appends: (await timed(() => timeAppends(a, 'g2m', 3), 60000)).status
      }
    }, 90000)
    out.victim = out.victimState.status === 'ok' ? out.victimState.value : { status: out.victimState.status }
  } catch (err) {
    out.error = err && err.message ? err.message : String(err)
  } finally {
    out.rssEnd = rss()
    out.errors = { victim: errorsOf(a), member: errorsOf(b) }
    // The peers that the forged approval took down, by the error that
    // autobee reported. A Set with 1e9 requested tiers exceeds the limit of
    // V8.
    out.crashed = Object.entries(out.errors)
      .filter(([, errs]) => errs.some((e) => /Set maximum size exceeded/.test(e)))
      .map(([name]) => name)
    unpair()
    out.closed = (
      await timed(async () => {
        await b.close().catch(() => {})
        await a.close().catch(() => {})
      }, 30000)
    ).status
    console.log(`CHILD-RESULT ${JSON.stringify(out)}`)
  }
}

/**
 * The member arm through a client that does not fold. forgeRawNode makes
 * the block durable before any fold, so the drain order of the sender no
 * longer gates delivery. The victim is genesis, on stock autobee. The
 * result states the order that a residual claim needs: delivery first,
 * then the failure of the victim, then its reopen.
 *
 * The reopen can die inside `Bundle.open`: the boot drain (`_bootOnline`)
 * folds the stored block before a caller can attach an error listener. So
 * this arm installs an uncaughtException handler, prints the result and
 * exits 0. A lost run proves nothing.
 */
async function childHugeApprovalMemberRaw(weight) {
  const SET_LIMIT = /Set maximum size exceeded/
  const rss = () => Math.round(process.memoryUsage().rss / 1048576)
  const out = { arm: 'member-raw', weight, rssStart: rss() }
  const peers = {} // filled once the vaults exist, so finish() always reads them
  let printed = false
  const finish = () => {
    if (printed) return
    printed = true
    out.errors = { victim: errorsOf(peers.a || {}), member: errorsOf(peers.b || {}) }
    out.crashed = Object.entries(out.errors)
      .filter(([, errs]) => errs.some((e) => SET_LIMIT.test(e)))
      .map(([name]) => name)
    out.rssEnd = rss()
    console.log(`CHILD-RESULT ${JSON.stringify(out)}`)
  }
  process.on('uncaughtException', (err) => {
    const msg = err && err.message ? err.message : String(err)
    out.uncaught = msg
    if (!out.reopen) out.reopen = { verdict: SET_LIMIT.test(msg) ? 'CRASH-ON-OPEN' : 'UNCAUGHT', error: msg }
    finish()
    process.exit(0)
  })

  const aDir = await tmpDir('g2r-a')
  const a = quiet(await Bundle.init(aDir)) // genesis, the victim
  const b = quiet(await Bundle.join(await tmpDir('g2r-b'), a.key)) // the member
  peers.a = a
  peers.b = b
  const named = randomBytes(32) // the key the forged approval names
  const unpair = pair(a, b)
  try {
    const { tag } = await a.createConcept('seed', 'note')
    out.synced = await until(async () => (await b.update(), (await b.val(K.cMeta(tag))) !== undefined), 20000)
    await a.writers.add(b.localKey, { indexer: false })
    out.memberWritable = await until(async () => (await b.update(), b.writable), 20000)
    out.hash0 = await converged([a, b], 20000)

    // the attack: one raw oplog block, approving a key at `weight`
    const raw = await timed(() => forgeRawNode(b, { approvals: [{ key: named, weight }] }), 20000)
    out.rawAppend = raw.status
    out.rawError = raw.error ?? null
    out.memberCoreLength = raw.status === 'ok' ? raw.value : null

    // FIRST the positive control: the victim holds the block. A claim about
    // a victim that never got the attack proves nothing.
    out.delivered =
      out.memberCoreLength > 0
        ? await deliveredTo([['a', a]], [{ key: b.localKey, length: out.memberCoreLength }], 20000)
        : { a: false }

    // THEN the failure of the victim, and whether it can still append.
    out.victimCrashed = await until(() => errorsOf(a).some((e) => SET_LIMIT.test(e)), 120000, 100)
    out.victimUpdate = (await timed(() => a.update(), 20000)).status
    out.victimAppends = (await timed(() => timeAppends(a, 'g2r', 2), 30000)).status
    out.rssAfterFold = rss()

    // THEN the reopen. The block stays in the victim's store either way.
    unpair()
    out.closed = (await timed(() => a.close(), 60000)).status
    const again = quiet(await Bundle.open(aDir))
    const upd = await timed(() => again.update(), 60000, 'reopen-update')
    const crashed = await until(() => errorsOf(again).some((e) => SET_LIMIT.test(e)), 20000, 100)
    const appends = await timed(() => timeAppends(again, 'g2r-reopen', 2), 60000)
    out.reopen = {
      verdict: crashed ? 'CRASH-AFTER-OPEN' : appends.status === 'ok' ? 'REOPENED' : 'NO-APPEND',
      update: upd.status,
      crashed,
      appends: appends.status,
      attackCoreStored: await storedCore(again, b.localKey),
      errors: errorsOf(again)
    }
    await timed(() => again.close(), 60000)
  } catch (err) {
    out.error = err && err.message ? err.message : String(err)
  } finally {
    unpair()
    await timed(async () => {
      await b.close().catch(() => {})
      await a.close().catch(() => {})
    }, 60000)
    finish()
  }
}

const ARMS = {
  outsider: childHugeApprovalOutsider,
  member: childHugeApprovalMember,
  'member-raw': childHugeApprovalMemberRaw
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  const [, , what, arm = 'outsider', weight = '1000000000'] = process.argv
  if (what !== 'huge-approval' || !Object.hasOwn(ARMS, arm)) {
    console.error(`unknown child attack ${what} ${arm}`)
    process.exit(2)
  }
  await ARMS[arm](Number(weight))
  process.exit(0)
}
