// Writer add and remove on real autobee: causal revocation (SPEC §8), the
// seqAtRemoval rule on a partitioned op, the local guard on a revoked
// append, equal views on every peer (I10), isIndexer from gov/, and weight
// 0 for every writer.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Bundle, K, tmpDir, pair, until, sleep, converged } from './store-helpers.js'
import { forgeNext, sys, linearized, carriers, hex } from './attack-helpers.js'

test('writer add/remove round trip: causal revocation, uniform on every peer', async (t) => {
  const a = await Bundle.init(await tmpDir('wr-a'))
  const b = await Bundle.join(await tmpDir('wr-b'), a.key)
  let unpair = pair(a, b)
  t.after(async () => {
    unpair()
    await a.close()
    await b.close()
  })
  const bHex = b.localKey.toString('hex')

  await a.writers.add(b.localKey, { indexer: false })
  assert.ok(
    await until(async () => {
      await b.update()
      return b.writable
    }),
    'b becomes writable'
  )
  await a.update()
  const rec = await a.val(K.govWriter(bHex))
  assert.deepEqual(rec, { indexer: false, namespacePrefixes: [], rateCeiling: null })

  // a folds one op of b before it revokes b, so the removal cites position
  // 0 of b (seqAtRemoval 0).
  const { tag: id } = await b.createConcept('agents/b/note', 'note')
  assert.ok(
    await until(async () => {
      await a.update()
      return (await a.val(K.cMeta(id))) !== undefined
    }),
    'a folds b op before the removal'
  )

  unpair()
  await a.writers.remove(b.localKey)
  await a.update()
  const removed = await a.val(K.govRemoved(bHex))
  assert.equal(removed.seqAtRemoval, 0, 'revocation records the observed position')
  assert.equal(removed.clock[bHex], 0, 'remove-writer clock cites the target (store-built clock)')

  const late = await b.setField(id, 'status', ['sneaky']) // b has not folded the removal yet
  assert.equal(late.seq, 1)

  // The op after the revocation linearizes on both peers, because the store
  // never calls host.removeWriter. Both peers reject it revoked.
  unpair = pair(a, b)
  assert.ok(
    await until(async () => {
      await a.update()
      return (await a.val(K.flagRejected(bHex, 1))) !== undefined
    }),
    'the partitioned post-revocation op reaches a and is rejected'
  )
  const hash = await converged([a, b])
  assert.ok(hash, 'peers converge after revocation')
  for (const v of [a, b]) {
    assert.deepEqual(await v.val(K.flagRejected(bHex, 1)), { reason: 'revoked' })
    assert.equal(await v.val(K.cField(id, 'status')), undefined, 'rejected op never mutated c/ (I10)')
    assert.deepEqual((await v.val(K.cMeta(id))).created, id, 'pre-revocation op survives')
  }

  await b.update()
  await assert.rejects(
    () => b.setField(id, 'status', ['again']),
    (err) => err.code === 'VAULT_REVOKED',
    'local append refused once the revocation is folded'
  )

  const aOthers = await a.val(K.govWriter(bHex))
  assert.equal(aOthers.indexer, false)
})

test('addWriter carries the swarm key onto gov/writer, and refuses a bad one before it appends (T25)', async (t) => {
  const a = await Bundle.init(await tmpDir('wr-swarm-a'))
  const b = await Bundle.join(await tmpDir('wr-swarm-b'), a.key)
  const c = await Bundle.join(await tmpDir('wr-swarm-c'), a.key)
  t.after(async () => {
    await a.close()
    await b.close()
    await c.close()
  })
  const bHex = b.localKey.toString('hex')
  const cHex = c.localKey.toString('hex')

  await a.addWriter(b.localKey, { swarmKey: b.swarmKey })
  await a.writers.add(c.localKey, { indexer: true, swarmKey: c.swarmKey.toString('hex').toUpperCase() })
  await a.update()
  assert.deepEqual(await a.val(K.govWriter(bHex)), {
    indexer: false,
    namespacePrefixes: [],
    rateCeiling: null,
    swarmKey: b.swarmKey.toString('hex')
  })
  assert.equal((await a.val(K.govWriter(cHex))).swarmKey, c.swarmKey.toString('hex'), 'hex input, any case')

  const length = a.db.local.length
  for (const bad of [Buffer.alloc(31, 1), Buffer.alloc(33, 1), 'ab', 'zz'.repeat(32), 42]) {
    await assert.rejects(
      a.addWriter(b.localKey, { swarmKey: bad }),
      (err) => err.code === 'VAULT_BAD_SWARM_KEY',
      `refused: ${String(bad)}`
    )
  }
  assert.equal(a.db.local.length, length, 'a refused swarm key appends no node')
})

