// I5 OR-set law for tags (okf SPEC §5, §11): concurrent add +
// remove-of-unobserved → present (SU-set); already-removed citations are
// silent no-ops; never-observed citations audit once to flag/staletag.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Env, writerKey, keysUnder } from './helpers.js'
import { makeTag } from '../core/index.js'

function setup() {
  const env = new Env({ genesis: 'A' })
  env.op('A', 'create-concept', { path: 't/c', type: 'note' })
  env.op('A', 'add-writer', { key: writerKey('B'), indexer: false })
  return { env, id: env.tag('A', 0) }
}

test('I5: concurrent re-add wins over remove-of-unobserved', async () => {
  const { env, id } = setup()
  const t0 = makeTag(env.hex('A'), 2)
  env.op('A', 'add-tag', { id, value: 'keep' }) // seq 2, token t0 — observed by B
  const base = env.observedAll()
  // concurrent: A re-adds 'keep' (new token), B removes citing only t0
  const reAdd = env.op('A', 'add-tag', { id, value: 'keep' }, { clock: base })
  const rem = env.op('B', 'rem-tag', { id, value: 'keep', tags: [t0] }, { clock: base })
  const view = await env.run()
  const rec = view.dump(`c/${id}/f/tags`)[`c/${id}/f/tags`]
  const values = Object.values(rec.els)
  assert.deepEqual(values, ['keep'], 'the concurrently-added token survives')
  assert.ok(!(t0 in rec.els), 'the cited token is removed')
  assert.deepEqual(rec.removed.keep, [t0])
  assert.equal(keysUnder(view, 'flag/staletag/').length, 0, 'observed citation never flags')
  // suppress unused-var lint noise
  void reAdd
  void rem
})

test('I5: benign concurrent removes of the same tag never flag', async () => {
  const { env, id } = setup()
  const t0 = makeTag(env.hex('A'), 2)
  env.op('A', 'add-tag', { id, value: 'x' })
  const base = env.observedAll()
  env.op('A', 'rem-tag', { id, value: 'x', tags: [t0] }, { clock: base })
  env.op('B', 'rem-tag', { id, value: 'x', tags: [t0] }, { clock: base })
  const view = await env.run()
  const rec = view.dump(`c/${id}/f/tags`)[`c/${id}/f/tags`]
  assert.deepEqual(rec.els, {})
  assert.equal(keysUnder(view, 'flag/staletag/').length, 0)
})

test('I5: a never-observed citation is ignored for effect and audited once', async () => {
  const { env, id } = setup()
  env.op('A', 'add-tag', { id, value: 'real' })
  const bogus = makeTag(env.hex('B'), 999)
  env.op('B', 'rem-tag', { id, value: 'real', tags: [bogus] })
  const view = await env.run()
  const rec = view.dump(`c/${id}/f/tags`)[`c/${id}/f/tags`]
  assert.deepEqual(Object.values(rec.els), ['real'], 'no effect on the live element')
  const staleKeys = keysUnder(view, `flag/staletag/${id}/`)
  assert.equal(staleKeys.length, 1)
  assert.ok(staleKeys[0].includes(bogus))
})

test('I5: a token observed for a DIFFERENT value does not remove this value', async () => {
  const { env, id } = setup()
  const tOther = makeTag(env.hex('A'), 2)
  env.op('A', 'add-tag', { id, value: 'other' }) // token tOther maps to 'other'
  env.op('A', 'add-tag', { id, value: 'target' })
  env.op('B', 'rem-tag', { id, value: 'target', tags: [tOther] })
  const view = await env.run()
  const rec = view.dump(`c/${id}/f/tags`)[`c/${id}/f/tags`]
  assert.deepEqual(Object.values(rec.els).sort(), ['other', 'target'])
  assert.equal(keysUnder(view, `flag/staletag/${id}/`).length, 1)
})
