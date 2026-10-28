// Store scope (okf SPEC §13, T4), I3 at store level: a vault reopened from
// disk holds a view bit-identical to the pre-restart view, appends continue
// with correct seq/clock continuity, and a fresh peer that rebuilds from
// the replicated log converges to the same hash (rebuild equivalence).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Corestore from '../store/node_modules/corestore/index.js'
import { Bundle, K, tmpDir, pair, until, converged } from './store-helpers.js'

test('restart from disk: reopened view equals the pre-close view (I3)', async (t) => {
  const dir = await tmpDir('restart')
  const a = await Bundle.init(dir)
  const { tag: id } = await a.createConcept('guides/home', 'guide')
  await a.setField(id, 'title', ['Welcome'])
  await a.addTag(id, 'wiki')
  await a.setBody(id, null, 'First body with a [want](/guides/missing).')
  await a.setPath(id, 'guides/start') // rename
  await a.setField(id, 'title', ['Welcome!']) // supersede own write
  const before = await a.snapshotHash()
  const beforeKeys = Object.keys(await a.view.dump(''))
  assert.ok(beforeKeys.length > 0)
  await a.close()

  const a2 = await Bundle.open(dir)
  t.after(() => a2.close())
  assert.equal(await a2.snapshotHash(), before, 'hash equality across restart')
  assert.deepEqual(Object.keys(await a2.view.dump('')), beforeKeys, 'same key set')

  // still writable with correct seq continuity after restart (§8
  // forged-clock: the self entry must equal the actual local position)
  const r = await a2.setField(id, 'title', ['Back again'])
  assert.equal(r.seq, 6, 'seq continues from the persisted local core')
  await a2.update()
  assert.equal(await a2.val(K.flagRejected(a2.localKey.toString('hex'), r.seq)), undefined)
  assert.deepEqual((await a2.val(K.cField(id, 'title'))).values, ['Back again'])
})

test('an empty block at the tail of the local core takes a position, so the seq after restart skips it (§3, §8 forged-clock)', async (t) => {
  // AD4: the seq of an op is its node's position in the local core,
  // node.length - 1. An empty block takes a position and never reaches
  // apply (autobee index.js:1444: only non-empty values reach apply). So
  // after a restart, seen/<self> counts the ops that apply saw, and the
  // next position is past the empty block. The first op after the restart
  // must take that position, or every peer rejects it forged-clock.
  //
  // G13: the test does not imitate an autobee ack. okf's configuration
  // never makes autobee append one (store-ordinal.test.js, G13). The test
  // appends the empty block with the documented db.append, which any
  // client that holds the vault's autobee can call.
  const dir = await tmpDir('restart-empty')
  const open = new Set()
  t.after(async () => {
    for (const v of open) await v.close()
  })
  const a = await Bundle.init(dir)
  open.add(a)
  const self = a.localKey.toString('hex')
  const { tag: id } = await a.createConcept('guides/empty', 'guide')
  await a.setField(id, 'title', ['Before the empty block'])
  await a.db.append(Buffer.alloc(0)) // position 2, the last block before the restart
  await a.update()
  assert.equal(a.db.local.length, 3, 'two ops plus one empty block in the local core')
  assert.equal(await a.val(K.seen(self)), 2, 'apply saw only the two ops')
  await a.close()
  open.delete(a)

  const a2 = await Bundle.open(dir)
  open.add(a2)
  assert.equal(a2.db.local.length, 3, 'after the restart the next position is 3')
  assert.equal(await a2.val(K.seen(self)), 2, 'after the restart seen/<self> is still 2')
  const r = await a2.setField(id, 'title', ['After the empty block'])
  assert.equal(r.seq, 3, 'the seq is the position of the node, past the empty block')
  assert.equal(a2.db.local.length, 4, 'the node is at position 3')
  await a2.update()
  // Core keys a rejection by the node's position, not by the seq that the
  // op claims (core/lib/apply.js reject). So check every rejection of self.
  assert.deepEqual(await a2.view.dump(K.flagPrefix('rejected', self)), {}, 'no op of self is rejected')
  assert.equal(await a2.val(K.seen(self)), 4, 'seen/<self> is the last position plus one')
  assert.deepEqual((await a2.val(K.cField(id, 'title'))).values, ['After the empty block'])
})

