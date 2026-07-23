// Adversarial cases the spec reviews surfaced (okf SPEC changelog): N1
// squat-proof minting (incl. future/unacked writer), M4 reserved field
// keys, M5 fabricated-base SetBody, casefold path collision, keyspace
// injection/escaping, empty-type, reserved paths.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Env, writerKey, keysUnder, rejectedReasons } from './helpers.js'
import { keyspace as K, makeTag } from '../core/index.js'

// ---------- §6 / N1: squat-proof minting ----------

test('N1: adopting an id shaped like a KNOWN writer’s future mint is rejected', async () => {
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

test('N1: an unacked writer’s future mints are protected too (seen/ counts every node)', async () => {
  const env = new Env({ genesis: 'A' })
  env.op('D', 'create-concept', { path: 'opt/held', type: 'note' }) // D unacked, held; seen/D = 1
  env.op('A', 'create-concept', { id: makeTag(env.hex('D'), 3), path: 'squat/d', type: 'note' })
  const view = await env.run()
  assert.deepEqual(Object.values(rejectedReasons(view)), ['mint-collision-risk'])
})

test('N1: a squat on an UNKNOWN future writer cannot block its mint — fallback + flag/squat', async () => {
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

test('N1: a non-minimal hex suffix is not mint-shaped and adopts freely', async () => {
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

// ---------- §5 / M4: reserved field keys ----------

test('M4: SetField on tags/_id/_rev is rejected reserved-key', async () => {
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

test('N4: empty type is unreachable — create and set-field both reject', async () => {
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

// ---------- §5 / M5: fabricated-base SetBody ----------

test('M5: a fabricated base is stored + flagged against the head and never becomes head', async () => {
  const env = new Env({ genesis: 'A' })
  env.op('A', 'create-concept', { path: 'm5/doc', type: 'note' })
  const id = env.tag('A', 0)
  env.op('A', 'set-body', { id, base: null, text: 'real head' })
  const { revHash } = await import('../core/index.js')
  const realHead = revHash(null, 'real head')
  const fake = 'ab'.repeat(32) // well-formed, absent from c/<id>/rev/
  env.op('A', 'set-body', { id, base: fake, text: 'forged ancestry' })
  const forged = revHash(fake, 'forged ancestry')
  const view = await env.run()
  assert.equal(view.dump(`c/${id}/body`)[`c/${id}/body`], realHead, 'head undisplaced')
  assert.notEqual(view.dump(`c/${id}/rev/`)[`c/${id}/rev/${forged}`], undefined, 'stored (I4)')
  assert.notEqual(view.dump(`flag/conflict/${id}/`)[`flag/conflict/${id}/${realHead}/${forged}`], undefined)

  // only ResolveConflict can elevate it
  env.op('A', 'resolve-conflict', { id, keep: forged, supersede: [realHead] })
  const view2 = await env.run()
  assert.equal(view2.dump(`c/${id}/body`)[`c/${id}/body`], forged)
  assert.equal(keysUnder(view2, `flag/conflict/${id}/`).length, 0)
})

test('M5: fabricated base with NO head flags against `-` and stays bodyless', async () => {
  const env = new Env({ genesis: 'A' })
  env.op('A', 'create-concept', { path: 'm5/fresh', type: 'note' })
  const id = env.tag('A', 0)
  const fake = 'cd'.repeat(32)
  env.op('A', 'set-body', { id, base: fake, text: 'orphan' })
  const view = await env.run()
  assert.equal(view.dump(`c/${id}/body`)[`c/${id}/body`], undefined, 'bodyless until resolve')
  assert.equal(keysUnder(view, `flag/conflict/${id}/-/`).length, 1)
})

test('M5: a non-hash-shaped base is rejected outright', async () => {
  const env = new Env({ genesis: 'A' })
  env.op('A', 'create-concept', { path: 'm5/garbage', type: 'note' })
  const id = env.tag('A', 0)
  env.op('A', 'set-body', { id, base: 'not-a-hash', text: 'x' })
  const view = await env.run()
  assert.deepEqual(Object.values(rejectedReasons(view)), ['bad-base'])
})

// ---------- §7: casefold collision + reserved paths ----------

test('§7: casefold collision — loser flagged on every platform, keeps its exact path/', async () => {
  const env = new Env({ genesis: 'A' })
  env.op('A', 'create-concept', { path: 'Notes/Réunion', type: 'note' })
  const winner = env.tag('A', 0)
  // NFD input casefolding to the same claim (NFC + casefold in apply)
  env.op('A', 'create-concept', { path: 'notes/réunion', type: 'note' })
  const loser = env.tag('A', 1)
  const view = await env.run()
  const flagKeys = keysUnder(view, 'flag/pathcollision/')
  assert.equal(flagKeys.length, 1)
  assert.ok(flagKeys[0].includes(loser))
  assert.equal(Object.values(view.dump(flagKeys[0]))[0].against, winner)
  // casefold loser retains path/<its exact path> (NFC form)
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

// ---------- §4: keyspace injection / escaping ----------

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
      ['c', 'path', 'pcl', 'link', 'bl', 'wanted', 'wantedrank', 'log', 'flag', 'seen', 'gov', 'rate', 'ord', 'hold', 'revbybase'].includes(family),
      `unexpected family for ${key}`
    )
  }
  // the field key round-trips through escaping
  const fieldKeys = keysUnder(view, `c/${id}/f/`)
  assert.ok(fieldKeys.includes(`c/${id}/f/a%2Fb%2F..%2Fc`))
  assert.deepEqual(K.parseKey(`c/${id}/f/a%2Fb%2F..%2Fc`), ['c', id, 'f', 'a/b/../c'])
  // gov/ was never touched by the hostile path
  assert.equal(keysUnder(view, 'gov/').length, 1, 'only the genesis writer record')
  // staletag flag key embeds the hostile value, escaped
  const stale = keysUnder(view, `flag/staletag/${id}/`)
  assert.equal(stale.length, 1)
  assert.equal(K.parseKey(stale[0])[3], 'x/y')
})

test('§6: adopting an unknown _id (epoch-cycle contract) works and preserves identity', async () => {
  const env = new Env({ genesis: 'A' })
  const carried = 'abcdef0123456789' // 16-hex id from a predecessor epoch
  env.op('A', 'create-concept', { id: carried, path: 'epoch/doc', type: 'note' })
  env.op('A', 'set-body', { id: carried, base: null, text: 'carried across' })
  const view = await env.run()
  assert.deepEqual(rejectedReasons(view), {})
  assert.equal(view.dump(`c/${carried}/meta`)[`c/${carried}/meta`].type, 'note')
})
