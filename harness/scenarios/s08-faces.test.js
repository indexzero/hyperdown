// S8 (I9) face determinism. After convergence, materialize and Turtle
// export on two different peers must be byte-identical. Then ingest a
// human edit (modify one field of a materialized file on disk) and assert
// the emitted ops are minimal — field-level, never whole-file — by
// inspecting the recorded op stream.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { setupVaultCluster } from '../lib/setup.js'

async function listFiles(dir, base = '') {
  const out = []
  for (const e of await readdir(join(dir, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...(await listFiles(dir, rel)))
    else out.push(rel)
  }
  return out.sort()
}

async function assertDirsEqual(d1, d2, label) {
  const [f1, f2] = await Promise.all([listFiles(d1), listFiles(d2)])
  assert.deepEqual(f1, f2, `${label}: same file sets`)
  for (const rel of f1) {
    const [b1, b2] = await Promise.all([readFile(join(d1, rel)), readFile(join(d2, rel))])
    assert.ok(b1.equals(b2), `${label}: ${rel} differs byte-for-byte`)
  }
}

test('S8: materialize + Turtle are byte-identical across peers; ingest is minimal (I9)', async (t) => {
  const { ctl, writers } = await setupVaultCluster('s08', 2)
  t.after(() => ctl.stop())
  const [a, b] = writers

  await a.call('defineScope', 'culinary', 'https://example.org/culinary#', 'cul')
  await a.call('defineTerm', 'culinary', 'title', { '@id': 'cul:title' })
  await a.call('defineTerm', 'culinary', 'topic', { '@id': 'cul:topic', '@container': '@set' })
  await a.call('setField', 'Home', 'title', 'Welcome home')
  await b.call('addMember', 'Home', 'topic', { ref: 'Recipe' })
  await b.call('addMember', 'Home', 'topic', 'plain-topic')
  await a.call('setBody', 'Home', null, 'Hello **world**')
  await b.call('setField', 'Recipe', 'title', 'A recipe')
  await ctl.quiesce(writers)

  // byte-diff the projections of two different peers
  const faceA = join(ctl.baseDir, 'face-a')
  const faceB = join(ctl.baseDir, 'face-b')
  await a.cmd('materialize', { dir: faceA })
  await b.cmd('materialize', { dir: faceB })
  await assertDirsEqual(faceA, faceB, 'materialize')

  const ttlA = join(ctl.baseDir, 'ttl-a')
  const ttlB = join(ctl.baseDir, 'ttl-b')
  await a.cmd('exportTurtle', { dir: ttlA })
  await b.cmd('exportTurtle', { dir: ttlB })
  await assertDirsEqual(ttlA, ttlB, 'turtle')

  // human edit: one field changes in one file
  const home = await readFile(join(faceA, 'Home.md'), 'utf8')
  assert.ok(home.includes('Welcome home'), 'materialized field present')
  await writeFile(join(faceA, 'Home.md'), home.replace('Welcome home', 'Hello there'))

  const ops = await a.cmd('ingest', { dir: faceA })
  assert.equal(ops.length, 1, `minimal op set (got ${JSON.stringify(ops.map((o) => o.type))})`)
  assert.equal(ops[0].type, 'set-field')
  assert.equal(ops[0].payload.p, 'title')
  assert.equal(ops[0].payload.o, 'Hello there')

  // the edit round-trips: converge and re-materialize on the OTHER peer
  const hash = await ctl.quiesce(writers)
  assert.ok(hash)
  const faceB2 = join(ctl.baseDir, 'face-b2')
  await b.cmd('materialize', { dir: faceB2 })
  const homeB = await readFile(join(faceB2, 'Home.md'), 'utf8')
  assert.ok(homeB.includes('Hello there'), 'edited field visible on the other peer')
})
