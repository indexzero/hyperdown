// I1 Determinism (okf SPEC §11): apply is a pure function of the
// linearized op sequence — same sequence, bit-identical views; and the
// source carries no wall clock / randomness / peer-local reads (enforced
// by a source scan, per the assignment).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Env, writerKey } from './helpers.js'

const LIB = join(dirname(fileURLToPath(import.meta.url)), '..', 'core', 'lib')

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
  // timestamps differ where recorded, but every merge-relevant row agrees
  const strip = (v) => {
    const d = v.dump()
    for (const k of Object.keys(d)) {
      if (d[k] && typeof d[k] === 'object' && 'at' in d[k]) delete d[k].at
    }
    return d
  }
  assert.deepEqual(strip(v1), strip(v2))
})
