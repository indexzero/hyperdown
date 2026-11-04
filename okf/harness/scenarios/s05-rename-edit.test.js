// S5: a rename and a concurrent edit under a partition. The path is an LWW
// register on a stable `_id`, so the two merge. See SPEC §7.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupVaultCluster, assertAllCoherent } from './helpers.js'

test('S5: rename + concurrent edit merge — the edit follows the concept, no ghost', async () => {
  const { ctl, writers } = await setupVaultCluster('s05-rename-edit', 2)
  const [a, b] = writers
  try {
    const { tag: id } = await a.call('createConcept', 'notes/old', 'note')
    await ctl.quiesce(writers)

    await ctl.disconnect(a, b)
    await a.call('setPath', id, 'notes/new')
    await b.call('setField', id, 'title', 'edited')
    await ctl.connect(a, b)
    await ctl.quiesce(writers)

    for (const w of writers) {
      const dump = await w.dump('')
      assert.equal(dump['path/notes%2Fnew'], id, `${w.name}: concept at the new path`)
      assert.equal(dump['path/notes%2Fold'], undefined, `${w.name}: old path vacated (no ghost)`)
      assert.deepEqual(dump[`c/${id}/f/title`].values, ['edited'], `${w.name}: edit not lost`)
      assert.equal(dump[`c/${id}/path`].path, 'notes/new')
    }
    await assertAllCoherent(writers)
  } finally {
    await ctl.stop()
  }
})
