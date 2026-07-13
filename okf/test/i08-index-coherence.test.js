// I8 Index coherence (okf SPEC §11): path/, link/, bl/, wanted/,
// wantedrank/ and revbybase/ are exactly derivable from c/ at every
// quiescent point — path/ winner selection uses the ord recorded in
// c/<id>/path, so derivability needs no information outside c/.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Env, writerKey } from './helpers.js'
import { extractLinks, dirOf, keyspace as K } from '../core/index.js'

/** Re-derive the §11 I8 families from the c/ family alone. */
function deriveFromC(view) {
  const dump = view.dump()
  const concepts = new Map()
  for (const [key, value] of Object.entries(dump)) {
    if (!key.startsWith('c/')) continue
    const segs = K.parseKey(key)
    const id = segs[1]
    if (!concepts.has(id)) concepts.set(id, { revs: new Map(), fields: {} })
    const c = concepts.get(id)
    if (segs[2] === 'meta') c.meta = value
    else if (segs[2] === 'path') c.path = value
    else if (segs[2] === 'body') c.body = value
    else if (segs[2] === 'rev') c.revs.set(segs[3], value)
  }

  const derived = { path: {}, link: {}, bl: {}, wanted: {}, wantedrank: {}, revbybase: {} }

  // revbybase/: every revision citing a non-null base
  for (const [id, c] of concepts) {
    for (const [rh, rev] of c.revs) {
      if (rev.base !== null) derived.revbybase[K.revByBase(id, rev.base, rh)] = true
    }
  }

  // path/: per exact path, the live claim with the lowest ord
  const claims = new Map()
  for (const [id, c] of concepts) {
    if (!c.meta || c.meta.deleted != null || !c.path) continue
    const cur = claims.get(c.path.path)
    if (!cur || c.path.ord < cur.ord) claims.set(c.path.path, { id, ord: c.path.ord })
  }
  for (const [p, { id }] of claims) derived.path[K.path(p)] = id

  // link/ + bl/ + wanted/(+rank): live concepts' head-text extraction
  const wantedCounts = new Map()
  for (const [id, c] of concepts) {
    if (!c.meta || c.meta.deleted != null || !c.path || c.body === undefined) continue
    const rev = c.revs.get(c.body)
    if (!rev) continue
    for (const t of extractLinks(rev.text, dirOf(c.path.path))) {
      derived.link[K.link(id, t)] = true
      const holder = claims.get(t)
      if (holder) {
        derived.bl[K.bl(holder.id, id)] = true
      } else {
        derived.wanted[K.wanted(t, id)] = true
        wantedCounts.set(t, (wantedCounts.get(t) || 0) + 1)
      }
    }
  }
  for (const [t, n] of wantedCounts) derived.wantedrank[K.wantedRank(n, t)] = n
  return derived
}

function assertCoherent(view) {
  const derived = deriveFromC(view)
  for (const family of ['path', 'link', 'bl', 'wanted', 'wantedrank', 'revbybase']) {
    assert.deepEqual(view.dump(family + '/'), derived[family], `${family}/ derivable from c/`)
  }
}

test('I8: all six index families match a from-c/ derivation across a full lifecycle', async () => {
  const env = new Env({ genesis: 'A' })
  env.op('A', 'add-writer', { key: writerKey('B'), indexer: false })
  env.op('A', 'create-concept', { path: 'wiki/home', type: 'page' })
  const home = env.tag('A', 1)
  env.op('B', 'create-concept', { path: 'wiki/about', type: 'page' })
  const about = env.tag('B', 0)
  env.op('A', 'set-body', { id: home, base: null, text: '[about](/wiki/about) [missing](/wiki/missing) [rel](nested/deep)' })
  env.op('B', 'set-body', { id: about, base: null, text: 'back to [home](/wiki/home) and [missing](/wiki/missing)' })
  assertCoherent(await env.run())

  // rename: relative links re-resolve, inbound edges follow
  env.op('A', 'set-path', { id: home, path: 'wiki/start' })
  assertCoherent(await env.run())

  // collision: two claims on one path
  env.op('B', 'set-path', { id: about, path: 'wiki/start' })
  assertCoherent(await env.run())

  // deletion vacates path + edges; undelete restores
  env.op('A', 'delete-concept', { id: home })
  assertCoherent(await env.run())
  env.op('A', 'undelete-concept', { id: home })
  assertCoherent(await env.run())

  // body edit changes the link set
  const dump = (await env.run()).dump()
  const head = dump[`c/${home}/body`]
  env.op('A', 'set-body', { id: home, base: head, text: 'only [missing](/wiki/missing) now' })
  assertCoherent(await env.run())

  // wanted target materializes late
  env.op('B', 'create-concept', { path: 'wiki/missing', type: 'page' })
  assertCoherent(await env.run())
})

test('I8: casefold losers retain path/<exact path> and stay link-resolvable', async () => {
  const env = new Env({ genesis: 'A' })
  env.op('A', 'create-concept', { path: 'Docs/Guide', type: 'page' })
  env.op('A', 'create-concept', { path: 'docs/guide', type: 'page' })
  const loser = env.tag('A', 1)
  env.op('A', 'create-concept', { path: 'src', type: 'page' })
  const src = env.tag('A', 2)
  env.op('A', 'set-body', { id: src, base: null, text: '[x](/docs/guide)' })
  const view = await env.run()
  assertCoherent(view)
  assert.equal(view.dump('path/docs%2Fguide')['path/docs%2Fguide'], loser)
  assert.deepEqual(Object.keys(view.dump(`bl/${loser}/`)), [`bl/${loser}/${src}`])
})
