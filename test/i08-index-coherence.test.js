// I8: idx/* and bl/* are always consistent with n/* within a single view
// state — including after deferred-DefineTerm backfill (§10.3), host-key
// promotion (§5.6), and kind-changing redefinition migration (§5.5).
import test from 'node:test'
import assert from 'node:assert/strict'
import { run, n, addWriters, defineSetTerm, defineLwwTerm, checkIndexCoherence, K, GEN, W1, makeTag } from './helpers.js'

test('I8: triple indexes are maintained inside the same apply pass (§4)', async () => {
  const { view } = await run([
    defineLwwTerm('title'),
    defineSetTerm('links'),
    n(GEN, 'set-field', { s: 'A', p: 'title', o: 'hello', tag: makeTag(GEN, 1) }),
    n(GEN, 'add-member', { s: 'A', p: 'links', o: { ref: 'B' }, tag: makeTag(GEN, 2) }),
    n(GEN, 'set-field', { s: 'B', p: 'title', o: 'target', tag: makeTag(GEN, 3) })
  ])
  const coherence = await checkIndexCoherence(view)
  assert.deepEqual(coherence, { ok: true, missing: [], extra: [] })
  // all three permutations exist for the same triple
  const spo = Object.keys(view.dump('idx/spo/'))
  const pos = Object.keys(view.dump('idx/pos/'))
  const osp = Object.keys(view.dump('idx/osp/'))
  assert.equal(spo.length, pos.length)
  assert.equal(spo.length, osp.length)
  assert.ok(spo.length >= 3)
})

test('I8: a deferred DefineTerm makes previously-unmapped values index-visible (§10.3)', async () => {
  const nodes = [
    n(GEN, 'set-field', { s: 'A', p: 'mood', o: 'sunny', tag: makeTag(GEN, 1) }),
    n(GEN, 'add-member', { s: 'B', p: 'mood', o: 'rainy', tag: makeTag(GEN, 2) })
  ]
  const before = await run(nodes)
  assert.equal(Object.keys(before.view.dump('idx/')).length, 0)
  assert.ok(await before.view.get(K.unmappedIdx('mood', 'A')))

  const after = await run([...nodes, defineLwwTerm('mood')])
  // flags and reverse index cleared, values now triples
  assert.equal(Object.keys(after.view.dump('flag/unmapped/')).length, 0)
  assert.equal(Object.keys(after.view.dump('unmapped-idx/')).length, 0)
  const rows = Object.keys(after.view.dump('idx/pos/'))
  assert.ok(rows.some((k) => K.parseKey(k)[2] === 'ex:mood' && K.parseKey(k)[3] === 's:sunny'))
  assert.ok(rows.some((k) => K.parseKey(k)[2] === 'ex:mood' && K.parseKey(k)[3] === 's:rainy'))
  const coherence = await checkIndexCoherence(after.view)
  assert.deepEqual(coherence, { ok: true, missing: [], extra: [] })
})

test('I8: kind-changing redefinition migrates state and keeps indexes well-formed (§5.5)', async () => {
  const base = [
    ...addWriters([W1, false]),
    defineLwwTerm('genre'),
    n(GEN, 'set-field', { s: 'A', p: 'genre', o: ['jazz', 'blues'], tag: makeTag(GEN, 1) })
  ]
  // lww → or-set: register values become element-map entries under a
  // synthetic tag from the DefineTerm op
  const toSet = [
    ...base,
    n(GEN, 'define-term', { scope: 'core', term: 'genre', def: { '@id': 'ex:genre', '@container': '@set' } })
  ]
  const a = await run(toSet)
  const recA = (await a.view.get(K.nField('A', 'genre'))).value
  assert.equal(recA.reg, undefined)
  assert.deepEqual(Object.values(recA.els).map((e) => e.v).sort(), ['blues', 'jazz'])
  assert.ok(await a.view.get(K.flag('shadow', 'core', 'genre'))) // differing redefinition (§5.5)
  assert.deepEqual(await checkIndexCoherence(a.view), { ok: true, missing: [], extra: [] })

  // or-set → lww: deterministic collapse, lossy collapse audited
  const backToLww = [
    ...toSet,
    n(W1, 'add-member', { s: 'A', p: 'genre', o: 'ska', tag: makeTag(W1, 1) }),
    defineLwwTerm('genre')
  ]
  const b = await run(backToLww)
  const recB = (await b.view.get(K.nField('A', 'genre'))).value
  assert.equal(recB.els, undefined)
  assert.deepEqual(recB.reg.values, ['ska']) // last element in linearized order wins
  assert.ok(await b.view.get(K.flag('kindcollapse', 'A', 'genre')))
  assert.deepEqual(await checkIndexCoherence(b.view), { ok: true, missing: [], extra: [] })

  // determinism of the whole migration chain (I1 over §5.5)
  const b2 = await run(backToLww)
  assert.equal(b.view.hash(), b2.view.hash())
})

test('I8: host-key promotion migrates host/ state into f/ and backfills (§5.6)', async () => {
  const base = [
    n(GEN, 'set-field', { s: 'A', p: 'cssclasses', o: ['wide', 'dark'], tag: makeTag(GEN, 1) })
  ]
  const before = await run(base)
  // host keys: neither triples nor unmapped flags; authored order preserved
  // verbatim for lossless materialization (§5.6)
  assert.deepEqual((await before.view.get(K.nHost('A', 'cssclasses'))).value.value, ['wide', 'dark'])
  assert.equal(Object.keys(before.view.dump('flag/')).length, 0)
  assert.equal(Object.keys(before.view.dump('idx/')).length, 0)

  const after = await run([...base, defineSetTerm('cssclasses', 'ex:css')])
  assert.equal(await after.view.get(K.nHost('A', 'cssclasses')), null)
  const rec = (await after.view.get(K.nField('A', 'cssclasses'))).value
  assert.deepEqual(Object.values(rec.els).map((e) => e.v).sort(), ['dark', 'wide'])
  const rows = Object.keys(after.view.dump('idx/pos/'))
  assert.ok(rows.some((k) => K.parseKey(k)[2] === 'ex:css'))
  assert.deepEqual(await checkIndexCoherence(after.view), { ok: true, missing: [], extra: [] })
})

test('I8: deletion suppresses a subject from idx/* and bl/*; undelete restores (§9.2)', async () => {
  const base = [
    defineSetTerm('links'),
    defineLwwTerm('title'),
    n(GEN, 'set-field', { s: 'A', p: 'title', o: 'x', tag: makeTag(GEN, 1) }),
    n(GEN, 'add-member', { s: 'A', p: 'links', o: { ref: 'B' }, tag: makeTag(GEN, 2) })
  ]
  const del = await run([...base, n(GEN, 'delete-subject', { s: 'A', tag: makeTag(GEN, 3) })])
  assert.equal(Object.keys(del.view.dump('idx/')).length, 0)
  assert.equal(Object.keys(del.view.dump('bl/')).length, 0)
  assert.deepEqual(await checkIndexCoherence(del.view), { ok: true, missing: [], extra: [] })

  const undel = await run([
    ...base,
    n(GEN, 'delete-subject', { s: 'A', tag: makeTag(GEN, 3) }),
    n(GEN, 'set-field', { s: 'A', p: 'title', o: 'back', tag: makeTag(GEN, 4), clock: [[GEN.toString('hex'), 3]] })
  ])
  assert.ok(Object.keys(undel.view.dump('idx/')).length >= 6)
  assert.ok(await undel.view.get(K.flag('undelete', 'A')))
  assert.deepEqual(await checkIndexCoherence(undel.view), { ok: true, missing: [], extra: [] })
})
