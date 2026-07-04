// Faces roundtrip: materialize → human edit → ingest → converge →
// materialize is stable (the second materialize regenerates canonical
// bytes and the next ingest pass is quiescent), placement survives via
// vld:path/§9.3, and edits converge across writers (I9 at face level).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  Vault,
  K,
  faces,
  tmpDir,
  seedVault,
  treeHash,
  readText,
  captureOps,
  pair,
  until,
  converged
} from './faces-helpers.js'

const { materialize, createIngestWatcher, exportTurtle } = faces

test('materialize → edit → ingest → materialize reaches a stable fixed point', async (t) => {
  const v = await Vault.init(await tmpDir('rt-vault'))
  const dir = await tmpDir('rt-face')
  t.after(() => v.close())
  await seedVault(v)
  await materialize(v, dir)

  const w = await createIngestWatcher(v, dir, { watch: false })
  t.after(() => w.close())

  // a human edit: field + body, written with non-canonical spacing so the
  // regenerated canonical bytes differ from the edit
  const edited =
    '---\ntitle:   "Welcome home, edited"\nservings: 4\ntags: [demo, wiki]\nmood: blue\ntopic: [ "[[Recipe]]" , p2p ]\n---\n\nEdited body\n'
  await writeFile(join(dir, 'Home.md'), edited)
  const ops1 = await w.ingestFile('Home.md')
  assert.ok(ops1.length > 0, 'edit produced ops')

  const r2 = await materialize(v, dir)
  assert.ok(r2.written.includes('Home.md'), 'canonical bytes regenerated after ingest')
  const canon = await readText(dir, 'Home.md')
  assert.match(canon, /title: "Welcome home, edited"/)
  assert.match(canon, /\n\nEdited body\n$/)

  // fixed point: nothing more to ingest, nothing more to write
  const ops2 = await w.scan()
  assert.equal(ops2.length, 0, 'post-materialize ingest pass is quiescent')
  const before = await treeHash(dir)
  const r3 = await materialize(v, dir)
  assert.equal(r3.written.length, 0)
  assert.equal(await treeHash(dir), before, 'materialize is idempotent at the fixed point')
})

test('note placement roundtrips: authored path → vld:path → identical rebuild (§9.3/§10.4)', async (t) => {
  const v = await Vault.init(await tmpDir('rt-path-vault'))
  t.after(() => v.close())
  await seedVault(v)
  const dir = await tmpDir('rt-path-face')
  await materialize(v, dir)

  // Pinned sits off its reconstructable default
  const ttl = await tmpDir('rt-path-ttl')
  await exportTurtle(v, ttl, { roundtrip: true })
  const data = await readText(ttl, 'data.ttl')
  assert.match(
    data,
    /<vault:\/\/data\/Pinned> vld:path "Notes\/Deep\/Pinned\.md" \./,
    'vld:path emitted for the non-default location'
  )
  assert.ok(!data.includes('<vault://data/Home> vld:path'), 'omitted at the reconstructable default')

  // and the on-disk face honors the same path on a fresh materialize
  const dir2 = await tmpDir('rt-path-face2')
  await materialize(v, dir2)
  assert.equal(await treeHash(dir2), await treeHash(dir), 'placement identical across materializations')
  assert.equal(await readText(dir2, 'Notes/Deep/Pinned.md'), await readText(dir, 'Notes/Deep/Pinned.md'))
})

test('human edits ingest on one writer and converge to identical faces on another (I2 → I9)', async (t) => {
  const a = await Vault.init(await tmpDir('rt-conv-a'))
  const b = await Vault.join(await tmpDir('rt-conv-b'), a.key)
  const unpair = pair(a, b)
  t.after(async () => {
    unpair()
    await a.close()
    await b.close()
  })
  await a.addWriter(b.localKey, { indexer: false })
  assert.ok(
    await until(async () => {
      await b.update()
      return b.writable
    }),
    'b becomes writable'
  )
  await seedVault(a)
  assert.ok(await converged([a, b]), 'seed converges')

  // human edit enters through b's face
  const faceB = await tmpDir('rt-conv-face-b')
  await materialize(b, faceB)
  const wb = await createIngestWatcher(b, faceB, { watch: false })
  t.after(() => wb.close())
  const ops = captureOps(wb)
  const home = await readText(faceB, 'Home.md')
  await writeFile(join(faceB, 'Home.md'), home.replace('title: Welcome home', 'title: Edited on b'))
  await wb.ingestFile('Home.md')
  assert.equal(ops.length, 1)

  assert.ok(await converged([a, b]), 'edit converges to a')
  const faceA = await tmpDir('rt-conv-face-a')
  await materialize(a, faceA)
  await materialize(b, faceB)
  assert.equal(await treeHash(faceA), await treeHash(faceB), 'both peers materialize identical bytes (I9)')
  assert.match(await readText(faceA, 'Home.md'), /title: Edited on b/)
})
