// S6 — rename + rename. A and B SetPath the SAME concept to two different
// paths concurrently behind a partition; on heal the linearization winner
// holds the path, the loser is recorded under flag/clobber/<id>/path/<tag>,
// and every peer converges. Permutation replay confirms the winner is a pure
// function of the linearized log.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupVaultCluster, flagKeys, assertAllCoherent, replayHash } from './helpers.js'

test('S6: concurrent rename → linearization winner holds path, loser flag/clobber', async () => {
  const { ctl, writers } = await setupVaultCluster('s06-rename-rename', 2)
  const [a, b] = writers
  try {
    const { tag: id } = await a.call('createConcept', 'notes/base', 'note')
    await ctl.quiesce(writers)

    await ctl.disconnect(a, b) // partition
    await a.call('setPath', id, 'notes/a')
    await b.call('setPath', id, 'notes/b')
    await ctl.connect(a, b) // heal
    const hash = await ctl.quiesce(writers)

    for (const w of writers) {
      const dump = await w.dump('')
      const winner = dump[`c/${id}/path`].path
      assert.ok(['notes/a', 'notes/b'].includes(winner), `${w.name}: one path wins`)
      assert.equal(dump[`path/${winner === 'notes/a' ? 'notes%2Fa' : 'notes%2Fb'}`], id)
      // exactly one path-clobber audit for the losing rename
      assert.equal(flagKeys(dump, `clobber/${id}/path`).length, 1, `${w.name}: one path clobber`)
    }
    await assertAllCoherent(writers)

    assert.equal(await replayHash(ctl, writers, 's06'), hash, 'rename winner is pure linearization')
  } finally {
    await ctl.stop()
  }
})
