// S2 (I5) OR-set add/remove race. B removes member M citing the tags it
// observed; concurrently C adds M again. Heal: M MUST be present on every
// peer (add wins over remove of an unobserved tag). Also: a remove citing
// a tag that never replicated to the applying peer (adversarial citation)
// must stay deterministic and convergent.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupVaultCluster } from '../lib/setup.js'

test('S2: concurrent add wins over remove of unobserved tag (I5)', async (t) => {
  const { ctl, writers } = await setupVaultCluster('s02', 3)
  t.after(() => ctl.stop())
  const [a, b, c] = writers

  await a.call('defineTerm', 'core', 'topic', { '@id': 'ex:topic', '@container': '@set' })
  await b.call('addMember', 'Home', 'topic', 'm')
  await ctl.quiesce(writers)

  // race by construction: B removes m (citing the tag it observed), C
  // concurrently re-adds m under a fresh tag B has never seen
  await ctl.partition([a], [b, c])
  await ctl.partition([b], [c])
  await ctl.barrier([
    () => b.call('remMember', 'Home', 'topic', 'm'),
    () => c.call('addMember', 'Home', 'topic', 'm')
  ])

  await ctl.connectAll(writers)
  const hash = await ctl.quiesce(writers)
  assert.ok(hash)

  for (const w of writers) {
    const rec = await w.val('n/Home/f/topic')
    const members = rec && rec.els ? Object.values(rec.els).map((e) => e.v) : []
    assert.deepEqual(members, ['m'], `${w.name}: m must survive the race (I5)`)
  }
})

test('S2b: remove citing a never-replicated tag is deterministic', async (t) => {
  const { ctl, writers } = await setupVaultCluster('s02b', 3)
  t.after(() => ctl.stop())
  const [a, b, c] = writers

  await a.call('defineTerm', 'core', 'topic', { '@id': 'ex:topic', '@container': '@set' })
  await ctl.quiesce(writers)

  // C adds m behind a partition; its tag never replicates to B
  await ctl.partition([a, b], [c])
  const { tag } = await c.append('add-member', { s: 'Home', p: 'topic', o: 'm' })
  assert.ok(tag)

  // B (adversarially) removes citing C's unreplicated tag — bypassing the
  // §5.3 citation contract on purpose
  await b.append('rem-member', { s: 'Home', p: 'topic', tags: [{ __hex: tag }] })

  await ctl.connectAll(writers)
  const hash = await ctl.quiesce(writers)
  assert.ok(hash)

  // outcome must be identical on every peer, and audited: either the
  // remove linearized before the add (staletag flag + member present) or
  // after (member removed) — same answer everywhere either way
  const states = new Set()
  for (const w of writers) {
    const rec = await w.val('n/Home/f/topic')
    const members = rec && rec.els ? Object.values(rec.els).map((e) => e.v) : []
    const stale = Object.keys(await w.dump('flag/staletag/')).length
    states.add(JSON.stringify({ members, stale }))
  }
  assert.equal(states.size, 1, `peers disagree: ${[...states]}`)
  const { members, stale } = JSON.parse([...states][0])
  assert.ok(
    (members.length === 1 && stale === 1) || (members.length === 0 && stale === 0),
    `unexpected outcome members=${members} stale=${stale} (no-silent-loss: removal-before-add must staletag)`
  )
})
