// I10 Governance (okf SPEC §8, §11): revoked-writer ops after the causal
// revocation point, unauthorized governance ops, and policy-violating ops
// never mutate c/; the applied/rejected partition is replay-stable.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Env, writerKey, hostStub, keysUnder, rejectedReasons } from './helpers.js'
import { MemView } from '../core/index.js'

test('I10: governance requires an indexer issuer; host.addWriter never called for it', async () => {
  const env = new Env({ genesis: 'A' })
  env.op('A', 'add-writer', { key: writerKey('B'), indexer: false }) // B: plain writer
  env.op('B', 'add-writer', { key: writerKey('E'), indexer: true }) // unauthorized
  const host = hostStub()
  const view = await env.run(env.nodes, { host })
  assert.ok(Object.values(rejectedReasons(view)).includes('policy-governance'))
  assert.equal((await view.get('gov/writer/' + env.hex('E'))), null, 'E never admitted')
  const added = host.calls.filter(([m]) => m === 'addWriter').map(([, k]) => k)
  assert.deepEqual(added, [env.hex('B')], 'host.addWriter only for the authorized op')
  // §8: explicit uniform weight, never autobee defaults
  assert.deepEqual(host.calls.find(([m]) => m === 'addWriter')[2], { isIndexer: false, weight: 1 })
})

test('I10: causal revocation — in-flight ops with strictly-preceding clocks land, later ops reject', async () => {
  const env = new Env({ genesis: 'A' })
  env.op('A', 'add-writer', { key: writerKey('C'), indexer: false })
  env.op('A', 'create-concept', { path: 'g/doc', type: 'note' })
  const id = env.tag('A', 1)
  env.op('C', 'add-tag', { id, value: 'seen-by-a' }) // C seq 0, observed by A
  const preRemoval = env.observedAll()
  // A removes C having observed C through seq 0
  const removal = env.op('A', 'remove-writer', { key: writerKey('C') })
  // in-flight: C's op at seq 1 > seqAtRemoval(0) → rejected regardless of clock
  const late = env.op('C', 'add-tag', { id, value: 'too-late' }, { clock: preRemoval })
  const view = await env.run()
  const reasons = rejectedReasons(view)
  assert.equal(reasons[env.hex('C') + '/000000000001'], 'revoked')
  const tags = Object.values(view.dump(`c/${id}/f/tags`)[`c/${id}/f/tags`].els)
  assert.deepEqual(tags, ['seen-by-a'], 'pre-revocation op landed; post-revocation never mutated c/')
  void removal
  void late
})

test('I10: revocation race — an in-flight op (seq ≤ seqAtRemoval, preceding clock) lands even when it linearizes after the removal', async () => {
  const env = new Env({ genesis: 'A' })
  env.op('A', 'add-writer', { key: writerKey('C'), indexer: false })
  env.op('A', 'create-concept', { path: 'g/race', type: 'note' })
  const id = env.tag('A', 1)
  const [aw, cr] = env.nodes
  const c0 = env.op('C', 'add-tag', { id, value: 'c0' }) // C seq 0
  const c1 = env.op('C', 'add-tag', { id, value: 'c1-in-flight' }) // C seq 1
  // A observed C through seq 1 when it issued the removal…
  const removal = env.op('A', 'remove-writer', { key: writerKey('C') })
  // …but on this peer c1 linearizes AFTER the removal (partition heal);
  // per-writer order (c0 before c1) is preserved.
  const view = await env.run([aw, cr, c0, removal, c1])
  const tags = Object.values(view.dump(`c/${id}/f/tags`)[`c/${id}/f/tags`].els).sort()
  assert.deepEqual(tags, ['c0', 'c1-in-flight'], 'the §8 bounded window admits the in-flight op')
  assert.deepEqual(rejectedReasons(view), {}, 'nothing rejected')
})

test('I10: seq cross-check — a backdated clock cannot smuggle an op past seqAtRemoval', async () => {
  const env = new Env({ genesis: 'A' })
  env.op('A', 'add-writer', { key: writerKey('C'), indexer: false })
  env.op('A', 'create-concept', { path: 'g/x', type: 'note' })
  const id = env.tag('A', 1)
  env.op('C', 'add-tag', { id, value: 't0' }) // seq 0
  env.op('A', 'remove-writer', { key: writerKey('C') }) // seqAtRemoval = 0
  // C forges an op claiming a pre-removal view of the world, but its
  // actual position is seq 1 — the §8 unforgeable-position rule rejects it
  // even though the claimed clock strictly precedes the revocation clock.
  env.op('C', 'add-tag', { id, value: 'forged' }, {
    clock: [[env.hex('C'), 1]],
    verbatimClock: true
  })
  const view = await env.run()
  assert.equal(rejectedReasons(view)[env.hex('C') + '/000000000001'], 'revoked')
})

