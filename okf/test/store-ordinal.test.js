// AD4, the per-writer ordinal is the node's position (okf SPEC §3, §8).
// T9 adopts spike T8 (D-027). The ports of ab2-review/scratch-A
// s4-race.mjs (G9a), s5-clock-units.mjs (G8) and s6-strand.mjs (G10),
// adapted to admit before writing, plus the core rules that the ordinal
// changes and the G13 ack check.
//
// The actual seq of an op is its node's position in its writer's core,
// node.length - 1 (autobee README, Apply: "node.length — position in the
// writer's core"). seen/<W> is the last position plus one. A node that never
// reaches apply, such as an empty block (autobee index.js:1444), takes a
// position, so the positions of a writer's ops can have gaps. The Bundle
// reads the next position from the documented db.local before it encodes an
// op.
//
// The tests append an empty block through the documented db.append. The
// G10 test simulates a crash: it rewrites the boot record of the local core
// and clears one replicated block, through the documented hypercore API of
// a closed store. Nothing here changes autobee behaviour.
//
// T12 bounds the clock (G33). An op's clock carries self and each writer
// with a gov/writer record, a revoked writer too, and no other key. The G33
// test is the port of ab2-review/scratch-B/s7-clock-size.mjs, adapted to
// admit before writing: 1,000 keys that a member approves write one op
// each, as an attacker's client does (outsiderAppend, decision 5).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import Corestore from '../store/node_modules/corestore/index.js'
import { Bundle, K, makeTag, tmpDir, pair, until, sleep } from './store-helpers.js'
import { Env, hostStub, rejectedReasons, writerKey } from './helpers.js'
import { holds, outsiderAppend } from './attack-helpers.js'
import { decodeOp, normalizeClock } from '../core/index.js'

const OKF = join(dirname(fileURLToPath(import.meta.url)), '..')
const hex = (k) => k.toString('hex')
/** The rejectedReasons() key of writer W's op at seq. */
const rk = (W, seq) => K.flagRejected(W, seq).slice('flag/rejected/'.length)

/** Skip `n` positions of writer `w` in an Env, as empty blocks would. */
function gap(env, w, n = 1) {
  const W = env.hex(w)
  env.seqs.set(W, (env.seqs.get(W) ?? 0) + n)
}

// ---------- core: the actual seq is node.length - 1 ----------

test('core: the actual seq of an op is node.length - 1, also after a gap in its writer\'s positions', async () => {
  const env = new Env()
  const n0 = env.op('A', 'create-concept', { path: 'notes/a', type: 'note' })
  gap(env, 'A') // position 1 is an empty block that never reaches apply
  const n2 = env.op('A', 'set-field', { id: env.tag('A', 0), key: 'title', value: ['two'] })
  assert.equal(n0.length, 1)
  assert.equal(n2.length, 3)
  const view = await env.run([n0, n2], { host: hostStub() })
  assert.deepEqual(rejectedReasons(view), {}, 'the op at position 2 claims seq 2 and is not forged-clock')
  assert.equal(JSON.parse((await view.get(K.seen(env.hex('A')))).value), 3, 'seen/A is the last position plus one')
  const f = JSON.parse((await view.get(K.cField(env.tag('A', 0), 'title'))).value)
  assert.deepEqual(f.values, ['two'])
  assert.equal(f.tag, env.tag('A', 2), 'the tag of the op is writerKey || position')
})

test('core: flag/rejected keys a rejected op by its position', async () => {
  const env = new Env()
  const n0 = env.op('A', 'create-concept', { path: 'notes/a', type: 'note' })
  gap(env, 'A')
  // position 2, but the self entry claims 1 (the old seen-count)
  const n2 = env.op('A', 'set-field', { id: env.tag('A', 0), key: 'title', value: ['x'] }, {
    verbatimClock: true,
    clock: [[env.hex('A'), 1]]
  })
  const view = await env.run([n0, n2], { host: hostStub() })
  assert.deepEqual(rejectedReasons(view), { [rk(env.hex('A'), 2)]: 'forged-clock' })
})

