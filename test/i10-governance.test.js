// I10: governance — §8.0 authority, §8.2 optimistic gating, §8.3 causal
// revocation with triple-replay partition stability, §8.5 rate ceilings,
// §8.6 namespace policy.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  run,
  n,
  addWriters,
  defineLwwTerm,
  partition,
  stubHost,
  K,
  GEN,
  W1,
  W2,
  W3,
  makeTag,
  hex
} from './helpers.js'
import { MemView, createApply } from '../packages/core/index.js'

test('I10/§8.0: a non-indexer AddWriter{indexer:true} never reaches host.addWriter and never mutates ctx/gov', async () => {
  const { view, host } = await run([
    ...addWriters([W1, false]), // W1 is a confirmed NON-indexer
    n(W1, 'add-writer', { key: W2, indexer: true }) // puppet-key capture attempt
  ])
  // host.addWriter was called exactly once — for GEN's admission of W1
  assert.deepEqual(host.added.map(([k]) => k), [hex(W1)])
  assert.equal(await view.get(K.govWriter(hex(W2))), null)
  const reasons = Object.values(view.dump('flag/rejected/')).map((r) => r.reason)
  assert.deepEqual(reasons, ['policy-governance'])
})

test('I10/§8.6: an agent op outside its namespace never mutates n/', async () => {
  const nodes = [
    ...addWriters([W1, false]),
    defineLwwTerm('title'),
    n(GEN, 'set-writer-policy', { key: W1, namespacePrefixes: ['agents/alice'], rateCeiling: 100 }),
    n(W1, 'set-field', { s: 'agents/alice/notes', p: 'title', o: 'ok', tag: makeTag(W1, 1) }),
    n(W1, 'set-field', { s: 'agents/alicecooper', p: 'title', o: 'nope', tag: makeTag(W1, 2) }),
    n(W1, 'set-field', { s: 'Elsewhere', p: 'title', o: 'nope', tag: makeTag(W1, 3) })
  ]
  const { view } = await run(nodes)
  assert.ok(await view.get(K.nField('agents/alice/notes', 'title')))
  // byte-prefix matching is forbidden (§8.6): alicecooper does NOT match alice
  assert.equal(await view.get(K.nField('agents/alicecooper', 'title')), null)
  assert.equal(await view.get(K.nField('Elsewhere', 'title')), null)
  const reasons = Object.values(view.dump('flag/rejected/')).map((r) => r.reason)
  assert.deepEqual(reasons, ['policy-namespace', 'policy-namespace'])
})

test('I10/§8.3: revocation is causal (clock-based), not positional', async () => {
  const g = hex(GEN)
  const w = hex(W1)
  const nodes = [
    ...addWriters([W1, false]),
    defineLwwTerm('title'),
    n(W1, 'set-field', { s: 'A', p: 'title', o: 'pre', tag: makeTag(W1, 1), clock: [[w, 1]] }),
    // GEN revokes W1 having observed W1 through seq 2
    n(GEN, 'remove-writer', { key: W1, clock: [[w, 2], [g, 3]] }),
    // causally BELOW the revocation clock → accepted
    n(W1, 'set-field', { s: 'A', p: 'title', o: 'below', tag: makeTag(W1, 2), clock: [[w, 2]] }),
    // NOT causally below → rejected 'revoked'
    n(W1, 'set-field', { s: 'A', p: 'title', o: 'after', tag: makeTag(W1, 3), clock: [[w, 3]] }),
    // missing clock once revoked → rejected 'revoked' (§8.3)
    n(W1, 'set-field', { s: 'A', p: 'title', o: 'noclock', tag: makeTag(W1, 4) })
  ]
  const { view } = await run(nodes)
  const rec = (await view.get(K.nField('A', 'title'))).value
  assert.deepEqual(rec.reg.values, ['below'])
  const reasons = Object.values(view.dump('flag/rejected/')).map((r) => r.reason)
  assert.deepEqual(reasons, ['revoked', 'revoked'])
})

