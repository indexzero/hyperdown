// I6 (SPEC §5, §11): for every LWW register, the later linearized op wins,
// whichever writer wrote it. Also the SetField rules of §5: the reserved keys
// and the empty type.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Env, writerKey, rejectedReasons } from '../helpers.js'
import { MemView, revHash } from '../../index.js'

function concurrentField() {
  const env = new Env({ genesis: 'A' })
  env.op('A', 'create-concept', { path: 'l/c', type: 'note' })
  const id = env.tag('A', 0)
  env.op('A', 'add-writer', { key: writerKey('B'), indexer: false })
  const setup = [...env.nodes]
  const base = env.observedAll()
  const a = env.op('A', 'set-field', { id, key: 'k', value: ['from-a'] }, { clock: base })
  const b = env.op('B', 'set-field', { id, key: 'k', value: ['from-b'] }, { clock: base })
  return { env, id, setup, a, b }
}

test('I6: the later linearized set-field wins, in either order', async () => {
  const { env, id, setup, a, b } = concurrentField()
  const vAB = await env.run([...setup, a, b], { view: new MemView() })
  const vBA = await env.run([...setup, b, a], { view: new MemView() })
  assert.deepEqual(vAB.dump(`c/${id}/f/k`)[`c/${id}/f/k`].values, ['from-b'])
  assert.deepEqual(vBA.dump(`c/${id}/f/k`)[`c/${id}/f/k`].values, ['from-a'])
  // both orders flag the loser (I4)
  assert.equal(Object.keys(vAB.dump(`flag/clobber/${id}/k/`)).length, 1)
  assert.equal(Object.keys(vBA.dump(`flag/clobber/${id}/k/`)).length, 1)
})

test('I6: body head pointer is LWW under linearization', async () => {
  const env = new Env({ genesis: 'A' })
  env.op('A', 'create-concept', { path: 'l/b', type: 'note' })
  const id = env.tag('A', 0)
  env.op('A', 'set-body', { id, base: null, text: 'v1' })
  const r1 = revHash(null, 'v1')
  env.op('A', 'set-body', { id, base: r1, text: 'v2' })
  const r2 = revHash(r1, 'v2')
  const view = await env.run()
  assert.equal(view.dump(`c/${id}/body`)[`c/${id}/body`], r2)
  // both revisions retained (append-only)
  assert.equal(Object.keys(view.dump(`c/${id}/rev/`)).length, 2)
})

test('I6: values are canonical arrays — scalar and singleton array converge', async () => {
  const env = new Env({ genesis: 'A' })
  env.op('A', 'create-concept', { path: 'l/s', type: 'note' })
  const id = env.tag('A', 0)
  env.op('A', 'set-field', { id, key: 'k1', value: 'solo' })
  env.op('A', 'set-field', { id, key: 'k2', value: ['solo'] })
  const view = await env.run()
  assert.deepEqual(view.dump(`c/${id}/f/k1`)[`c/${id}/f/k1`].values, ['solo'])
  assert.deepEqual(view.dump(`c/${id}/f/k2`)[`c/${id}/f/k2`].values, ['solo'])
})

test('I6: an empty-array set-field empties the register (key omitted downstream)', async () => {
  const env = new Env({ genesis: 'A' })
  env.op('A', 'create-concept', { path: 'l/e', type: 'note' })
  const id = env.tag('A', 0)
  env.op('A', 'set-field', { id, key: 'k', value: ['x'] })
  env.op('A', 'set-field', { id, key: 'k', value: [] })
  const view = await env.run()
  assert.deepEqual(view.dump(`c/${id}/f/k`)[`c/${id}/f/k`].values, [])
})

test('§5: SetField on tags/_id/_rev is rejected reserved-key', async () => {
  const env = new Env({ genesis: 'A' })
  env.op('A', 'create-concept', { path: 'm4/c', type: 'note' })
  const id = env.tag('A', 0)
  env.op('A', 'set-field', { id, key: 'tags', value: ['sneak'] })
  env.op('A', 'set-field', { id, key: '_id', value: ['other'] })
  env.op('A', 'set-field', { id, key: '_rev', value: ['fake'] })
  const view = await env.run()
  assert.deepEqual(Object.values(rejectedReasons(view)), [
    'reserved-key',
    'reserved-key',
    'reserved-key'
  ])
  assert.equal(view.dump(`c/${id}/f/tags`)[`c/${id}/f/tags`], undefined)
})

test('§5: empty type is unreachable — create and set-field both reject', async () => {
  const env = new Env({ genesis: 'A' })
  env.op('A', 'create-concept', { path: 'n4/empty', type: '' })
  env.op('A', 'create-concept', { path: 'n4/ok', type: 'note' })
  const id = env.tag('A', 1)
  env.op('A', 'set-field', { id, key: 'type', value: [] })
  env.op('A', 'set-field', { id, key: 'type', value: [''] })
  const view = await env.run()
  assert.deepEqual(Object.values(rejectedReasons(view)), ['empty-type', 'empty-type', 'empty-type'])
  assert.deepEqual(view.dump(`c/${id}/f/type`)[`c/${id}/f/type`].values, ['note'])
})