test('core: an op whose handling throws is rejected apply-error at its position', async () => {
  const env = new Env()
  const n0 = env.op('A', 'create-concept', { path: 'notes/a', type: 'note' })
  gap(env, 'A')
  const n2 = env.op('A', 'add-writer', { key: env.key('B'), indexer: false })
  const host = {
    async addWriter() {
      throw new Error('boom')
    }
  }
  const view = await env.run([n0, n2], { host })
  const W = env.hex('A')
  assert.deepEqual(
    JSON.parse((await view.get(K.flagRejected(W, 2))).value),
    { reason: 'apply-error' },
    'containThrow records the node at position 2'
  )
  assert.equal(JSON.parse((await view.get(K.seen(W))).value), 3)
})

test('core: a node without a positive integer length breaks the transport contract, so apply throws', async () => {
  const env = new Env()
  const n0 = env.op('A', 'create-concept', { path: 'notes/a', type: 'note' })
  for (const length of [undefined, 0, -1, 1.5, '1']) {
    await assert.rejects(
      () => env.run([{ ...n0, length }], { host: hostStub() }),
      TypeError,
      `length ${JSON.stringify(length)} is never an op rejection`
    )
  }
})

test('core: mint-collision-risk compares an adopted suffix with the last position plus one', async () => {
  const env = new Env()
  const A = env.hex('A')
  env.op('A', 'add-writer', { key: env.key('B'), indexer: false }) // position 0
  env.op('A', 'create-concept', { path: 'notes/a', type: 'note' }) // position 1, mints A||1
  gap(env, 'A') // position 2: an empty block, so no op of A ever has seq 2
  env.op('A', 'set-field', { id: env.tag('A', 1), key: 'title', value: ['t'] }) // position 3
  // seen/A is 4. A suffix below 4 names a position that has passed.
  env.op('B', 'create-concept', { path: 'adopt/gap', type: 'note', id: A + '2' })
  env.op('B', 'create-concept', { path: 'adopt/next', type: 'note', id: A + '4' })
  const view = await env.run(env.nodes, { host: hostStub() })
  assert.equal(JSON.parse((await view.get(K.seen(A))).value), 4)
  const rej = rejectedReasons(view)
  const B = env.hex('B')
  assert.equal(rej[rk(B, 0)], undefined, 'A||2 names a passed position, so B can adopt it')
  assert.equal(rej[rk(B, 1)], 'mint-collision-risk', 'A||4 is the next mint of A')
})

