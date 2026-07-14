// S9 — epoch cycle under concurrency (I11 under the harness). Converge a
// multi-writer bundle, run one epoch cycle (materialize → fresh vault →
// ingest with _id adoption), then have a fresh peer join the NEW vault and
// converge. Assert the new peers converge to one identical view hash and that
// every live concept's _id / type / path / tags / head-body TEXT survived the
// cycle byte-for-byte (modulo _rev/log.md, which necessarily re-derive).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { setupVaultCluster } from './helpers.js'
import { until } from '../lib/controller.js'

/** Live-concept identity/state fingerprint from a full dump. */
function liveState(dump) {
  const out = new Map()
  for (const [key, value] of Object.entries(dump)) {
    if (!key.startsWith('c/') || !key.endsWith('/meta')) continue
    const id = key.split('/')[1]
    if (value.deleted != null) continue
    const path = dump[`c/${id}/path`] ? dump[`c/${id}/path`].path : null
    const bodyRev = dump[`c/${id}/body`]
    const headText = bodyRev ? dump[`c/${id}/rev/${bodyRev}`].text : null
    const typeRec = dump[`c/${id}/f/type`]
    const tagsRec = dump[`c/${id}/f/tags`]
    out.set(id, {
      type: typeRec ? typeRec.values[0] : value.type,
      path,
      headText,
      tags: tagsRec ? Object.values(tagsRec.els).sort() : []
    })
  }
  return out
}

test('S9: epoch cycle preserves _id/type/path/tags/head + new peers converge identically', async () => {
  const { ctl, writers } = await setupVaultCluster('s09-epoch', 2)
  const [w0, w1] = writers
  try {
    // build a non-trivial, conflict-free multi-writer bundle
    const { tag: home } = await w0.call('createConcept', 'wiki/home', 'page')
    await w0.call('setField', home, 'title', 'Home')
    await w0.call('addTag', home, 'root')
    await w0.append('set-body', { id: home, base: null, text: 'see [about](/wiki/about)' })
    const { tag: about } = await w1.call('createConcept', 'wiki/about', 'page')
    await w1.call('setField', about, 'title', 'About')
    await w1.append('set-body', { id: about, base: null, text: 'back [home](/wiki/home)' })
    await ctl.quiesce(writers)

    const before = liveState(await w0.dump(''))
    assert.ok(before.size >= 2)

    // one epoch cycle on w0 (tears down its links first)
    await ctl.disconnect(w0, w1)
    await w1.shutdown()
    const epoch = await w0.cmd('compact', {
      toDir: join(ctl.baseDir, 'epoch-face'),
      vaultDir: join(ctl.baseDir, 'epoch-vault')
    })

    // identity + state fidelity across the cycle
    const after = liveState(await w0.dump(''))
    for (const [id, want] of before) {
      const got = after.get(id)
      assert.ok(got, `concept ${id} survived the epoch cycle (adopted _id)`)
      assert.equal(got.type, want.type, `${id}: type preserved`)
      assert.equal(got.path, want.path, `${id}: path preserved`)
      assert.equal(got.headText, want.headText, `${id}: head body text preserved`)
      assert.deepEqual(got.tags, want.tags, `${id}: tags preserved`)
    }

    // a fresh peer joins the NEW vault (with the epoch-chain overrides) and
    // must converge to a byte-identical view
    const meta = { predecessorKey: epoch.predecessorKey, predecessorCheckpoint: epoch.predecessorCheckpoint }
    const p = await ctl.spawn('e1')
    await p.join(epoch.key, meta)
    // the fresh joiner must INITIATE the link (side 0): autobee backfills a
    // populated vault to a new peer only when the joiner pulls
    await ctl.connect(p, w0)
    await w0.call('addWriter', p.info.localKey, { indexer: false })
    const ok = await until(async () => { await p.update(); return (await p.cmd('info')).writable }, 120000)
    assert.ok(ok, 'the fresh epoch peer became writable')
    const hash = await ctl.quiesce([w0, p])
    assert.equal(typeof hash, 'string', 'new-epoch peers converge to one view hash')
  } finally {
    await ctl.stop()
  }
})
