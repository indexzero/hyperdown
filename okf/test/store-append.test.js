// T10, G11 (the close race): an append returns { seq, tag } only for a node
// that is in the local core, and close() waits for the append chain.
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
// The first test is the port of ab2-review/scratch-A/s9-close-race.mjs. It
// is adapted to admit before writing: the creator is the genesis writer, so
// it is writable at init, and the test asserts that before the first write.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Corestore from '../store/node_modules/corestore/index.js'
import { Bundle, K, tmpDir, sleep, pair, until } from './store-helpers.js'

const hex = (k) => k.toString('hex')

test('G11 (s9): a close during an append returns no tag for a node that is missing after a reopen, in 50 of 50 runs', { timeout: 300000 }, async () => {
  const RUNS = 50
  const lost = []
  let ok = 0
  let rejected = 0
  for (let i = 0; i < RUNS; i++) {
    const dir = await tmpDir('s9-close-race')
    const a = await Bundle.init(dir)
    assert.ok(a.writable, 'the creator is admitted before it writes')
    const self = hex(a.localKey)
    await a.createConcept('x/0', 'note')
    const p = a.createConcept('x/1', 'note').then(
      (r) => ({ r }),
      (e) => ({ e })
    )
    await sleep(i % 10) // vary the race point
    await a.close()
    const res = await p
    const a2 = await Bundle.open(dir)
    try {
      if (res.e) {
        rejected++
        continue
      }
      const length = a2.db.local.length
      const seen = await a2.val(K.seen(self))
      const meta = await a2.val(K.cMeta(res.r.tag))
      if (length > res.r.seq && seen === res.r.seq + 1 && meta !== undefined) ok++
      else lost.push({ run: i, seq: res.r.seq, length, seen })
    } finally {
      await a2.close()
    }
  }
  assert.deepEqual(lost, [], `no tag for a node that is missing after the reopen (ok ${ok}, rejected ${rejected})`)
})

test('close() resolves only after every in-flight append has settled, and each node is in the core after a reopen', { timeout: 60000 }, async (t) => {
  const N = 8
  const dir = await tmpDir('close-settles')
  const a = await Bundle.init(dir)
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
  await a.close()
  assert.equal(settled.size, N, 'every append that started before close() settled before close() resolved')
  const results = await Promise.all(outcomes)
  assert.deepEqual(
    results.map((r) => (r instanceof Error ? r.message : 'returned')),
    Array(N).fill('returned'),
    'close() lets each append that started before it complete'
  )
  assert.deepEqual(
    results.map((r) => r.seq),
    [...Array(N).keys()],
    'the seqs are the positions 0 to N - 1'
  )

  const a2 = await Bundle.open(dir)
  t.after(() => a2.close())
  assert.equal(a2.db.local.length, N, 'the local core holds every node')
  for (const r of results) {
    assert.notEqual(await a2.val(K.cMeta(r.tag)), undefined, `the concept of tag ${r.tag} is in the view`)
  }
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

test('an append that waits behind a missing link fails VAULT_CLOSED_BEFORE_DURABLE when close() runs, and after a reopen its op is not in the view', { timeout: 60000 }, async (t) => {
  // The setup is the one of the G10 test (store-ordinal.test.js): after a
  // crash that loses the boot record and c's block R, the reopen of b cannot
  // fold S, which links R. A new local node of b then waits behind S.
  const a = await Bundle.init(await tmpDir('wait-close-a'))
  const bdir = await tmpDir('wait-close-b')
  const b = await Bundle.join(bdir, a.key)
  const c = await Bundle.join(await tmpDir('wait-close-c'), a.key)
  const bHex = hex(b.localKey)
  const unAB = pair(a, b)
  const unAC = pair(a, c)
  let b2 = null
  let b3 = null
  let unA3 = () => {}
  t.after(async () => {
    unAB()
    unAC()
    unA3()
    if (b2) await b2.close() // a no-op once the test has closed it
    if (b3) await b3.close()
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
  await c.setField(id, 'status', ['r'])
  assert.ok(await until(async () => (await b.update(), (await b.val(K.seen(hex(c.localKey)))) === 1)))
  const S = await b.setField(id, 'title', ['S'])
  assert.equal(S.seq, 1)
  unAB()
  unAC()
  const gen = b.generation
  await b.close()
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
  assert.equal(await b2.val(K.seen(bHex)), 1, 'S waits for R')

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

  b3 = await Bundle.open(bdir)
  assert.equal(b3.db.local.length, 2, 'after the reopen the local core still holds only b0 and S')
  unA3 = pair(a, b3) // a serves R
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
