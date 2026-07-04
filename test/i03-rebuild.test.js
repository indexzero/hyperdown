// I3: a view rebuilt from scratch from the same log equals the incrementally
// maintained view (§12).
import test from 'node:test'
import assert from 'node:assert/strict'
import { run, n, addWriters, defineSetTerm, defineLwwTerm, GEN, W1, W2, makeTag } from './helpers.js'

test('I3: incremental view equals from-scratch rebuild', async () => {
  const nodes = [
    ...addWriters([W1, false], [W2, true]),
    defineLwwTerm('status'),
    defineSetTerm('links'),
    n(W1, 'set-field', { s: 'Page', p: 'status', o: 'draft', tag: makeTag(W1, 1) }),
    n(W1, 'add-member', { s: 'Page', p: 'links', o: { ref: 'Missing' }, tag: makeTag(W1, 2) }),
    n(W2, 'set-field', { s: 'Page', p: 'status', o: 'live', tag: makeTag(W2, 1) }),
    n(W2, 'delete-subject', { s: 'Page', tag: makeTag(W2, 2) }),
    n(W1, 'set-field', { s: 'Page', p: 'status', o: 'undead', tag: makeTag(W1, 3) }),
    n(GEN, 'define-term', { scope: 'alt', term: 'status', def: { '@id': 'ex:status2', '@container': '@set' } })
  ]
  const incremental = await run(nodes, { batches: Array(nodes.length).fill(1) })
  const scratch = await run(nodes)
  assert.equal(incremental.view.hash(), scratch.view.hash())
})
