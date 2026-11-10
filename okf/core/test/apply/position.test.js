// The seq of an op is the position of its node in the core of its writer
// (SPEC §3). An empty block takes a position and never reaches apply, so
// positions can have gaps.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Env, hostStub, rejectedReasons, rk, gap } from '../helpers.js'
import { keyspace as K } from '../../index.js'

test('the actual seq of an op is node.length - 1, also after a gap in its writer\'s positions', async () => {
  const env = new Env()
  const n0 = env.op('A', 'create-concept', { path: 'notes/a', type: 'note' })
  gap(env, 'A') // position 1 is an empty block that never reaches apply
  const n2 = env.op('A', 'set-field', { id: env.tag('A', 0), key: 'title', value: ['two'] })
  assert.equal(n0.length, 1)
  assert.equal(n2.length, 3)
  const view = await env.run([n0, n2], { host: hostStub() })
  assert.deepEqual(rejectedReasons(view), {}, 'the op at position 2 claims seq 2 and is not forged-clock')
  assert.equal(JSON.parse((await view.get(K.seen(env.hex('A')))).value), 3, 'seen/A is the last position plus one')
  const f = JSON.parse((await view.get(K.cField(env.tag('A', 0), 'title'))).value)
  assert.deepEqual(f.values, ['two'])
  assert.equal(f.tag, env.tag('A', 2), 'the tag of the op is writerKey || position')
})

test('flag/rejected keys a rejected op by its position', async () => {
  const env = new Env()
  const n0 = env.op('A', 'create-concept', { path: 'notes/a', type: 'note' })
  gap(env, 'A')
  // position 2, but the self entry claims 1
  const n2 = env.op('A', 'set-field', { id: env.tag('A', 0), key: 'title', value: ['x'] }, {
    verbatimClock: true,
    clock: [[env.hex('A'), 1]]
  })
  const view = await env.run([n0, n2], { host: hostStub() })
  assert.deepEqual(rejectedReasons(view), { [rk(env.hex('A'), 2)]: 'forged-clock' })
})

test('an op whose handling throws is rejected apply-error at its position', async () => {
  const env = new Env()
  const n0 = env.op('A', 'create-concept', { path: 'notes/a', type: 'note' })
  gap(env, 'A')
  const n2 = env.op('A', 'add-writer', { key: env.key('B'), indexer: false })
  const host = {
    async addWriter() {
      throw new Error('boom')
    }
  }
  const view = await env.run([n0, n2], { host })
  const W = env.hex('A')
  assert.deepEqual(
    JSON.parse((await view.get(K.flagRejected(W, 2))).value),
    { reason: 'apply-error' },
    'containThrow records the node at position 2'
  )
  assert.equal(JSON.parse((await view.get(K.seen(W))).value), 3)
})

test('a node without a positive integer length breaks the transport contract, so apply throws', async () => {
  const env = new Env()
  const n0 = env.op('A', 'create-concept', { path: 'notes/a', type: 'note' })
  for (const length of [undefined, 0, -1, 1.5, '1']) {
    await assert.rejects(
      () => env.run([{ ...n0, length }], { host: hostStub() }),
      TypeError,
      `length ${JSON.stringify(length)} is never an op rejection`
    )
  }
})
