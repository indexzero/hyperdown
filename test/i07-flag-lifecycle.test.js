// I7: flag lifecycle — dangling clears on both takeover shapes (§7), conflict
// persists until ResolveConflict (§6), audit flags drain via ClearFlag,
// structural flags reject ClearFlag (§6).
import test from 'node:test'
import assert from 'node:assert/strict'
import { run, n, addWriters, defineSetTerm, defineLwwTerm, K, GEN, W1, W2, makeTag } from './helpers.js'
import { revHash, tagHex } from '../vault-ld/core/index.js'

test('I7: dangling ref mints in the data namespace and coalesces a count (§7)', async () => {
  const { view } = await run([
    defineSetTerm('links'),
    n(GEN, 'add-member', { s: 'A', p: 'links', o: { ref: 'Ghost' }, tag: makeTag(GEN, 1) }),
    n(GEN, 'add-member', { s: 'B', p: 'links', o: { ref: 'Ghost' }, tag: makeTag(GEN, 2) })
  ])
  const flag = (await view.get(K.flag('dangling', 'Ghost'))).value
  assert.equal(flag.count, 2)
  assert.equal(flag.mintedAs, 'vault://data/Ghost')
  assert.equal((await view.get(K.nMintedAs('Ghost'))).value, 'vault://data/Ghost')
  // referrers recoverable from bl/ (§7)
  assert.ok(await view.get(K.bl('Ghost', 'A', 'links')))
  assert.ok(await view.get(K.bl('Ghost', 'B', 'links')))
})

test('I7: same-IRI takeover clears the flag and reuses the IRI (§7)', async () => {
  const { view } = await run([
    defineSetTerm('links'),
    defineLwwTerm('title'),
    n(GEN, 'add-member', { s: 'A', p: 'links', o: { ref: 'Ghost' }, tag: makeTag(GEN, 1) }),
    n(GEN, 'set-field', { s: 'Ghost', p: 'title', o: 'now real', tag: makeTag(GEN, 2) })
  ])
  assert.equal(await view.get(K.flag('dangling', 'Ghost')), null)
  assert.equal(await view.get(K.nMintedAs('Ghost')), null)
  assert.equal((await view.get(K.nBase('Ghost'))).value.iri, 'vault://data/Ghost')
  // referring triple points at the reused IRI
  const oKeys = Object.keys(view.dump('idx/spo/')).map((k) => K.parseKey(k)[4])
  assert.ok(oKeys.includes('r:vault://data/Ghost'))
})

test('I7: different-IRI takeover retargets triples with audit flags, never merges (§7)', async () => {
  const { view } = await run([
    defineSetTerm('links'),
    n(GEN, 'add-member', { s: 'A', p: 'links', o: { ref: 'Ghost' }, tag: makeTag(GEN, 1) }),
    // Ghost materializes with an explicit @id — a DIFFERENT IRI (§5.8)
    n(GEN, 'set-field', { s: 'Ghost', p: '@id', o: 'https://ex.org/ghost', tag: makeTag(GEN, 2) })
  ])
  assert.equal(await view.get(K.flag('dangling', 'Ghost')), null)
  const retarget = (await view.get(K.flag('danglingretarget', 'A', 'links', 'Ghost'))).value
  assert.equal(retarget.from, 'vault://data/Ghost')
  assert.equal(retarget.to, 'https://ex.org/ghost')
  // the referring triple was rewritten to the new IRI
  const oKeys = Object.keys(view.dump('idx/spo/')).map((k) => K.parseKey(k)[4])
  assert.ok(oKeys.includes('r:https://ex.org/ghost'))
  assert.ok(!oKeys.includes('r:vault://data/Ghost'))
})