test('I10/§8.3: triple replay — incremental, from-scratch, forced-reorg partitions identical', async () => {
  const g = hex(GEN)
  const w = hex(W1)
  const nodes = [
    ...addWriters([W1, false]),
    defineLwwTerm('title'),
    n(W1, 'set-field', { s: 'A', p: 'title', o: 'one', tag: makeTag(W1, 1), clock: [[w, 1]] }),
    n(GEN, 'remove-writer', { key: W1, clock: [[w, 1], [g, 3]] }),
    n(W1, 'set-field', { s: 'A', p: 'title', o: 'two', tag: makeTag(W1, 2), clock: [[w, 2]] }),
    n(GEN, 'set-field', { s: 'A', p: 'title', o: 'three', tag: makeTag(GEN, 5), clock: [[g, 5]] })
  ]
  // (a) incremental
  const inc = await run(nodes, { batches: Array(nodes.length).fill(1) })
  // (b) from scratch
  const scratch = await run(nodes)
  // (c) forced reorg: a peer first applied a different provisional order,
  // autobase undid the view and reapplied the final order from scratch —
  // simulate the rebuild on a fresh view after the provisional pass
  const provisional = [nodes[0], nodes[1], nodes[5], nodes[2], nodes[3], nodes[4]]
  const throwaway = new MemView()
  const apply = createApply({ genesisKey: GEN })
  await apply(provisional, throwaway, stubHost())
  const reorged = await run(nodes)

  assert.deepEqual(partition(inc.view), partition(scratch.view))
  assert.deepEqual(partition(scratch.view), partition(reorged.view))
  assert.equal(inc.view.hash(), reorged.view.hash())
})

test('I10/§8.2: unacked optimistic ops are held, folded at ack position, never early-applied', async () => {
  const preAck = [
    defineLwwTerm('title'),
    // W1 was never added: optimistic writes go to the hold buffer
    n(W1, 'set-field', { s: 'A', p: 'title', o: 'spec-1', tag: makeTag(W1, 1) }),
    n(W1, 'set-field', { s: 'B', p: 'title', o: 'spec-2', tag: makeTag(W1, 2) })
  ]
  const held = await run(preAck)
  assert.equal(await held.view.get(K.nField('A', 'title')), null) // not applied
  assert.equal(Object.keys(held.view.dump('n/hold/' + hex(W1) + '/')).length, 2)
  assert.equal(Object.keys(held.view.dump('flag/optimistic/')).length, 2)
  assert.equal(Object.keys(held.view.dump('idx/')).length, 0)

  const acked = await run([...preAck, ...addWriters([W1, false])])
  const rec = (await acked.view.get(K.nField('A', 'title'))).value
  assert.deepEqual(rec.reg.values, ['spec-1'])
  assert.equal(Object.keys(acked.view.dump('n/hold/')).length, 0)
  assert.equal(Object.keys(acked.view.dump('flag/optimistic/')).length, 0)
})

test('I10/§8.2: H_max caps the hold buffer of an unacked writer', async () => {
  const config = { rate: { holdMax: 2 } }
  const nodes = [1, 2, 3].map((i) =>
    n(W1, 'set-field', { s: 'S' + i, p: 'x', o: i, tag: makeTag(W1, i) })
  )
  const { view } = await run(nodes, { config })
  assert.equal(Object.keys(view.dump('n/hold/')).length, 2)
  const reasons = Object.values(view.dump('flag/rejected/')).map((r) => r.reason)
  assert.deepEqual(reasons, ['policy-rate'])
})

test('I10/§8.2: RemoveWriter for an unacked writer drops holds without folding', async () => {
  const { view } = await run([
    defineLwwTerm('title'),
    n(W1, 'set-field', { s: 'A', p: 'title', o: 'spec', tag: makeTag(W1, 1) }),
    n(GEN, 'remove-writer', { key: W1, clock: [[hex(GEN), 2]] })
  ])
  assert.equal(Object.keys(view.dump('n/hold/')).length, 0)
  assert.equal(Object.keys(view.dump('flag/optimistic/')).length, 0)
  assert.equal(await view.get(K.nField('A', 'title')), null) // never took effect
})