test('core: a revoked writer stays in the clock, because the §8 window compares every entry (I10)', async () => {
  // The store clocks each writer with a gov/writer record (T12). J has none,
  // so no clock below cites it, and core accepts every such clock. Z is
  // revoked after C cites it and before A revokes C. C's in-flight op c1
  // sorts after the removal of C, as in the I10 revocation race. c1 is in
  // the window (seq <= seqAtRemoval), so it lands only if its clock strictly
  // precedes the revocation clock. That needs every writer that c1 cites in
  // the revocation clock, the revoked Z too.
  const run = async (removalCitesZ) => {
    const env = new Env({ genesis: 'A' })
    const [A, C, J, Z] = ['A', 'C', 'J', 'Z'].map((w) => env.hex(w))
    const clocked = () => ({ clock: env.observedAll().filter(([k]) => k !== J) })
    env.op('A', 'add-writer', { key: writerKey('C'), indexer: false }) // A0
    env.op('A', 'add-writer', { key: writerKey('Z'), indexer: false }) // A1
    env.op('A', 'create-concept', { path: 'w/doc', type: 'note' }) // A2
    const id = env.tag('A', 2)
    env.op('J', 'add-tag', { id, value: 'j0' }) // not-a-writer, and seen/J moves
    env.op('Z', 'add-tag', { id, value: 'z0' }, clocked())
    env.op('C', 'add-tag', { id, value: 'c0' }, clocked()) // cites A:2, Z:0
    const c1 = env.op('C', 'add-tag', { id, value: 'c1' }, clocked()) // cites A:2, Z:0
    env.op('A', 'remove-writer', { key: writerKey('Z') }, clocked()) // A3
    // A has folded C through c1, so seqAtRemoval is 1. Without Z, A's clock
    // is what a store that drops revoked writers would send.
    const clock = [[A, 4], [C, 1], ...(removalCitesZ ? [[Z, 0]] : [])]
    env.op('A', 'remove-writer', { key: writerKey('C') }, { clock, verbatimClock: true }) // A4
    const view = await env.run([...env.nodes.filter((n) => n !== c1), c1])
    const tags = Object.values(view.dump(`c/${id}/f/tags`)[`c/${id}/f/tags`].els).sort()
    return { reasons: rejectedReasons(view), tags, removed: JSON.parse((await view.get(K.govRemoved(C))).value), J, C }
  }

  const kept = await run(true)
  assert.deepEqual(kept.reasons, { [rk(kept.J, 0)]: 'not-a-writer' }, 'only the op of J is rejected')
  assert.deepEqual(kept.tags, ['c0', 'c1', 'z0'], 'c1 lands in the window')
  assert.equal(kept.removed.seqAtRemoval, 1)

  const dropped = await run(false)
  assert.deepEqual(
    dropped.reasons,
    { [rk(dropped.J, 0)]: 'not-a-writer', [rk(dropped.C, 1)]: 'revoked' },
    'c1 cites Z, and the revocation clock does not, so c1 is not strictly before it'
  )
  assert.deepEqual(dropped.tags, ['c0', 'z0'])
})

// ---------- store: the Bundle's seq is the local core's next length ----------

/** The op in block `seq` of a vault's local core. */
async function opAt(v, seq) {
  const value = await v.db.constructor.decodeValue(await v.db.local.get(seq)) // README: Autobee.decodeValue
  const dec = decodeOp(Buffer.from(value))
  assert.ok(dec.ok, `block ${seq} decodes as an op`)
  return dec.op
}

test('store: the seq of an op is its node\'s position in the local core, also after an empty block and a restart', async (t) => {
  const dir = await tmpDir('ordinal-pos')
  const a = await Bundle.init(dir)
  const self = hex(a.localKey)
  const c0 = await a.createConcept('notes/pos', 'note')
  assert.equal(c0.seq, 0)
  await a.db.append(Buffer.alloc(0)) // position 1: never reaches apply (index.js:1444)
  await a.update()
  assert.equal(a.db.local.length, 2)
  const r = await a.setField(c0.tag, 'title', ['after the empty block'])
  assert.equal(r.seq, 2, 'the seq is the position, not the count of ops that apply saw')
  assert.equal(r.tag, makeTag(a.localKey, 2))
  assert.equal(a.db.local.length, 3, 'the node is at position 2')
  const op = await opAt(a, 2)
  assert.equal(normalizeClock(op.clock)[self], 2, 'the self entry of the clock in block 2 is 2')
  await a.update()
  assert.equal(await a.val(K.flagRejected(self, 2)), undefined, 'not rejected forged-clock')
  assert.equal(await a.val(K.seen(self)), 3, 'seen/<self> is the last position plus one')
  assert.deepEqual((await a.val(K.cField(c0.tag, 'title'))).values, ['after the empty block'])
  await a.close()

  const a2 = await Bundle.open(dir)
  t.after(() => a2.close())
  const r2 = await a2.setField(c0.tag, 'title', ['after the restart'])
  assert.equal(r2.seq, 3, 'after a restart the seq continues from the local core length')
  await a2.update()
  assert.equal(await a2.val(K.flagRejected(self, 3)), undefined)
  assert.deepEqual((await a2.val(K.cField(c0.tag, 'title'))).values, ['after the restart'])
})

