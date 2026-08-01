// @auto-okf/faces ingest watcher on REAL @auto-okf/store vaults: minimal-op
// emission, the full materialize -> edit -> ingest -> materialize roundtrip,
// rename+concurrent-edit merge across a roundtrip, and the guarded delete.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  Bundle,
  materialize,
  createIngestWatcher,
  K,
  tmpDir,
  readBundle,
  bundleDiff,
  pair,
  converged
} from './faces-helpers.js'

async function seedOne(v) {
  const { tag: id } = await v.createConcept('guides/intro', 'Guide')
  await v.setField(id, 'title', 'Intro')
  await v.setField(id, 'description', 'Getting started.')
  await v.setBody(id, null, 'See [architecture](/guides/architecture.md).')
  await v.update()
  return id
}

test('ingest of a single field edit emits exactly one op (minimality)', async () => {
  const v = await Bundle.init(await tmpDir('vault'))
  await seedOne(v)
  const dir = await tmpDir('bundle')
  await materialize(v, dir)

  const f = join(dir, 'guides/intro.md')
  const txt = (await readFile(f, 'utf8')).replace('Getting started.', 'Getting started fast.')
  await writeFile(f, txt)

  const w = await createIngestWatcher(v, dir, { watch: false })
  const ops = await w.ingestFile('guides/intro.md')
  assert.equal(ops.length, 1, 'expected exactly one op, got ' + JSON.stringify(ops))
  assert.equal(ops[0].type, 'set-field')
  assert.equal(ops[0].payload.key, 'description')
  assert.equal(ops[0].payload.value, 'Getting started fast.')
  await w.close()
  await v.close()
})

test('ingest of a body edit emits exactly one SetBody citing the file _rev', async () => {
  const v = await Bundle.init(await tmpDir('vault'))
  const id = await seedOne(v)
  const dir = await tmpDir('bundle')
  await materialize(v, dir)
  const headBefore = await v.val(K.cBody(id))

  const f = join(dir, 'guides/intro.md')
  const txt = (await readFile(f, 'utf8')).replace(
    'See [architecture](/guides/architecture.md).',
    'See [architecture](/guides/architecture.md) and [ops](/guides/ops.md).'
  )
  await writeFile(f, txt)

  const w = await createIngestWatcher(v, dir, { watch: false })
  const ops = await w.ingestFile('guides/intro.md')
  assert.equal(ops.length, 1)
  assert.equal(ops[0].type, 'set-body')
  assert.equal(ops[0].payload.base, headBefore, 'SetBody must cite the head the file carried as _rev')
  await w.close()
  await v.close()
})

test('full roundtrip: materialize -> edit -> ingest -> materialize is stable', async () => {
  const v = await Bundle.init(await tmpDir('vault'))
  await seedOne(v)
  const dir = await tmpDir('bundle')
  await materialize(v, dir)

  const f = join(dir, 'guides/intro.md')
  await writeFile(f, (await readFile(f, 'utf8')).replace('Intro', 'Introduction'))

  const w = await createIngestWatcher(v, dir, { watch: false })
  await w.ingestFile('guides/intro.md')
  await v.update()
  await materialize(v, dir)
  const snapshot = await readBundle(dir)

  // A second ingest pass sees the system's own canonical bytes => no ops.
  const ops2 = await w.scan()
  assert.equal(ops2.length, 0, 'stable bundle must not re-emit ops: ' + JSON.stringify(ops2))
  // A second materialize is byte-identical (stable fixpoint).
  const r = await materialize(v, dir)
  assert.equal(r.written.length, 0, 'stable materialize wrote: ' + JSON.stringify(r.written))
  assert.equal(bundleDiff(snapshot, await readBundle(dir)), null)
  // The edit landed in the view.
  const text = (await readBundle(dir)).get('guides/intro.md')
  assert.match(text, /title: Introduction/)
  await w.close()
  await v.close()
})

