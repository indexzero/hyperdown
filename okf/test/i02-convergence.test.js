// I2 Convergence (okf SPEC §11): peers that exchanged all ops have
// bit-identical views (full range-scan hash). The substrate guarantees one
// linearization for converged peers; at unit level we assert (a) the same
// linearization is bit-identical across independent applies, and (b) the
// commutative state (OR-set tags) is bit-identical even across DIFFERENT
// per-writer-order-preserving interleavings.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Env, writerKey } from './helpers.js'
import { MemView } from '../core/index.js'

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
  // the OR-set element map keys are opId tags — order-independent content
  const K = `c/${id}/f/tags`
  assert.deepEqual(v1.dump(K), v2.dump(K))
  assert.equal(Object.keys(v1.dump(K)[K].els).length, 2)
})
