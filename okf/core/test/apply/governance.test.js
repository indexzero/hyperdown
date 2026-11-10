// I10 (SPEC §8, §11): an op that governance rejects never changes c/, and
// the applied/rejected partition is replay-stable.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Env, writerKey, hostStub, keysUnder, rejectedReasons, rk } from '../helpers.js'
import { keyspace as K, MemView } from '../../index.js'

test('I10: governance requires an indexer issuer; an unauthorized AddWriter still grants at weight 0 and never admits', async () => {
  const env = new Env({ genesis: 'A' })
  env.op('A', 'add-writer', { key: writerKey('B'), indexer: false }) // B: plain writer
  env.op('B', 'add-writer', { key: writerKey('E'), indexer: true }) // unauthorized
  const host = hostStub()
  const view = await env.run(env.nodes, { host })
  assert.deepEqual(rejectedReasons(view), { [`${env.hex('B')}/000000000000`]: 'policy-governance' })
  assert.equal((await view.get('gov/writer/' + env.hex('E'))), null, 'E never admitted')
  // The grant rule, SPEC §8: a grant for every AddWriter, accepted or
  // rejected. Membership comes from gov/ alone.
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
  // bad-writer-key: a key that is not 32 bytes, and no grant
  env.op('A', 'add-writer', { key: Buffer.alloc(31, 7), indexer: false })
  const host = hostStub()
  const view = await env.run(env.nodes, { host })

  assert.deepEqual(rejectedReasons(view), {
    [`${env.hex('B')}/000000000000`]: 'policy-governance',
    [`${env.hex('D')}/000000000000`]: 'policy-governance',
    [`${A}/000000000004`]: 'forged-clock',
    [`${env.hex('C')}/000000000000`]: 'revoked',
    [`${env.hex('F')}/000000000000`]: 'policy-governance',
    [`${env.hex('F')}/000000000001`]: 'policy-rate',
    [`${A}/000000000006`]: 'bad-writer-key'
  })
  assert.equal(await view.get('gov/writer/' + Buffer.alloc(31, 7).toString('hex')), null, 'no record for the 31-byte key')
  for (const e of ['E1', 'E2', 'E3', 'E4', 'E5']) {
    assert.equal(await view.get('gov/writer/' + env.hex(e)), null, `${e} never admitted`)
  }
  // One grant per AddWriter with a 32-byte key, in linearized order,
  // whatever the outcome of the op (SPEC §8).
  assert.deepEqual(
    host.calls.filter(([m]) => m === 'addWriter'),
    ['B', 'C', 'F', 'E1', 'E2', 'E3', 'E4', 'E5'].map((w) => ['addWriter', env.hex(w), { weight: 0 }])
  )
})

test('I10: an AddWriter stores its 32-byte swarm key on the gov/writer record, and a later governance op without one keeps it', async () => {
  const env = new Env({ genesis: 'A' })
  const swarmB = writerKey('swarm-B')
  env.op('A', 'add-writer', { key: writerKey('B'), indexer: false, swarmKey: swarmB })
  env.op('A', 'add-writer', { key: writerKey('C'), indexer: false }) // no swarm key
  env.op('A', 'set-writer-policy', { key: writerKey('B'), namespacePrefixes: ['team'], rateCeiling: 8 })
  env.op('A', 'add-writer', { key: writerKey('B'), indexer: true }) // promotion, no swarm key
  const view = await env.run()

  assert.deepEqual(rejectedReasons(view), {})
  assert.deepEqual(await view.get('gov/writer/' + env.hex('B')).then((n) => JSON.parse(n.value)), {
    indexer: true,
    namespacePrefixes: ['team'],
    rateCeiling: 8,
    swarmKey: swarmB.toString('hex')
  })
  assert.deepEqual(
    await view.get('gov/writer/' + env.hex('C')).then((n) => JSON.parse(n.value)),
    { indexer: false, namespacePrefixes: [], rateCeiling: null },
    'a record without a swarm key has no swarmKey field'
  )
})

test('I10: an AddWriter whose swarm key is not 32 bytes is rejected bad-swarm-key, admits nobody, and still grants at weight 0', async () => {
  const env = new Env({ genesis: 'A' })
  const A = env.hex('A')
  env.op('A', 'add-writer', { key: writerKey('E1'), indexer: false, swarmKey: Buffer.alloc(31, 1) })
  env.op('A', 'add-writer', { key: writerKey('E2'), indexer: false, swarmKey: Buffer.alloc(33, 2) })
  const host = hostStub()
  const view = await env.run(env.nodes, { host })

  assert.deepEqual(rejectedReasons(view), {
    [`${A}/000000000000`]: 'bad-swarm-key',
    [`${A}/000000000001`]: 'bad-swarm-key'
  })
  for (const e of ['E1', 'E2']) {
    assert.equal(await view.get('gov/writer/' + env.hex(e)), null, `${e} never admitted`)
  }
  // The grant comes before every check (SPEC §8).
  assert.deepEqual(
    host.calls.filter(([m]) => m === 'addWriter'),
    ['E1', 'E2'].map((w) => ['addWriter', env.hex(w), { weight: 0 }])
  )
})

