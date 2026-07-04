// REGRESSION (blocker): revocation-race convergence divergence (I2/I10).
//
// Shrunk from harness scenario S6 (seed=7) to the minimal two-writer case.
// A (genesis indexer) admits C, converges, then a partition is opened; C
// appends an op WHILE partitioned, and A issues RemoveWriter(C) before C's
// op replicates. On heal the two peers DO NOT converge: A's autobee never
// linearizes C's in-flight node (C is removed at A's linearization point),
// while C's own view (and any fresh peer that replayed both cores) DID
// linearize and apply it. The applied/rejected partition for C's
// post-revocation op therefore differs between peers — a permanent view-
// hash divergence, which the severity rule classes as a blocker.
//
// SPEC-FINAL §8.3 requires the accept/reject decision for a revoked
// writer's racing op to be a pure function of op-embedded clocks and
// linearized order, applied uniformly on every peer (I10, reorg-stable).
// Under autobee, RemoveWriter drops the node from the remover's
// linearization entirely, so core's clock-based reject-in-apply never
// runs on that peer, and convergence (I2) breaks.
//
// This test asserts the CORRECT behavior and is expected to FAIL until the
// defect is fixed. See orchestration/results/CODE-REVIEW.md finding B1.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vault, tmpDir, until } from '../store-helpers.js'

function pairStreams(a, b) {
  const s1 = a.replicate(true)
  const s2 = b.replicate(false)
  s1.on('error', () => {})
  s2.on('error', () => {})
  s1.pipe(s2).pipe(s1)
  return () => {
    s1.destroy()
    s2.destroy()
  }
}

test('revocation race: peers converge after a removed writer\'s in-flight op (I2/I10)', async (t) => {
  const a = await Vault.init(await tmpDir('rev-a'))
  const c = await Vault.join(await tmpDir('rev-c'), a.key)
  c.on('error', () => {}) // autobee tears the revoked instance down
  t.after(async () => {
    await a.close().catch(() => {})
    await c.close().catch(() => {})
  })

  let unpair = pairStreams(a, c)
  await a.addWriter(c.localKey, { indexer: false })
  assert.ok(
    await until(async () => {
      await c.update()
      return c.writable
    }),
    'c becomes writable'
  )
  await a.defineTerm('core', 'title', { '@id': 'ex:title' })
  await c.setField('agents/c/Pre', 'title', 'pre')
  assert.ok(
    await until(async () => (await a.hash()) === (await c.hash())),
    'converged before the partition'
  )

  // partition, then race: C writes while A revokes it
  unpair()
  await c.setField('agents/c/InFlight', 'title', 'raced the revocation')
  await c.update()
  await a.removeWriter(c.localKey)
  await a.update()

  // heal and drain
  unpair = pairStreams(a, c)
  await until(async () => {
    await a.update()
    await c.update().catch(() => {})
    return false
  }, 6000)
  t.after(() => unpair())

  const ha = await a.hash()
  const hc = await c.hash()
  assert.equal(ha, hc, 'peers MUST converge to one view hash after the revocation race (I2)')
})