test('G8 (s5): an empty block does not inflate seqAtRemoval, so an op made after the revocation is rejected (I10)', { timeout: 60000 }, async (t) => {
  const a = await Bundle.init(await tmpDir('g8-a'))
  const b = await Bundle.join(await tmpDir('g8-b'), a.key)
  const bHex = hex(b.localKey)
  let un = pair(a, b)
  t.after(async () => {
    un()
    await a.close()
    await b.close()
  })
  await a.writers.add(b.localKey, { indexer: false })
  assert.ok(await until(async () => (await b.update(), b.writable)), 'b is admitted before it writes')
  const { tag: id } = await a.createConcept('n/x', 'note')
  assert.ok(await until(async () => (await b.update(), (await b.val(K.cMeta(id))) !== undefined)))
  const b0 = await b.setField(id, 'title', ['b0'])
  assert.equal(b0.seq, 0)
  await b.db.append(Buffer.alloc(0)) // position 1, as autobee's _appendAck would append it
  await b.update()
  assert.equal(b.db.local.length, 2)
  // a folds both nodes of b. The empty one reaches a's substrate and no apply.
  assert.ok(await until(async () => (await a.update(), await holds(a, b.localKey, 2))), 'a holds both nodes of b')
  await a.update()
  assert.equal(await a.val(K.seen(bHex)), 1, 'apply on a saw b0 only')
  const entry = (await a.clock()).find(([k]) => k === bHex)
  assert.deepEqual(entry, [bHex, 0], 'the clock entry for b is its last folded position, from the view alone')

  un()
  await a.removeWriter(b.localKey)
  await a.update()
  assert.equal((await a.val(K.govRemoved(bHex))).seqAtRemoval, 0)
  // b, partitioned, never sees the removal and writes once more
  const b1 = await b.setField(id, 'title', ['after-revocation'])
  assert.equal(b1.seq, 2, 'b1 is at position 2')
  un = pair(a, b)
  assert.ok(await until(async () => (await a.update(), ((await a.val(K.seen(bHex))) ?? 0) >= b1.seq + 1)))
  assert.deepEqual(await a.val(K.flagRejected(bHex, b1.seq)), { reason: 'revoked' })
  assert.deepEqual((await a.val(K.cField(id, 'title'))).values, ['b0'])
})

