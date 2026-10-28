// T10, G11 (the close race): an append returns { seq, tag } only for a node
// that is in the local core. close() closes autobee first, and then it waits
// for every append to settle (G3-P3 F01).
//
// autobee's close sets _interrupting (index.js:392). The drain then stops
// (index.js:797), and _flushLocal pulls in no more local nodes
// (index.js:1580). A db.append in flight resolves with its node only in
// memory, and the node never reaches the local core. Before T10,
// Bundle.close() did not wait for its appends, so an append could return a
// tag for a node that a reopen does not hold.
//
// A plain db.append also resolves with its node only in memory when the node
// waits behind an earlier local node that links a missing block
// (lib/writers.js:624-631). The append then waits for the node to reach the
// local core. A close() before that fails it VAULT_CLOSED_BEFORE_DURABLE: the
// node lives only in autobee's memory (lib/writers.js:732-755), so it never
// lands after a reopen.
//
// close() does not wait for an append before it closes autobee. A db.append
// can wait for a drain that only autobee's close ends: a reorder that reads a
// block that the peer does not hold (G3-P3 F01). So an append that has not
// handed autobee its node when close() begins fails
// VAULT_CLOSED_BEFORE_DURABLE, and its op is not written.
//
// The first test is the port of ab2-review/scratch-A/s9-close-race.mjs. It
// is adapted to admit before writing: the creator is the genesis writer, so
// it is writable at init, and the test asserts that before the first write.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Corestore from '../store/node_modules/corestore/index.js'
import { Bundle, K, tmpDir, sleep, pair, until } from './store-helpers.js'

const hex = (k) => k.toString('hex')

test('G11 (s9): a close during an append returns no tag for a node that is missing after a reopen, and an append that it rejects wrote nothing, in 50 of 50 runs', { timeout: 300000 }, async (t) => {
  // D-047 F09: the error says "the op is not written", and a retry depends
  // on it. So for each rejected append, the reopened local core holds x/0
  // only. The D-047 mutation M14, which rejects every append that decides
  // at the close, wrote 1 to 4 rejected nodes in 50 runs.
  const RUNS = 50
  const lost = []
  const written = []
  const open = new Set()
  t.after(async () => {
    for (const v of open) await v.close()
  })
  let ok = 0
  let rejected = 0
  for (let i = 0; i < RUNS; i++) {
    const dir = await tmpDir('s9-close-race')
    const a = await Bundle.init(dir)
    open.add(a)
    assert.ok(a.writable, 'the creator is admitted before it writes')
    const self = hex(a.localKey)
    await a.createConcept('x/0', 'note')
    const p = a.createConcept('x/1', 'note').then(
      (r) => ({ r }),
      (e) => ({ e })
    )
    await sleep(i % 10) // vary the race point
    await a.close()
    open.delete(a)
    const res = await p
    const a2 = await Bundle.open(dir)
    open.add(a2)
    const length = a2.db.local.length
    const seen = await a2.val(K.seen(self))
    if (res.e) {
      rejected++
      assert.equal(res.e.code, 'VAULT_CLOSED_BEFORE_DURABLE', `run ${i}: ${res.e.message}`)
      if (length !== 1 || seen !== 1) written.push({ run: i, seq: res.e.seq, length, seen })
    } else {
      const meta = await a2.val(K.cMeta(res.r.tag))
      if (length > res.r.seq && seen === res.r.seq + 1 && meta !== undefined) ok++
      else lost.push({ run: i, seq: res.r.seq, length, seen })
    }
    await a2.close()
    open.delete(a2)
  }
  assert.deepEqual(lost, [], `no tag for a node that is missing after the reopen (ok ${ok}, rejected ${rejected})`)
  assert.deepEqual(written, [], `an append that the close rejected wrote nothing (ok ${ok}, rejected ${rejected})`)
})

