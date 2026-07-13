// §4 keyspace codec escaping + §9.4 adversarial '../escape' containment.
import test from 'node:test'
import assert from 'node:assert/strict'
import { keyspace as K } from '../packages/core/index.js'
import { isSafePath, namespaceMatches } from '../packages/core/index.js'
import { run, n, GEN, W1, addWriters, defineLwwTerm, defineSetTerm, makeTag, hex } from './helpers.js'

test('§4: components round-trip through escaping; separators cannot be injected', () => {
  for (const nasty of ['a/b', '../escape', 'x%2Fy', '%', 'hold', 'f', 'body', 'rev/x', 'a/../../b']) {
    const key = K.nField(nasty, 'p/q')
    const segs = key.split('/')
    // structural shape survives: n / <subject> / f / <term>
    assert.equal(segs.length, 4, key)
    assert.equal(segs[0], 'n')
    assert.equal(segs[2], 'f')
    assert.equal(K.parseKey(key)[1], nasty) // lossless round-trip
    assert.equal(K.parseKey(key)[3], 'p/q')
  }
})

test("§4: a subject named 'hold' can never collide with the n/hold/ family", () => {
  const w = 'ab'.repeat(32)
  const holdKey = K.nHold(w, 3)
  const subjKey = K.nBody('hold')
  assert.ok(holdKey.startsWith('n/hold/'))
  assert.ok(!subjKey.startsWith('n/hold/'))
  assert.equal(K.parseKey(subjKey)[1], 'hold')
})

test("§9.4: an op naming '../escape' is contained in the keyspace on any peer", async () => {
  const { view } = await run([
    defineLwwTerm('title'),
    defineSetTerm('links'),
    n(GEN, 'set-field', { s: '../escape', p: 'title', o: 'evil', tag: makeTag(GEN, 1) }),
    n(GEN, 'add-member', { s: 'safe', p: 'links', o: { ref: '../escape' }, tag: makeTag(GEN, 2) }),
    n(GEN, 'set-body', { s: '../escape', base: null, text: 'payload' })
  ])
  for (const key of Object.keys(view.dump(''))) {
    // no raw '..' path segment exists in any view key
    assert.ok(!key.split('/').includes('..'), key)
    // and the subject stayed inside its own family
    if (key.includes('escape')) {
      const segs = key.split('/')
      assert.ok(['n', 'idx', 'bl', 'flag', 'fidx', 'unmapped-idx', 'iri', 'hostidx', 'scopeidx'].includes(segs[0]), key)
    }
  }
  // the data round-trips under the original subject name
  assert.ok(await view.get(K.nBody('../escape')))
})

test('§9.4: apply rejects SetPath values that escape root', async () => {
  const cases = ['../up.md', 'a/../../b.md', '/absolute.md', 'C:evil.md', 'a\\b.md', 'ok/../fine.md']
  const nodes = [
    ...cases.map((path, i) => n(GEN, 'set-path', { s: 'S' + i, path }))
  ]
  const { view } = await run(nodes)
  const reasons = Object.values(view.dump('flag/rejected/')).map((r) => r.reason)
  assert.deepEqual(reasons, cases.map(() => 'unsafe-path'))
  assert.equal(Object.keys(view.dump('n/')).length, 0)
})

test('§9.4: isSafePath is strict on traversal, absolute paths, and drive letters', () => {
  assert.ok(isSafePath('Notes/Deep/Note.md'))
  assert.ok(isSafePath('single.md'))
  for (const bad of ['../x', 'a/..', '/x', 'C:x', 'a\\b', '', 'a//b']) {
    assert.ok(!isSafePath(bad), bad)
  }
})

test('§8.6: prefix matching is per path segment, never byte-prefix', () => {
  assert.ok(namespaceMatches(['agents/alice'], 'agents/alice'))
  assert.ok(namespaceMatches(['agents/alice'], 'agents/alice/notes'))
  assert.ok(!namespaceMatches(['agents/alice'], 'agents/alicecooper'))
  assert.ok(namespaceMatches([], 'anything')) // empty ⇒ unrestricted
})

test('§8.2/§8.4: hold, rejection, and optimistic families share one ordinal source', async () => {
  const config = { rate: { holdMax: 1 } }
  const nodes = [
    n(W1, 'set-field', { s: 'A', p: 'x', o: 1, tag: makeTag(W1, 1) }), // held (ord 1)
    n(W1, 'set-field', { s: 'B', p: 'x', o: 2, tag: makeTag(W1, 2) }), // over H_max → rejected (ord 2)
    ...addWriters([W1, false])
  ]
  const { view } = await run(nodes, { config })
  const rejectedKeys = Object.keys(view.dump('flag/rejected/'))
  assert.deepEqual(rejectedKeys, [`flag/rejected/${hex(W1)}/${K.pad(2)}`])
  // the held op folded at ack under ordinal 1; seen-count kept counting rejected ops
  assert.equal((await view.get(K.seen(hex(W1)))).value, 2)
})
