// I2: peers that exchanged all ops produce bit-identical views, verified by
// hashing a full range scan (§12). Peers see the SAME linearized order
// (autobase guarantees that); they differ in how apply() batches arrive.
import test from 'node:test'
import assert from 'node:assert/strict'
import { run, n, addWriters, defineSetTerm, defineLwwTerm, GEN, W1, W2, makeTag } from './helpers.js'

function script() {
  return [
    ...addWriters([W1, false], [W2, false]),
    defineSetTerm('topics'),
    defineLwwTerm('title'),
    n(W1, 'set-field', { s: 'A', p: 'title', o: 'one', tag: makeTag(W1, 1) }),
    n(W2, 'set-field', { s: 'A', p: 'title', o: 'two', tag: makeTag(W2, 1) }),
    n(W1, 'add-member', { s: 'A', p: 'topics', o: 'x', tag: makeTag(W1, 2) }),
    n(W2, 'add-member', { s: 'A', p: 'topics', o: 'y', tag: makeTag(W2, 2) }),
    n(W2, 'rem-member', { s: 'A', p: 'topics', tags: [makeTag(W1, 2)] }),
    n(W1, 'set-body', { s: 'A', base: null, text: 'hello' }),
    n(GEN, 'set-field', { s: 'B', p: 'title', o: 'bee', tag: makeTag(GEN, 9) })
  ]
}

test('I2: batching variance does not change the converged view hash', async () => {
  const whole = await run(script())
  const oneByOne = await run(script(), { batches: Array(script().length).fill(1) })
  const lumpy = await run(script(), { batches: [3, 1, 4] })
  assert.equal(whole.view.hash(), oneByOne.view.hash())
  assert.equal(whole.view.hash(), lumpy.view.hash())
  // seen/ is deterministic view state and included in the hash (§8.2)
  assert.ok(Object.keys(whole.view.dump('seen/')).length > 0)
})