test('an append from a writer that is not writable fails fast: VAULT_NOT_WRITABLE, autobee stays open, no seq used (G12)', async (t) => {
  // autobee's own append refuses only a writer that it records as removed
  // (`append` in index.js). A writer that it never added gets past that
  // refusal. Its node then fails the local flush with 'Not writable' (`_next`
  // in lib/writers.js), autobee closes itself (`_onError`), and the append
  // still resolves with a seq.
  const a = await Bundle.init(await tmpDir('nw-a'))
  const { tag: id } = await a.createConcept('notes/x', 'note')
  const c = await Bundle.join(await tmpDir('nw-c'), a.key)
  const errors = []
  c.on('error', (err) => errors.push(err.message))
  const unpair = pair(a, c)
  t.after(async () => {
    unpair()
    await a.close()
    await c.close()
  })
  assert.ok(
    await until(async () => {
      await c.update()
      return (await c.val(K.cMeta(id))) !== undefined
    }),
    'c syncs the vault'
  )
  assert.equal(c.writable, false, 'nobody admitted c')

  await assert.rejects(
    () => c.setField(id, 'status', ['plain']),
    (err) => err.code === 'VAULT_NOT_WRITABLE',
    'a content op fails fast with the named error'
  )
  await assert.rejects(
    () => c.addWriter(a.localKey),
    (err) => err.code === 'VAULT_NOT_WRITABLE',
    'a governance op fails fast with the named error'
  )
  await sleep(200)
  assert.equal(c.db.closing, null, 'autobee was never asked to close')
  assert.equal(c.db.closed, false, 'autobee stays open')
  assert.deepEqual(errors, [], 'autobee emitted no error')
  assert.equal(c._nextSeq, 0, 'no seq used')
  assert.equal(c.db.local.length, 0, 'no node reached the local core')
  await c.update()
  assert.ok(await c.val(K.cMeta(id)), 'c still reads the view')
})

test('remove-writer that would leave zero indexers is rejected (§8)', async (t) => {
  const a = await Bundle.init(await tmpDir('wr-last'))
  t.after(() => a.close())
  const aHex = a.localKey.toString('hex')

  const r = await a.writers.remove(a.localKey)
  await a.update()
  assert.deepEqual(await a.val(K.flagRejected(aHex, r.seq)), { reason: 'policy-governance' })
  assert.equal(await a.val(K.govRemoved(aHex)), undefined, 'genesis indexer not removed')
  const c = await a.createConcept('still/alive', 'note')
  await a.update()
  assert.ok(await a.val(K.cMeta(c.tag)))
})

