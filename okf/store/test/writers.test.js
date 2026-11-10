// Adding, removing and policing writers through the store, on real
// autobee: the writers API and the keys that it refuses, the store-built
// clock of a removal, the local guard on a revoked append, isIndexer from
// gov/, weight 0 for every writer, and the governance race. The rules of
// apply live in okf/core/lib/apply.js, and okf/core/test/apply proves them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Bundle, K, tmpDir, pair, until, sleep, converged } from './helpers.js'
import { forgeNext, sys, linearized, carriers, hex } from './attack-helpers.js'

test('writers.add and writers.remove round trip: the removal records the position that the store observed, every peer flags the later op revoked, and the next append of the removed writer fails VAULT_REVOKED', async (t) => {
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

test('addWriter carries the swarm key onto gov/writer, and refuses a bad one before it appends', async (t) => {
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

test('an append from a writer that is not writable fails fast: VAULT_NOT_WRITABLE, autobee stays open, no seq used', async (t) => {
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

test('writers.remove of the only indexer returns a seq, leaves a policy-governance flag at that seq, and the vault stays writable (§8)', async (t) => {
  // okf/core/test/apply/governance.test.js proves the rule of apply. This
  // test holds the store's part: the flag key at the returned seq, and no
  // VAULT_REVOKED from the local guard on the next append.
  const a = await Bundle.init(await tmpDir('wr-last'))
  t.after(() => a.close())
  const aHex = a.localKey.toString('hex')

  const r = await a.writers.remove(a.localKey)
  await a.update()
  assert.deepEqual(await a.val(K.flagRejected(aHex, r.seq)), { reason: 'policy-governance' })
  const c = await a.createConcept('still/alive', 'note')
  await a.update()
  assert.ok(await a.val(K.cMeta(c.tag)))
})

test('writers.setPolicy round trip: the writer folds its namespace prefixes, and every peer flags its create outside them policy-namespace', async (t) => {
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

test('HostAdapter returns the autobee grant, so core resumes only once the system records it, on every peer', async (t) => {
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

// ---------- the key and policy checks of the writers API ----------

test('writers.add, writers.remove and writers.setPolicy refuse a key that is not 32 bytes or 64 hex characters, VAULT_BAD_WRITER_KEY, and append nothing', async (t) => {
  // A z-base-32 id, which is how hypercore names a core (db.local.id),
  // decodes as hex to no bytes. If writers.add does not test the key, an
  // AddWriter of such an id writes a phantom gov/writer record.
  const a = await Bundle.init(await tmpDir('badkey-a'))
  const b = await Bundle.join(await tmpDir('badkey-b'), a.key)
  t.after(async () => {
    await a.close()
    await b.close()
  })
  const before = a.db.local.length
  const bad = [
    ['the z-base-32 id', b.db.local.id],
    ['63 hex characters', hex(b.localKey).slice(0, 63)],
    ['64 characters that are not hex', 'zz'.repeat(32)],
    ['31 bytes', Buffer.alloc(31, 1)],
    ['33 bytes', Buffer.alloc(33, 1)]
  ]
  for (const [name, key] of bad) {
    await assert.rejects(a.writers.add(key, { indexer: true }), { code: 'VAULT_BAD_WRITER_KEY' }, `writers.add: ${name}`)
    await assert.rejects(a.writers.remove(key), { code: 'VAULT_BAD_WRITER_KEY' }, `writers.remove: ${name}`)
    await assert.rejects(
      a.writers.setPolicy(key, { namespacePrefixes: ['x'] }),
      { code: 'VAULT_BAD_WRITER_KEY' },
      `writers.setPolicy: ${name}`
    )
  }
  assert.equal(a.db.local.length, before, 'no op reached the local core')

  // 32 bytes and 64 hex characters, in either case, name the same writer.
  await a.writers.add(hex(b.localKey).toUpperCase())
  await a.writers.setPolicy(b.localKey, { namespacePrefixes: ['b'] })
  await a.update()
  const govKeys = []
  for await (const { key } of a.scan(K.govWriterPrefix())) govKeys.push(key)
  assert.deepEqual(govKeys.sort(), [K.govWriter(hex(a.localKey)), K.govWriter(hex(b.localKey))].sort())
  assert.deepEqual((await a.val(K.govWriter(hex(b.localKey)))).namespacePrefixes, ['b'])
})

test('writers.setPolicy before open waits for open, and takes the default ceiling from the pinned metadata', async (t) => {
  // The default rateCeiling comes from the metadata, which open loads. A
  // setPolicy that reads it before open throws a TypeError.
  const dir = await tmpDir('policy-before-open')
  const v = await Bundle.init(dir, { metadata: { rate: { defaultCeiling: 8 } } })
  const self = hex(v.localKey)
  await v.close()

  const a = new Bundle(dir)
  t.after(() => a.close())
  const res = await a.writers.setPolicy(self, { namespacePrefixes: ['team'] })
  assert.equal(res.seq, 0, 'the policy op is the first op of the vault')
  await a.update()
  assert.deepEqual(await a.val(K.govWriter(self)), { indexer: true, namespacePrefixes: ['team'], rateCeiling: 8 })
})

test('an AddWriter grant leaves no pending promotion on any peer: HostAdapter grants at weight 0, not at autobee\'s default', async (t) => {
  // autobee's host addWriter (lib/apply-calls.js) defaults to weight 2.
  // The carrier stands at weight 0, so autobee caps every weight at 0, but
  // a grant at the default weight still records a pending promotion to 2
  // (System.addWriter, `pending`). That promotion brings back a livelock.
  // No documented autobee surface shows the promotion, so the test reads
  // db.system, as the attack tests do.
  const a = await Bundle.init(await tmpDir('grant-a'))
  const b = await Bundle.join(await tmpDir('grant-b'), a.key)
  const c = await Bundle.join(await tmpDir('grant-c'), a.key)
  const unpairs = [pair(a, b), pair(a, c)]
  t.after(async () => {
    for (const un of unpairs) un()
    for (const v of [a, b, c]) await v.close()
  })
  await a.writers.add(b.localKey, { indexer: false })
  await a.writers.add(c.localKey, { indexer: true })
  assert.ok(await until(async () => (await b.update(), await c.update(), b.writable && c.writable)), 'b and c are granted')
  await b.createConcept('b/x', 'note')
  await c.createConcept('c/x', 'note')
  assert.ok(
    await until(async () => {
      for (const v of [a, b, c]) {
        await v.update()
        for (const w of [b, c]) if ((await v.val(K.seen(hex(w.localKey)))) !== 1) return false
      }
      return true
    }),
    'every peer folds the ops of b and c'
  )
  const grants = {}
  for (const [name, v] of [['a', a], ['b', b], ['c', c]]) {
    for (const [wname, w] of [['b', b], ['c', c]]) {
      const r = await v.db.system.get(w.localKey)
      grants[`${name}:${wname}`] = { weight: r.weight, maxWeight: r.maxWeight, pending: await v.db.system.pendingPromotion(w.localKey) }
    }
  }
  const zero = { weight: 0, maxWeight: 0, pending: 0 }
  assert.deepEqual(grants, { 'a:b': zero, 'a:c': zero, 'b:b': zero, 'b:c': zero, 'c:b': zero, 'c:c': zero })
})

// ---------- the governance race (SPEC §8) ----------
//
// b revokes a while a and b are partitioned. 100 ms later a admits c, and
// c appends Y. The RemoveWriter has the earlier timestamp, so after the
// heal it sorts first and every peer rejects the AddWriter revoked. On a
// and c, that reorder flips an AddWriter that core first accepted.

const DEADLINE = 30000
const GAP_MS = 100

/** Poll until fn() is truthy. Throws when the deadline passes. */
async function waitFor(label, fn, ms = DEADLINE, step = 25) {
  const t0 = Date.now()
  for (;;) {
    if (await fn()) return
    if (Date.now() - t0 >= ms) throw new Error(`deadline ${ms} ms passed: ${label}`)
    await sleep(step)
  }
}

async function hashes(peers) {
  const hs = []
  for (const v of peers) {
    await v.update()
    hs.push(await v.snapshotHash())
  }
  return hs
}

const allEqual = (hs) => hs.every((h) => h === hs[0])

/** Wait for equal view hashes, then make sure they stay equal. */
async function converge(label, peers) {
  let hs = []
  await waitFor(`${label}: equal view hashes`, async () => allEqual((hs = await hashes(peers))))
  await sleep(300)
  hs = await hashes(peers)
  assert.ok(allEqual(hs), `${label}: the hashes stay equal: ${hs.map((h) => h.slice(0, 16))}`)
  return hs[0]
}

async function rejections(v) {
  await v.update()
  const out = []
  for await (const { key, value } of v.scan(K.flagPrefix('rejected'))) out.push([key, value.reason])
  return out
}

/** State of one peer for the diagnostics. db.system is read here only. */
async function report(name, v, cKey) {
  await v.update()
  const sys = await v.db.system.get(cKey)
  return {
    peer: name,
    hash: (await v.snapshotHash()).slice(0, 16),
    seenC: (await v.val(K.seen(hex(cKey)))) ?? null,
    govWriterC: (await v.val(K.govWriter(hex(cKey)))) !== undefined,
    rejected: (await rejections(v)).map(([k, r]) => [k.split('/').slice(2).join('/').slice(-24), r]),
    systemC: sys ? { length: sys.length, isRemoved: sys.isRemoved } : null
  }
}

/** Wait until every peer has folded c's ops up to and with `op`. */
async function everyPeerFolds(label, peers, cHex, op) {
  await waitFor(label, async () => {
    for (const v of peers) {
      await v.update()
      if (((await v.val(K.seen(cHex))) ?? 0) < op.seq + 1) return false
    }
    return true
  })
}

test('the governance race converges, and every op of the race writer leaves a flag (I2, I3, I4)', { timeout: 240000 }, async (t) => {
  const outcome = { steps: {} }
  const peers = []
  let cKey = null
  const links = []
  t.after(async () => {
    for (const unlink of links) unlink()
    for (const v of peers) await v.close().catch(() => {})
  })
  const link = (x, y) => {
    const unlink = pair(x, y)
    links.push(unlink)
    return unlink
  }

  try {
    // a and b are indexers. c joins and folds the seed, but cannot write.
    const a = await Bundle.init(await tmpDir('race-a'))
    peers.push(a)
    const b = await Bundle.join(await tmpDir('race-b'), a.key)
    peers.push(b)
    const unAB = link(a, b)
    await a.writers.add(b.localKey, { indexer: true })
    await waitFor('b becomes writable', async () => (await b.update(), b.writable))
    const seed = await a.createConcept('seed/a1', 'note')
    await waitFor('b folds the seed', async () => {
      await b.update()
      return (await b.val(K.cMeta(seed.tag))) !== undefined
    })
    const c = await Bundle.join(await tmpDir('race-c'), a.key)
    peers.push(c)
    link(a, c)
    await waitFor('c folds the seed', async () => {
      await c.update()
      return (await c.val(K.cMeta(seed.tag))) !== undefined
    })
    assert.equal(c.writable, false, 'c cannot write before its admission')
    cKey = c.localKey
    const aHex = hex(a.localKey)
    const cHex = hex(cKey)

    // The partition: b revokes a first, then a admits c, and c appends Y.
    unAB()
    await sleep(50)
    await b.removeWriter(a.localKey)
    await b.update()
    await sleep(GAP_MS)
    const add = await a.writers.add(c.localKey, { indexer: false })
    await waitFor('c becomes writable', async () => (await c.update(), c.writable))
    const Y = await c.createConcept('c/y', 'note')
    await c.update()
    await waitFor('a accepts Y before the heal', async () => {
      await a.update()
      return (await a.val(K.cMeta(Y.tag))) !== undefined
    })

    // The heal. Every peer folds the revocation, and a's AddWriter(c) in
    // its final disposition.
    link(a, b)
    link(b, c)
    await waitFor('every peer folds the revocation and the AddWriter', async () => {
      for (const v of peers) {
        await v.update()
        if ((await v.val(K.govRemoved(aHex))) === undefined) return false
        if (((await v.val(K.seen(aHex))) ?? 0) < add.seq + 1) return false
      }
      return true
    })
    for (const v of peers) {
      assert.deepEqual(
        await v.val(K.flagRejected(aHex, add.seq)),
        { reason: 'revoked' },
        'the RemoveWriter sorts first, so every peer rejects the AddWriter revoked'
      )
    }

    // Core grants every AddWriter it folds, accepted or rejected, so Y
    // reaches apply on every peer and leaves a flag. With a grant on accept
    // only, autobee keeps Y in the systems of a and c, and b never sees
    // it: Y vanishes with no flag (I4). okf/core/lib/apply.js
    // holds the grant rule.
    const flagged = async (op) => {
      for (const v of peers) {
        assert.deepEqual(
          await v.val(K.flagRejected(cHex, op.seq)),
          { reason: 'not-a-writer' },
          `c's op at seq ${op.seq} leaves a flag on every peer (I4)`
        )
        assert.equal(await v.val(K.cMeta(op.tag)), undefined, `c's op at seq ${op.seq} takes no effect`)
      }
    }

    // After Y.
    await everyPeerFolds('every peer folds Y', peers, cHex, Y)
    outcome.steps.afterY = { hash: (await converge('after Y', peers)).slice(0, 16) }
    await flagged(Y)

    // After c's next op Z.
    const Z = await c.createConcept('c/z', 'note')
    await c.update()
    await everyPeerFolds('every peer folds Z', peers, cHex, Z)
    const hz = await converge('after Z', peers)
    outcome.steps.afterZ = {
      hash: hz.slice(0, 16),
      peers: await Promise.all(peers.map((v, i) => report('abc'[i], v, c.localKey)))
    }
    await flagged(Y)
    await flagged(Z)

    // An indexer admits c again, and c appends R. R takes effect.
    await b.writers.add(c.localKey, { indexer: false })
    await waitFor('c folds its re-admission', async () => {
      await c.update()
      return (await c.val(K.govWriter(cHex))) !== undefined
    })
    const R = await c.createConcept('c/r', 'note')
    await waitFor('R takes effect on every peer', async () => {
      for (const v of peers) {
        await v.update()
        if ((await v.val(K.cMeta(R.tag))) === undefined) return false
      }
      return true
    })
    const hr = await converge('after R', peers)
    for (const v of peers) {
      assert.equal(await v.val(K.flagRejected(cHex, R.seq)), undefined, 'R is not rejected')
      assert.equal((await v.val(K.cPath(R.tag))).path, 'c/r', 'R takes effect')
    }

    // A fresh peer rebuilds from nothing (I3).
    const d = await Bundle.join(await tmpDir('race-d'), a.key)
    peers.push(d)
    link(b, d)
    await waitFor('the fresh peer folds R', async () => {
      await d.update()
      return (await d.val(K.cMeta(R.tag))) !== undefined
    })
    const hd = await converge('fresh peer', peers)
    assert.equal(hd, hr, 'the fresh peer gives the same view hash as the three peers')
    const want = await rejections(a)
    for (const v of peers) {
      assert.deepEqual(await rejections(v), want, 'the same rejection records on every peer')
    }
    assert.deepEqual(
      want.filter(([k]) => k.startsWith(`flag/rejected/${cHex}/`)).map(([, reason]) => reason),
      ['not-a-writer', 'not-a-writer'],
      'the rejected ops of c are Y and Z'
    )
    assert.equal((await d.val(K.cPath(R.tag))).path, 'c/r', 'R takes effect on the fresh peer')
    outcome.steps.fresh = {
      hash: hd.slice(0, 16),
      peers: await Promise.all(peers.map((v, i) => report('abcd'[i], v, c.localKey)))
    }
  } finally {
    // On a failure, the state of every peer at that moment.
    if (cKey && !outcome.steps.fresh) {
      outcome.atFailure = await Promise.all(peers.map((v, i) => report('abcd'[i], v, cKey))).catch(String)
    }
    t.diagnostic(`outcome ${JSON.stringify(outcome)}`)
  }
})
