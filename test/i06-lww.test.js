// I6: LWW law — outcome depends only on linearized order (§12, §5.1).
import test from 'node:test'
import assert from 'node:assert/strict'
import { run, n, addWriters, defineLwwTerm, K, GEN, W1, W2, makeTag } from './helpers.js'

test('I6: last in linearized order wins, independent of apply batching', async () => {
  const nodes = [
    ...addWriters([W1, false], [W2, false]),
    defineLwwTerm('title'),
    n(W1, 'set-field', { s: 'A', p: 'title', o: 'from-w1', tag: makeTag(W1, 1) }),
    n(W2, 'set-field', { s: 'A', p: 'title', o: 'from-w2', tag: makeTag(W2, 1) })
  ]
  for (const batches of [undefined, [1, 1, 1, 1, 1], [4, 1]]) {
    const { view } = await run(nodes, { batches })
    const rec = (await view.get(K.nField('A', 'title'))).value
    assert.deepEqual(rec.reg.values, ['from-w2'])
  }
})

test('I6: an lww register value is a canonical array; whole array supersedes atomically (§5.1)', async () => {
  const { view } = await run([
    defineLwwTerm('domain'),
    n(GEN, 'set-field', { s: 'P', p: 'domain', o: ['Zebra', 'Apple', 'Apple'], tag: makeTag(GEN, 1) })
  ])
  const rec = (await view.get(K.nField('P', 'domain'))).value
  assert.deepEqual(rec.reg.values, ['Apple', 'Zebra']) // sorted by §10.2 byte form, deduped

  const { view: v2 } = await run([
    defineLwwTerm('domain'),
    n(GEN, 'set-field', { s: 'P', p: 'domain', o: ['Zebra', 'Apple'], tag: makeTag(GEN, 1) }),
    n(GEN, 'set-field', { s: 'P', p: 'domain', o: 'Solo', tag: makeTag(GEN, 2) })
  ])
  const rec2 = (await v2.get(K.nField('P', 'domain'))).value
  assert.deepEqual(rec2.reg.values, ['Solo']) // no per-element merge on lww terms
})

test('I6: UnsetField clears the register; cross-writer removal is flagged (§5.2/§5.4)', async () => {
  const t = makeTag(W2, 1)
  const { view } = await run([
    ...addWriters([W1, false], [W2, false]),
    defineLwwTerm('title'),
    n(W1, 'set-field', { s: 'A', p: 'title', o: 'val', tag: makeTag(W1, 1) }),
    n(W2, 'unset-field', { s: 'A', p: 'title', tag: t })
  ])
  assert.equal(await view.get(K.nField('A', 'title')), null)
  assert.ok(await view.get(K.flag('clobber', 'A', 'title', t.toString('hex'))))
})
