// I10 Governance (okf SPEC §8, §11): ops from a writer with no gov/writer
// record, revoked-writer ops after the causal revocation point,
// unauthorized governance ops, and policy-violating ops never mutate c/;
// the applied/rejected partition is replay-stable.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Env, writerKey, hostStub, keysUnder, rejectedReasons } from './helpers.js'
import { MemView } from '../core/index.js'

test('I10: governance requires an indexer issuer; an unauthorized AddWriter still grants at weight 0 and never admits', async () => {
  const env = new Env({ genesis: 'A' })
  env.op('A', 'add-writer', { key: writerKey('B'), indexer: false }) // B: plain writer
  env.op('B', 'add-writer', { key: writerKey('E'), indexer: true }) // unauthorized
  const host = hostStub()
  const view = await env.run(env.nodes, { host })
  assert.deepEqual(rejectedReasons(view), { [`${env.hex('B')}/000000000000`]: 'policy-governance' })
  assert.equal((await view.get('gov/writer/' + env.hex('E'))), null, 'E never admitted')
  // §8 (AD7): an autobee grant follows every AddWriter op, accepted or
  // rejected, at an explicit weight 0. okf membership comes only from gov/.
  assert.deepEqual(
    host.calls.filter(([m]) => m === 'addWriter'),
    [
      ['addWriter', env.hex('B'), { weight: 0 }],
      ['addWriter', env.hex('E'), { weight: 0 }]
    ],
    'host.addWriter for the authorized op and for the unauthorized one'
  )
})

test('I10: the AddWriter grant comes before every check that can reject the op, and only a 32-byte key is granted', async () => {
  const env = new Env({ genesis: 'A' })
  const A = env.hex('A')
  // B: a plain writer. C and F: indexers.
  env.op('A', 'add-writer', { key: writerKey('B'), indexer: false })
  env.op('A', 'add-writer', { key: writerKey('C'), indexer: true })
  env.op('A', 'add-writer', { key: writerKey('F'), indexer: true })
  env.op('A', 'set-writer-policy', { key: writerKey('F'), namespacePrefixes: [], rateCeiling: 1 })
  // policy-governance: the issuer is not an indexer
  env.op('B', 'add-writer', { key: writerKey('E1'), indexer: false })
  // policy-governance: the issuer has no gov/writer record
  env.op('D', 'add-writer', { key: writerKey('E2'), indexer: false })
  // forged-clock: the self-entry (9) is not A's actual seq (4)
  env.op('A', 'add-writer', { key: writerKey('E3'), indexer: false }, { clock: [[A, 9]], verbatimClock: true })
  // revoked: A removes C before C's first op (seqAtRemoval -1)
  env.op('A', 'remove-writer', { key: writerKey('C') }, { clock: [[A, 5]], verbatimClock: true })
  env.op('C', 'add-writer', { key: writerKey('E4'), indexer: false })
  // policy-rate: F spends its one token on a rejected op, so its bucket is empty
  env.op('F', 'set-writer-policy', { key: writerKey('nobody'), namespacePrefixes: [], rateCeiling: 1 })
  env.op('F', 'add-writer', { key: writerKey('E5'), indexer: false })
  // a key that is not 32 bytes: no grant
  env.op('A', 'add-writer', { key: Buffer.alloc(31, 7), indexer: false })
  const host = hostStub()
  const view = await env.run(env.nodes, { host })

  assert.deepEqual(rejectedReasons(view), {
    [`${env.hex('B')}/000000000000`]: 'policy-governance',
    [`${env.hex('D')}/000000000000`]: 'policy-governance',
    [`${A}/000000000004`]: 'forged-clock',
    [`${env.hex('C')}/000000000000`]: 'revoked',
    [`${env.hex('F')}/000000000000`]: 'policy-governance',
    [`${env.hex('F')}/000000000001`]: 'policy-rate'
  })
  for (const e of ['E1', 'E2', 'E3', 'E4', 'E5']) {
    assert.equal(await view.get('gov/writer/' + env.hex(e)), null, `${e} never admitted`)
  }
  // §8 (AD7): one grant per decoded AddWriter op with a 32-byte key, in
  // linearized order, whatever the op's disposition.
  assert.deepEqual(
    host.calls.filter(([m]) => m === 'addWriter'),
    ['B', 'C', 'F', 'E1', 'E2', 'E3', 'E4', 'E5'].map((w) => ['addWriter', env.hex(w), { weight: 0 }])
  )
})

