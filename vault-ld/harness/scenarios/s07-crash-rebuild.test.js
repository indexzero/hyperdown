// S7 (I3) crash and rebuild. SIGKILL a peer mid-apply under sustained
// write load; restart it; its recovered view hash must match the others.
// Separately: a view rebuilt from scratch from the log (fresh peer) must
// equal the incrementally built one, key by key.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupVaultCluster } from '../lib/setup.js'
import { sleep } from '../lib/controller.js'

test('S7: SIGKILL mid-apply, restart, rebuild-from-scratch equality (I3)', async (t) => {
  const { ctl, writers } = await setupVaultCluster('s07', 3)
  t.after(() => ctl.stop())
  const [a, b, c] = writers

  await a.call('defineTerm', 'core', 'title', { '@id': 'ex:title' })
  await a.call('defineTerm', 'core', 'link', { '@id': 'ex:link', '@container': '@set' })
  await ctl.quiesce(writers)

  // sustained load from two writers while c applies incoming ops
  const load = (async () => {
    for (let i = 0; i < 120; i++) {
      await a.call('setField', `Note${i % 20}`, 'title', `title-a-${i}`)
      await b.call('addMember', `Note${i % 20}`, 'link', { ref: `Note${(i + 1) % 20}` })
    }
  })()

  await sleep(700) // let c be mid-apply under load
  await c.crash() // SIGKILL, no cleanup
  ctl.purgeLinks(c)
  await load

  await c.restart()
  await ctl.connectAll(writers)
  const hash = await ctl.quiesce(writers)
  assert.ok(hash, 'crashed peer recovers to the common hash')

  // rebuild from scratch: a fresh peer replays the whole log
  const fresh = await ctl.spawn('fresh')
  await fresh.join(a.info.keyHex)
  await ctl.connect(fresh, a)
  await ctl.connect(fresh, b)
  const hash2 = await ctl.quiesce([...writers, fresh])
  assert.equal(hash2, hash, 'from-scratch rebuild equals the incremental views')

  // key-by-key diff between the restarted (incremental + recovered) view
  // and the from-scratch view
  const diffs = await ctl.diffViews(c, fresh)
  assert.deepEqual(diffs, [], `rebuild diff must be empty (seed=${ctl.seed})`)
})
