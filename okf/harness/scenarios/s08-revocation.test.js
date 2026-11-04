// S8 (I10): an indexer removes C while C has unreplicated ops behind a
// partition. Those ops are concurrent with the removal, so which ones land
// depends on the linearization alone (SPEC §8). The test asserts
// convergence and one applied/rejected partition on every peer, not that
// every late op rejects. Do not weaken this to pass.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupVaultCluster, assertAllCoherent, replayHash } from './helpers.js'

/** C's landed tag tokens (seq suffixes) and its flag/rejected reasons. */
function partitionOfC(dump, id, cHex) {
  const rec = dump[`c/${id}/f/tags`] || { els: {} }
  const landed = Object.keys(rec.els).filter((t) => t.startsWith(cHex)).map((t) => t.slice(cHex.length)).sort()
  const rejected = {}
  for (const [k, v] of Object.entries(dump)) {
    if (k.startsWith(`flag/rejected/${cHex}/`)) rejected[k.split('/').pop()] = v.reason
  }
  return { landed, rejected }
}

test('S8: revocation race — every peer agrees which of C’s partitioned ops landed; converge', async () => {
  const { ctl, writers } = await setupVaultCluster('s08-revocation', 3)
  const [w0, w1, c] = writers // w0 genesis indexer, w1 plain, c the target
  const cHex = c.info.localKey // localKey is already hex
  try {
    const { tag: id } = await w0.call('createConcept', 'gov/doc', 'note')
    await c.call('addTag', id, 'c-pre') // C seq 0, observed by everyone
    await ctl.quiesce(writers)

    await ctl.partition([w0, w1], [c])
    await c.call('addTag', id, 'c-late1')
    await c.call('addTag', id, 'c-late2')
    // w0 observed C through seq 0 only, so seqAtRemoval is 0
    await w0.call('removeWriter', cHex)
    await ctl.connectAll(writers)
    const hash = await ctl.quiesce(writers)

    let ref = null
    for (const w of writers) {
      const dump = await w.dump('')
      assert.ok(dump[`gov/removed/${cHex}`], `${w.name}: revocation recorded`)
      const part = partitionOfC(dump, id, cHex)
      for (const r of Object.values(part.rejected)) assert.equal(r, 'revoked', `${w.name}: only 'revoked'`)
      // C's ops never reach gov/
      assert.equal(dump[`gov/writer/${cHex}`] && dump[`gov/writer/${cHex}`].indexer, false)
      const sig = JSON.stringify(part)
      if (ref === null) ref = sig
      else assert.equal(sig, ref, `${w.name}: replay-stable applied/rejected partition`)
    }
    assert.ok(JSON.parse(ref).landed.includes('0'), 'the pre-revocation op landed')
    await assertAllCoherent(writers)

    // C folded its own revocation, so its store refuses the append
    await assert.rejects(() => c.call('addTag', id, 'after-revoke'), /VAULT_REVOKED|revoked/)

    assert.equal(await replayHash(ctl, writers, 's08'), hash, 'revocation outcome is replay-stable')
  } finally {
    await ctl.stop()
  }
})
