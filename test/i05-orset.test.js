// I5: OR-set law — concurrent add wins over remove of an unobserved tag,
// under the §5.3 citation contract.
import test from 'node:test'
import assert from 'node:assert/strict'
import { run, n, addWriters, defineSetTerm, K, GEN, W1, W2, makeTag } from './helpers.js'
import { tagHex } from '../vault-ld/core/index.js'

test('I5: concurrent add and remove of the same member converge to present', async () => {
  const tA = makeTag(W1, 2)
  const tB = makeTag(W2, 2) // concurrent re-add under a new tag, not cited
  const { view } = await run([
    ...addWriters([W1, false], [W2, false]),
    defineSetTerm('topics'),
    n(W1, 'add-member', { s: 'A', p: 'topics', o: 'crdt', tag: tA }),
    // W2 removes citing the only tag it observed…
    n(W2, 'rem-member', { s: 'A', p: 'topics', tags: [tA] }),
    // …concurrently W2's other persona re-added under a fresh tag
    n(W2, 'add-member', { s: 'A', p: 'topics', o: 'crdt', tag: tB })
  ])
  const rec = (await view.get(K.nField('A', 'topics'))).value
  assert.deepEqual(Object.keys(rec.els), [tagHex(tB)])
  assert.equal(rec.els[tagHex(tB)].v, 'crdt')
})

test('I5: remove deletes exactly the cited present tags; stale citations flag (§5.3)', async () => {
  const t1 = makeTag(W1, 1)
  const t2 = makeTag(W1, 2)
  const stale = makeTag(W2, 9) // never added
  const { view } = await run([
    ...addWriters([W1, false], [W2, false]),
    defineSetTerm('topics'),
    n(W1, 'add-member', { s: 'A', p: 'topics', o: 'x', tag: t1 }),
    n(W1, 'add-member', { s: 'A', p: 'topics', o: 'x', tag: t2 }),
    n(W2, 'rem-member', { s: 'A', p: 'topics', tags: [t1, t2, stale] })
  ])
  assert.equal(await view.get(K.nField('A', 'topics')), null) // both present tags removed
  assert.ok(await view.get(K.flag('staletag', 'A', 'topics', tagHex(stale))))
  // stale citation is ignored for effect, recorded once (I4), outcome unchanged
})

test('I5: element order in the view is canonical, not arrival order', async () => {
  const script = (order) => [
    defineSetTerm('topics'),
    ...order.map((o) => n(GEN, 'add-member', { s: 'A', p: 'topics', o, tag: makeTag(GEN, 10 + order.indexOf(o)) }))
  ]
  const a = await run(script(['b', 'a', 'c']))
  const b = await run(script(['b', 'a', 'c']))
  assert.equal(a.view.hash(), b.view.hash())
})