test('setWriterPolicy round trip: namespace prefixes enforced at apply', async (t) => {
  const a = await Bundle.init(await tmpDir('wr-pol-a'))
  const b = await Bundle.join(await tmpDir('wr-pol-b'), a.key)
  const unpair = pair(a, b)
  t.after(async () => {
    unpair()
    await a.close()
    await b.close()
  })
  const bHex = b.localKey.toString('hex')

  await a.writers.add(b.localKey, { indexer: false })
  await a.writers.setPolicy(b.localKey, { namespacePrefixes: ['agents/b'], rateCeiling: 16 })
  assert.ok(
    await until(async () => {
      await b.update()
      const rec = await b.val(K.govWriter(bHex))
      return b.writable && rec && rec.namespacePrefixes.length === 1
    }),
    'b folds its policy'
  )

  const ok = await b.createConcept('agents/b/inside', 'note')
  const bad = await b.createConcept('outside/prefix', 'note')
  assert.ok(
    await until(async () => {
      await b.update()
      return (await b.val(K.flagRejected(bHex, bad.seq))) !== undefined
    }),
    'out-of-namespace create rejected'
  )
  assert.deepEqual(await b.val(K.flagRejected(bHex, bad.seq)), { reason: 'policy-namespace' })
  assert.ok(await b.val(K.cMeta(ok.tag)), 'in-namespace create accepted')
  assert.ok(await converged([a, b]), 'policy decisions are uniform across peers')
})

test('isIndexer answers from gov/: a live gov/writer record with indexer true', async (t) => {
  // isIndexer reads gov/, never autobee's weight: indexer true in
  // gov/writer/<self>, and no gov/removed/<self>.
  const aDir = await tmpDir('idx-a')
  const a = await Bundle.init(aDir)
  const b = await Bundle.join(await tmpDir('idx-b'), a.key)
  const c = await Bundle.join(await tmpDir('idx-c'), a.key)
  const open = new Set([a, b, c])
  const unpairAB = pair(a, b)
  const unpairAC = pair(a, c)
  t.after(async () => {
    unpairAB()
    unpairAC()
    for (const v of open) await v.close()
  })
  const bHex = b.localKey.toString('hex')
  const cHex = c.localKey.toString('hex')

  await a.createConcept('idx/seed', 'note') // the first op seeds gov/writer/<genesis>
  await a.update()
  assert.equal(a.isIndexer, true, 'genesis is the first indexer')

  await a.writers.add(b.localKey, { indexer: true })
  await a.writers.add(c.localKey, { indexer: false })
  assert.ok(
    await until(async () => {
      await b.update()
      await c.update()
      return (await b.val(K.govWriter(bHex))) !== undefined && (await c.val(K.govWriter(cHex))) !== undefined
    }),
    'b and c fold their admissions'
  )
  assert.equal(b.isIndexer, true, 'b: admitted as an indexer')
  assert.equal(c.isIndexer, false, 'c: admitted as a plain writer')

  await a.writers.remove(b.localKey)
  assert.ok(
    await until(async () => {
      await b.update()
      return (await b.val(K.govRemoved(bHex))) !== undefined
    }),
    'b folds its revocation'
  )
  assert.equal((await b.val(K.govWriter(bHex))).indexer, true, 'the gov/writer record stays')
  assert.equal(b.isIndexer, false, 'a revoked indexer is no longer an indexer')
  await a.update()
  assert.equal(a.isIndexer, true, 'genesis stays an indexer')

  // a reopen answers from the view on disk, before any new apply
  unpairAB()
  unpairAC()
  await a.close()
  open.delete(a)
  const a2 = await Bundle.open(aDir)
  open.add(a2)
  assert.equal(a2.isIndexer, true, 'genesis reopens as an indexer')
})