test('a reopen folds every node that the local core holds before open resolves', async (t) => {
  // Bundle.open runs db.update() before it resolves (store/lib/bundle.js
  // _openInner), so the view is current when open resolves. A crash can
  // leave a node in the local core that the stored boot record does not
  // cover: autobee's drain writes the local nodes to the core
  // (index.js:824) before it stores the boot record, `autobee/head` in the
  // user data of the local core (index.js:841, :1492). The test simulates
  // that crash. It puts back the boot record from before the last node,
  // through the documented hypercore API of a closed store, as
  // store-ordinal.test.js G10 does. Without the update() on open, autobee
  // folds the node later in the background, and reads right after open
  // miss it.
  const dir = await tmpDir('reopen-fold')
  const open = new Set()
  t.after(async () => {
    for (const v of open) await v.close()
  })
  const a = await Bundle.init(dir)
  open.add(a)
  const self = a.localKey.toString('hex')
  const { tag: id } = await a.createConcept('guides/fold', 'guide')
  await a.update()
  const H0 = await a.db.local.getUserData('autobee/head') // covers position 0
  await a.setField(id, 'title', ['After the boot record']) // position 1
  await a.update()
  const gen = a.generation
  await a.close()
  open.delete(a)
  const store = new Corestore(dir)
  try {
    const core = store.namespace('okf/generation/' + gen).get({ key: a.localKey, active: false })
    await core.ready()
    await core.setUserData('autobee/head', H0)
  } finally {
    await store.close() // closes the core too
  }

  const a2 = await Bundle.open(dir)
  open.add(a2)
  // No update() here: open itself must have folded position 1.
  assert.equal(a2.db.local.length, 2, 'the local core holds both nodes')
  assert.equal(await a2.val(K.seen(self)), 2, 'the view holds both nodes when open resolves')
  assert.deepEqual((await a2.val(K.cField(id, 'title'))).values, ['After the boot record'])
})

test('fresh peer rebuild from the log equals the restarted view (I3)', async (t) => {
  const dir = await tmpDir('rebuild-a')
  const a = await Bundle.init(dir)
  const { tag: id } = await a.createConcept('guides/rebuild', 'guide')
  await a.setField(id, 'title', ['Rebuild me'])
  await a.setBody(id, null, 'body text')
  await a.close()

  const a2 = await Bundle.open(dir)
  const fresh = await Bundle.join(await tmpDir('rebuild-b'), a2.key)
  const unpair = pair(a2, fresh)
  t.after(async () => {
    unpair()
    await a2.close()
    await fresh.close()
  })

  assert.ok(
    await until(async () => {
      await fresh.update()
      return (await fresh.val(K.cField(id, 'title'))) !== undefined
    }),
    'fresh peer folds the replicated log'
  )
  const hash = await converged([a2, fresh])
  assert.ok(hash, 'restarted view and from-scratch rebuild agree')
  assert.deepEqual((await fresh.val(K.cField(id, 'title'))).values, ['Rebuild me'])
})

// ---------- D-047 F02: a restart during a heal ----------

const hex = (k) => k.toString('hex')

test('a peer that closes during a heal, and reopens in a quiet vault, converges: open wakes each writer with a gov/writer record (D-047 F02)', { timeout: 120000 }, async (t) => {
  // The port of the D-047 probe convergence/probe-c-stall-3.mjs (who=ac,
  // bWrites=yes). b is away while a, b and c write. b reconnects, and it
  // closes as soon as its own cores of a and c hold every new block, while
  // its fold of them can still run. After the reopen, no peer writes.
  //
  // autobee restarts only the writers that are system heads, plus the boot
  // hints since the last drain that applied hints (index.js:605-618,
  // :853-875, :877-892). b's last node links the old heads of a and c, so
  // neither is a head. a and c are caught up, so they announce no pending
  // writer (autobee-wakeup index.js:19-23). b already holds the blocks, so
  // no new length reaches it. Without a wakeup, b stays behind until
  // somebody writes. Bundle._openInner calls the documented db.wakeup for
  // each key with a gov/writer record (autobee README.md:165-167).
  //
  // The close races b's fold. The trials run at once, and under that load
  // most of them close before the fold ends. Without the wakeup, the D-055
  // probe sslop/D-055/probes/probe-par.mjs stalled 4, 3 and 4 of 4 trials,
  // and with it 0 of 8. Four trials keep the load low for the other tests.
  const TRIALS = 4
  const N = 10
  const DEADLINE = 15000
  const open = new Set()
  const unpairs = []
  t.after(async () => {
    for (const un of unpairs) un()
    for (const v of open) await v.close().catch(() => {})
  })
  const link = (x, y) => {
    const un = pair(x, y)
    unpairs.push(un)
    return un
  }
  const trial = async (i) => {
    const a = await Bundle.init(await tmpDir(`heal-a${i}`))
    open.add(a)
    const bdir = await tmpDir(`heal-b${i}`)
    let b = await Bundle.join(bdir, a.key)
    open.add(b)
    const c = await Bundle.join(await tmpDir(`heal-c${i}`), a.key)
    open.add(c)
    const unAB = link(a, b)
    link(a, c)
    const unBC = link(b, c)
    await a.writers.add(b.localKey)
    await a.writers.add(c.localKey)
    assert.ok(await until(async () => (await b.update(), await c.update(), b.writable && c.writable)), `trial ${i}: b and c are admitted`)
    const y = await c.createConcept('c/zero', 'note')
    assert.ok(await until(async () => (await b.update(), (await b.val(K.cMeta(y.tag))) !== undefined)), `trial ${i}: b folds c`)
    const x = await b.createConcept('b/one', 'note') // it links the heads of a and c
    assert.ok(
      await until(async () => {
        for (const v of [a, c]) {
          await v.update()
          if ((await v.val(K.cMeta(x.tag))) === undefined) return false
        }
        return true
      }),
      `trial ${i}: a and c fold b`
    )

    unAB()
    unBC()
    for (let j = 0; j < N; j++) {
      await a.createConcept(`a/${j}`, 'note')
      await c.createConcept(`c/${j}`, 'note')
      await b.createConcept(`b/${j}`, 'note')
    }
    await a.update()
    await c.update()
    const want = { a: a.db.local.length, c: c.db.local.length }

    // The heal: b closes as soon as its cores of a and c hold every new block.
    const ns = b.store.namespace('okf/generation/' + b.generation)
    const ca = ns.get({ key: a.localKey, active: false })
    const cc = ns.get({ key: c.localKey, active: false })
    await ca.ready()
    await cc.ready()
    link(a, b)
    link(b, c)
    const arrived = await until(() => ca.contiguousLength >= want.a && cc.contiguousLength >= want.c, DEADLINE, 1)
    await ca.close()
    await cc.close()
    assert.ok(arrived, `trial ${i}: b holds every block of the heal (positive control)`)
    await b.close()
    open.delete(b)

    b = await Bundle.open(bdir)
    open.add(b)
    link(a, b)
    link(b, c)
    const hash = await converged([a, b, c], DEADLINE)
    const seen = {
      a: (await b.val(K.seen(hex(a.localKey)))) ?? 0,
      c: (await b.val(K.seen(hex(c.localKey)))) ?? 0
    }
    return { trial: i, converged: hash !== null, seen, want }
  }
  const results = await Promise.all(Array.from({ length: TRIALS }, (_, i) => trial(i)))
  assert.deepEqual(
    results.filter((r) => !r.converged),
    [],
    `every trial converges within ${DEADLINE} ms in a quiet vault`
  )
})

