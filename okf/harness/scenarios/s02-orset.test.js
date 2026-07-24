// S2 (I5) — tag OR-set race (SU-set law). A removes an observed tag while B
// concurrently re-adds the same value behind a partition; on heal the tag
// MUST be present on every peer (concurrent add beats remove-of-unobserved).
// A remove citing a never-observed token is ignored for effect and audited
// once under flag/staletag.
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

    await ctl.disconnect(a, b) // partition
    await a.call('remTag', id, 'k') // A cites the observed token t0
    await b.call('addTag', id, 'k') // B mints a NEW token, unseen by A
    // a remove citing a never-observed (fabricated) token — must not affect
    // the live value and must audit exactly once to staletag
    const bogus = a.info.localKey + 'ff'
    await a.append('rem-tag', { id, value: 'k', tags: [bogus] })
    await ctl.connect(a, b) // heal
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
