// I3 Rebuild equivalence (okf SPEC §11): a from-scratch rebuild of the
// view equals the incrementally-maintained view — apply carried no state
// between calls beyond the view itself.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Env, writerKey } from './helpers.js'
import { MemView } from '../core/index.js'

function scenario() {
  const env = new Env({ genesis: 'A' })
  env.op('A', 'create-concept', { path: 'wiki/home', type: 'page' })
  const home = env.tag('A', 0)
  env.op('A', 'add-writer', { key: writerKey('B'), indexer: false })
  env.op('A', 'set-body', { id: home, base: null, text: '[next](/wiki/next) and [gone](/wiki/gone)' })
  env.op('B', 'create-concept', { path: 'wiki/next', type: 'page' })
  const next = env.tag('B', 0)
  env.op('B', 'add-tag', { id: next, value: 'todo' })
  env.op('B', 'set-path', { id: next, path: 'wiki/renamed' })
  env.op('A', 'delete-concept', { id: next })
  env.op('B', 'undelete-concept', { id: next })
  env.raw('A', Buffer.alloc(70000)) // oversize → rejected, still counted
  env.op('A', 'set-field', { id: home, key: 'status', value: ['live'] })
  return env
}

test('I3: incremental (per-node applies) equals one-shot rebuild', async () => {
  const env = scenario()
  const incremental = await env.run(env.nodes, { view: new MemView(), chunk: 1 })
  const oneShot = await env.run(env.nodes, { view: new MemView() })
  const chunked = await env.run(env.nodes, { view: new MemView(), chunk: 3 })
  assert.equal(incremental.hash(), oneShot.hash())
  assert.equal(chunked.hash(), oneShot.hash())
})