test('open wakes each key with a gov/writer record, and never a key that only seen/ holds (D-047 F02, G32)', { timeout: 60000 }, async (t) => {
  // m is a member and no indexer. Core rejects m's AddWriter of j
  // policy-governance, and grants j at weight 0 all the same (AD7). So the op
  // of j reaches apply: a holds seen/<j>, and j has no gov/writer record. A
  // junk key of G32 is such a key, and the open must not open a core for it.
  // a's last node links the heads of m and j, so neither is a system head
  // at the reopen, and autobee itself restarts neither (index.js:605-618).
  // The test records each core that the store opens, through corestore's
  // documented store.watch (corestore README.md:105-113).
  const adir = await tmpDir('wake-a')
  const a = await Bundle.init(adir)
  const m = await Bundle.join(await tmpDir('wake-m'), a.key)
  const j = await Bundle.join(await tmpDir('wake-j'), a.key)
  const unpairs = [pair(a, m), pair(a, j)]
  let a2 = null
  t.after(async () => {
    for (const un of unpairs) un()
    if (a2) await a2.close()
    for (const v of [a, m, j]) await v.close() // a no-op for a, which the test closed
  })
  const [mHex, jHex] = [m, j].map((v) => hex(v.localKey))
  // The internal core that store.watch passes can have no key yet, and it
  // always has its discovery key, so the test compares discovery keys.
  const [mDk, jDk] = [m, j].map((v) => hex(v.db.local.discoveryKey))
  await a.writers.add(m.localKey)
  assert.ok(await until(async () => (await m.update(), m.writable)), 'm is admitted')
  await m.writers.add(j.localKey) // rejected policy-governance, granted at weight 0 (AD7)
  assert.ok(await until(async () => (await j.update(), j.writable)), 'j is an autobee writer (positive control)')
  await j.createConcept('j/x', 'note')
  assert.ok(await until(async () => (await a.update(), (await a.val(K.seen(jHex))) === 1)), 'a folds the op of j')
  assert.deepEqual(await a.val(K.flagRejected(jHex, 0)), { reason: 'not-a-writer' })
  assert.notEqual(await a.val(K.govWriter(mHex)), undefined, 'm has a gov/writer record')
  assert.equal(await a.val(K.govWriter(jHex)), undefined, 'j has no gov/writer record')
  await a.createConcept('a/last', 'note') // it links the heads of m and j
  await a.update()
  for (const un of unpairs) un()
  await a.close()

  a2 = new Bundle(adir)
  const opened = new Set()
  a2.store.watch((core) => opened.add(hex(core.discoveryKey)))
  await a2.ready()
  assert.ok(opened.has(mDk), 'the open wakes m, which has a gov/writer record')
  assert.ok(!opened.has(jDk), 'the open never wakes j, which only seen/ holds')
})
