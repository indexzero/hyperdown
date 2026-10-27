// AD4, the per-writer ordinal is the node's position (okf SPEC §3, §8).
// T9 adopts spike T8 (D-027). The ports of ab2-review/scratch-A
// s4-race.mjs (G9a), s5-clock-units.mjs (G8) and s6-strand.mjs (G10),
// adapted to admit before writing, plus the core rules that the ordinal
// changes.
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
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import Corestore from '../store/node_modules/corestore/index.js'
import { Bundle, K, makeTag, tmpDir, pair, until, sleep } from './store-helpers.js'
import { Env, hostStub, rejectedReasons } from './helpers.js'
import { holds } from './attack-helpers.js'
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
  const T = await b2.setField(id, 'title', ['T'])
  const U = await b2.setField(id, 'title', ['U'])
  assert.equal(T.seq, S.seq + 1, 'T takes position 2')
  assert.equal(U.seq, T.seq + 1, 'U takes position 3, also while T waits behind S')
  unA2 = pair(a, b2) // a serves R
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