test('close() cuts each append that waits in the append chain VAULT_CLOSED_BEFORE_DURABLE, and each append that returned is in the core after a reopen', { timeout: 60000 }, async (t) => {
  // D-047 F10: this test passed without step 2 of close(), so it no longer
  // carries that claim. The next test does.
  const N = 8
  const dir = await tmpDir('close-cuts')
  const a = await Bundle.init(dir)
  let a2 = null
  t.after(async () => {
    await a.close() // a no-op once the test has closed it
    if (a2) await a2.close()
  })
  const settled = new Set()
  const outcomes = []
  for (let i = 0; i < N; i++) {
    outcomes.push(
      a.createConcept(`n/${i}`, 'note').then(
        (r) => {
          settled.add(i)
          return r
        },
        (e) => {
          settled.add(i)
          return e
        }
      )
    )
  }
  // Append 0 has returned. Append 1 runs, and appends 2 to N - 1 wait in the
  // append chain. close() closes autobee before it waits for them.
  assert.equal((await outcomes[0]).seq, 0)
  await a.close()
  assert.equal(settled.size, N, 'every append that started before close() settled before close() resolved')
  const results = await Promise.all(outcomes)
  for (let i = 2; i < N; i++) {
    assert.equal(results[i].code, 'VAULT_CLOSED_BEFORE_DURABLE', `append ${i} was still queued, so close() cut it`)
    assert.equal(results[i].seq, null, `append ${i} took no position`)
  }
  const returned = results.filter((r) => !(r instanceof Error))
  const failed = results.filter((r) => r instanceof Error)
  assert.deepEqual(
    failed.map((e) => e.code),
    Array(failed.length).fill('VAULT_CLOSED_BEFORE_DURABLE'),
    'each append that close() cut fails by that name'
  )
  assert.deepEqual(
    returned.map((r) => r.seq),
    [...Array(returned.length).keys()],
    'the seqs that returned are the positions 0 to k - 1'
  )

  a2 = await Bundle.open(dir)
  assert.equal(a2.db.local.length, returned.length, 'the local core holds the node of each append that returned, and no other node')
  for (const r of returned) {
    assert.notEqual(await a2.val(K.cMeta(r.tag)), undefined, `the concept of tag ${r.tag} is in the view`)
  }
})

test('close() during an append that waits in the ack gate, before db.append, fails it VAULT_CLOSED_BEFORE_DURABLE, and no node of it reaches the core', { timeout: 60000 }, async (t) => {
  // The ack gate of backpressure (see Bundle.append()) holds the append in
  // _append, before it hands autobee its node. close() releases the gate.
  // autobee is then closing or closed, so the append hands it no node.
  const adir = await tmpDir('gate-close-a')
  const a = await Bundle.init(adir, { backpressure: { maxInflight: 1, ackTimeout: 60000 } })
  const b = await Bundle.join(await tmpDir('gate-close-b'), a.key)
  const unAB = pair(a, b)
  let a2 = null
  t.after(async () => {
    unAB()
    if (a2) await a2.close()
    await a.close() // a no-op once the test has closed it
    await b.close()
  })
  await a.writers.add(b.localKey)
  const { tag: id } = await a.createConcept('n/x', 'note')
  assert.ok(await until(async () => (await b.update(), b.writable && (await b.val(K.cMeta(id))) !== undefined)))
  await b.setField(id, 'title', ['b0']) // its clock cites position 1 of a
  assert.ok(
    await until(async () => (await a.update(), (await a.val(K.seen(hex(b.localKey)))) === 1)),
    'a folds b0, which acks position 1'
  )
  unAB() // no later ack reaches a
  const A2 = await a.setField(id, 'title', ['a2'])
  assert.equal(A2.seq, 2, 'one op past the ack is admitted')

  const T = a.setField(id, 'title', ['T']).then(
    (r) => ({ r }),
    (e) => ({ e })
  )
  const before = await Promise.race([T.then(() => 'settled'), sleep(500).then(() => 'waiting')])
  assert.equal(before, 'waiting', 'T waits in the ack gate, because no peer acks position 2')
  await a.close()
  const res = await T
  assert.equal(res.r, undefined, 'no tag for T')
  assert.equal(res.e.code, 'VAULT_CLOSED_BEFORE_DURABLE')
  assert.equal(res.e.seq, 3)

  a2 = await Bundle.open(adir)
  assert.equal(a2.db.local.length, 3, 'the local core holds no node of T')
  assert.deepEqual((await a2.val(K.cField(id, 'title'))).values, ['a2'], 'T is not in the view')
})

