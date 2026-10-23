// Store scope (okf SPEC §13, T4): two-writer convergence over real
// autobee + corestore — view-hash equality after replication (I2 at store
// level) — plus the §8 optimistic onboarding flow (hold buffer on the
// writer's own peer, ack-anchored fold, cross-peer hash equality).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Bundle, K, tmpDir, pair, until, converged } from './store-helpers.js'

test('two writers converge to bit-identical views (hash equality)', async (t) => {
  const a = await Bundle.init(await tmpDir('conv-a'))
  const b = await Bundle.join(await tmpDir('conv-b'), a.key)
  const unpair = pair(a, b)
  t.after(async () => {
    unpair()
    await a.close()
    await b.close()
  })

  // onboarding: genesis indexer admits b (in-log governance op, §8)
  await a.writers.add(b.localKey, { indexer: false })
  assert.ok(
    await until(async () => {
      await b.update()
      return b.writable
    }),
    'b becomes writable after the AddWriter op linearizes'
  )

  // cross-writer content ops on one concept
  const { tag: id } = await a.createConcept('guides/home', 'guide')
  assert.ok(
    await until(async () => {
      await b.update()
      return (await b.val(K.cMeta(id))) !== undefined
    }),
    'b folds the create'
  )
  await a.setField(id, 'title', ['Welcome'])
  await b.addTag(id, 'p2p')
  await a.addTag(id, 'wiki')
  await b.setBody(id, null, 'Hello from b — see [arch](/guides/architecture).')

  const hash = await converged([a, b])
  assert.ok(hash, 'views converge to one hash')

  // both tags present in the OR-set on both peers; link demand indexed
  for (const v of [a, b]) {
    const rec = await v.val(K.cField(id, 'tags'))
    assert.deepEqual(Object.values(rec.els).sort(), ['p2p', 'wiki'])
    const title = await v.val(K.cField(id, 'title'))
    assert.deepEqual(title.values, ['Welcome'])
    assert.equal(await v.val(K.wanted('guides/architecture', id)), true, 'wanted/ demand row')
  }

  // §5 citation contract via the emission helper: remove one tag
  await b.remTag(id, 'p2p')
  assert.ok(await converged([a, b]), 'views converge after the remove')
  const rec = await a.val(K.cField(id, 'tags'))
  assert.deepEqual(Object.values(rec.els), ['wiki'])
})

test('optimistic onboarding: held locally, folded at the ack position (§8)', async (t) => {
  const a = await Bundle.init(await tmpDir('opt-a'))
  const c = await Bundle.join(await tmpDir('opt-c'), a.key)
  const unpair = pair(a, c)
  t.after(async () => {
    unpair()
    await a.close()
    await c.close()
  })

  const { tag: id } = await a.createConcept('notes/seed', 'note')
  assert.ok(
    await until(async () => {
      await c.update()
      return (await c.val(K.cMeta(id))) !== undefined
    }),
    'c replicates the seed concept'
  )

  // c is NOT an admitted writer: optimistic write (autobee append
  // {optimistic: true}; the apply wrapper acks the writer at the DAG
  // level, core holds the op's view effect in hold/ until the in-log ack)
  assert.equal(c.writable, false)
  await c.setField(id, 'status', ['draft'], { optimistic: true })
  await c.update()

  const cHex = c.localKey.toString('hex')
  const held = await c.view.dump('hold/')
  assert.equal(Object.keys(held).length, 1, 'full decoded op held under hold/ (§8)')
  assert.ok(Object.keys(held)[0].startsWith(`hold/${cHex}/`))
  assert.equal(
    await c.val(K.cField(id, 'status')),
    undefined,
    'no c/ mutation before the ack (I10)'
  )

  // an indexer AddWriter linearizes: core folds the held op at the ack
  // position and deletes the hold
  await a.writers.add(c.localKey, { indexer: false })
  assert.ok(
    await until(async () => {
      await a.update()
      await c.update()
      return (await c.val(K.cField(id, 'status'))) !== undefined
    }),
    'held op folds after the AddWriter'
  )
  const hash = await converged([a, c])
  assert.ok(hash, 'peers converge (effects are ack-anchored)')
  for (const v of [a, c]) {
    assert.equal(Object.keys(await v.view.dump('hold/')).length, 0, 'hold buffer cleared')
    const rec = await v.val(K.cField(id, 'status'))
    assert.deepEqual(rec.values, ['draft'])
  }
})