test('I10: apply does not return before host.addWriter settles', async () => {
  // autobee@2's host.addWriter reads the system before it records the
  // grant (lib/system.js addWriter), and the system flush runs as soon as
  // apply returns (index.js _applyBatch), so a grant apply did not await
  // can miss the flush and be lost.
  const env = new Env({ genesis: 'A' })
  env.op('A', 'add-writer', { key: writerKey('B'), indexer: false })
  env.op('A', 'add-writer', { key: writerKey('C'), indexer: true })
  const settled = []
  const host = {
    async addWriter(key) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      settled.push(key.toString('hex'))
    }
  }
  await env.run(env.nodes, { host })
  assert.deepEqual(settled, [env.hex('B'), env.hex('C')], 'both grants settled, in order')
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

test('I10: an op from a writer with no gov/writer record is rejected not-a-writer and changes no c/ key', async () => {
  const env = new Env({ genesis: 'A' })
  env.op('A', 'create-concept', { path: 'nw/doc', type: 'note' })
  const id = env.tag('A', 0)
  env.op('A', 'set-body', { id, base: null, text: 'body from A' })
  const before = await env.run()

  // D has no gov/writer record: a mint, then each mutation op on A's
  // concept (all nine content ops)
  const D = env.hex('D')
  env.op('D', 'create-concept', { path: 'nw/from-d', type: 'note' })
  env.op('D', 'set-field', { id, key: 'status', value: ['d'] })
  env.op('D', 'add-tag', { id, value: 'from-d' })
  env.op('D', 'rem-tag', { id, value: 'from-d', tags: [env.tag('D', 2)] })
  env.op('D', 'set-body', { id, base: null, text: 'body from D' })
  env.op('D', 'set-path', { id, path: 'nw/moved-by-d' })
  env.op('D', 'delete-concept', { id })
  env.op('D', 'undelete-concept', { id })
  env.op('D', 'resolve-conflict', { id, keep: 'ab'.repeat(32), supersede: [] })
  // a governance op from D meets the indexer-issuer rule first (§8)
  env.op('D', 'add-writer', { key: writerKey('E'), indexer: true })
  const view = await env.run()

  const reasons = rejectedReasons(view)
  for (let seq = 0; seq < 9; seq++) {
    assert.equal(reasons[`${D}/${String(seq).padStart(12, '0')}`], 'not-a-writer', `D seq ${seq}`)
  }
  assert.equal(reasons[`${D}/000000000009`], 'policy-governance')
  assert.equal(Object.keys(reasons).length, 10, 'only D is rejected')
  // the content pipeline never ran: no c/ key and no index key changed
  for (const prefix of ['c/', 'path/', 'pcl/', 'link/', 'bl/', 'wanted/', 'revbybase/', 'log/']) {
    assert.deepEqual(view.dump(prefix), before.dump(prefix), `no ${prefix} key changed`)
  }
  // §3: seen/ counts every node; a rejected non-writer takes no rate token
  assert.equal(view.dump('seen/' + D)['seen/' + D], 10)
  assert.equal(keysUnder(view, 'rate/' + D).length, 0, 'no rate/ record for D')
  assert.equal(keysUnder(view, 'gov/writer/' + env.hex('E')).length, 0, 'E never admitted')
})

test('I10: admission is not retroactive: ops before the AddWriter stay rejected, ops after it take effect', async () => {
  const env = new Env({ genesis: 'A' })
  const D = env.hex('D')
  // D is unadmitted: its ops are rejected and never touch c/
  env.op('D', 'create-concept', { path: 'adm/early', type: 'note' })
  const early = env.tag('D', 0)
  env.op('D', 'set-body', { id: early, base: null, text: 'early body' })
  const host = hostStub()
  const mid = await env.run(env.nodes, { host })
  assert.equal(keysUnder(mid, 'c/').length, 0, 'ops of a non-writer never mutate c/')

  // the indexer's AddWriter admits D at its linearized position
  env.op('A', 'add-writer', { key: writerKey('D'), indexer: false })
  env.op('D', 'create-concept', { path: 'adm/late', type: 'note' })
  const late = env.tag('D', 2)
  const view = await env.run(env.nodes, { host })
  assert.deepEqual(rejectedReasons(view), {
    [`${D}/000000000000`]: 'not-a-writer',
    [`${D}/000000000001`]: 'not-a-writer'
  })
  assert.equal(view.dump(`c/${early}/meta`)[`c/${early}/meta`], undefined, 'the AddWriter revives no earlier op')
  assert.equal(view.dump(`c/${late}/meta`)[`c/${late}/meta`].type, 'note', 'an op after the admission takes effect')
  assert.equal(view.dump('path/adm%2Flate')['path/adm%2Flate'], late)
  // the substrate grant is host.addWriter; no separate substrate ack
  assert.ok(host.calls.some(([m, k]) => m === 'addWriter' && k === D))
  assert.ok(!host.calls.some(([m]) => m === 'ackWriter'))
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