test('an append that starts after close() begins fails with VAULT_CLOSED, and nothing reaches the local core', { timeout: 60000 }, async (t) => {
  const dir = await tmpDir('append-after-close')
  const a = await Bundle.init(dir)
  const { tag: id } = await a.createConcept('n/0', 'note')
  await a.addTag(id, 'kept')

  const closing = a.close()
  await assert.rejects(a.createConcept('n/1', 'note'), { code: 'VAULT_CLOSED' }, 'while close() runs')
  await assert.rejects(a.setField(id, 'title', ['late']), { code: 'VAULT_CLOSED' }, 'while close() runs')
  await assert.rejects(a.remTag(id, 'kept'), { code: 'VAULT_CLOSED' }, 'remTag reads the view first, and still fails named')
  await closing
  await assert.rejects(a.createConcept('n/2', 'note'), { code: 'VAULT_CLOSED' }, 'after close() resolved')
  await assert.rejects(a.writers.add(Buffer.alloc(32, 1)), { code: 'VAULT_CLOSED' }, 'a governance op too')

  const a2 = await Bundle.open(dir)
  t.after(() => a2.close())
  assert.equal(a2.db.local.length, 2, 'the local core holds only the two appends from before close()')
  assert.equal((await a2.val(K.cField(id, 'title'))), undefined, 'no late set-field')
})

/**
 * The setup of the G10 test (store-ordinal.test.js). After a crash that
 * loses the boot record of b and c's block R, the reopen of b cannot fold
 * S, which links R. A new local node of b then waits behind S, in
 * autobee's memory, and its append waits for the local core (_durable()).
 * Returns `s`: s.b2 is the reopened b. The test can set s.b3 and push
 * unpairs on s.unpairs. t.after closes every vault and unpairs each pair.
 */
