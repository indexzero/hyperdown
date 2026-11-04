// S2: I5 under a partition, and a staletag flag for a fabricated token.
// See SPEC §5 for the OR-set rule.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupVaultCluster, flagKeys, assertAllCoherent } from './helpers.js'

test('S2: concurrent add wins over remove-of-unobserved; tag present on every peer', async () => {
  const { ctl, writers } = await setupVaultCluster('s02-orset', 2)
  const [a, b] = writers
  try {
    const { tag: id } = await a.call('createConcept', 'notes/tagged', 'note')
    await a.call('addTag', id, 'k') // token t0, observed by both
    await ctl.quiesce(writers)

    await ctl.disconnect(a, b)
    await a.call('remTag', id, 'k') // A cites the observed token t0
    await b.call('addTag', id, 'k') // B mints a new token that A did not see
    // a token that no writer minted
    const bogus = a.info.localKey + 'ff'
    await a.append('rem-tag', { id, value: 'k', tags: [bogus] })
    await ctl.connect(a, b)
    await ctl.quiesce(writers)

    for (const w of writers) {
      const dump = await w.dump('')
      const rec = dump[`c/${id}/f/tags`]
      const values = Object.values(rec.els)
      assert.ok(values.includes('k'), `${w.name}: SU-set keeps the concurrently re-added tag`)
      assert.equal(flagKeys(dump, `staletag/${id}`).length, 1, `${w.name}: one staletag audit`)
    }
    await assertAllCoherent(writers)
  } finally {
    await ctl.stop()
  }
})