test('I10/§8.5: token bucket — default ceiling applies from the first op; indexer ops replenish', async () => {
  const config = { rate: { capacity: 2, tokensPerIndexerOp: 1 } }
  const nodes = [
    ...addWriters([W1, false]),
    n(W1, 'set-field', { s: 'A', p: 'x', o: 1, tag: makeTag(W1, 1) }),
    n(W1, 'set-field', { s: 'A', p: 'x', o: 2, tag: makeTag(W1, 2) }),
    n(W1, 'set-field', { s: 'A', p: 'x', o: 3, tag: makeTag(W1, 3) }), // bucket empty → rejected
    n(GEN, 'set-field', { s: 'B', p: 'x', o: 'g', tag: makeTag(GEN, 9) }), // accepted indexer op
    n(W1, 'set-field', { s: 'A', p: 'x', o: 4, tag: makeTag(W1, 4) }) // replenished → accepted
  ]
  const { view } = await run(nodes, { config })
  const rejected = Object.entries(view.dump('flag/rejected/'))
  assert.equal(rejected.length, 1)
  assert.equal(rejected[0][1].reason, 'policy-rate')
  assert.match(rejected[0][0], new RegExp('^flag/rejected/' + hex(W1) + '/'))
  const rec = (await view.get(K.nField('A', 'x'))).value
  assert.deepEqual(rec.un.items.map((i) => i.v).filter((v) => v === 4), [4])
})

test('I10/§8.5: SetWriterPolicy may only tighten below the default; override audited', async () => {
  const nodes = [
    ...addWriters([W1, false]),
    n(GEN, 'set-writer-policy', { key: W1, namespacePrefixes: [], rateCeiling: 999999 }),
    n(GEN, 'set-writer-policy', { key: W1, namespacePrefixes: ['a'], rateCeiling: 5 })
  ]
  const { view } = await run(nodes)
  const rec = (await view.get(K.govWriter(hex(W1)))).value
  assert.equal(rec.rateCeiling, 5)
  assert.equal(rec.indexer, false) // indexer bit preserved (§8.6)
  assert.ok(await view.get(K.flag('govoverride', hex(W1))))
  // first policy was clamped to the default capacity (§8.5: only tighten)
  const g1 = await run(nodes.slice(0, 2))
  assert.equal((await g1.view.get(K.govWriter(hex(W1)))).value.rateCeiling, 1024)
})

test('I10/§8.6: namespace partition is stable across replay shapes', async () => {
  const nodes = [
    ...addWriters([W1, false]),
    n(GEN, 'set-writer-policy', { key: W1, namespacePrefixes: ['agents/w1'], rateCeiling: 100 }),
    n(W1, 'set-field', { s: 'agents/w1/a', p: 'x', o: 1, tag: makeTag(W1, 1) }),
    n(W1, 'set-field', { s: 'other', p: 'x', o: 2, tag: makeTag(W1, 2) }),
    n(GEN, 'set-field', { s: 'other', p: 'x', o: 3, tag: makeTag(GEN, 4) })
  ]
  const a = await run(nodes)
  const b = await run(nodes, { batches: Array(nodes.length).fill(1) })
  assert.deepEqual(partition(a.view), partition(b.view))
})

test('I10: governance ops from a writer with no record at all are rejected', async () => {
  const { view, host } = await run([n(W3, 'add-writer', { key: W2, indexer: true })])
  assert.equal(host.added.length, 0)
  const reasons = Object.values(view.dump('flag/rejected/')).map((r) => r.reason)
  assert.deepEqual(reasons, ['policy-governance'])
  assert.equal(Object.keys(view.dump('ctx/gov/writer/')).length, 1) // genesis only
})
