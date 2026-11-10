// Paths (SPEC §3, §4, §7): the paths that apply rejects, the casefold
// collision rule, and the escaping that keeps a hostile string inside its
// key family.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Env, keysUnder, rejectedReasons } from '../helpers.js'
import { keyspace as K, makeTag } from '../../index.js'

test('§7: casefold collision — loser flagged on every platform, keeps its exact path/', async () => {
  const env = new Env({ genesis: 'A' })
  env.op('A', 'create-concept', { path: 'Notes/Réunion', type: 'note' })
  const winner = env.tag('A', 0)
  // NFD input casefolding to the same claim (NFC + casefold in apply)
  env.op('A', 'create-concept', { path: 'notes/réunion', type: 'note' })
  const loser = env.tag('A', 1)
  const view = await env.run()
  const flagKeys = keysUnder(view, 'flag/pathcollision/')
  assert.equal(flagKeys.length, 1)
  assert.ok(flagKeys[0].includes(loser))
  assert.equal(Object.values(view.dump(flagKeys[0]))[0].against, winner)
  assert.equal(view.dump('path/notes%2Fréunion')['path/notes%2Fréunion'], loser)
  assert.equal(view.dump('path/Notes%2FRéunion')['path/Notes%2FRéunion'], winner)
})

test('§7: reserved paths — index/log terminals (casefolded) and conflict-copy suffixes reject', async () => {
  const env = new Env({ genesis: 'A' })
  env.op('A', 'create-concept', { path: 'a/index', type: 'note' })
  env.op('A', 'create-concept', { path: 'a/INDEX.md', type: 'note' }) // .md strip + casefold
  env.op('A', 'create-concept', { path: 'b/Log', type: 'note' })
  env.op('A', 'create-concept', { path: 'a/b.conflict-deadbeef', type: 'note' })
  env.op('A', 'create-concept', { path: 'a/b.conflict-' + 'a'.repeat(64), type: 'note' })
  env.op('A', 'create-concept', { path: 'ok/page', type: 'note' })
  env.op('A', 'set-path', { id: env.tag('A', 5), path: 'ok/log' })
  const view = await env.run()
  assert.deepEqual(Object.values(rejectedReasons(view)), [
    'reserved-path',
    'reserved-path',
    'reserved-path',
    'reserved-path',
    'reserved-path',
    'reserved-path'
  ])
  assert.equal(view.dump(`c/${env.tag('A', 5)}/path`)[`c/${env.tag('A', 5)}/path`].path, 'ok/page')
})

test('§7: unsafe paths reject in apply', async () => {
  const env = new Env({ genesis: 'A' })
  for (const path of ['/absolute', '../escape', 'a/../../up', 'a//b', 'a\\b', 'C:/drive', 'a/./b']) {
    env.op('A', 'create-concept', { path, type: 'note' })
  }
  const view = await env.run()
  assert.deepEqual(
    Object.values(rejectedReasons(view)),
    Array(7).fill('unsafe-path')
  )
  assert.equal(keysUnder(view, 'c/').length, 0)
})

test('§3: path limits — oversize path and excessive depth reject in fixed order', async () => {
  const env = new Env({ genesis: 'A' })
  env.op('A', 'create-concept', { path: 'x'.repeat(1025), type: 'note' })
  env.op('A', 'create-concept', { path: Array(65).fill('d').join('/'), type: 'note' })
  const view = await env.run()
  assert.deepEqual(Object.values(rejectedReasons(view)), ['oversize-path', 'depth-exceeded'])
})

test('§4: hostile strings cannot escape their key family', async () => {
  const env = new Env({ genesis: 'A' })
  env.op('A', 'create-concept', { path: 'inj/gov%2Fwriter', type: 'note' })
  const id = env.tag('A', 0)
  env.op('A', 'set-field', { id, key: 'a/b/../c', value: ['x'] })
  env.op('A', 'add-tag', { id, value: 'flag/rejected/evil' })
  env.op('A', 'rem-tag', { id, value: 'x/y', tags: [makeTag(env.hex('A'), 99)] })
  env.op('A', 'set-body', { id, base: null, text: 'link to [e](/inj/%25real)' })
  const view = await env.run()
  for (const key of view.sortedKeys()) {
    const family = key.split('/')[0]
    assert.ok(
      ['c', 'path', 'pcl', 'link', 'bl', 'wanted', 'wantedrank', 'log', 'flag', 'seen', 'gov', 'rate', 'ord', 'revbybase'].includes(family),
      `unexpected family for ${key}`
    )
  }
  const fieldKeys = keysUnder(view, `c/${id}/f/`)
  assert.ok(fieldKeys.includes(`c/${id}/f/a%2Fb%2F..%2Fc`))
  assert.deepEqual(K.parseKey(`c/${id}/f/a%2Fb%2F..%2Fc`), ['c', id, 'f', 'a/b/../c'])
  assert.equal(keysUnder(view, 'gov/').length, 1, 'only the genesis writer record')
  const stale = keysUnder(view, `flag/staletag/${id}/`)
  assert.equal(stale.length, 1)
  assert.equal(K.parseKey(stale[0])[3], 'x/y')
})
