// @auto-okf/faces ingest watcher on REAL @auto-okf/store vaults: minimal-op
// emission, the full materialize -> edit -> ingest -> materialize roundtrip,
// rename+concurrent-edit merge across a roundtrip, and the guarded delete.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { encodeOp } from '../core/index.js'
import {
  Bundle,
  materialize,
  createIngestWatcher,
  K,
  makeTag,
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
  // encodes the set-body op, so the op of the big body is over the limit by
  // the body's extra byte and the op's other fields (D-048 F02).
  const limit = 65536
  await writeFile(join(dir, 'big.md'), `---\ntype: note\n---\n${'x'.repeat(limit + 1)}\n`)
  await writeFile(join(dir, 'small.md'), `---\ntype: note\n---\n${'y'.repeat(60000)}\n`)

  const w = await createIngestWatcher(v, dir, { watch: false })
  const oversize = []
  w.on('oversize', (e) => oversize.push(e))
  const ops = await w.scan()

  assert.equal(oversize.length, 1)
  const { opBytes, ...named } = oversize[0]
  assert.deepEqual(named, { path: 'big.md', bytes: limit + 1, limit })
  assert.ok(opBytes > limit + 1, `the encoded op (${opBytes} bytes) holds more than the body`)
  assert.ok(!ops.some((o) => o.payload && o.payload.path === 'big'), 'zero ops for the oversize file')
  await v.update()
  assert.equal(await v.val(K.path('big')), undefined, 'no concept claims the oversize path')
  assert.notEqual(await v.val(K.path('small')), undefined, 'the sibling still ingested')
  await w.close()
  await v.close()
})

// ---------- D-048 F02: the preflight checks the encoded op ----------

test('the oversize preflight encodes the set-body op: a body just below maxOpBytes whose op is over it appends nothing and stays pending (D-048 F02)', async (t) => {
  // apply measures the encoded op (core apply.js `raw.length > maxOpBytes`),
  // and the set-body op adds the id, the base, the clock and `at` to the
  // body. A body under the limit can encode to an op over it. Before the
  // fix, ingest appended such a file, core rejected its set-body
  // oversize-op, ingest recorded the file as ingested, and the next
  // materialize overwrote it with the empty concept.
  const limit = 4096
  const v = await Bundle.init(await tmpDir('vault'), { metadata: { limits: { maxOpBytes: limit } } })
  const dir = await tmpDir('bundle')
  const w = await createIngestWatcher(v, dir, { watch: false })
  t.after(async () => {
    await w.close()
    await v.close()
  })
  await materialize(v, dir)
  const self = v.localKey.toString('hex')
  // The set-body op of a new note, as the store appends it in this vault:
  // a minted id of seq 0 or 2 (65 hex characters), no base, and a clock
  // that holds only self, at seq 1 or 3.
  const opBytes = (n, seq) =>
    encodeOp('set-body', { id: makeTag(v.localKey, seq - 1), base: null, text: 'x'.repeat(n), clock: [[self, seq]], at: Date.now() }).byteLength
  let edge = limit
  while (opBytes(edge, 1) > limit) edge--
  assert.equal(opBytes(edge, 1), limit, 'the op of the edge body is exactly maxOpBytes')
  assert.equal(opBytes(edge + 1, 3), limit + 1)
  assert.ok(edge + 1 < limit, `the over body (${edge + 1} bytes) is below maxOpBytes`)
  await writeFile(join(dir, 'edge.md'), `---\ntype: note\n---\n${'x'.repeat(edge)}\n`)
  await writeFile(join(dir, 'over.md'), `---\ntype: note\n---\n${'x'.repeat(edge + 1)}\n`)

  const oversize = []
  w.on('oversize', (e) => oversize.push(e))
  const ops = await w.scan()

  assert.deepEqual(oversize, [{ path: 'over.md', bytes: edge + 1, limit, opBytes: limit + 1 }])
  assert.deepEqual(ops.map((o) => o.type), ['create-concept', 'set-body'], 'the ops of edge.md, and none of over.md')
  await v.update()
  assert.equal(await v.val(K.path('over')), undefined, 'no concept claims the path of over.md')
  const edgeId = await v.val(K.path('edge'))
  const head = await v.val(K.cBody(edgeId))
  assert.equal((await v.val(K.cRev(edgeId, head))).text, 'x'.repeat(edge), 'an op of exactly maxOpBytes takes effect')
  assert.deepEqual(await rejectedOf(v), {}, 'core rejects no op')

  const before = await readFile(join(dir, 'over.md'), 'utf8')
  const report = await materialize(v, dir)
  assert.ok(report.pendingIngest.includes('over.md'), 'over.md stays pending')
  assert.equal(await readFile(join(dir, 'over.md'), 'utf8'), before, 'materialize keeps over.md')
})

test('a body that core rejects on an established concept is not recorded as ingested: it stays pending, materialize keeps it, and ingest names the rejection (D-048 F02)', async (t) => {
  // The writer may write under team/ only, so core rejects its set-body on
  // other/x policy-namespace. Before the fix, ingest recorded the file as
  // ingested before core's verdict, so the next materialize overwrote the
  // human edit with the head that the vault still holds.
  const v = await Bundle.init(await tmpDir('vault'))
  const dir = await tmpDir('bundle')
  const w = await createIngestWatcher(v, dir, { watch: false })
  t.after(async () => {
    await w.close()
    await v.close()
  })
  const { tag: id } = await v.createConcept('other/x', 'note')
  await v.setBody(id, null, 'first')
  await materialize(v, dir)
  await v.writers.setPolicy(v.localKey, { namespacePrefixes: ['team'] })
  await v.update()

  const f = join(dir, 'other/x.md')
  const edited = (await readFile(f, 'utf8')).replace('first', 'second')
  await writeFile(f, edited)
  const rejected = []
  const ingested = []
  w.on('rejected', (e) => rejected.push(e))
  w.on('ops', (e) => ingested.push(e.path))
  const ops = await w.ingestFile('other/x.md')

  assert.deepEqual(ops.map((o) => o.type), ['set-body'], 'ingest appended the set-body')
  assert.deepEqual(rejected, [{ path: 'other/x.md', op: 'set-body', reason: 'policy-namespace' }])
  assert.deepEqual(ingested, [], "no 'ops' event for a rejected file")
  const report = await materialize(v, dir)
  assert.ok(report.pendingIngest.includes('other/x.md'), 'the file stays pending')
  assert.equal(await readFile(f, 'utf8'), edited, 'materialize keeps the human edit')
})

/** Every flag/rejected record in a vault's view, as { key: reason }. */
async function rejectedOf(v) {
  const out = {}
  for await (const { key, value } of v.scan('flag/rejected/')) out[key] = value.reason
  return out
}