test('rename + concurrent edit merge survives the roundtrip', async () => {
  const a = await Bundle.init(await tmpDir('vault-a'))
  const { tag: id } = await a.createConcept('notes/draft', 'Note')
  await a.setBody(id, null, 'version zero')
  await a.update()

  const b = await Bundle.join(await tmpDir('vault-b'), a.key)
  let unpair = pair(a, b)
  assert.ok(await converged([a, b]), 'initial converge failed')
  await a.writers.add(b.localKey)
  assert.ok(await converged([a, b]), 'writer-add converge failed')
  const base = await b.val(K.cBody(id)) // both peers observe v0's head

  // Partition, then concurrent rename (A) + body edit (B).
  unpair()
  await a.setPath(id, 'notes/final')
  await b.setBody(id, base, 'version one')

  // Heal and converge; the edit follows the _id across the rename (merge).
  unpair = pair(a, b)
  assert.ok(await converged([a, b]), 'post-partition converge failed')

  const dir = await tmpDir('bundle')
  await materialize(a, dir)
  const bundle = await readBundle(dir)
  assert.ok(bundle.has('notes/final.md'), 'renamed path missing')
  assert.ok(!bundle.has('notes/draft.md'), 'old path should be gone')
  assert.match(bundle.get('notes/final.md'), /version one/, 'concurrent edit lost')

  // Roundtrip stability: ingest sees only canonical bytes, emits nothing.
  const w = await createIngestWatcher(a, dir, { watch: false })
  const ops = await w.scan()
  assert.equal(ops.length, 0, 'merged bundle re-emitted ops: ' + JSON.stringify(ops))
  await w.close()
  unpair()
  await a.close()
  await b.close()
})

test('deleting a file emits DeleteConcept only when the guard confirms', async () => {
  const v = await Bundle.init(await tmpDir('vault'))
  const id = await seedOne(v)
  const dir = await tmpDir('bundle')
  await materialize(v, dir)

  // Guard default (no confirmer): the delete is skipped, never emitted.
  const wSkip = await createIngestWatcher(v, dir, { watch: false })
  const skipped = []
  wSkip.on('delete-skipped', (e) => skipped.push(e))
  const opsSkip = await wSkip._maybeDelete('guides/intro.md')
  assert.equal(opsSkip.length, 0)
  assert.equal(skipped.length, 1)
  assert.equal(await v.val(K.cMeta(id)).then((m) => m.deleted ?? null), null, 'concept must survive an unconfirmed delete')
  await wSkip.close()

  // With a confirmer: DeleteConcept is emitted and the concept tombstones.
  const wDo = await createIngestWatcher(v, dir, { watch: false, confirmDelete: async () => true })
  const opsDo = await wDo._maybeDelete('guides/intro.md')
  assert.equal(opsDo.length, 1)
  assert.equal(opsDo[0].type, 'delete-concept')
  await v.update()
  const meta = await v.val(K.cMeta(id))
  assert.ok(meta.deleted != null, 'confirmed delete must tombstone the concept')
  await wDo.close()
  await v.close()
})

test('adopting an unknown _id creates the concept (generation-cycle contract)', async () => {
  const v = await Bundle.init(await tmpDir('vault'))
  const dir = await tmpDir('bundle')
  await materialize(v, dir) // establish the manifest + reserved faces

  // A human authors a brand-new file carrying an _id the vault has never seen.
  const adoptedId = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef01'
  await writeFile(
    join(dir, 'imported.md'),
    `---\n_id: ${adoptedId}\ntype: Reference\ntitle: Imported\n---\n\nHello.\n`
  )
  const w = await createIngestWatcher(v, dir, { watch: false })
  const ops = await w.ingestFile('imported.md')
  assert.ok(ops.some((o) => o.type === 'create-concept' && o.payload.id === adoptedId), 'expected adoption')
  await v.update()
  const meta = await v.val(K.cMeta(adoptedId))
  assert.ok(meta !== undefined, 'adopted concept not in view')
  assert.equal((await v.val(K.cPath(adoptedId))).path, 'imported')
  await w.close()
  await v.close()
})

test('oversize body preflight: named refusal, zero ops, siblings unaffected (ADR-005)', async () => {
  const v = await Bundle.init(await tmpDir('vault'))
  const dir = await tmpDir('bundle')
  await materialize(v, dir) // establish the manifest + reserved faces

  // One byte over the limit, plus a comfortably-under sibling. The preflight
  // boundary is body bytes vs maxOpBytes; the per-op encoding overhead on top
  // of the body stays apply's defense-in-depth territory (oversize-op).
  const limit = 65536
  await writeFile(join(dir, 'big.md'), `---\ntype: note\n---\n${'x'.repeat(limit + 1)}\n`)
  await writeFile(join(dir, 'small.md'), `---\ntype: note\n---\n${'y'.repeat(60000)}\n`)

  const w = await createIngestWatcher(v, dir, { watch: false })
  const oversize = []
  w.on('oversize', (e) => oversize.push(e))
  const ops = await w.scan()

  assert.deepEqual(oversize, [{ path: 'big.md', bytes: limit + 1, limit }])
  assert.ok(!ops.some((o) => o.payload && o.payload.path === 'big'), 'zero ops for the oversize file')
  await v.update()
  assert.equal(await v.val(K.path('big')), undefined, 'no concept claims the oversize path')
  assert.notEqual(await v.val(K.path('small')), undefined, 'the sibling still ingested')
  await w.close()
  await v.close()
})