test('G10 (s6): after a crash that loses the boot record, each next op takes its own position, never a used seq', { timeout: 60000 }, async (t) => {
  const a = await Bundle.init(await tmpDir('g10-a'))
  const bdir = await tmpDir('g10-b')
  const b = await Bundle.join(bdir, a.key)
  const c = await Bundle.join(await tmpDir('g10-c'), a.key)
  const bHex = hex(b.localKey)
  const unAB = pair(a, b)
  const unAC = pair(a, c)
  let b2 = null
  let unA2 = () => {}
  t.after(async () => {
    unAB()
    unAC()
    unA2()
    if (b2) await b2.close()
    await a.close()
    await c.close()
  })
  await a.writers.add(b.localKey)
  await a.writers.add(c.localKey)
  assert.ok(await until(async () => (await b.update(), await c.update(), b.writable && c.writable)))
  const { tag: id } = await a.createConcept('n/x', 'note')
  assert.ok(await until(async () => (await b.update(), (await b.val(K.cMeta(id))) !== undefined)))
  await b.setField(id, 'title', ['b0'])
  await b.update()
  await sleep(200)
  await b.update()
  const H0 = await b.db.local.getUserData('autobee/head')
  // c appends R, b folds it, and b appends S, which links R
  await c.setField(id, 'status', ['r'])
  assert.ok(await until(async () => (await b.update(), (await b.val(K.seen(hex(c.localKey)))) === 1)))
  const S = await b.setField(id, 'title', ['S'])
  assert.equal(S.seq, 1)
  unAB()
  unAC()
  const gen = b.generation
  await b.close()
  // A crash before autobee stores its boot record leaves the older record
  // H0 behind. The crash also loses c's block R. So the reopen cannot fold
  // S until a peer serves R, and its view counts only b0 of b.
  {
    const store = new Corestore(bdir)
    const ns = store.namespace('okf/generation/' + gen)
    const core = ns.get({ key: b.localKey, active: false })
    await core.ready()
    await core.setUserData('autobee/head', H0)
    await core.close()
    const cCore = ns.get({ key: c.localKey, active: false })
    await cCore.ready()
    await cCore.clear(0, 1)
    await cCore.close()
    await store.close()
  }
  b2 = await Bundle.open(bdir)
  assert.equal(b2.db.local.length, 2, 'the local core holds b0 and S')
  assert.equal(await b2.val(K.seen(bHex)), 1, 'the reopen folded b0 only: S waits for R')
  // T10: an append resolves only once its node is in the local core. The
  // nodes of T and U wait in memory behind S, so T and U resolve only after
  // a serves R.
  const TU = Promise.all([
    b2.setField(id, 'title', ['T']).then((r) => ({ ...r, length: b2.db.local.length })),
    b2.setField(id, 'title', ['U']).then((r) => ({ ...r, length: b2.db.local.length }))
  ])
  const before = await Promise.race([TU.then(() => 'resolved'), sleep(500).then(() => 'waiting')])
  assert.equal(before, 'waiting', 'T and U do not resolve before a peer serves R')
  assert.equal(b2.db.local.length, 2, 'T and U are not in the local core yet')
  unA2 = pair(a, b2) // a serves R
  const [T, U] = await TU
  assert.equal(T.seq, S.seq + 1, 'T takes position 2')
  assert.equal(U.seq, T.seq + 1, 'U takes position 3, also while T waits behind S')
  assert.ok(T.length > T.seq && U.length > U.seq, 'T and U resolve with their nodes in the local core')
  assert.ok(await until(async () => (await b2.update(), ((await b2.val(K.seen(bHex))) ?? 0) >= U.seq + 1)), 'b2 folds S, T and U')
  assert.equal(b2.db.local.length, 4, 'T and U are at positions 2 and 3')
  assert.ok(await until(async () => (await a.update(), ((await a.val(K.seen(bHex))) ?? 0) >= U.seq + 1)), 'a folds S, T and U')
  for (const [name, v] of [['b2', b2], ['a', a]]) {
    for (const seq of [S.seq, T.seq, U.seq]) {
      assert.equal(await v.val(K.flagRejected(bHex, seq)), undefined, `${name}: the op at position ${seq} is not rejected`)
    }
    assert.deepEqual((await v.val(K.cField(id, 'title'))).values, ['U'], `${name}: U wins`)
  }
  assert.equal(await b2.snapshotHash(), await a.snapshotHash(), 'equal view hashes')
})

test('G9a (s4): after the governance race, the race writer\'s next op claims its position, and every peer flags it not-a-writer', { timeout: 120000 }, async (t) => {
  const links = []
  const peers = []
  t.after(async () => {
    for (const un of links) un()
    for (const v of peers) await v.close().catch(() => {})
  })
  const link = (x, y) => {
    const un = pair(x, y)
    links.push(un)
    return un
  }
  const a = await Bundle.init(await tmpDir('g9a-a'))
  const b = await Bundle.join(await tmpDir('g9a-b'), a.key)
  peers.push(a, b)
  const unAB = link(a, b)
  await a.writers.add(b.localKey, { indexer: true })
  assert.ok(await until(async () => (await b.update(), b.writable)))
  const a1 = await a.createConcept('seed/a1', 'note')
  assert.ok(await until(async () => (await b.update(), (await b.val(K.cMeta(a1.tag))) !== undefined)))
  const c = await Bundle.join(await tmpDir('g9a-c'), a.key)
  peers.push(c)
  const cHex = hex(c.localKey)
  const aHex = hex(a.localKey)
  link(a, c)
  assert.ok(await until(async () => (await c.update(), (await c.val(K.cMeta(a1.tag))) !== undefined)))
  assert.equal(c.writable, false, 'c writes nothing before its admission')

  unAB()
  await sleep(50)
  await b.removeWriter(a.localKey)
  await b.update()
  await sleep(100)
  const add = await a.writers.add(c.localKey, { indexer: false })
  assert.ok(await until(async () => (await c.update(), c.writable)))
  const Y = await c.setField(a1.tag, 'status', ['y'])
  assert.equal(Y.seq, 0)
  await c.update()
  link(a, b)
  link(b, c)
  const all = async (fn) => {
    for (const v of peers) {
      await v.update()
      if (!(await fn(v))) return false
    }
    return true
  }
  assert.ok(
    await until(() => all(async (v) => (await v.val(K.govRemoved(aHex))) !== undefined && ((await v.val(K.seen(aHex))) ?? 0) >= add.seq + 1), 30000),
    'every peer folds the revocation and the AddWriter'
  )
  const Z = await c.setField(a1.tag, 'status', ['z'])
  assert.equal(Z.seq, 1, 'Z takes position 1 in c\'s core')
  assert.equal(c.db.local.length, 2)
  assert.ok(await until(() => all(async (v) => ((await v.val(K.seen(cHex))) ?? 0) >= Z.seq + 1), 30000), 'every peer folds Z')
  const hs = []
  for (const v of peers) {
    assert.deepEqual(await v.val(K.flagRejected(aHex, add.seq)), { reason: 'revoked' })
    assert.deepEqual(await v.val(K.flagRejected(cHex, Y.seq)), { reason: 'not-a-writer' })
    assert.deepEqual(await v.val(K.flagRejected(cHex, Z.seq)), { reason: 'not-a-writer' }, 'Z is not forged-clock')
    hs.push(await v.snapshotHash())
  }
  assert.ok(hs.every((h) => h === hs[0]), `equal view hashes: ${hs.map((h) => h.slice(0, 16))}`)
})