test('I10: an AddWriter whose key is not 32 bytes is rejected bad-writer-key, writes no gov/ key, gets no grant, and never counts as an indexer', async () => {
  // A z-base-32 id passed where a hex key belongs decodes to no bytes
  // (b4a.from(id, 'hex')). A gov/writer record for it is a phantom indexer,
  // and that phantom lets the only real indexer remove itself.
  const env = new Env({ genesis: 'A' })
  const A = env.hex('A')
  env.op('A', 'add-writer', { key: Buffer.alloc(31, 7), indexer: true })
  env.op('A', 'add-writer', { key: Buffer.alloc(33, 8), indexer: true })
  env.op('A', 'add-writer', { key: Buffer.alloc(0), indexer: true })
  env.op('A', 'remove-writer', { key: writerKey('A') }) // A is the only indexer
  const host = hostStub()
  const view = await env.run(env.nodes, { host })

  assert.deepEqual(rejectedReasons(view), {
    [`${A}/000000000000`]: 'bad-writer-key',
    [`${A}/000000000001`]: 'bad-writer-key',
    [`${A}/000000000002`]: 'bad-writer-key',
    [`${A}/000000000003`]: 'policy-governance'
  })
  assert.deepEqual(keysUnder(view, 'gov/'), [`gov/writer/${A}`], 'no gov/ key for a bad key, and A is not removed')
  assert.deepEqual(host.calls.filter(([m]) => m === 'addWriter'), [], 'no grant for a key that is not 32 bytes')
})

