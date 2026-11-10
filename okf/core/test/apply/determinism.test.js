// I1, I2, I3 (SPEC §11): apply is a pure function of the linearized op
// sequence. I1: apply reads no clock, randomness or peer-local state. I2:
// one linearization gives bit-identical views. I3: a rebuild from scratch
// equals the incremental view, so apply carries no state between calls
// beyond the view.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Env, writerKey } from '../helpers.js'
import { MemView } from '../../index.js'

const LIB = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'lib')

function mixedScenario() {
  const env = new Env({ genesis: 'A' })
  const A = env.hex('A')
  env.op('A', 'create-concept', { path: 'notes/alpha', type: 'note' })
  const id = env.tag('A', 0)
  env.op('A', 'add-writer', { key: writerKey('B'), indexer: false })
  env.op('A', 'set-body', { id, base: null, text: 'see [beta](/notes/beta)' })
  env.op('B', 'add-tag', { id, value: 'draft' })
  env.op('B', 'set-field', { id, key: 'status', value: ['open'] })
  env.op('A', 'set-field', { id, key: 'status', value: ['closed'] })
  env.op('B', 'create-concept', { path: 'notes/beta', type: 'note' })
  env.op('A', 'set-path', { id, path: 'notes/alpha-renamed' })
  env.op('B', 'delete-concept', { id: env.tag('B', 3) })
  env.raw('B', Buffer.from('garbage bytes, not an op'))
  return env
}

test('I1: identical linearizations produce bit-identical views', async () => {
  const h1 = (await mixedScenario().run()).hash()
  const h2 = (await mixedScenario().run()).hash()
  assert.equal(h1, h2)
})

test('I1: apply sources are clock-, randomness- and peer-state-free', async () => {
  const files = (await readdir(LIB)).filter((f) => f.endsWith('.js'))
  assert.ok(files.includes('apply.js'))
  for (const f of files) {
    const src = await readFile(join(LIB, f), 'utf8')
    for (const forbidden of [
      /Date\.now/,
      /Math\.random/,
      /hrtime/,
      /performance\.now/,
      /process\.env/,
      /signedLength/, // peer-local replication state (SPEC §11 I1)
      /\bheads\(/
    ]) {
      assert.ok(!forbidden.test(src), `${f} must not match ${forbidden}`)
    }
  }
})

test('I1: `at` is informational only — different timestamps, same semantic state', async () => {
  const build = (atBase) => {
    const env = new Env({ genesis: 'A' })
    env.atCounter = atBase
    env.op('A', 'create-concept', { path: 'a', type: 'note' })
    env.op('A', 'set-field', { id: env.tag('A', 0), key: 'x', value: [1] })
    return env
  }
  const v1 = await build(1700000000000).run()
  const v2 = await build(999).run()
  // strip `at`, the one field that differs
  const strip = (v) => {
    const d = v.dump()
    for (const k of Object.keys(d)) {
      if (d[k] && typeof d[k] === 'object' && 'at' in d[k]) delete d[k].at
    }
    return d
  }
  assert.deepEqual(strip(v1), strip(v2))
})

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
  env.raw('A', Buffer.alloc(70000)) // oversize, rejected but counted in seen/
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