async function waitBehindMissingLink(t, name) {
  const s = { unpairs: [], b: null, b2: null, b3: null }
  t.after(async () => {
    for (const un of s.unpairs) un()
    for (const v of [s.b, s.b2, s.b3, s.a, s.c]) if (v) await v.close() // a no-op for a closed vault
  })
  s.a = await Bundle.init(await tmpDir(`${name}-a`))
  s.bdir = await tmpDir(`${name}-b`)
  const b = (s.b = await Bundle.join(s.bdir, s.a.key))
  s.c = await Bundle.join(await tmpDir(`${name}-c`), s.a.key)
  const { a, c } = s
  s.bHex = hex(b.localKey)
  const unAB = pair(a, b)
  const unAC = pair(a, c)
  s.unpairs.push(unAB, unAC)
  await a.writers.add(b.localKey)
  await a.writers.add(c.localKey)
  assert.ok(await until(async () => (await b.update(), await c.update(), b.writable && c.writable)))
  const { tag: id } = await a.createConcept('n/x', 'note')
  s.id = id
  assert.ok(await until(async () => (await b.update(), (await b.val(K.cMeta(id))) !== undefined)))
  await b.setField(id, 'title', ['b0'])
  await b.update()
  await sleep(200)
  await b.update()
  const H0 = await b.db.local.getUserData('autobee/head')
  await c.setField(id, 'status', ['r'])
  assert.ok(await until(async () => (await b.update(), (await b.val(K.seen(hex(c.localKey)))) === 1)))
  const S = await b.setField(id, 'title', ['S'])
  assert.equal(S.seq, 1)
  unAB()
  unAC()
  const gen = b.generation
  await b.close()
  {
    const store = new Corestore(s.bdir)
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
  s.b2 = await Bundle.open(s.bdir)
  assert.equal(s.b2.db.local.length, 2, 'the local core holds b0 and S')
  assert.equal(await s.b2.val(K.seen(s.bHex)), 1, 'S waits for R')
  return s
}

test('an append that waits behind a missing link fails VAULT_CLOSED_BEFORE_DURABLE when close() runs, and after a reopen its op is not in the view', { timeout: 60000 }, async (t) => {
  const s = await waitBehindMissingLink(t, 'wait-close')
  const { a, b2, bHex, id } = s
  const T = b2.setField(id, 'title', ['T']).then(
    (r) => ({ r }),
    (e) => ({ e })
  )
  const before = await Promise.race([T.then(() => 'settled'), sleep(500).then(() => 'waiting')])
  assert.equal(before, 'waiting', 'T waits for its node to reach the local core')
  await b2.close() // returns: it does not wait for T's node
  const res = await T
  assert.equal(res.r, undefined, 'no tag for T')
  assert.equal(res.e.code, 'VAULT_CLOSED_BEFORE_DURABLE')
  assert.equal(res.e.seq, 2)

  const b3 = (s.b3 = await Bundle.open(s.bdir))
  assert.equal(b3.db.local.length, 2, 'after the reopen the local core still holds only b0 and S')
  s.unpairs.push(pair(a, b3)) // a serves R
  assert.ok(await until(async () => (await b3.update(), ((await b3.val(K.seen(bHex))) ?? 0) >= 2)), 'b3 folds S')
  assert.deepEqual((await b3.val(K.cField(id, 'title'))).values, ['S'], 'T is not in the view')
  // T never reached any core, so its position is free: the next op takes it,
  // and every peer accepts it.
  const V = await b3.setField(id, 'title', ['V'])
  assert.equal(V.seq, 2)
  assert.ok(await until(async () => (await a.update(), ((await a.val(K.seen(bHex))) ?? 0) >= 3)), 'a folds V')
  for (const v of [b3, a]) {
    await v.update()
    assert.equal(await v.val(K.flagRejected(bHex, 2)), undefined)
    assert.deepEqual((await v.val(K.cField(id, 'title'))).values, ['V'])
  }
})

test('close() resolves only after every in-flight append has settled: each append whose node waits for the local core fails VAULT_CLOSED_BEFORE_DURABLE before close() resolves, and none is in the core after a reopen (D-047 F10)', { timeout: 60000 }, async (t) => {
  // Each append hands autobee its node, which waits behind S, so each
  // append waits for the local core. Only close() ends that wait:
  // _lengthAfterClose() reads the length of the local core through the
  // root corestore, which step 3 of close() closes. Without step 2,
  // `await Promise.all(this._appending)`, close() closes that store while
  // the reads run (D-047 F10).
  const s = await waitBehindMissingLink(t, 'close-settles')
  const N = 4
  const settled = new Set()
  const outcomes = []
  for (let i = 0; i < N; i++) {
    outcomes.push(
      s.b2.setField(s.id, 'title', [`T${i}`]).then(
        (r) => {
          settled.add(i)
          return r
        },
        (e) => {
          settled.add(i)
          return e
        }
      )
    )
  }
  const before = await Promise.race([outcomes[N - 1].then(() => 'settled'), sleep(500).then(() => 'waiting')])
  assert.equal(before, 'waiting', 'the last append waits for its node to reach the local core')
  await s.b2.close()
  assert.equal(settled.size, N, 'every append that started before close() settled before close() resolved')
  const results = await Promise.all(outcomes)
  assert.deepEqual(
    results.map((e) => [e.code, e.seq]),
    [...Array(N).keys()].map((i) => ['VAULT_CLOSED_BEFORE_DURABLE', 2 + i]),
    'each append took a position, handed autobee its node, and failed by name'
  )
  s.b3 = await Bundle.open(s.bdir)
  assert.equal(s.b3.db.local.length, 2, 'after the reopen the local core holds only b0 and S')
})

test('close() returns while an append waits for a drain that reads an absent block, and the append fails VAULT_CLOSED_BEFORE_DURABLE (G3-P3 F01)', { timeout: 60000 }, async (t) => {
  // The port of the D-039 probe probe-close-reorder.mjs. a folds b0, and then
  // a writes a node that links b0. a closes and loses its stored copy of b0.
  // It keeps its boot record, its system and its view. a reopens with b
  // offline. c sends c0, which c made before b0, so autobee reorders, and the
  // reorder reads b0 and waits for it (lib/topo.js:78, :181-182). An append
  // of a then waits for that drain (index.js:1575, :645). Only autobee's close
  // cancels the read.
  const DEADLINE = 5000
  const adir = await tmpDir('reorder-close-a')
  const a = await Bundle.init(adir)
  const b = await Bundle.join(await tmpDir('reorder-close-b'), a.key)
  const c = await Bundle.join(await tmpDir('reorder-close-c'), a.key)
  const bHex = hex(b.localKey)
  const unpairs = []
  let a2 = null
  let closing = null
  t.after(async () => {
    for (const un of unpairs) un()
    if (a2) {
      // If close() stays pending, the documented db.close() cancels the read
      // (D-039 F01), so that the test ends. After the fix it is a no-op.
      await a2.db.close()
      await (closing || a2.close())
    }
    await a.close() // a no-op once the test has closed it
    await b.close()
    await c.close()
  })
  const unAB = pair(a, b)
  const unAC = pair(a, c)
  unpairs.push(unAB, unAC)
  await a.writers.add(b.localKey)
  await a.writers.add(c.localKey)
  const { tag: id } = await a.createConcept('n/x', 'note')
  assert.ok(
    await until(
      async () => (
        await b.update(),
        await c.update(),
        (await b.val(K.cMeta(id))) !== undefined && (await c.val(K.cMeta(id))) !== undefined
      )
    )
  )
  unAB()
  unAC()
  await sleep(50)
  await c.setField(id, 'title', ['c0'])
  await sleep(100) // c0 comes before b0 in the order
  await b.setField(id, 'title', ['b0'])
  const unAB2 = pair(a, b)
  unpairs.push(unAB2)
  assert.ok(await until(async () => (await a.update(), (await a.val(K.seen(bHex))) === 1)), 'a folds b0')
  const A3 = await a.setField(id, 'checkpoint', ['a3']) // it links b0
  assert.equal(A3.seq, 3)
  await a.update()
  await sleep(50)
  await a.update()
  unAB2()
  await a.close()
  {
    // a loses its stored copy of b0 (hypercore clear(), documented)
    const store = new Corestore(adir)
    const core = store.get({ key: b.localKey, active: false })
    await core.ready()
    assert.ok(await core.has(0))
    await core.clear(0, 1)
    assert.equal(await core.has(0), false)
    await core.close()
    await store.close()
  }

  a2 = await Bundle.open(adir)
  assert.equal(a2.db.local.length, 4, 'the local core holds the four nodes of a')
  assert.equal(await a2.val(K.seen(bHex)), 1, 'the view of a still holds b0')
  unpairs.push(pair(a2, c)) // c sends c0, and the reorder waits for b0
  {
    const cCore = a2.store.get({ key: c.localKey, active: false })
    await cCore.ready()
    assert.ok(await until(() => cCore.has(0)), 'a holds c0')
    await cCore.close()
  }
  const appending = a2.setField(id, 'title', ['late']).then(
    (r) => ({ r }),
    (e) => ({ e })
  )
  const before = await Promise.race([appending.then(() => 'settled'), sleep(300).then(() => 'waiting')])
  assert.equal(before, 'waiting', 'the append waits for the drain, and the drain waits for b0')

  closing = a2.close().then(() => 'closed')
  const outcome = await Promise.race([closing, sleep(DEADLINE).then(() => 'pending')])
  assert.equal(outcome, 'closed', `close() returns within ${DEADLINE} ms`)
  const res = await appending
  assert.equal(res.r, undefined, 'no tag for the waiting append')
  assert.equal(res.e.code, 'VAULT_CLOSED_BEFORE_DURABLE')
  assert.equal(res.e.seq, 4)
  {
    // The op never landed: the local core of a still holds four nodes.
    const store = new Corestore(adir)
    const core = store.get({ key: a2.localKey, active: false })
    await core.ready()
    assert.equal(core.length, 4)
    await core.close()
    await store.close()
  }
})