test('I10: forged self-clock entries are rejected on every op', async () => {
  const env = new Env({ genesis: 'A' })
  env.op('A', 'create-concept', { path: 'g/f', type: 'note' }, {
    clock: [[env.hex('A'), 7]], // actual seq is 0
    verbatimClock: true
  })
  env.op('A', 'create-concept', { path: 'g/f2', type: 'note' }, {
    clock: null,
    verbatimClock: true // missing clock entirely
  })
  const view = await env.run()
  const reasons = Object.values(rejectedReasons(view))
  assert.deepEqual(reasons, ['forged-clock', 'forged-clock'])
  assert.equal(keysUnder(view, 'c/').length, 0)
})

test('I10: a RemoveWriter that would leave zero indexers is rejected', async () => {
  const env = new Env({ genesis: 'A' })
  env.op('A', 'remove-writer', { key: writerKey('A') }) // sole indexer removes self
  const view = await env.run()
  assert.deepEqual(Object.values(rejectedReasons(view)), ['policy-governance'])
  assert.equal((await view.get('gov/removed/' + env.hex('A'))), null)

  // with a second indexer admitted, the same removal is legal
  env.op('A', 'add-writer', { key: writerKey('B'), indexer: true })
  env.op('A', 'remove-writer', { key: writerKey('A') })
  const view2 = await env.run()
  assert.notEqual((await view2.get('gov/removed/' + env.hex('A'))), null)
})

test('I10: namespace policy rejects out-of-prefix writes against the CURRENT path', async () => {
  const env = new Env({ genesis: 'A' })
  env.op('A', 'add-writer', { key: writerKey('B'), indexer: false })
  env.op('A', 'set-writer-policy', { key: writerKey('B'), namespacePrefixes: ['team'], rateCeiling: 100 })
  env.op('A', 'create-concept', { path: 'team/doc', type: 'note' })
  const inScope = env.tag('A', 2)
  env.op('A', 'create-concept', { path: 'private/doc', type: 'note' })
  const outScope = env.tag('A', 3)
  env.op('B', 'add-tag', { id: inScope, value: 'ok' }) // in scope
  env.op('B', 'add-tag', { id: outScope, value: 'nope' }) // out of scope
  env.op('B', 'create-concept', { path: 'elsewhere/new', type: 'note' }) // create checks claimed path
  const view = await env.run()
  const reasons = rejectedReasons(view)
  assert.equal(reasons[env.hex('B') + '/000000000001'], 'policy-namespace')
  assert.equal(reasons[env.hex('B') + '/000000000002'], 'policy-namespace')
  assert.deepEqual(Object.values(view.dump(`c/${inScope}/f/tags`)[`c/${inScope}/f/tags`].els), ['ok'])
  assert.equal(view.dump(`c/${outScope}/f/tags`)[`c/${outScope}/f/tags`], undefined)
})

test('I10: the applied/rejected partition is replay-stable', async () => {
  const env = new Env({ genesis: 'A' })
  env.op('A', 'add-writer', { key: writerKey('C'), indexer: false })
  env.op('A', 'create-concept', { path: 'r/doc', type: 'note' })
  const id = env.tag('A', 1)
  env.op('C', 'add-tag', { id, value: 'pre' })
  env.op('A', 'remove-writer', { key: writerKey('C') })
  env.op('C', 'add-tag', { id, value: 'post' })
  env.raw('C', Buffer.from('junk'))
  const v1 = await env.run(env.nodes, { view: new MemView() })
  const v2 = await env.run(env.nodes, { view: new MemView(), chunk: 2 })
  assert.equal(v1.hash(), v2.hash())
  assert.deepEqual(rejectedReasons(v1), rejectedReasons(v2))
})

