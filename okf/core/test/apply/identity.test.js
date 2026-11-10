// Identity (SPEC §6): apply mints an `_id` from the tag of the creating op,
// or adopts one. An adopted id cannot take a writer's future mint, and a
// squat cannot block a genuine mint.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Env, writerKey, rejectedReasons } from '../helpers.js'
import { makeTag } from '../../index.js'

test('§6: adopting an id shaped like a KNOWN writer’s future mint is rejected', async () => {
  const env = new Env({ genesis: 'A' })
  env.op('A', 'add-writer', { key: writerKey('B'), indexer: false })
  env.op('B', 'create-concept', { path: 'squat/b0', type: 'note' }) // B seq 0 → seen/B = 1
  // future seq 5 of B (seen-count 1 → 5 >= 1)
  env.op('A', 'create-concept', { id: makeTag(env.hex('B'), 5), path: 'squat/steal', type: 'note' })
  // an id exactly equal to a writer key (empty seq suffix)
  env.op('A', 'create-concept', { id: env.hex('B'), path: 'squat/steal2', type: 'note' })
  const view = await env.run()
  const reasons = Object.values(rejectedReasons(view))
  assert.deepEqual(reasons, ['mint-collision-risk', 'mint-collision-risk'])
})

test('§6: an unadmitted writer’s future mints are protected too (seen/ counts every node)', async () => {
  const env = new Env({ genesis: 'A' })
  // D has no gov/writer record: its op is rejected not-a-writer, and seen/D = 1
  env.op('D', 'create-concept', { path: 'nw/d', type: 'note' })
  env.op('A', 'create-concept', { id: makeTag(env.hex('D'), 3), path: 'squat/d', type: 'note' })
  const view = await env.run()
  assert.deepEqual(rejectedReasons(view), {
    [`${env.hex('D')}/000000000000`]: 'not-a-writer',
    [`${env.hex('A')}/000000000000`]: 'mint-collision-risk'
  })
  assert.equal(view.dump('seen/' + env.hex('D'))['seen/' + env.hex('D')], 1)
})

test('§6: a squat on an UNKNOWN future writer cannot block its mint — fallback + flag/squat', async () => {
  const env = new Env({ genesis: 'A' })
  const eKey = writerKey('E') // E is unknown to the vault at adoption time
  const squattedId = makeTag(eKey.toString('hex'), 0)
  env.op('A', 'create-concept', { id: squattedId, path: 'squat/preclaim', type: 'note' })
  env.op('A', 'add-writer', { key: eKey, indexer: false })
  env.op('E', 'create-concept', { path: 'squat/genuine', type: 'note' }) // E mints at seq 0
  const view = await env.run()
  assert.deepEqual(rejectedReasons(view), {}, 'the genuine mint always succeeds')
  const squatFlags = view.dump(`flag/squat/${squattedId}/`)
  assert.equal(Object.keys(squatFlags).length, 1)
  const minted = Object.values(squatFlags)[0].minted
  assert.match(minted, /^[0-9a-f]{64}$/, 'fallback id is the 64-hex SHA-256 form')
  assert.equal(view.dump(`c/${minted}/meta`)[`c/${minted}/meta`].type, 'note')
  assert.equal(view.dump(`c/${minted}/path`)[`c/${minted}/path`].path, 'squat/genuine')
})

test('§6: a non-minimal hex suffix is not mint-shaped and adopts freely', async () => {
  const env = new Env({ genesis: 'A' })
  env.op('A', 'add-writer', { key: writerKey('B'), indexer: false })
  env.op('A', 'create-concept', { id: env.hex('B') + '00', path: 'ok/nonminimal', type: 'note' })
  const view = await env.run()
  assert.deepEqual(rejectedReasons(view), {})
})

test('§6: duplicate-id — adoption of a seen id (even a tombstoned one) is rejected', async () => {
  const env = new Env({ genesis: 'A' })
  env.op('A', 'create-concept', { path: 'dup/a', type: 'note' })
  const id = env.tag('A', 0)
  env.op('A', 'delete-concept', { id })
  env.op('A', 'create-concept', { id, path: 'dup/b', type: 'note' })
  const view = await env.run()
  assert.deepEqual(Object.values(rejectedReasons(view)), ['duplicate-id'])
})

test('§6: malformed adopted ids are rejected', async () => {
  const env = new Env({ genesis: 'A' })
  env.op('A', 'create-concept', { id: 'XYZ', path: 'bad/1', type: 'note' })
  env.op('A', 'create-concept', { id: 'f', path: 'bad/2', type: 'note' }) // too short
  env.op('A', 'create-concept', { id: 'a'.repeat(129), path: 'bad/3', type: 'note' }) // too long
  const view = await env.run()
  assert.deepEqual(Object.values(rejectedReasons(view)), ['bad-id', 'bad-id', 'bad-id'])
})

test('§6: adopting an unknown _id (generation-cycle contract) works and preserves identity', async () => {
  const env = new Env({ genesis: 'A' })
  const carried = 'abcdef0123456789' // 16-hex id from a predecessor generation
  env.op('A', 'create-concept', { id: carried, path: 'epoch/doc', type: 'note' })
  env.op('A', 'set-body', { id: carried, base: null, text: 'carried across' })
  const view = await env.run()
  assert.deepEqual(rejectedReasons(view), {})
  assert.equal(view.dump(`c/${carried}/meta`)[`c/${carried}/meta`].type, 'note')
})
