// S4 (I4) body conflict detection. B and C both SetBody citing the same
// base revision, concurrently. Both revisions must be retained, one
// deterministic head chosen, and exactly one conflict flag present, on
// every peer.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupVaultCluster } from '../lib/setup.js'

test('S4: concurrent same-base SetBody keeps both revisions + one conflict flag (I4)', async (t) => {
  const { ctl, writers } = await setupVaultCluster('s04', 3)
  t.after(() => ctl.stop())
  const [a, b, c] = writers

  await a.call('setBody', 'Home', null, 'the shared base text')
  await ctl.quiesce(writers)
  const base = await a.val('n/Home/body')
  assert.match(base, /^[0-9a-f]{64}$/)

  await ctl.partition([a], [b, c])
  await ctl.partition([b], [c])
  await ctl.barrier([
    () => b.call('setBody', 'Home', base, 'divergent text from b'),
    () => c.call('setBody', 'Home', base, 'divergent text from c')
  ])

  await ctl.connectAll(writers)
  const hash = await ctl.quiesce(writers)
  assert.ok(hash)

  let head0 = null
  for (const w of writers) {
    const revs = Object.keys(await w.dump('n/Home/rev/'))
    assert.equal(revs.length, 3, `${w.name}: base + both concurrent revisions retained (I4)`)
    const conflicts = Object.keys(await w.dump('flag/conflict/Home/'))
    assert.equal(conflicts.length, 1, `${w.name}: exactly one conflict flag`)
    const head = await w.val('n/Home/body')
    if (head0 === null) head0 = head
    assert.equal(head, head0, `${w.name}: deterministic head`)
    assert.notEqual(head, base, `${w.name}: head advanced past the base`)
  }
})
