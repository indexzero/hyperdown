// S8 (I10) — revocation race. This is exactly where the vault-ld harness
// found its blocker: positional teardown (host.removeWriter) DIVERGED under a
// partition. auto-okf's revocation is causal, in-band, never positional
// (host.removeWriter is never called; every node keeps linearizing so the §8
// clock+seq rule runs uniformly on every peer). Attack it hard:
//
//   an indexer removes C while C has UNREPLICATED ops behind a partition; heal.
//
// The real I10 guarantee is not "every late op rejects" — C's partitioned ops
// are CONCURRENT with the removal, so whether a given one lands depends only
// on the (deterministic) linearization: an op that linearizes before the
// removal has no gov/removed to check yet and applies; the seqAtRemoval
// cross-check rejects only ops linearizing after it. What MUST hold on every
// peer is: convergence (the vault-ld blocker was DIVERGENCE here), an
// IDENTICAL applied/rejected partition of C's ops (replay-stable), and that C
// can author no further ops once it has folded its own revocation. A divergent
// view hash under any seed is a BLOCKER — do not weaken this to pass.
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
  const cHex = c.info.localKey // writer info().localKey is already a hex string
  try {
    const { tag: id } = await w0.call('createConcept', 'gov/doc', 'note')
    await c.call('addTag', id, 'c-pre') // C seq 0, observed by everyone
    await ctl.quiesce(writers)

    // partition C away from the governed side; C keeps writing (unreplicated)
    await ctl.partition([w0, w1], [c])
    await c.call('addTag', id, 'c-late1')
    await c.call('addTag', id, 'c-late2')
    // meanwhile the indexer revokes C, having observed it only through seq 0
    await w0.call('removeWriter', cHex)
    await ctl.connectAll(writers) // heal
    const hash = await ctl.quiesce(writers) // convergence: the anti-DIVERGENCE check

    // the applied/rejected partition of C's ops is IDENTICAL on every peer
    let ref = null
    for (const w of writers) {
      const dump = await w.dump('')
      assert.ok(dump[`gov/removed/${cHex}`], `${w.name}: revocation recorded`)
      const part = partitionOfC(dump, id, cHex)
      // whatever DID reject rejected for the §8 causal reason, nothing else
      for (const r of Object.values(part.rejected)) assert.equal(r, 'revoked', `${w.name}: only 'revoked'`)
      // C ops mutate ONLY c/ tags (the concept) or flag/ — never governance
      assert.equal(dump[`gov/writer/${cHex}`] && dump[`gov/writer/${cHex}`].indexer, false)
      const sig = JSON.stringify(part)
      if (ref === null) ref = sig
      else assert.equal(sig, ref, `${w.name}: replay-stable applied/rejected partition`)
    }
    // c-pre (seq 0, pre-revocation) always survives
    assert.ok(JSON.parse(ref).landed.includes('0'), 'the pre-revocation op landed')
    await assertAllCoherent(writers)

    // once C has folded its own revocation it can author no further ops
    await assert.rejects(() => c.call('addTag', id, 'after-revoke'), /VAULT_REVOKED|revoked/)

    // permutation replay: the outcome is a pure function of the linearized log
    assert.equal(await replayHash(ctl, writers, 's08'), hash, 'revocation outcome is replay-stable')
  } finally {
    await ctl.stop()
  }
})
