// I7 Conflict lifecycle (okf SPEC §5, §7, §11): same-non-null-base
// siblings persist until ResolveConflict; wanted/ entries clear when their
// path materializes; pathcollision flags clear when the loser gets a free
// path (or the winner vacates).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Env, writerKey, keysUnder, rejectedReasons } from './helpers.js'
import { revHash } from '../core/index.js'

test('I7: same-base siblings both persist under one conflict flag until resolved', async () => {
  const env = new Env({ genesis: 'A' })
  env.op('A', 'create-concept', { path: 'c/doc', type: 'note' })
  const id = env.tag('A', 0)
  env.op('A', 'add-writer', { key: writerKey('B'), indexer: false })
  env.op('A', 'set-body', { id, base: null, text: 'base' })
  const r0 = revHash(null, 'base')
  const base = env.observedAll()
  env.op('A', 'set-body', { id, base: r0, text: 'edit A' }, { clock: base })
  env.op('B', 'set-body', { id, base: r0, text: 'edit B' }, { clock: base })
  const rA = revHash(r0, 'edit A')
  const rB = revHash(r0, 'edit B')
  const view = await env.run()
  // both retained, deterministic head (later linearized), exactly one flag
  assert.equal(Object.keys(view.dump(`c/${id}/rev/`)).length, 3)
  assert.equal(view.dump(`c/${id}/body`)[`c/${id}/body`], rB)
  const conflictKeys = keysUnder(view, `flag/conflict/${id}/`)
  assert.equal(conflictKeys.length, 1)
  const [a, b] = [rA, rB].sort()
  assert.ok(conflictKeys[0].endsWith(`/${a}/${b}`))

  // ResolveConflict keeps one, clears the cited flag
  env.op('A', 'resolve-conflict', { id, keep: rA, supersede: [rB] })
  const view2 = await env.run()
  assert.equal(keysUnder(view2, `flag/conflict/${id}/`).length, 0)
  assert.equal(view2.dump(`c/${id}/body`)[`c/${id}/body`], rA)

  // a replayed resolve over the now-cleared flags is rejected bad-resolve
  env.op('B', 'resolve-conflict', { id, keep: rB, supersede: [rA] })
  const view3 = await env.run()
  assert.ok(Object.values(rejectedReasons(view3)).includes('bad-resolve'))
  assert.equal(view3.dump(`c/${id}/body`)[`c/${id}/body`], rA, 'losing resolve has no effect')
})

test('I7: resolve with text synthesizes a merged revision based on keep', async () => {
  const env = new Env({ genesis: 'A' })
  env.op('A', 'create-concept', { path: 'c/m', type: 'note' })
  const id = env.tag('A', 0)
  env.op('A', 'set-body', { id, base: null, text: 'root' })
  const r0 = revHash(null, 'root')
  const base = env.observedAll()
  env.op('A', 'set-body', { id, base: r0, text: 'x' }, { clock: base })
  env.op('A', 'set-body', { id, base: r0, text: 'y' }, { clock: base })
  const rx = revHash(r0, 'x')
  const ry = revHash(r0, 'y')
  env.op('A', 'resolve-conflict', { id, keep: rx, supersede: [ry], text: 'merged' })
  const view = await env.run()
  const merged = revHash(rx, 'merged')
  assert.equal(view.dump(`c/${id}/body`)[`c/${id}/body`], merged)
  assert.equal(view.dump(`c/${id}/rev/`)[`c/${id}/rev/${merged}`].base, rx)
  assert.equal(keysUnder(view, `flag/conflict/${id}/`).length, 0)
})

test('I7: wanted/ entries (and rank) clear when a concept lands on the path', async () => {
  const env = new Env({ genesis: 'A' })
  env.op('A', 'create-concept', { path: 'w/src1', type: 'note' })
  env.op('A', 'create-concept', { path: 'w/src2', type: 'note' })
  const s1 = env.tag('A', 0)
  const s2 = env.tag('A', 1)
  env.op('A', 'set-body', { id: s1, base: null, text: '[t](/w/target)' })
  env.op('A', 'set-body', { id: s2, base: null, text: 'also [t](/w/target)' })
  const view = await env.run()
  assert.equal(keysUnder(view, 'wanted/w%2Ftarget/').length, 2)
  assert.equal(keysUnder(view, 'wantedrank/').length, 1)
  assert.ok(keysUnder(view, 'wantedrank/')[0].startsWith('wantedrank/9999999999999997/'))

  env.op('A', 'create-concept', { path: 'w/target', type: 'note' })
  const target = env.tag('A', 4)
  const view2 = await env.run()
  assert.equal(keysUnder(view2, 'wanted/').length, 0, 'demand cleared')
  assert.equal(keysUnder(view2, 'wantedrank/').length, 0)
  assert.deepEqual(keysUnder(view2, `bl/${target}/`).length, 2, 'both edges promoted to backlinks')
})

test('I7: pathcollision clears on the loser’s own rename', async () => {
  const env = new Env({ genesis: 'A' })
  env.op('A', 'create-concept', { path: 'p/spot', type: 'note' })
  const winner = env.tag('A', 0)
  env.op('A', 'create-concept', { path: 'p/spot', type: 'note' })
  const loser = env.tag('A', 1)
  const view = await env.run()
  assert.equal(view.dump('path/p%2Fspot')['path/p%2Fspot'], winner, 'first claim wins')
  assert.equal(keysUnder(view, `flag/pathcollision/p%2Fspot/`).length, 1)

  env.op('A', 'set-path', { id: loser, path: 'p/free' })
  const view2 = await env.run()
  assert.equal(keysUnder(view2, 'flag/pathcollision/').length, 0, 'flag cleared')
  assert.equal(view2.dump('path/p%2Ffree')['path/p%2Ffree'], loser)
})

test('I7: pathcollision clears when the winner vacates (rename / delete)', async () => {
  const env = new Env({ genesis: 'A' })
  env.op('A', 'create-concept', { path: 'q/spot', type: 'note' })
  const winner = env.tag('A', 0)
  env.op('A', 'create-concept', { path: 'q/spot', type: 'note' })
  const loser = env.tag('A', 1)
  env.op('A', 'delete-concept', { id: winner })
  const view = await env.run()
  assert.equal(keysUnder(view, 'flag/pathcollision/').length, 0, 'loser freed by vacation')
  assert.equal(view.dump('path/q%2Fspot')['path/q%2Fspot'], loser, 'loser promoted to holder')
})
