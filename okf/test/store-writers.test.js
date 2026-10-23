// Store scope (okf SPEC §13, T4): writer add/remove round trip on real
// autobee — §8 causal revocation (in-band clock rule, never
// host.removeWriter positional), the seqAtRemoval cross-check on a
// partitioned post-revocation op, the local revoked-append guard, and
// cross-peer hash equality of the applied/rejected partition (I10).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Bundle, K, tmpDir, pair, until, converged } from './store-helpers.js'

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

  // add: in-log governance op from the genesis indexer
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

  // b writes one accepted op; a folds it before revoking, so the
  // remove-writer's clock cites b@0 (seqAtRemoval = 0)
  const { tag: id } = await b.createConcept('agents/b/note', 'note')
  assert.ok(
    await until(async () => {
      await a.update()
      return (await a.val(K.cMeta(id))) !== undefined
    }),
    'a folds b op before the removal'
  )

  // partition b, revoke, let b append one more op while partitioned
  unpair()
  await a.writers.remove(b.localKey)
  await a.update()
  const removed = await a.val(K.govRemoved(bHex))
  assert.equal(removed.seqAtRemoval, 0, 'revocation records the observed position')
  assert.equal(removed.clock[bHex], 0, 'remove-writer clock cites the target (store-built clock)')

  const late = await b.setField(id, 'status', ['sneaky']) // b has not folded the removal yet
  assert.equal(late.seq, 1)

  // heal: the post-revocation op linearizes on BOTH peers and is rejected
  // 'revoked' on both — host.removeWriter is never called, so every node
  // keeps linearizing and the partition of applied/rejected is uniform
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

  // the revoked writer's own store refuses further local appends (§8)
  await b.update()
  await assert.rejects(
    () => b.setField(id, 'status', ['again']),
    (err) => err.code === 'VAULT_REVOKED',
    'local append refused once the revocation is folded'
  )

  // governance from a non-indexer is rejected in apply on every peer:
  // the removal of b did not go through b, and a stays the only indexer
  const aOthers = await a.val(K.govWriter(bHex))
  assert.equal(aOthers.indexer, false)
})

