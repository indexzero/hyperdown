// Test-only attacker toolkit for the substrate attack suite
// (store-substrate-attacks.test.js) and the writer tests. Adopted from the
// T1 spike (D-003) without its configuration switch: the product has one
// substrate configuration (store/lib/bundle.js), so every helper runs
// against it.
//
// What an attacker may do here (decision 5): a test wraps the local
// writer's `appendLocal` to forge the fields an honest client never sets:
// approvals, a witness, a timestamp, a link set. That is a malicious
// CLIENT, not a modified autobee. The forged node is a legal oplog node,
// and every peer that reads it runs stock autobee@2.12.1. An outsider's
// client also asks for an optimistic node and announces its own core over
// the wakeup protocol (outsiderAppend, announce), which the Bundle never
// does. Nothing here changes how a victim's autobee behaves: the other
// helpers only read, and watchApply wraps okf's apply handler, not
// autobee. Product code never does any of this.
//
// This file is also a child-process entry point (see the end): the G2
// approval at a huge weight can exhaust a heap, so it runs in a child.
//
// Vaults live under the store tests' temp root (store-helpers.js tmpDir).
import { mkdir, appendFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { encodeOp } from '../core/index.js'
import { Bundle, K, tmpDir, pair, until, sleep, converged } from './store-helpers.js'

export { Bundle, K, tmpDir, pair, until, sleep, converged }

// Keys are Buffers in this workspace (corestore/hypercore on node).
export const hex = (k) => Buffer.from(k).toString('hex')

/**
 * Forge the next local append of `v`. Pass any of `approvals`, `witness`,
 * `timestamp`, `links` and `hash`. An absent field keeps what the honest
 * client would send. One append only: the wrapper removes itself.
 *
 * `hash: null` matters for a reorder attack. autobee appends a node at the
 * tip with no sort when the node's hash equals the receiver's system hash
 * and the node links every head (autobee index.js:1377-1384).
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
 * Append one forged node as an outsider's client. The outsider is a Bundle
 * that no indexer admitted. The Bundle refuses its appends
 * (VAULT_NOT_WRITABLE) and never asks for an optimistic node, so the
 * outsider calls autobee's documented `db.append(buf, { optimistic: true
 * })` (autobee README.md:131-134) itself. `over` forges node fields
 * through forgeNext. It waits until the outsider's own core holds the
 * node, and returns that core length: the attack length that a positive
 * control checks.
 *
 * The outsider's own autobee runs with optimistic: false, so it never
 * applies its own node (autobee index.js:1357-1364). A writer that a peer
 * never applied is no system head there, so that peer never couples the
 * core to the wakeup protocol (lib/writers.js:504-516), and no other peer
 * hears of it. A test therefore sends the core with announce(), as a
 * modified client can.
 *
 * Thus an outsider writes one node to its core, and no more. Its autobee
 * reads that node from the core again on each pass and drops it, so it
 * never gets to a second local node (lib/writers.js:560-621, :624-664).
 * A node whose witness or links cite a writer that the outsider's own
 * system does not hold never gets written either (lib/writers.js:673-722,
 * lib/system.js:32-36). In these cases this helper throws, so no test
 * can count a node that no core holds.
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
 * Send one wakeup announce of `entries` from `from` to its paired peers, as
 * a modified client can (autobee-wakeup/index.js:24-26: a receiver hints
 * every announced key). Returns true when a non-pending wakeup peer took
 * it. Adopted from the T1 spike (D-003).
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
 * True when `v`'s corestore holds the first `length` blocks of the core
 * `key`: the outsider's node reached the victim. This is the positive
 * control of an outsider attack, so a test that sees no effect knows that
 * the node arrived. It reads through a short-lived session, and it never
 * creates a core that is missing.
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
 * True when `v`'s corestore has a stored core for `key`, whether or not it
 * holds blocks. After a reopen this is how a test tells that an outsider's
 * announced writer core persisted. Only call it for a core that is
 * expected: hypercore rejects a missing one with STORAGE_EMPTY, and that
 * rejection can also surface outside this call.
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
 * The per-peer positive control. Poll until each peer `[name, vault]` in
 * `peers` holds the first `length` blocks of each attack core `{ key,
 * length }` in `cores`. Returns `{ <name>: true | false }`, one entry per
 * peer. A peer that never got the attack nodes reads false: no effect on
 * that peer proves nothing, so a test asserts every entry true before it
 * asserts no effect. A length below 1 is no attack, so every entry then
 * reads false.
 *
 * Each poll updates the peer under a deadline. A stalled update is a
 * liveness result that the test asserts by itself. It does not stall this
 * check, which reads only the blocks.
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
 * Record the writer key (hex) of every node that autobee hands to okf's
 * apply on `v`. It wraps the Bundle's apply handler (store/lib/bundle.js
 * `_apply`, which the Autobee `apply` option calls), never autobee.
 * Returns the live Set.
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

// Bundle re-emits autobee's `error` event, and an EventEmitter 'error' with
// no listener crashes the process. An attack that makes a peer's own
// autobee close must be a RECORDED result, not a dead test run.
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

/** autobee's system record for one writer key, or null. */
export async function sys(v, key) {
  await v.update()
  const r = await v.db.system.get(key)
  return r ? { weight: r.weight, maxWeight: r.maxWeight, isRemoved: r.isRemoved } : null
}

/**
 * Every node in `v`'s linearized order (autobee index.js:1758-1760,
 * lib/topo.js:38-54), as `{ writer, length, weight, approvals, witness }`.
 * `weight` is the resolved weight autobee pinned for the node, and
 * `approvals` / `witness` say whether the node carries the field.
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
 * value, error }`, so a stall or a crash is a RESULT and never a hung test.
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
 * autobee counters of one vault: reorders undone, nodes applied, writer
 * cores opened and closed (autobee lib/writers.js:266, :464), and the
 * writers it keeps active (lib/writers.js:41-43). The G44 flood is measured
 * in `opened` and `active`.
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

/** Bytes on disk under `dir`, recursively. The G44 storage metric. */
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
 * Milliseconds for `n` appends plus folds on one vault: the G44 latency
 * metric. Each append is one honest op through the Bundle.
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
 * Record one attack result. It goes to the test's diagnostics as
 * `ATTACK-RESULT {json}`, and is appended to the JSON-lines file at
 * `$OKF_ATTACK_RECORD` when that is set.
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
 * Close a vault, open the same directory again, and time one update. This
 * is the "permanent brick on reopen" check: a peer that cannot reopen, or
 * whose first fold after a reopen never returns, is bricked.
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
// lib/promotions.js:137, :144). At W = 1e9 that exhausts the heap, so the
// G2 tests spawn this file and read the JSON line it prints:
//
//   node okf/test/attack-helpers.js huge-approval <arm> <weight>
//
// `arm` is `outsider` (a Bundle that no indexer admitted) or `member` (a
// key an indexer admitted with add-writer). Adopted from the T1 spike
// (D-003), which measured both arms.
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
 * The member arm of G2 (T11 residual). The carrier is a key an indexer
 * admitted with add-writer, so autobee has added it and its plain nodes
 * reach _applyBatch on every peer that reads them (index.js:1359,
 * :1425-1455). okf cannot filter the approvals on such a node: autobee
 * applies them before apply runs (index.js:1432-1441).
 *
 * The result records which peers died and what the memory cost was. A
 * member folds its OWN node before the drain flushes it to the local core
 * (index.js:818 _bumpPendingWriters, then :824 _flushLocal), so the first
 * peer to pay the cost is the attacker itself.
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

    // the attack: the member's next node approves a key at `weight`
    forgeNext(b, { approvals: [{ key: named, weight }] })
    const append = await timed(() => b.createConcept('carrier', 'note'), 120000)
    out.forgedAppend = append.status
    out.forgedError = append.error ?? null
    out.rssAfterAppend = rss()

    // Did the forged node leave the attacker's core, and did the victim
    // fold it? Both are reads, each under a deadline, because either peer
    // can be down by now.
    const len = await timed(() => b.db.local.length, 5000)
    out.memberCoreLength = len.status === 'ok' ? len.value : null
    out.delivered =
      out.memberCoreLength > 0
        ? await deliveredTo([['a', a]], [{ key: b.localKey, length: out.memberCoreLength }], 10000)
        : { a: false }
    // How long the victim takes to fold the forged approval into its own
    // system. A node that never left the attacker's core cannot be folded,
    // so that case is recorded and not waited on.
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
    // The peers that the forged approval took down, by the error autobee
    // reported. A Set with 1e9 requested tiers exceeds V8's limit
    // (lib/promotions.js:137).
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

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  const [, , what, arm = 'outsider', weight = '1000000000'] = process.argv
  if (what !== 'huge-approval' || (arm !== 'outsider' && arm !== 'member')) {
    console.error(`unknown child attack ${what} ${arm}`)
    process.exit(2)
  }
  if (arm === 'member') await childHugeApprovalMember(Number(weight))
  else await childHugeApprovalOutsider(Number(weight))
  process.exit(0)
}
