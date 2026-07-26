// S1 (I6) LWW arrival independence. Writers B and C set the same scalar on
// the same subject during a full partition. Heal. All peers must agree, and
// the winner must be a pure function of linearization: the same universe
// (identical writer cores) healed in two different arrival orders must
// produce the same view hash and the same winner (permutation replay by
// universe cloning).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupVaultCluster } from '../lib/setup.js'

test('S1: LWW winner is arrival-order independent (I6)', async (t) => {
  const { ctl, writers } = await setupVaultCluster('s01', 3)
  t.after(() => ctl.stop())
  const [a, b, c] = writers

  await a.call('defineTerm', 'core', 'title', { '@id': 'ex:title' })
  await ctl.quiesce(writers)

  // full partition, then a constructed race: both set the same scalar
  await ctl.partition([a], [b, c])
  await ctl.partition([b], [c])
  await ctl.barrier([
    () => b.call('setField', 'Home', 'title', 'from-b'),
    () => c.call('setField', 'Home', 'title', 'from-c')
  ])
  await b.update()
  await c.update()

  // permutation replay: same cores, two heal orders
  const cloneL = await ctl.cloneUniverse(writers, 'L')
  const cloneR = await ctl.cloneUniverse(writers, 'R')

  // L: a sees b's op first, then c's
  await ctl.connect(cloneL[0], cloneL[1])
  await ctl.quiesce([cloneL[0], cloneL[1]])
  await ctl.connectAll(cloneL)
  const hashL = await ctl.quiesce(cloneL)

  // R: a sees c's op first, then b's
  await ctl.connect(cloneR[0], cloneR[2])
  await ctl.quiesce([cloneR[0], cloneR[2]])
  await ctl.connectAll(cloneR)
  const hashR = await ctl.quiesce(cloneR)

  assert.equal(hashL, hashR, `arrival order changed the converged view (seed=${ctl.seed})`)

  // the winner is one deterministic value on every peer of both clones
  const winners = new Set()
  for (const w of [...cloneL, ...cloneR]) {
    const rec = await w.val('n/Home/f/title')
    assert.ok(rec && rec.reg, `${w.name} has a register`)
    winners.add(JSON.stringify(rec.reg.values))
  }
  assert.equal(winners.size, 1, `winner differs across peers: ${[...winners]}`)
})
