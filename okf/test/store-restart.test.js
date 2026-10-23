// Store scope (okf SPEC §13, T4), I3 at store level: a vault reopened from
// disk holds a view bit-identical to the pre-restart view, appends continue
// with correct seq/clock continuity, and a fresh peer that rebuilds from
// the replicated log converges to the same hash (rebuild equivalence).
import { test } from 'node:test'
import assert from 'node:assert/strict'
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

test('an empty block in the local core does not shift the seq after restart (§8 forged-clock)', async (t) => {
  // autobee@2 can append empty "ack" nodes to the local writer core
  // (index.js _appendAck: when acking, and once after a reindex). apply
  // never sees them (index.js _applyBatch: only non-empty values reach
  // apply), so they never count in seen/<self>, but they do count in
  // local.length. Append one exactly as _appendAck does.
  const dir = await tmpDir('restart-ack')
  const a = await Bundle.init(dir)
  const { tag: id } = await a.createConcept('guides/ack', 'guide')
  await a.setField(id, 'title', ['Before the ack'])
  const db = a.db
  const links = db.system.getLinks(db.local.key)
  const ts = Math.max(Date.now(), db.system.timestamp)
  db.writers.appendLocal(null, ts, { start: 0, end: 0 }, links, false, null, null, null, 0)
  await a.update()
  const self = a.localKey.toString('hex')
  assert.equal(db.local.length, 3, 'two ops plus one empty block in the local core')
  assert.equal(await a.val(K.seen(self)), 2, 'apply counted only the two ops')
  await a.close()

  const a2 = await Bundle.open(dir)
  t.after(() => a2.close())
  const r = await a2.setField(id, 'title', ['After the ack'])
  assert.equal(r.seq, 2, 'seq continues from what apply counted, not from local.length')
  await a2.update()
  assert.equal(await a2.val(K.flagRejected(self, r.seq)), undefined, 'not rejected forged-clock')
  assert.deepEqual((await a2.val(K.cField(id, 'title'))).values, ['After the ack'])
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
