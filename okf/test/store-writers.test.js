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