// ---------- T12: the clock carries self and the writers with a gov/writer record ----------

test('T12: the clock carries self and each writer with a gov/writer record, a revoked one too, and no other key', { timeout: 60000 }, async (t) => {
  const a = await Bundle.init(await tmpDir('t12-a')) // the genesis indexer
  const b = await Bundle.join(await tmpDir('t12-b'), a.key) // admitted, then revoked
  const m = await Bundle.join(await tmpDir('t12-m'), a.key) // a member
  const s = await Bundle.join(await tmpDir('t12-s'), a.key) // a key that m approves
  const unpair = [pair(a, b), pair(a, m), pair(a, s)]
  t.after(async () => {
    for (const un of unpair) un()
    for (const v of [a, b, m, s]) await v.close()
  })
  const [aHex, bHex, mHex, sHex] = [a, b, m, s].map((v) => hex(v.localKey))
  await a.writers.add(b.localKey, { indexer: false })
  await a.writers.add(m.localKey, { indexer: false })
  assert.ok(await until(async () => (await b.update(), await m.update(), b.writable && m.writable)), 'b and m are admitted before they write')
  await b.createConcept('t12/b', 'note')
  // m is no indexer, so core rejects its AddWriter op policy-governance,
  // and grants s at weight 0 all the same (AD7).
  await m.writers.add(s.localKey)
  assert.ok(await until(async () => (await s.update(), s.writable)), 's is an autobee writer (positive control)')
  const sOp = await s.createConcept('t12/s', 'note')
  assert.ok(
    await until(async () => (await a.update(), (await a.val(K.seen(bHex))) === 1 && (await a.val(K.seen(sHex))) === 1)),
    'a folds the op of b and the op of s'
  )
  // s has no gov/writer record, and its op still claims its own position:
  // the clock carries self in every case.
  assert.equal(await s.val(K.govWriter(sHex)), undefined)
  assert.deepEqual(await a.val(K.flagRejected(sHex, sOp.seq)), { reason: 'not-a-writer' }, 'not forged-clock')
  await a.removeWriter(b.localKey)
  await a.update()
  const removed = await a.val(K.govRemoved(bHex))
  assert.equal(removed.seqAtRemoval, 0)
  assert.deepEqual(Object.keys(removed.clock).sort(), [aHex, bHex, mHex].sort(), 'the revocation clock cites no key without a record')
  assert.notEqual(await a.val(K.govWriter(bHex)), undefined, 'a revoked writer keeps its gov/writer record')

  const byKey = (x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0)
  const expected = [
    [aHex, (await a.val(K.seen(aHex))) - 1],
    [bHex, 0], // revoked, and still clocked
    [mHex, 0]
  ].sort(byKey)
  assert.deepEqual(await a.clock(), expected, 'self, the admitted writers and the revoked b. Not s.')
  const r = await a.createConcept('t12/a', 'note')
  const clock = normalizeClock((await opAt(a, r.seq)).clock)
  assert.deepEqual(Object.keys(clock).sort(), [aHex, bHex, mHex].sort(), 'the next op of a carries the same writers')
  assert.equal(clock[aHex], r.seq, 'its self entry is its own position')
})