test('I10: apply does not return before host.addWriter settles', async () => {
  // autobee flushes its system as soon as apply returns, so a grant that
  // apply does not await can miss the flush. See DEVIATIONS.md, "Substrate
  // behaviour that okf relies on".
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
  // A observed C through seq 0, so seqAtRemoval is 0
  const removal = env.op('A', 'remove-writer', { key: writerKey('C') })
  // seq 1 is past seqAtRemoval, so the clock cannot save the op
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
  // A observed C through seq 1, so seqAtRemoval is 1
  const removal = env.op('A', 'remove-writer', { key: writerKey('C') })
  // On this peer c1 linearizes after the removal, as after a partition
  // heal. Per-writer order holds: c0 before c1.
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
  // The clock claims a view before the removal, but the position of the
  // node is seq 1. The position decides (SPEC §8).
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

test('I10: an AddWriter that would demote the last live indexer is rejected policy-governance', async () => {
  // Bundle.addWriter defaults to indexer: false, so `writers.add` of its
  // own key by the only indexer is a demotion. Without this rule the vault
  // has no indexer left and no governance.
  const env = new Env({ genesis: 'A' })
  const [A, B] = [env.hex('A'), env.hex('B')]
  env.op('A', 'add-writer', { key: writerKey('A'), indexer: false }) // A/0: the only indexer demotes itself
  env.op('A', 'add-writer', { key: writerKey('B'), indexer: true }) // A/1: A is still an indexer
  env.op('A', 'add-writer', { key: writerKey('A'), indexer: false }) // A/2: B stays, so A can step down
  env.op('B', 'add-writer', { key: writerKey('C'), indexer: true }) // B/0
  env.op('B', 'remove-writer', { key: writerKey('C') }) // B/1: C is revoked, so it is no live indexer
  env.op('B', 'add-writer', { key: writerKey('B'), indexer: false }) // B/2: B is the last live indexer
  const view = await env.run()

  assert.deepEqual(rejectedReasons(view), {
    [`${A}/000000000000`]: 'policy-governance',
    [`${B}/000000000002`]: 'policy-governance'
  })
  const rec = async (w) => JSON.parse((await view.get('gov/writer/' + env.hex(w))).value)
  assert.equal((await rec('A')).indexer, false, 'A stepped down once B was an indexer')
  assert.equal((await rec('B')).indexer, true, 'B, the last live indexer, is still one')
  assert.notEqual(await view.get('gov/removed/' + env.hex('C')), null)
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

  // D has no gov/writer record. One of each of the nine content ops.
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
  // a governance op from D meets the indexer-issuer rule first (SPEC §8)
  env.op('D', 'add-writer', { key: writerKey('E'), indexer: true })
  const view = await env.run()

  const reasons = rejectedReasons(view)
  for (let seq = 0; seq < 9; seq++) {
    assert.equal(reasons[`${D}/${String(seq).padStart(12, '0')}`], 'not-a-writer', `D seq ${seq}`)
  }
  assert.equal(reasons[`${D}/000000000009`], 'policy-governance')
  assert.equal(Object.keys(reasons).length, 10, 'only D is rejected')
  for (const prefix of ['c/', 'path/', 'pcl/', 'link/', 'bl/', 'wanted/', 'revbybase/', 'log/']) {
    assert.deepEqual(view.dump(prefix), before.dump(prefix), `no ${prefix} key changed`)
  }
  // seen/ counts every node (SPEC §3). A rejected non-writer takes no rate token.
  assert.equal(view.dump('seen/' + D)['seen/' + D], 10)
  assert.equal(keysUnder(view, 'rate/' + D).length, 0, 'no rate/ record for D')
  assert.equal(keysUnder(view, 'gov/writer/' + env.hex('E')).length, 0, 'E never admitted')
})

test('I10: admission is not retroactive: ops before the AddWriter stay rejected, ops after it take effect', async () => {
  const env = new Env({ genesis: 'A' })
  const D = env.hex('D')
  env.op('D', 'create-concept', { path: 'adm/early', type: 'note' })
  const early = env.tag('D', 0)
  env.op('D', 'set-body', { id: early, base: null, text: 'early body' })
  const host = hostStub()
  const mid = await env.run(env.nodes, { host })
  assert.equal(keysUnder(mid, 'c/').length, 0, 'ops of a non-writer never mutate c/')

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
  // The grant is host.addWriter alone. There is no ackWriter.
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

test('a revoked writer stays in the clock, because the §8 window compares every entry (I10)', async () => {
  // No clock below cites J, which has no gov/writer record. Z is revoked
  // after C cites it and before A revokes C. The op c1 of C sorts after the
  // removal of C, inside the window (seq <= seqAtRemoval). It lands only if
  // its clock strictly precedes the revocation clock, and that compare
  // needs Z in the revocation clock.
  const run = async (removalCitesZ) => {
    const env = new Env({ genesis: 'A' })
    const [A, C, J, Z] = ['A', 'C', 'J', 'Z'].map((w) => env.hex(w))
    const clocked = () => ({ clock: env.observedAll().filter(([k]) => k !== J) })
    env.op('A', 'add-writer', { key: writerKey('C'), indexer: false }) // A0
    env.op('A', 'add-writer', { key: writerKey('Z'), indexer: false }) // A1
    env.op('A', 'create-concept', { path: 'w/doc', type: 'note' }) // A2
    const id = env.tag('A', 2)
    env.op('J', 'add-tag', { id, value: 'j0' }) // not-a-writer, and seen/J moves
    env.op('Z', 'add-tag', { id, value: 'z0' }, clocked())
    env.op('C', 'add-tag', { id, value: 'c0' }, clocked()) // cites A:2, Z:0
    const c1 = env.op('C', 'add-tag', { id, value: 'c1' }, clocked()) // cites A:2, Z:0
    env.op('A', 'remove-writer', { key: writerKey('Z') }, clocked()) // A3
    // A has folded C through c1, so seqAtRemoval is 1. Without Z, A's clock
    // is the clock of a store that drops revoked writers.
    const clock = [[A, 4], [C, 1], ...(removalCitesZ ? [[Z, 0]] : [])]
    env.op('A', 'remove-writer', { key: writerKey('C') }, { clock, verbatimClock: true }) // A4
    const view = await env.run([...env.nodes.filter((n) => n !== c1), c1])
    const tags = Object.values(view.dump(`c/${id}/f/tags`)[`c/${id}/f/tags`].els).sort()
    return { reasons: rejectedReasons(view), tags, removed: JSON.parse((await view.get(K.govRemoved(C))).value), J, C }
  }

  const kept = await run(true)
  assert.deepEqual(kept.reasons, { [rk(kept.J, 0)]: 'not-a-writer' }, 'only the op of J is rejected')
  assert.deepEqual(kept.tags, ['c0', 'c1', 'z0'], 'c1 lands in the window')
  assert.equal(kept.removed.seqAtRemoval, 1)

  const dropped = await run(false)
  assert.deepEqual(
    dropped.reasons,
    { [rk(dropped.J, 0)]: 'not-a-writer', [rk(dropped.C, 1)]: 'revoked' },
    'c1 cites Z, and the revocation clock does not, so c1 is not strictly before it'
  )
  assert.deepEqual(dropped.tags, ['c0', 'z0'])
})
