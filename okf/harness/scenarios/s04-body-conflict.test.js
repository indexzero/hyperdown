// S4 — body conflict. A and B SetBody the same base concurrently behind a
// partition; on heal both revisions are retained, the head is deterministic,
// and exactly one flag/conflict is open on every peer (I4/I7). A subsequent
// ResolveConflict drains it on every peer.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupVaultCluster, flagKeys, assertAllCoherent } from './helpers.js'

test('S4: same-base siblings both survive under one conflict flag; resolve drains it', async () => {
  const { ctl, writers } = await setupVaultCluster('s04-body', 2)
  const [a, b] = writers
  try {
    const { tag: id } = await a.call('createConcept', 'notes/doc', 'note')
    await a.append('set-body', { id, base: null, text: 'root' })
    await ctl.quiesce(writers)
    const base = (await a.dump(`c/${id}/`))[`c/${id}/body`] // shared head r0

    await ctl.disconnect(a, b) // partition
    await a.append('set-body', { id, base, text: 'edit A' })
    await b.append('set-body', { id, base, text: 'edit B' })
    await ctl.connect(a, b) // heal
    await ctl.quiesce(writers)

    let head = null
    for (const w of writers) {
      const dump = await w.dump('')
      assert.equal(Object.keys(dump).filter((k) => k.startsWith(`c/${id}/rev/`)).length, 3, `${w.name}: both siblings + root retained`)
      assert.equal(flagKeys(dump, `conflict/${id}`).length, 1, `${w.name}: exactly one conflict`)
      const h = dump[`c/${id}/body`]
      if (head === null) head = h
      else assert.equal(h, head, 'head is deterministic across peers')
    }
    await assertAllCoherent(writers)

    // resolve on A: keep the deterministic head, supersede the sibling
    const dump = await a.dump('')
    const revs = Object.keys(dump).filter((k) => k.startsWith(`c/${id}/rev/`)).map((k) => k.split('/').pop())
    const root = revs.find((r) => dump[`c/${id}/rev/${r}`].base === null)
    const sibling = revs.find((r) => r !== head && r !== root)
    await a.call('resolveConflict', id, head, { supersede: [sibling] })
    await ctl.quiesce(writers)
    for (const w of writers) {
      const d = await w.dump('')
      assert.equal(flagKeys(d, `conflict/${id}`).length, 0, `${w.name}: conflict drained`)
      assert.equal(d[`c/${id}/body`], head, `${w.name}: kept head`)
    }
    await assertAllCoherent(writers)
  } finally {
    await ctl.stop()
  }
})
