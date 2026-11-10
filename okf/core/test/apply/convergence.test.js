// I2 (SPEC §11): one linearization gives bit-identical views, and the
// OR-set state is bit-identical under either interleaving that keeps
// per-writer order. The substrate provides the one linearization.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Env, writerKey } from '../helpers.js'
import { MemView } from '../../index.js'

test('I2: independent applies of one linearization converge bit-identically', async () => {
  const env = new Env({ genesis: 'A' })
  env.op('A', 'create-concept', { path: 'p/one', type: 'note' })
  const id = env.tag('A', 0)
  env.op('A', 'add-writer', { key: writerKey('B'), indexer: true })
  env.op('B', 'set-body', { id, base: null, text: 'x [w](/p/wanted)' })
  env.op('A', 'add-tag', { id, value: 't1' })
  env.op('B', 'add-tag', { id, value: 't2' })

  const v1 = await env.run(env.nodes, { view: new MemView() })
  const v2 = await env.run(env.nodes, { view: new MemView() })
  assert.equal(v1.hash(), v2.hash())
})

test('I2/I5: concurrent tag adds converge to identical bytes under either interleaving', async () => {
  const env = new Env({ genesis: 'A' })
  env.op('A', 'create-concept', { path: 'p/tags', type: 'note' })
  const id = env.tag('A', 0)
  env.op('A', 'add-writer', { key: writerKey('B'), indexer: false })
  const setup = [...env.nodes]

  // concurrent: neither observes the other's add
  const base = env.observedAll()
  const a = env.op('A', 'add-tag', { id, value: 'shared' }, { clock: base })
  const b = env.op('B', 'add-tag', { id, value: 'shared' }, { clock: base })

  const v1 = await env.run([...setup, a, b], { view: new MemView() })
  const v2 = await env.run([...setup, b, a], { view: new MemView() })
  // the element map is keyed by tag, so its content does not depend on order
  const K = `c/${id}/f/tags`
  assert.deepEqual(v1.dump(K), v2.dump(K))
  assert.equal(Object.keys(v1.dump(K)[K].els).length, 2)
})
