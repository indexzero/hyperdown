// I4: no op's effect disappears without a flag (§12, §5.2, §5.4, §8.4).
import test from 'node:test'
import assert from 'node:assert/strict'
import { run, n, rawNode, addWriters, defineSetTerm, defineLwwTerm, K, GEN, W1, W2, makeTag, hex } from './helpers.js'
import { tagHex } from '../packages/core/index.js'

test('I4: unmapped writes are preserved verbatim and flagged', async () => {
  const { view } = await run([
    n(GEN, 'set-field', { s: 'A', p: 'mood', o: 'sunny', tag: makeTag(GEN, 1) })
  ])
  assert.ok(view.dump(K.flag('unmapped', 'A', 'mood'))[K.flag('unmapped', 'A', 'mood')])
  const rec = (await view.get(K.nField('A', 'mood'))).value
  assert.deepEqual(rec.un.items.map((i) => i.v), ['sunny'])
  assert.ok(await view.get(K.unmappedIdx('mood', 'A')))
  // never indexed as a triple (§10.3)
  assert.equal(Object.keys(view.dump('idx/')).length, 0)
})

test('I4: op/kind mismatch rejects with flag/kindmismatch and no n/ mutation (§5.2)', async () => {
  const tag = makeTag(GEN, 2)
  const { view } = await run([
    defineSetTerm('topics'),
    n(GEN, 'set-field', { s: 'A', p: 'topics', o: 'x', tag })
  ])
  assert.ok(await view.get(K.flag('kindmismatch', 'A', 'topics', tagHex(tag))))
  assert.equal(await view.get(K.nField('A', 'topics')), null)

  const tag2 = makeTag(GEN, 3)
  const { view: v2 } = await run([
    defineLwwTerm('title'),
    n(GEN, 'add-member', { s: 'A', p: 'title', o: 'x', tag: tag2 })
  ])
  assert.ok(await v2.get(K.flag('kindmismatch', 'A', 'title', tagHex(tag2))))
  assert.equal(await v2.get(K.nField('A', 'title')), null)
})

test('I4: cross-writer LWW supersession is clobber-flagged (§5.4)', async () => {
  const t2 = makeTag(W2, 1)
  const { view } = await run([
    ...addWriters([W1, false], [W2, false]),
    defineLwwTerm('title'),
    n(W1, 'set-field', { s: 'A', p: 'title', o: 'first', tag: makeTag(W1, 1) }),
    n(W2, 'set-field', { s: 'A', p: 'title', o: 'second', tag: t2 })
  ])
  const flag = (await view.get(K.flag('clobber', 'A', 'title', tagHex(t2)))).value
  assert.equal(flag.superseded.writer, hex(W1))
  assert.deepEqual(flag.superseded.values, ['first'])
})

test('I4: same-writer sequential updates do not clobber-flag (§5.4)', async () => {
  const { view } = await run([
    defineLwwTerm('title'),
    n(GEN, 'set-field', { s: 'A', p: 'title', o: 'v1', tag: makeTag(GEN, 1) }),
    n(GEN, 'set-field', { s: 'A', p: 'title', o: 'v2', tag: makeTag(GEN, 2) })
  ])
  assert.equal(Object.keys(view.dump('flag/clobber/')).length, 0)
})

test('I4: undecodable and oversize ops are flagged writer/seq-keyed (§8.4)', async () => {
  const { view } = await run([
    rawNode(GEN, Buffer.from([250, 250, 250])), // unknown msgid
    rawNode(GEN, Buffer.from([0, 1])), // truncated set-field
    rawNode(GEN, Buffer.alloc(70000)) // oversize-op
  ])
  const rejected = view.dump('flag/rejected/')
  const reasons = Object.values(rejected).map((r) => r.reason)
  assert.deepEqual(reasons.sort(), ['oversize-op', 'undecodable', 'unknown-msgid'])
  for (const [key, val] of Object.entries(rejected)) {
    assert.match(key, new RegExp(`^flag/rejected/${hex(GEN)}/\\d{12}$`))
    assert.match(val.rawHashHex, /^[0-9a-f]{64}$/)
  }
  // no n/ (other than hold), ctx/ beyond genesis, or idx/ mutation
  assert.equal(Object.keys(view.dump('n/')).length, 0)
  assert.equal(Object.keys(view.dump('idx/')).length, 0)
})

test('I4: oversize-subject rejects after decode (§8.4 fixed order)', async () => {
  const big = 'x'.repeat(2000)
  const { view } = await run([
    n(GEN, 'set-field', { s: big, p: 'title', o: 'v', tag: makeTag(GEN, 1) })
  ])
  const reasons = Object.values(view.dump('flag/rejected/')).map((r) => r.reason)
  assert.deepEqual(reasons, ['oversize-subject'])
})

test('I4: depth-exceeded rejects (§8.4)', async () => {
  let deep = 'leaf'
  for (let i = 0; i < 70; i++) deep = [deep]
  const { view } = await run([
    n(GEN, 'set-field', { s: 'A', p: 'x', o: deep, tag: makeTag(GEN, 1) })
  ])
  const reasons = Object.values(view.dump('flag/rejected/')).map((r) => r.reason)
  assert.deepEqual(reasons, ['depth-exceeded'])
})

test('I4: epoch divergence on a pinned op is applied under the cited kind and flagged (§5.7)', async () => {
  const tag = makeTag(GEN, 5)
  const { view } = await run([
    defineSetTerm('topics'),
    // writer resolved 'topics' as scalar; ctx/ now says @set
    n(GEN, 'set-field', { s: 'A', p: 'topics', o: 'pinned', tag, ctxKind: 'scalar' })
  ])
  const flag = (await view.get(K.flag('epoch', 'A', 'topics', tagHex(tag)))).value
  assert.deepEqual(flag, { citedKind: 'scalar', applyKind: 'set' })
  const rec = (await view.get(K.nField('A', 'topics'))).value
  assert.deepEqual(rec.reg.values, ['pinned']) // applied as LWW register
})