test('G33 (s7): with 1,000 keys that a member approves, of one op each, an honest op stays under maxOpBytes', { timeout: 240000 }, async (t) => {
  const N = 1000
  const a = await Bundle.init(await tmpDir('g33-a')) // the genesis indexer
  const m = await Bundle.join(await tmpDir('g33-m'), a.key) // a member
  // The attacker's client holds the junk writers in one corestore.
  const junk = new Corestore(await tmpDir('g33-junk'))
  let unAM = pair(a, m)
  let unAJ = () => {}
  t.after(async () => {
    unAM()
    unAJ()
    await a.close()
    await m.close()
    await junk.close()
  })
  const [aHex, mHex] = [a, m].map((v) => hex(v.localKey))
  await a.writers.add(m.localKey, { indexer: false })
  assert.ok(await until(async () => (await m.update(), m.writable)), 'm is admitted before it writes')

  // The junk store gets the first node of a and nothing more. autobee
  // flushes no optimistic local node while its system is at genesis
  // (lib/writers.js:608-611, :644-645). So each junk writer folds one node
  // and not the vault, and N writers cost O(N).
  unAJ = pair(a, junk)
  const boot = junk.get({ key: a.key })
  await boot.ready()
  await boot.download({ start: 0, end: 1 }).done()
  await boot.close()
  unAJ()

  // The junk writers share one corestore, and autobee keeps a joiner's
  // local key in the user data of the bootstrap core (lib/boot.js:30, :94,
  // :153-160). So each one passes its own key pair, through the documented
  // keyPair option. The local key is the hash of the core's manifest, so
  // each junk writer opens once to tell its key.
  const junkWriter = async (i) =>
    Bundle.join(junk.namespace(`junk/${i}`), a.key, { keyPair: await junk.createKeyPair(`junk/${i}`) })
  const keys = []
  for (let i = 0; i < N; i++) {
    const j = await junkWriter(i)
    keys.push(hex(j.localKey))
    await j.close()
  }
  assert.equal(new Set(keys).size, N, 'N distinct junk keys')

  // m's AddWriter op makes each junk key an autobee writer at weight 0
  // (AD7). All grants come first: a junk op that sorts before a grant
  // would make peer a undo and apply again every grant after it.
  for (const k of keys) await m.writers.add(k)
  const mLength = m.db.local.length
  assert.ok(await until(async () => (await a.update(), (await a.val(K.seen(mHex))) === mLength)), 'a folds every grant of m')
  unAM()
  unAM = () => {}

  // Each junk key appends one op, as an attacker's client does.
  for (let i = 0; i < N; i++) {
    const j = await junkWriter(i)
    assert.equal(hex(j.localKey), keys[i])
    await outsiderAppend(j, `junk/${i}`)
    await j.close()
  }

  // A junk writer's own client would announce its core over the wakeup
  // protocol. The junk store has no such client, so a learns of each core
  // through the documented db.wakeup (autobee README). Without the hint,
  // autobee closes an idle writer core that holds no node at its next reset
  // (lib/writers.js:445-459), and nothing opens it again. A hinted length
  // keeps it open and active (lib/writers.js:67-88, :410-415).
  await Promise.all(keys.map((k) => a.db.wakeup({ key: Buffer.from(k, 'hex'), length: 1 })))
  unAJ = pair(a, junk)
  const foldedAll = async () => {
    await a.update()
    for (const k of keys) if ((await a.val(K.seen(k))) !== 1) return false
    return true
  }
  assert.ok(await until(foldedAll, 180000, 250), 'a folds the op of every junk key (positive control)')
  for (const k of keys) {
    assert.deepEqual(await a.val(K.flagRejected(k, 0)), { reason: 'not-a-writer' })
  }

  const r = await a.createConcept('g33/honest', 'note')
  const block = await a.db.local.get(r.seq)
  const bytes = (await a.db.constructor.decodeValue(block)).byteLength // README: Autobee.decodeValue
  assert.ok(bytes <= a.metadata.limits.maxOpBytes, `the honest op is ${bytes} bytes, at most maxOpBytes ${a.metadata.limits.maxOpBytes}`)
  await a.update()
  assert.equal(await a.val(K.flagRejected(aHex, r.seq)), undefined, 'the honest op is not rejected oversize-op')
  assert.notEqual(await a.val(K.cMeta(r.tag)), undefined, 'the honest op takes effect')
  const clock = normalizeClock((await opAt(a, r.seq)).clock)
  assert.deepEqual(Object.keys(clock).sort(), [aHex, mHex].sort(), 'its clock carries self and m, and no junk key')
})

