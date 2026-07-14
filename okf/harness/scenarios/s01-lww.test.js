// S1 (I6) — LWW-array clobber. Two writers SetField the same key on the
// same concept during a partition; on heal the register converges, the
// winner is a pure function of linearization order (verified by permutation
// replay), and the loser is preserved under flag/clobber (I4: no silent loss).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupVaultCluster, flagKeys, assertAllCoherent, replayHash } from './helpers.js'

test('S1: concurrent same-key SetField converges to one linearization winner + flag/clobber', async () => {
  const { ctl, writers } = await setupVaultCluster('s01-lww', 2)
  const [a, b] = writers
  try {
    const { tag: id } = await a.call('createConcept', 'notes/doc', 'note')
    await ctl.quiesce(writers) // both peers observe the concept

    await ctl.disconnect(a, b) // partition
    await a.call('setField', id, 'title', 'from-a')
    await b.call('setField', id, 'title', 'from-b')
    await ctl.connect(a, b) // heal
    const hash = await ctl.quiesce(writers)

    for (const w of writers) {
      const dump = await w.dump('')
      const reg = dump[`c/${id}/f/title`]
      assert.equal(reg.values.length, 1, `${w.name}: one materialized winner`)
      assert.ok(['from-a', 'from-b'].includes(reg.values[0]))
      // I4: the loser is auditable, exactly one clobber for this key
      assert.equal(flagKeys(dump, `clobber/${id}/title`).length, 1, `${w.name}: one clobber`)
    }
    await assertAllCoherent(writers)

    // permutation replay: same linearized log -> same view hash
    assert.equal(await replayHash(ctl, writers, 's01'), hash, 'winner is pure linearization')
  } finally {
    await ctl.stop()
  }
})
