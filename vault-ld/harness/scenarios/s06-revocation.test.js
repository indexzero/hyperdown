// S6 (I10) revocation race. The genesis indexer removes writer C behind a
// partition while C, not yet knowing, keeps writing. Heal. C's
// post-revocation-point ops (linearized after the RemoveWriter — it
// carries the earlier node timestamp — with clocks not dominated by the
// recorded revocation clock, §8.3) must have touched nothing outside
// flag/, and all peers must agree on exactly which of C's ops landed.
// The mirror arm (C's op linearizes BEFORE the removal and is uniformly
// applied) is covered by test/regressions/revocation-race-divergence.test.js.
// Also (assignment §3 "governance plumbing"): the indexer set keeps making
// progress while the revoked agent is offline.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupVaultCluster } from '../lib/setup.js'

test('S6: ops racing their revocation are contained to flag/ (I10)', async (t) => {
  const { ctl, writers } = await setupVaultCluster('s06', 3)
  t.after(() => ctl.stop())
  const [a, b, c] = writers

  await a.call('defineTerm', 'core', 'title', { '@id': 'ex:title' })
  await c.call('setField', 'agents/c/Pre', 'title', 'before revocation')
  await ctl.quiesce(writers)
  const cKey = c.info.localKey

  // partition C, then race: the indexer revokes C while C — which has not
  // seen the removal — keeps writing. The removal's earlier node timestamp
  // puts it before C's in-flight ops in the final linearization on every
  // peer (autobee topo order), so §8.3's clock rule judges both racing ops
  // uniformly; the sleep keeps the timestamps strictly ordered.
  await ctl.partition([a, b], [c])
  await a.call('removeWriter', cKey)
  await new Promise((r) => setTimeout(r, 25))
  await c.call('setField', 'agents/c/InFlight1', 'title', 'in flight 1')
  await c.call('setField', 'agents/c/InFlight2', 'title', 'in flight 2')
  await c.update()
  await ctl.quiesce([a, b])

  // indexer-set progress with the agent offline (assignment §3)
  await a.call('setField', 'Home', 'title', 'progress while c offline')
  const duoHash = await ctl.quiesce([a, b])
  assert.ok(duoHash, 'indexer set makes progress with the agent partitioned')

  // heal: C's in-flight ops replicate everywhere. C stays admitted at the
  // autobee level (§8.3 is causal, in core's log — never the substrate's
  // positional removal; DEVIATIONS.md §13(d), review finding B1), so its
  // nodes linearize on every peer and the clock rule rejects them uniformly.
  await ctl.connectAll(writers)
  const hash = await ctl.quiesce(writers, { timeout: 15000 })
  assert.ok(hash, 'all peers converge after the heal (I2)')

  for (const w of writers) {
    // the racing ops never mutated n/ (I10)
    assert.equal(await w.val('n/agents%2Fc%2FInFlight1/base'), null, `${w.name}: no n/ effect`)
    assert.equal(await w.val('n/agents%2Fc%2FInFlight2/base'), null, `${w.name}: no n/ effect`)
    // pre-revocation state survives
    const pre = await w.val('n/agents%2Fc%2FPre/f/title')
    assert.deepEqual(pre.reg.values, ['before revocation'], `${w.name}: pre-revocation op landed`)
    // and the rejections are recorded writer/seq-keyed, identically
    const rejected = await w.dump(`flag/rejected/${cKey}/`)
    const reasons = Object.values(rejected).map((r) => r.reason)
    assert.deepEqual(reasons, ['revoked', 'revoked'], `${w.name}: both racing ops rejected`)
  }
})
