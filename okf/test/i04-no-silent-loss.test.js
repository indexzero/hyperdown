// I4 No silent loss (okf SPEC §11): no op's effect disappears without a
// flag (clobber / staletag / conflict / pathcollision / writeafterdelete /
// rejected). wanted/ entries are demand, not loss.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Env, writerKey, keysUnder, rejectedReasons } from './helpers.js'

test('I4: cross-writer LWW supersession flags clobber with the loser recorded', async () => {
  const env = new Env({ genesis: 'A' })
  env.op('A', 'create-concept', { path: 'n/x', type: 'note' })
  const id = env.tag('A', 0)
  env.op('A', 'add-writer', { key: writerKey('B'), indexer: false })
  env.op('A', 'set-field', { id, key: 'status', value: ['open'] })
  env.op('B', 'set-field', { id, key: 'status', value: ['closed'] })
  const view = await env.run()
  const flags = view.dump(`flag/clobber/${id}/status/`)
  const entries = Object.values(flags)
  assert.equal(entries.length, 1)
  assert.deepEqual(entries[0].superseded.values, ['open'])
  // and the winner is the later linearized value
  assert.deepEqual(view.dump(`c/${id}/f/status`)[`c/${id}/f/status`].values, ['closed'])
})

test('I4: same-writer supersession does not flag (self-revision is not loss)', async () => {
  const env = new Env({ genesis: 'A' })
  env.op('A', 'create-concept', { path: 'n/y', type: 'note' })
  const id = env.tag('A', 0)
  env.op('A', 'set-field', { id, key: 'status', value: ['a'] })
  env.op('A', 'set-field', { id, key: 'status', value: ['b'] })
  const view = await env.run()
  assert.deepEqual(keysUnder(view, 'flag/clobber/'), [])
})

test('I4: concurrent renames flag clobber on the path register', async () => {
  const env = new Env({ genesis: 'A' })
  env.op('A', 'create-concept', { path: 'n/orig', type: 'note' })
  const id = env.tag('A', 0)
  env.op('A', 'add-writer', { key: writerKey('B'), indexer: false })
  env.op('A', 'set-path', { id, path: 'n/from-a' })
  env.op('B', 'set-path', { id, path: 'n/from-b' })
  const view = await env.run()
  assert.equal(keysUnder(view, `flag/clobber/${id}/path/`).length, 1)
  assert.equal(view.dump(`c/${id}/path`)[`c/${id}/path`].path, 'n/from-b')
})

test('I4: writes landing on a tombstoned concept flag writeafterdelete', async () => {
  const env = new Env({ genesis: 'A' })
  env.op('A', 'create-concept', { path: 'n/dead', type: 'note' })
  const id = env.tag('A', 0)
  env.op('A', 'delete-concept', { id })
  env.op('A', 'set-field', { id, key: 'x', value: [1] })
  const view = await env.run()
  assert.equal(keysUnder(view, `flag/writeafterdelete/${id}/`).length, 1)
  // the write still landed (§8: lands and flags)
  assert.deepEqual(view.dump(`c/${id}/f/x`)[`c/${id}/f/x`].values, [1])
})

test('I4: undecodable and oversize ops are rejected with a recorded reason', async () => {
  const env = new Env({ genesis: 'A' })
  env.raw('A', Buffer.from([0xff, 0xfe, 0xfd]))
  env.raw('A', Buffer.alloc(65537))
  env.op('A', 'create-concept', { path: 'ok', type: 'note' }) // seq 2, still applies
  const view = await env.run()
  const reasons = Object.values(rejectedReasons(view)).sort()
  assert.ok(reasons.length === 2)
  assert.ok(reasons.includes('oversize-op'))
  // the garbage byte op decodes as unknown-msgid or undecodable — both fixed reasons
  assert.ok(reasons.some((r) => r === 'undecodable' || r === 'unknown-msgid'))
  assert.equal(keysUnder(view, 'c/').length > 0, true)
})

test('I4: unresolved link targets land in wanted/, never in flag/', async () => {
  const env = new Env({ genesis: 'A' })
  env.op('A', 'create-concept', { path: 'a', type: 'note' })
  env.op('A', 'set-body', { id: env.tag('A', 0), base: null, text: '[missing](/not/yet)' })
  const view = await env.run()
  assert.equal(keysUnder(view, 'wanted/not%2Fyet/').length, 1)
  assert.equal(keysUnder(view, 'flag/').length, 0)
})