test('every writer stands at weight 0 on every peer, and no honest node carries approvals or a witness', async (t) => {
  // bootstrapWeight 0 and every grant at weight 0. Nobody has standing, so
  // no peer collects an approval (`_collectApprovals`), no append cites a
  // witness (`append` in index.js), and nobody climbs. b admits c while
  // genesis is offline, so a grant that a non-genesis indexer carries is
  // covered too.
  const a = await Bundle.init(await tmpDir('w0-a'))
  const b = await Bundle.join(await tmpDir('w0-b'), a.key)
  const c = await Bundle.join(await tmpDir('w0-c'), a.key)
  let unpairAB = pair(a, b)
  const unpairBC = pair(b, c)
  t.after(async () => {
    unpairAB()
    unpairBC()
    await a.close()
    await b.close()
    await c.close()
  })
  const W0 = { weight: 0, maxWeight: 0, isRemoved: false }

  await a.createConcept('w0/a0', 'note')
  await a.writers.add(b.localKey, { indexer: true })
  assert.ok(await until(async () => (await b.update(), b.writable)), 'b writable')
  unpairAB() // genesis goes offline

  await b.writers.add(c.localKey, { indexer: false })
  assert.ok(await until(async () => (await c.update(), c.writable)), 'c writable')
  const c0 = await c.createConcept('w0/c0', 'note')
  await b.createConcept('w0/b0', 'note')
  assert.ok(await until(async () => (await b.update(), (await b.val(K.cMeta(c0.tag))) !== undefined)))
  for (const v of [b, c]) {
    for (const w of [a, b, c]) assert.deepEqual(await sys(v, w.localKey), W0, 'weight 0 while genesis is offline')
  }

  // genesis returns and appends, and then b and c append again
  unpairAB = pair(a, b)
  assert.ok(await until(async () => (await a.update(), (await a.val(K.cMeta(c0.tag))) !== undefined)))
  const a1 = await a.createConcept('w0/a1', 'note')
  assert.ok(await until(async () => (await c.update(), (await c.val(K.cMeta(a1.tag))) !== undefined)))
  await b.createConcept('w0/b1', 'note')
  await c.createConcept('w0/c1', 'note')
  assert.ok(await converged([a, b, c]), 'all three converge')

  for (const v of [a, b, c]) {
    for (const w of [a, b, c]) assert.deepEqual(await sys(v, w.localKey), W0, 'genesis and every member at weight 0')
    const nodes = await linearized(v)
    assert.ok(nodes.length >= 8, `every op is linearized (${nodes.length} nodes)`)
    assert.deepEqual(
      nodes.filter((n) => n.weight !== 0),
      [],
      'every node resolves at weight 0'
    )
    assert.deepEqual(await carriers(v), [], 'no honest node carries approvals or a witness')
  }
})

test('a forged approval from genesis adds an autobee writer apply never granted, at weight 0; its ops change no c/ key', async (t) => {
  const a = await Bundle.init(await tmpDir('appr-a'))
  const s = await Bundle.join(await tmpDir('appr-s'), a.key)
  const unpair = pair(a, s)
  t.after(async () => {
    unpair()
    await a.close()
    await s.close()
  })
  const aHex = a.localKey.toString('hex')
  const sHex = s.localKey.toString('hex')
  const { tag: seed } = await a.createConcept('appr/seed', 'note')
  assert.ok(await until(async () => (await s.update(), (await s.val(K.cMeta(seed))) !== undefined)))
  assert.equal(s.writable, false)

  // genesis, at weight 0, appends a node whose approvals name s. The test
  // forges the node through appendLocal of the local writer.
  forgeNext(a, { approvals: [{ key: s.localKey, weight: 2 }] })
  await a.createConcept('appr/carrier', 'note')
  assert.ok(await until(async () => (await s.update(), s.writable)), 'the approval alone makes s writable')
  for (const v of [a, s]) {
    // the ceiling is capped at the weight of the carrier, 0 (`System.addWriter`)
    assert.deepEqual(await sys(v, s.localKey), { weight: 0, maxWeight: 0, isRemoved: false })
    assert.equal(await v.val(K.govWriter(sHex)), undefined, 'okf never admitted s')
  }

  const c0 = await s.createConcept('appr/from-s', 'note')
  const g1 = await s.addWriter(a.localKey, { indexer: true })
  const hash = await converged([a, s])
  assert.ok(hash, 'peers converge')
  for (const v of [a, s]) {
    assert.equal(await v.val(K.seen(sHex)), 2, 'both plain ops reached apply')
    assert.equal(await v.val(K.cMeta(c0.tag)), undefined, 'no c/ effect (I10)')
    assert.deepEqual(await v.val(K.flagRejected(sHex, g1.seq)), { reason: 'policy-governance' })
    // the grant hint is at weight 0, so the appends of s cite no witness
    // (`append` in index.js)
    assert.equal((await sys(v, s.localKey)).weight, 0, 's never climbs')
    assert.deepEqual(
      (await carriers(v)).map((n) => [n.writer, n.approvals, n.witness]),
      [[aHex, true, false]],
      'the forged node is the only node with approvals or a witness'
    )
  }
})

