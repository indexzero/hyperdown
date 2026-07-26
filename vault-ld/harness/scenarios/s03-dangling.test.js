// S3 (I7) dangling flag lifecycle. B links to nonexistent note X during a
// partition; C creates X during the same partition. Heal in both orders
// (permutation replay by universe cloning). Final state MUST have no
// dangling flag for X, deterministically, and both heal orders MUST agree
// on the whole view.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupVaultCluster } from '../lib/setup.js'

test('S3: dangling flag clears when the target materializes, both heal orders (I7)', async (t) => {
  const { ctl, writers } = await setupVaultCluster('s03', 3)
  t.after(() => ctl.stop())
  const [a, b, c] = writers

  await a.call('defineTerm', 'core', 'link', { '@id': 'ex:link', '@container': '@set' })
  await a.call('defineTerm', 'core', 'title', { '@id': 'ex:title' })
  await ctl.quiesce(writers)

  await ctl.partition([a], [b, c])
  await ctl.partition([b], [c])
  await ctl.barrier([
    () => b.call('addMember', 'Home', 'link', { ref: 'X' }),
    () => c.call('setField', 'X', 'title', 'X exists')
  ])
  await b.update()
  await c.update()

  // B alone must currently hold a dangling flag for X
  const bFlags = await b.dump('flag/dangling/')
  assert.equal(Object.keys(bFlags).length, 1, 'B flags the dangling ref during the partition')

  const cloneL = await ctl.cloneUniverse(writers, 'L')
  const cloneR = await ctl.cloneUniverse(writers, 'R')

  // L: link op arrives first, then the target creation
  await ctl.connect(cloneL[0], cloneL[1])
  await ctl.quiesce([cloneL[0], cloneL[1]])
  await ctl.connectAll(cloneL)
  const hashL = await ctl.quiesce(cloneL)

  // R: target creation first, then the link op
  await ctl.connect(cloneR[0], cloneR[2])
  await ctl.quiesce([cloneR[0], cloneR[2]])
  await ctl.connectAll(cloneR)
  const hashR = await ctl.quiesce(cloneR)

  assert.equal(hashL, hashR, `heal order changed the converged view (seed=${ctl.seed})`)

  for (const w of [...cloneL, ...cloneR]) {
    const dang = await w.dump('flag/dangling/')
    assert.deepEqual(Object.keys(dang), [], `${w.name}: no dangling flag once X exists (I7)`)
    assert.ok(await w.val('n/X/base'), `${w.name}: X exists`)
  }
})