test('remove-writer that would leave zero indexers is rejected (§8)', async (t) => {
  const a = await Bundle.init(await tmpDir('wr-last'))
  t.after(() => a.close())
  const aHex = a.localKey.toString('hex')

  const r = await a.writers.remove(a.localKey)
  await a.update()
  assert.deepEqual(await a.val(K.flagRejected(aHex, r.seq)), { reason: 'policy-governance' })
  assert.equal(await a.val(K.govRemoved(aHex)), undefined, 'genesis indexer not removed')
  // vault remains governable
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

test('a writer added while genesis is offline sorts at 0 until genesis approves it', async (t) => {
  // autobee@2: a grant's ceiling is capped at the resolved weight of the
  // node that carries it (lib/system.js addWriter), and a writer's nodes
  // sort at 0 until a peer whose standing reaches the tier approves it and
  // the writer cites that approval (index.js _collectApprovals, append
  // witness; lib/witness.js). Only genesis starts at 2 (bootstrapWeight).
  const a = await Bundle.init(await tmpDir('climb-a'))
  const b = await Bundle.join(await tmpDir('climb-b'), a.key)
  const c = await Bundle.join(await tmpDir('climb-c'), a.key)
  let unpairAB = pair(a, b)
  const unpairBC = pair(b, c)
  t.after(async () => {
    unpairAB()
    unpairBC()
    await a.close()
    await b.close()
    await c.close()
  })
  const sys = async (v, w) => {
    await v.update()
    const rec = await v.db.system.get(w.localKey)
    return rec ? { weight: rec.weight, maxWeight: rec.maxWeight } : null
  }

  // genesis admits b as an okf indexer, then goes offline before it
  // appends again, so it never approves b
  await a.writers.add(b.localKey, { indexer: true })
  assert.ok(await until(async () => (await b.update(), b.writable)), 'b writable')
  assert.deepEqual(await sys(b, b), { weight: 0, maxWeight: 2 }, 'b: ceiling 2, sorts at 0')
  unpairAB()

  // b (an okf indexer at autobee weight 0) admits c while genesis is offline
  await b.writers.add(c.localKey, { indexer: false })
  assert.ok(await until(async () => (await c.update(), c.writable)), 'c writable at once')
  const c0 = await c.createConcept('climb/c0', 'note')
  await b.createConcept('climb/b0', 'note')
  assert.ok(
    await until(async () => {
      await b.update()
      await c.update()
      return (await b.val(K.cMeta(c0.tag))) !== undefined
    })
  )
  // the carrier (b's node) sorted at 0, so c's ceiling is capped at 0, and
  // no online peer has the standing to approve either of them
  for (const v of [b, c]) {
    assert.deepEqual(await sys(v, c), { weight: 0, maxWeight: 0 }, 'c: capped at the carrier')
    assert.deepEqual(await sys(v, b), { weight: 0, maxWeight: 2 }, 'b: still 0')
  }
  const c1 = await c.createConcept('climb/c1', 'note')
  await until(async () => (await b.update(), (await b.val(K.cMeta(c1.tag))) !== undefined))
  assert.equal((await sys(b, c)).weight, 0, 'no climb while genesis is offline')

  // genesis returns, folds b's and c's ops, and appends: autobee adds
  // approvals for both pending promotions to that append
  unpairAB = pair(a, b)
  assert.ok(await until(async () => (await a.update(), (await a.val(K.cMeta(c1.tag))) !== undefined)))
  const a1 = await a.createConcept('climb/a1', 'note')
  assert.ok(
    await until(async () => {
      await b.update()
      await c.update()
      return (await c.val(K.cMeta(a1.tag))) !== undefined
    }),
    'b and c fold the approving append'
  )
  // each cites the approval (a witness) on its next append, and climbs
  await b.createConcept('climb/b2', 'note')
  await c.createConcept('climb/c2', 'note')
  assert.ok(await converged([a, b, c]), 'all three converge')
  for (const v of [a, b, c]) {
    assert.deepEqual(await sys(v, b), { weight: 2, maxWeight: 2 }, 'b climbed')
    assert.deepEqual(await sys(v, c), { weight: 2, maxWeight: 2 }, 'c climbed')
  }
})

/**
 * Append one op from `v` whose oplog node carries a hand-built approvals
 * entry. autobee normally fills `approvals` itself, only for pending
 * promotions (index.js _collectApprovals); here the list is forged.
 */
async function appendWithForgedApproval(v, key, weight, path) {
  const collect = v.db._collectApprovals
  v.db._collectApprovals = async () => [{ key, weight }]
  try {
    return await v.createConcept(path, 'note')
  } finally {
    v.db._collectApprovals = collect
  }
}

test('a hand-built approval adds an autobee writer apply never granted; core holds its ops', async (t) => {
  const a = await Bundle.init(await tmpDir('appr-a'))
  const s = await Bundle.join(await tmpDir('appr-s'), a.key)
  const unpair = pair(a, s)
  t.after(async () => {
    unpair()
    await a.close()
    await s.close()
  })
  const sHex = s.localKey.toString('hex')
  const { tag: seed } = await a.createConcept('appr/seed', 'note')
  assert.ok(await until(async () => (await s.update(), (await s.val(K.cMeta(seed))) !== undefined)))
  assert.equal(s.writable, false)

  // genesis (standing 2) appends a node whose approvals name s
  await appendWithForgedApproval(a, s.localKey, 2, 'appr/carrier')
  assert.ok(await until(async () => (await s.update(), s.writable)), 'the approval alone makes s writable')
  for (const v of [a, s]) {
    await v.update()
    const rec = await v.db.system.get(s.localKey)
    assert.equal(rec.isRemoved, false)
    assert.equal(rec.maxWeight, 2, 'ceiling 2 from a weight-2 carrier')
    assert.equal(await v.val(K.govWriter(sHex)), undefined, 'okf never admitted s')
  }

  // s's PLAIN ops reach okf apply (seen/ counts them) and are held, never
  // folded into c/; s's governance op is rejected
  const c0 = await s.createConcept('appr/from-s', 'note')
  const g1 = await s.addWriter(a.localKey, { indexer: true })
  const hash = await converged([a, s])
  assert.ok(hash, 'peers converge')
  for (const v of [a, s]) {
    assert.equal(await v.val(K.seen(sHex)), 2, 'both plain ops reached apply')
    assert.ok(await v.val(K.hold(sHex, c0.seq)), 'content op held under hold/')
    assert.equal(await v.val(K.cMeta(c0.tag)), undefined, 'no c/ effect (I10)')
    assert.deepEqual(await v.val(K.flagRejected(sHex, g1.seq)), { reason: 'policy-governance' })
  }
  // s's first plain append cited the approval as a witness, so its nodes
  // sort at weight 2, level with genesis
  assert.equal((await a.db.system.get(s.localKey)).weight, 2)
})

test('a hand-built approval from a member at weight 0 also adds the key, at ceiling 0', async (t) => {
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
  assert.equal((await b.db.system.get(b.localKey)).weight, 0, 'b has not climbed')

  await appendWithForgedApproval(b, s.localKey, 2, 'appr0/carrier')
  assert.ok(await until(async () => (await s.update(), s.writable)), 'still makes s writable')
  const rec = await b.db.system.get(s.localKey)
  assert.equal(rec.maxWeight, 0, 'capped at the weight-0 carrier')
  const c0 = await s.createConcept('appr0/from-s', 'note')
  assert.ok(await converged([a, b, s]), 'peers converge')
  for (const v of [a, b, s]) {
    assert.equal(await v.val(K.seen(sHex)), 1, 'the plain op reached apply')
    assert.ok(await v.val(K.hold(sHex, c0.seq)), 'held')
    assert.equal(await v.val(K.cMeta(c0.tag)), undefined, 'no c/ effect (I10)')
  }
})
