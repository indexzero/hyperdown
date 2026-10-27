// T10, G11 (the close race): an append returns { seq, tag } only for a node
// that is in the local core, and close() waits for the append chain.
//
// autobee's close interrupts its drain (index.js _close), and the drain then
// stops before _flushLocal (index.js:797-831). A db.append in flight resolves
// with its node only in memory, and the node never reaches the local core.
// Before T10, Bundle.close() did not wait for its appends, so an append could
// return a tag for a node that a reopen does not hold.
//
// The first test is the port of ab2-review/scratch-A/s9-close-race.mjs. It
// is adapted to admit before writing: the creator is the genesis writer, so
// it is writable at init, and the test asserts that before the first write.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Bundle, K, tmpDir, sleep } from './store-helpers.js'

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