test('a forged approval from a member at weight 0 also adds the key, at weight 0', async (t) => {
  const a = await Bundle.init(await tmpDir('appr0-a'))
  const b = await Bundle.join(await tmpDir('appr0-b'), a.key)
  const s = await Bundle.join(await tmpDir('appr0-s'), a.key)
  const unpairAB = pair(a, b)
  const unpairBS = pair(b, s)
  t.after(async () => {
    unpairAB()
    unpairBS()
    await a.close()
    await b.close()
    await s.close()
  })
  const sHex = s.localKey.toString('hex')
  await a.writers.add(b.localKey, { indexer: false }) // a plain okf writer
  assert.ok(await until(async () => (await b.update(), b.writable)))
  assert.equal((await sys(b, b.localKey)).weight, 0, 'b stands at weight 0')

  forgeNext(b, { approvals: [{ key: s.localKey, weight: 2 }] })
  await b.createConcept('appr0/carrier', 'note')
  assert.ok(await until(async () => (await s.update(), s.writable)), 'still makes s writable')
  assert.equal((await sys(b, s.localKey)).maxWeight, 0, 'capped at the weight-0 carrier')
  const c0 = await s.createConcept('appr0/from-s', 'note')
  assert.ok(await converged([a, b, s]), 'peers converge')
  for (const v of [a, b, s]) {
    assert.equal(await v.val(K.seen(sHex)), 1, 'the plain op reached apply')
    assert.equal(await v.val(K.cMeta(c0.tag)), undefined, 'no c/ effect (I10)')
  }
})

test('HostAdapter returns the autobee grant, so core resumes only once the system records it, on every peer (G40)', async (t) => {
  // Core awaits host.addWriter for every AddWriter it folds. autobee's
  // addWriter reads the system before it records the grant
  // (`System.addWriter`), and the system flush right after apply
  // (`_applyBatch`) writes only the updates it reads when it starts
  // (`System.flush`). So the adapter must return the promise of the grant,
  // or the grant can land after the flush read its updates.
  const open = []
  let unpair = () => {}
  t.after(async () => {
    unpair()
    for (const v of open) await v.close()
  })
  const a = await Bundle.init(await tmpDir('grant-a'))
  open.push(a)
  const b = await Bundle.join(await tmpDir('grant-b'), a.key)
  open.push(b)
  unpair = pair(a, b)
  // A pass-through observer between core apply and the real HostAdapter.
  // When the value that core awaits settles, it records whether autobee's
  // pending system updates hold the key (`System.update`).
  const observed = { a: [], b: [] }
  for (const [name, v] of [['a', a], ['b', b]]) {
    const pinned = v._coreApply
    v._coreApply = (nodes, view, adapter) =>
      pinned(nodes, view, {
        addWriter(key, opts) {
          return Promise.resolve(adapter.addWriter(key, opts)).then((value) => {
            observed[name].push({ key: hex(key), recorded: v.db.system.updates.has(hex(key)) })
            return value
          })
        }
      })
  }
  const bHex = hex(b.localKey)

  await a.writers.add(b.localKey, { indexer: false })
  assert.ok(await until(async () => (await b.update(), b.writable)), 'b becomes writable')
  await a.update()
  for (const name of ['a', 'b']) {
    assert.deepEqual(
      observed[name],
      [{ key: bHex, recorded: true }],
      `${name}: when the grant that core awaits settles, the system records it`
    )
  }
  for (const v of [a, b]) {
    assert.deepEqual(await sys(v, b.localKey), { weight: 0, maxWeight: 0, isRemoved: false }, 'the flushed system holds the grant')
  }
})
