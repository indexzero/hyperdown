// S3: wanted/ demand under a partition (I7, I8). See SPEC §4.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupVaultCluster, assertAllCoherent, replayHash } from './helpers.js'

test('S3: link + late create → wanted/ clears deterministically, both heal orders', async () => {
  const { ctl, writers } = await setupVaultCluster('s03-wanted', 2)
  const [a, b] = writers
  try {
    const { tag: src } = await a.call('createConcept', 'notes/src', 'note')
    await ctl.quiesce(writers)

    await ctl.disconnect(a, b)
    await a.append('set-body', { id: src, base: null, text: 'need [x](/notes/target)' })
    const { tag: target } = await b.call('createConcept', 'notes/target', 'note')
    await ctl.connect(a, b)
    const hash = await ctl.quiesce(writers)

    for (const w of writers) {
      const dump = await w.dump('')
      const wantedForTarget = Object.keys(dump).filter((k) => k.startsWith('wanted/notes%2Ftarget/'))
      assert.equal(wantedForTarget.length, 0, `${w.name}: no residual demand for the created path`)
      assert.ok(dump[`bl/${target}/${src}`], `${w.name}: edge promoted to a backlink`)
    }
    await assertAllCoherent(writers)

    assert.equal(await replayHash(ctl, writers, 's03'), hash, 'demand resolution is order-independent')
  } finally {
    await ctl.stop()
  }
})
