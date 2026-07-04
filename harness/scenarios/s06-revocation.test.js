// S6 (I10) revocation race. The genesis indexer removes writer C while C
// has unreplicated ops in flight behind a partition. Heal. C's
// post-revocation-point ops (clock not dominated by the recorded
// revocation clock, §8.3) must have touched nothing outside flag/, and
// all peers must agree on exactly which of C's ops landed.
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

  // partition C, then race: C keeps writing while the indexer revokes it
  await ctl.partition([a, b], [c])
  await c.call('setField', 'agents/c/InFlight1', 'title', 'in flight 1')
  await c.call('setField', 'agents/c/InFlight2', 'title', 'in flight 2')
  await c.update()
  await a.call('removeWriter', cKey)
  await ctl.quiesce([a, b])

  // indexer-set progress with the agent offline (assignment §3)
  await a.call('setField', 'Home', 'title', 'progress while c offline')
  const duoHash = await ctl.quiesce([a, b])
  assert.ok(duoHash, 'indexer set makes progress with the agent partitioned')

  // heal: C's in-flight ops replicate; autobee tears the revoked C down
  // once it sees its own removal ('error' event) — the harness records it.
  //
  // KNOWN BLOCKER B1 (see orchestration/results/CODE-REVIEW.md and
  // test/regressions/revocation-race-divergence.test.js): the indexer's
  // linearization drops C's in-flight node while C's own view (and any
  // fresh peer) applies it, so this quiesce does NOT converge. The
  // assertion below is the invariant the system must satisfy; it fails
  // today, which is the committed repro.
  await ctl.connectAll(writers)
  const hash = await ctl.quiesce(writers, { timeout: 15000 })
  assert.ok(hash, 'all peers converge after the heal (I2) — FAILS today, blocker B1')

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
