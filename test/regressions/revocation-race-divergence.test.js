// REGRESSION (blocker B1, fixed): revocation-race convergence (I2/I10).
//
// Shrunk from harness scenario S6 (seed=7) to the minimal two-writer case.
// A (genesis indexer) admits C, converges, then a partition is opened; C
// appends an op WHILE partitioned, and A issues RemoveWriter(C) before C's
// op replicates. Before the fix, revocation was delegated to autobee's
// positional host.removeWriter: A's linearization dropped C's in-flight
// node entirely while C's own view (and any fresh peer that replayed both
// cores) applied it — a permanent view-hash divergence (blocker).
//
// SPEC-FINAL §8.3 (causal, not positional): core records only the in-log
// removal clock (ctx/gov/removed/<C>) and never invokes the substrate's
// positional removal, so C stays admitted at the autobee level and its
// node linearizes on EVERY peer. Here the racing op carries the earlier
// node timestamp, so it linearizes before the RemoveWriter on every peer
// and is uniformly APPLIED (it precedes the in-log revocation point); the
// mirror arm — removal linearizes first, racing ops uniformly rejected
// 'revoked' — is exercised by harness/scenarios/s06-revocation.test.js.
// Either way: one convergent view. See orchestration/results/CODE-REVIEW.md
// finding B1.
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
  c.on('error', () => {}) // defensive; no substrate teardown is expected post-fix
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
