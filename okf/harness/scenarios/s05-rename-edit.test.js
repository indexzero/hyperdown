// S5 — rename + edit merge (the Kleppmann rule). A renames a concept
// (SetPath) while B edits it (SetField) behind a partition; on heal the edit
// follows the concept to its NEW path on every peer — no lost write, no ghost
// at the old path. Path is an LWW register on stable identity, so a rename
// and a concurrent field write merge rather than duplicating.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupVaultCluster, assertAllCoherent } from './helpers.js'

test('S5: rename + concurrent edit merge — the edit follows the concept, no ghost', async () => {
  const { ctl, writers } = await setupVaultCluster('s05-rename-edit', 2)
  const [a, b] = writers
  try {
    const { tag: id } = await a.call('createConcept', 'notes/old', 'note')
    await ctl.quiesce(writers)

    await ctl.disconnect(a, b) // partition
    await a.call('setPath', id, 'notes/new') // A renames
    await b.call('setField', id, 'title', 'edited') // B edits concurrently
    await ctl.connect(a, b) // heal
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