test('I10: optimistic holds fold on ack, in seq order, with host.ackWriter called', async () => {
  const env = new Env({ genesis: 'A' })
  // D is unadmitted: its content ops hold, never touching c/
  env.op('D', 'create-concept', { path: 'opt/doc', type: 'note' })
  const dId = env.tag('D', 0)
  env.op('D', 'set-body', { id: dId, base: null, text: 'held body' })
  const host = hostStub()
  const mid = await env.run(env.nodes, { host })
  assert.equal(keysUnder(mid, 'c/').length, 0, 'unacked ops never mutate c/')
  assert.equal(keysUnder(mid, 'hold/' + env.hex('D') + '/').length, 2)

  // the indexer's AddWriter is the ack: holds fold at its position
  env.op('A', 'add-writer', { key: writerKey('D'), indexer: false })
  const view = await env.run(env.nodes, { host })
  assert.equal(keysUnder(view, 'hold/').length, 0, 'holds consumed')
  assert.equal(view.dump(`c/${dId}/meta`)[`c/${dId}/meta`].type, 'note')
  assert.notEqual(view.dump(`c/${dId}/body`)[`c/${dId}/body`], undefined)
  assert.ok(host.calls.some(([m, k]) => m === 'ackWriter' && k === env.hex('D')))
})

test('I10: a held op that fails at fold time writes flag/optimistic (permanent)', async () => {
  const env = new Env({ genesis: 'A' })
  env.op('A', 'create-concept', { path: 'opt/taken', type: 'note' })
  const existing = env.tag('A', 0)
  // D (unacked) adopts an id that already exists → folds into duplicate-id
  env.op('D', 'create-concept', { id: existing, path: 'opt/other', type: 'note' })
  env.op('A', 'add-writer', { key: writerKey('D'), indexer: false })
  const view = await env.run()
  const flags = view.dump('flag/optimistic/' + env.hex('D') + '/')
  assert.deepEqual(Object.values(flags), [{ reason: 'duplicate-id' }])
})

test('I10: RemoveWriter of an unacked writer drops holds unfolded', async () => {
  const env = new Env({ genesis: 'A' })
  env.op('D', 'create-concept', { path: 'opt/never', type: 'note' })
  env.op('A', 'remove-writer', { key: writerKey('D') })
  env.op('A', 'add-writer', { key: writerKey('D'), indexer: false }) // re-admission
  const view = await env.run()
  assert.equal(keysUnder(view, 'hold/').length, 0)
  assert.equal(keysUnder(view, 'c/').length, 0, 'dropped holds never fold')
})

test('I10: hold overflow rejects at H_max; unacked rate ceiling caps holds', async () => {
  const env = new Env({ genesis: 'A', config: { rate: { holdMax: 2 } } })
  env.op('D', 'create-concept', { path: 'h/1', type: 'note' })
  env.op('D', 'create-concept', { path: 'h/2', type: 'note' })
  env.op('D', 'create-concept', { path: 'h/3', type: 'note' }) // 513th-equivalent
  const view = await env.run()
  assert.equal(keysUnder(view, 'hold/').length, 2)
  assert.deepEqual(Object.values(rejectedReasons(view)), ['hold-overflow'])

  const env2 = new Env({ genesis: 'A', config: { rate: { unackedCeiling: 1 } } })
  env2.op('D', 'create-concept', { path: 'h/1', type: 'note' })
  env2.op('D', 'create-concept', { path: 'h/2', type: 'note' }) // bucket empty
  const view2 = await env2.run()
  assert.deepEqual(Object.values(rejectedReasons(view2)), ['policy-rate'])
})

test('I10: token buckets refill from accepted indexer ops', async () => {
  const env = new Env({ genesis: 'A' })
  env.op('A', 'add-writer', { key: writerKey('B'), indexer: false })
  env.op('A', 'set-writer-policy', { key: writerKey('B'), namespacePrefixes: [], rateCeiling: 2 })
  env.op('A', 'create-concept', { path: 'rate/doc', type: 'note' })
  const id = env.tag('A', 2)
  env.op('B', 'add-tag', { id, value: 't1' }) // token 1 (bucket refilled to cap by A's create)
  env.op('B', 'add-tag', { id, value: 't2' }) // token 2
  env.op('B', 'add-tag', { id, value: 't3' }) // empty → policy-rate
  env.op('A', 'add-tag', { id, value: 'indexer-op' }) // indexer op → +1 token for everyone
  env.op('B', 'add-tag', { id, value: 't4' }) // accepted again
  const view = await env.run()
  const reasons = rejectedReasons(view)
  assert.equal(reasons[env.hex('B') + '/000000000002'], 'policy-rate')
  const tags = Object.values(view.dump(`c/${id}/f/tags`)[`c/${id}/f/tags`].els).sort()
  assert.deepEqual(tags, ['indexer-op', 't1', 't2', 't4'])
})