test('I7: conflict flags persist until an explicit ResolveConflict (§6)', async () => {
  // true concurrency = two revisions citing the same NON-null base (§6);
  // independent null-base creations are LWW on the head and do not conflict
  // (review finding M1), so the branches cite a shared seed revision.
  const r0 = revHash(null, 'seed')
  const r1 = revHash(r0, 'branch one')
  const r2 = revHash(r0, 'branch two')
  const [a, b] = [r1, r2].sort()
  const base = [
    ...addWriters([W1, false], [W2, false]),
    n(GEN, 'set-body', { s: 'A', base: null, text: 'seed' }),
    n(W1, 'set-body', { s: 'A', base: r0, text: 'branch one' }),
    n(W2, 'set-body', { s: 'A', base: r0, text: 'branch two' })
  ]
  const { view } = await run(base)
  assert.ok(await view.get(K.flag('conflict', 'A', a, b)))
  assert.equal((await view.get(K.nBody('A'))).value, r2) // head LWW under linearization
  // both revisions kept
  assert.ok(await view.get(K.nRev('A', r1)))
  assert.ok(await view.get(K.nRev('A', r2)))

  // ClearFlag cannot clear a structural conflict flag (§6)
  const { view: v2 } = await run([
    ...base,
    n(GEN, 'clear-flag', { flagKey: K.flag('conflict', 'A', a, b) })
  ])
  assert.ok(await v2.get(K.flag('conflict', 'A', a, b)))
  const rejReasons = Object.values(v2.dump('flag/rejected/')).map((r) => r.reason)
  assert.ok(rejReasons.includes('flag-not-clearable'))

  // ResolveConflict clears it and moves the head
  const { view: v3 } = await run([
    ...base,
    n(GEN, 'resolve-conflict', { s: 'A', keep: r1, supersede: [r2] })
  ])
  assert.equal(await v3.get(K.flag('conflict', 'A', a, b)), null)
  assert.equal((await v3.get(K.nBody('A'))).value, r1)
})

test('I7: ResolveConflict with text creates a merged revision based on keep (§6)', async () => {
  const r0 = revHash(null, 'seed')
  const r1 = revHash(r0, 'one')
  const r2 = revHash(r0, 'two')
  const merged = revHash(r1, 'merged text')
  const { view } = await run([
    ...addWriters([W1, false], [W2, false]),
    n(GEN, 'set-body', { s: 'A', base: null, text: 'seed' }),
    n(W1, 'set-body', { s: 'A', base: r0, text: 'one' }),
    n(W2, 'set-body', { s: 'A', base: r0, text: 'two' }),
    n(GEN, 'resolve-conflict', { s: 'A', keep: r1, supersede: [r2], text: 'merged text' })
  ])
  assert.equal((await view.get(K.nBody('A'))).value, merged)
  assert.equal((await view.get(K.nRev('A', merged))).value.base, r1)
  assert.equal(Object.keys(view.dump('flag/conflict/')).length, 0)
})

test('I7: audit flags are drainable via ClearFlag (§6)', async () => {
  const t2 = makeTag(W2, 1)
  const clobberKey = K.flag('clobber', 'A', 'title', tagHex(t2))
  const { view } = await run([
    ...addWriters([W1, false], [W2, false]),
    defineLwwTerm('title'),
    n(W1, 'set-field', { s: 'A', p: 'title', o: 'x', tag: makeTag(W1, 1) }),
    n(W2, 'set-field', { s: 'A', p: 'title', o: 'y', tag: t2 }),
    n(GEN, 'clear-flag', { flagKey: clobberKey })
  ])
  assert.equal(await view.get(clobberKey), null)
})

test('I7: cross-writer head supersession without shared base clobber-flags (§5.4/§6)', async () => {
  const r1 = revHash(null, 'one')
  const { view } = await run([
    ...addWriters([W1, false], [W2, false]),
    n(W1, 'set-body', { s: 'A', base: null, text: 'one' }),
    n(W2, 'set-body', { s: 'A', base: r1, text: 'two' }), // clean succession: no flag
    n(W1, 'set-body', { s: 'A', base: r1, text: 'three' }) // same base as 'two': conflict, no clobber
  ])
  assert.equal(Object.keys(view.dump('flag/clobber/')).length, 0)
  assert.equal(Object.keys(view.dump('flag/conflict/')).length, 1)
})