test('G13: with autobee\'s default ackThreshold, a writer that falls 40 flushes behind appends no empty block', { timeout: 60000 }, async (t) => {
  // An ack is an empty node in the local core (autobee index.js:1297-1314).
  // A threshold ack needs a head that the local writer does not trust
  // (index.js:1305, :1316-1330). okf passes no isTrusted and no
  // mostRecentTrusted hook, so every key is trusted (lib/trusted.js:30-32).
  // Each append of a is one batch, and each batch is one system flush on b
  // (index.js:1447-1462, lib/system.js:447). So b falls 40 flushes behind,
  // above the default threshold of 32 (index.js:30, :134).
  const a = await Bundle.init(await tmpDir('g13-a'))
  const b = await Bundle.join(await tmpDir('g13-b'), a.key)
  const un = pair(a, b)
  t.after(async () => {
    un()
    await a.close()
    await b.close()
  })
  await a.writers.add(b.localKey)
  assert.ok(await until(async () => (await b.update(), b.writable)))
  const { tag } = await b.createConcept('b/one', 'note')
  assert.ok(await until(async () => (await a.update(), (await a.val(K.cMeta(tag))) !== undefined)))
  const before = b.db.local.length
  assert.equal(before, 1)
  const aHex = hex(a.localKey)
  for (let i = 0; i < 40; i++) {
    await a.createConcept(`a/n${i}`, 'note')
  }
  const aOps = await a.val(K.seen(aHex))
  assert.ok(await until(async () => (await b.update(), (await b.val(K.seen(aHex))) === aOps)), 'b folds every op of a')
  await sleep(500)
  await b.update()
  assert.equal(b.db.local.length, before, 'no empty block landed in the local core of b')
  assert.equal(await b.val(K.seen(hex(b.localKey))), 1)
})

/** Every file under `dir`, relative to it, except node_modules. */
async function filesUnder(dir, rel = '') {
  const out = []
  for (const e of await readdir(join(dir, rel), { withFileTypes: true })) {
    if (e.name === 'node_modules') continue
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...(await filesUnder(dir, r)))
    else if (e.isFile()) out.push(r)
  }
  return out
}

test('the store, core, faces and cli read no undocumented autobee property (RAILS 22a)', async () => {
  const hits = []
  for (const pkg of ['store', 'core', 'faces', 'cli']) {
    const root = join(OKF, pkg)
    for (const rel of await filesUnder(root)) {
      const lines = (await readFile(join(root, rel), 'utf8')).split('\n')
      lines.forEach((line, i) => {
        if (/db\.system|db\.writers|db\._/.test(line)) hits.push(`${pkg}/${rel}:${i + 1}: ${line.trim()}`)
      })
    }
  }
  assert.deepEqual(hits, [])
})