test('a refused append does not burn a seq (§8 forged-clock)', async (t) => {
  const a = await Bundle.init(await tmpDir('burn-a'))
  const c = await Bundle.join(await tmpDir('burn-c'), a.key)
  const unpair = pair(a, c)
  t.after(async () => {
    unpair()
    await a.close()
    await c.close()
  })
  const { tag: id } = await a.createConcept('notes/burn', 'note')
  assert.ok(
    await until(async () => {
      await c.update()
      return (await c.val(K.cMeta(id))) !== undefined
    })
  )

  // autobee@2 records an unadmitted writer as removed once its optimistic
  // node is applied (lib/system.js ackWriter), and then refuses its plain
  // appends up front with "Not writable" (index.js append), before
  // anything reaches the local core.
  const first = await c.setField(id, 'status', ['one'], { optimistic: true })
  assert.equal(first.seq, 0)
  await c.update()
  await assert.rejects(() => c.setField(id, 'status', ['plain']), /Not writable/)

  const second = await c.setField(id, 'status', ['two'], { optimistic: true })
  assert.equal(second.seq, 1, 'the refused append did not consume seq 1')
  await c.update()
  const cHex = c.localKey.toString('hex')
  assert.equal(await c.val(K.flagRejected(cHex, 1)), undefined, 'not rejected forged-clock')
  assert.equal(Object.keys(await c.view.dump(`hold/${cHex}/`)).length, 2, 'both ops held')
})

test('a joiner folds every op through its own apply, never a stamped view (I2/I3)', async (t) => {
  // autobee@2 fast-forwards a peer onto a system/view head another writer
  // stamped in its oplog once that head is 16+ flushes ahead, and by
  // default it trusts every writer's stamp (autobee lib/trusted.js). Here
  // the genesis peer runs a DIFFERENT apply — it writes a key okf's apply
  // never writes — so a joiner that adopted its stamp would hold that key.
  const a = await Bundle.init(await tmpDir('ff-a'))
  const pinned = a._coreApply
  a._coreApply = async (nodes, view, host) => {
    await pinned(nodes, view, host)
    const w = view.write()
    w.tryPut('zz/foreign-config', '"stamped"')
    await w.flush()
  }
  const ids = []
  for (let i = 0; i < 40; i++) {
    const { tag } = await a.createConcept(`ff/n${i}`, 'note')
    ids.push(tag)
    await a.update() // one flush (one stamped view head) per op
  }
  assert.equal(await a.val('zz/foreign-config'), 'stamped')

  const b = await Bundle.join(await tmpDir('ff-b'), a.key)
  const unpair = pair(a, b)
  t.after(async () => {
    unpair()
    await a.close()
    await b.close()
  })
  const aHex = a.localKey.toString('hex')
  assert.ok(
    await until(async () => {
      await b.update()
      return (await b.val(K.seen(aHex))) === 40
    }),
    'b folds all 40 of a ops'
  )
  assert.equal(b.db.stats.fastForwards, 0, 'b never fast-forwards')
  assert.equal(await b.val('zz/foreign-config'), undefined, 'b holds only what its own apply wrote')
  assert.ok((await b.val(K.cMeta(ids[39]))) !== undefined)
})

test('opt-in append backpressure throttles without deadlocking', async (t) => {
  const a = await Bundle.init(await tmpDir('bp-a'))
  const b = await Bundle.join(await tmpDir('bp-b'), a.key, {
    backpressure: { maxInflight: 2, ackTimeout: 250 }
  })
  const unpair = pair(a, b)
  t.after(async () => {
    unpair()
    await a.close()
    await b.close()
  })

  await a.writers.add(b.localKey, { indexer: false })
  assert.ok(
    await until(async () => {
      await b.update()
      return b.writable
    }),
    'b writable'
  )

  const { tag: id } = await a.createConcept('bp/target', 'note')
  assert.ok(
    await until(async () => {
      await b.update()
      return (await b.val(K.cMeta(id))) !== undefined
    })
  )

  // a burst of backpressured appends completes (degrades on ackTimeout
  // rather than deadlocking) and converges
  for (let i = 0; i < 8; i++) {
    await b.setField(id, 'n', [String(i)])
  }
  assert.ok(await converged([a, b]), 'burst converges under backpressure')
  assert.deepEqual((await a.val(K.cField(id, 'n'))).values, ['7'])
})
