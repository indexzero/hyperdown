// @auto-okf/faces ingest watcher on REAL @auto-okf/store vaults: minimal-op
// emission, the full materialize -> edit -> ingest -> materialize roundtrip,
// rename+concurrent-edit merge across a roundtrip, and the guarded delete.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, rm, writeFile } from 'node:fs/promises'
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

test('the oversize preflight counts the UTF-8 bytes of an _id, as the codec does: an _id of 32 code units and 96 bytes is not the shorter id (G3-P8 F03)', async (t) => {
  // The preflight takes the file's _id or the shortest tag (65 ASCII
  // bytes), whichever gives the shorter op. The codec writes the UTF-8
  // bytes of an id. Before the fix, the preflight compared UTF-16 code
  // units, took this _id (32 code units, 96 bytes) as the shorter id, and
  // refused the file as oversize: an `error:` line that names a body
  // shorter than maxOpBytes.
  //
  // Core takes only an _id that matches ^[0-9a-f]{2,128}$ (SPEC §6), so no
  // concept holds this _id, and no copy of it can exist. The ingest adopts
  // it, and core names the cause: bad-id. The file stays pending.
  const limit = 400
  const unicodeId = '界'.repeat(32)
  const v = await Bundle.init(await tmpDir('vault'), { metadata: { limits: { maxOpBytes: limit } } })
  const dir = await tmpDir('bundle')
  const w = await createIngestWatcher(v, dir, { watch: false })
  t.after(async () => {
    await w.close()
    await v.close()
  })
  await materialize(v, dir)
  // The set-body op that the preflight encodes: no base, and clock(0).
  const clock = await v.clock(0)
  const opBytes = (id, n) => encodeOp('set-body', { id, base: null, text: 'b'.repeat(n), clock, at: Date.now() }).byteLength
  let n = limit
  while (opBytes('0'.repeat(65), n) > limit) n--
  assert.equal(opBytes('0'.repeat(65), n), limit, 'under the shortest tag, the op is exactly maxOpBytes')
  assert.ok(opBytes(unicodeId, n) > limit, 'under the _id, the op is over maxOpBytes')
  await writeFile(join(dir, 'note.md'), `---\n_id: ${unicodeId}\ntype: note\n---\n${'b'.repeat(n)}\n`)

  const oversize = []
  const rejected = []
  w.on('oversize', (e) => oversize.push(e))
  w.on('rejected', (e) => rejected.push(e))
  const ops = await w.ingestFile('note.md')

  assert.deepEqual(oversize, [], 'the preflight does not take the 96-byte _id as the shorter id')
  assert.deepEqual(rejected[0], { path: 'note.md', op: 'create-concept', reason: 'bad-id' }, 'core names the _id')
  assert.equal(rejected.length, ops.length, 'core rejects each op of the file')
  await v.update()
  assert.equal(await v.val(K.cMeta(unicodeId)), undefined, 'no concept holds the _id')
  assert.ok((await materialize(v, dir)).pendingIngest.includes('note.md'), 'the file stays pending')
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

test('a confirmed delete that core rejects emits rejected, keeps the manifest entry and the pending record, and a later scan retries it (G3-P8 F02)', async (t) => {
  // The writer may write under team/ only, so core rejects its
  // delete-concept of each concept under other/ policy-namespace. Before
  // the fix, ingest emitted 'ops' for the delete, dropped the manifest
  // entry and the pending record without core's verdict, and no later scan
  // retried the delete.
  const v = await Bundle.init(await tmpDir('vault'))
  const dir = await tmpDir('bundle')
  const w = await createIngestWatcher(v, dir, { watch: false, confirmDelete: async () => true })
  t.after(async () => {
    await w.close()
    await v.close()
  })
  const { tag: id } = await v.createConcept('other/x', 'note')
  await v.setBody(id, null, 'keep')
  await materialize(v, dir)
  // other/new.md is a new file whose ingest threw after its create, so the
  // pending record holds its concept (D-055 Q2).
  await writeFile(join(dir, 'other/new.md'), '---\ntype: note\ncount:\n  value: abc\n  datatype: http://www.w3.org/2001/XMLSchema#integer\n---\nbody\n')
  await assert.rejects(w.ingestFile('other/new.md'))
  await v.update()
  const newId = await v.val(K.path('other/new'))
  assert.deepEqual(await pendingOf(dir), { files: { 'other/new.md': newId } })
  await v.writers.setPolicy(v.localKey, { namespacePrefixes: ['team'] })
  await v.update()
  await rm(join(dir, 'other/x.md'))
  await rm(join(dir, 'other/new.md'))
  const rejected = []
  const ingested = []
  w.on('rejected', (e) => rejected.push(e))
  w.on('ops', (e) => ingested.push(e.path))

  // The scan deletes each path that the manifest lists. The live watcher
  // deletes a vanished path through _maybeDelete.
  const deletes = async () => [...(await w.scan()), ...(await w._maybeDelete('other/new.md'))].map((o) => o.type)
  assert.deepEqual(await deletes(), ['delete-concept', 'delete-concept'])
  assert.deepEqual(rejected, [
    { path: 'other/x.md', op: 'delete-concept', reason: 'policy-namespace' },
    { path: 'other/new.md', op: 'delete-concept', reason: 'policy-namespace' }
  ])
  assert.deepEqual(ingested, [], "no 'ops' event for a rejected delete")
  assert.equal((await v.val(K.cMeta(id))).deleted ?? null, null, 'other/x stays live')
  assert.ok(Object.hasOwn((await manifestOf(dir)).files, 'other/x.md'), 'the manifest keeps other/x.md')
  assert.deepEqual(await pendingOf(dir), { files: { 'other/new.md': newId } }, 'the pending record stays')

  // The writer may write anywhere again: the next scan retries the delete.
  await v.writers.setPolicy(v.localKey, { namespacePrefixes: [] })
  await v.update()
  assert.deepEqual(await deletes(), ['delete-concept', 'delete-concept'])
  assert.equal(rejected.length, 2, 'core takes the retries')
  assert.deepEqual(ingested, ['other/x.md', 'other/new.md'])
  assert.notEqual((await v.val(K.cMeta(id))).deleted ?? null, null, 'the retry deletes other/x')
  assert.ok(!Object.hasOwn((await manifestOf(dir)).files, 'other/x.md'), 'the manifest drops other/x.md')
  await assert.rejects(readFile(join(dir, '.okf-pending.json')), { code: 'ENOENT' }, 'no pending record is left')
})

test('a later ingest of a pending new file reuses the concept that its first ingest created, also in a new watcher: core rejected a later op (D-055 Q2)', async (t) => {
  // A new file has no _id until materialize stamps it (DEVIATIONS: the
  // deferred write-back). Core accepts its create-concept here and rejects
  // its set-body oversize-op, so the file stays pending (D-048 F02). Before
  // the fix, each later ingest of the same bytes minted another concept.
  // The writer holds 16 nodes first, so the next minted tag has two hex
  // digits of seq, and the clock of the set-body a two-digit self entry:
  // the op is 2 bytes over the preflight's lower bound.
  const limit = 4096
  const v = await Bundle.init(await tmpDir('vault'), { metadata: { limits: { maxOpBytes: limit } } })
  const dir = await tmpDir('bundle')
  let w = await createIngestWatcher(v, dir, { watch: false })
  t.after(async () => {
    await w.close()
    await v.close()
  })
  await materialize(v, dir)
  for (let i = 0; i < 16; i++) await v.createConcept(`seed/${i}`, 'note')
  const n = v.db.local.length
  const self = v.localKey.toString('hex')
  const opBytes = (len) =>
    encodeOp('set-body', { id: makeTag(v.localKey, n), base: null, text: 'x'.repeat(len), clock: [[self, n + 1]], at: Date.now() }).byteLength
  let len = limit
  while (opBytes(len) > limit + 1) len--
  assert.equal(opBytes(len), limit + 1, 'the set-body op of the file is one byte over maxOpBytes')
  await writeFile(join(dir, 'near.md'), `---\ntype: note\n---\n${'x'.repeat(len)}\n`)
  const rejected = []
  const listen = (watcher) => watcher.on('rejected', (e) => rejected.push(e))
  listen(w)

  const first = await w.ingestFile('near.md')
  assert.deepEqual(first.map((o) => o.type), ['create-concept', 'set-body'])
  assert.deepEqual(rejected, [{ path: 'near.md', op: 'set-body', reason: 'oversize-op' }], 'core accepted the create and rejected the body')
  const id = await v.val(K.path('near'))
  assert.notEqual(id, undefined)

  const second = await w.ingestFile('near.md')
  assert.deepEqual(second.map((o) => o.type), ['set-body'], 'the same watcher creates no second concept')
  await w.close()
  w = await createIngestWatcher(v, dir, { watch: false }) // as a new auto-okf ingest run does
  listen(w)
  const third = await w.scan()
  assert.deepEqual(third.map((o) => o.type), ['set-body'], 'a new watcher creates no second concept')
  assert.equal(rejected.length, 3, 'each ingest names the rejection')
  assert.deepEqual(await conceptIds(v), [...(await seedIds(v)), id].sort(), 'one concept for near.md, beside the 16 seeds')
})

test('a later ingest of a new file whose ingest failed after its create reuses that concept (D-055 Q2)', async (t) => {
  // A typed literal with a bad lexical form makes ingest throw in the
  // field diff, after it appended the create-concept. Before the fix, each
  // later ingest minted another concept.
  const v = await Bundle.init(await tmpDir('vault'))
  const dir = await tmpDir('bundle')
  const w = await createIngestWatcher(v, dir, { watch: false })
  t.after(async () => {
    await w.close()
    await v.close()
  })
  await materialize(v, dir)
  const bad = '---\ntype: note\ncount:\n  value: abc\n  datatype: http://www.w3.org/2001/XMLSchema#integer\n---\nbody\n'
  await writeFile(join(dir, 'bad.md'), bad)
  await assert.rejects(w.ingestFile('bad.md'))
  await v.update()
  const id = await v.val(K.path('bad'))
  assert.notEqual(id, undefined, 'the create-concept took effect before the throw')
  await assert.rejects(w.ingestFile('bad.md'))
  await v.update()
  assert.deepEqual(await conceptIds(v), [id], 'the second ingest created no second concept')
  assert.deepEqual(JSON.parse(await readFile(join(dir, '.okf-pending.json'), 'utf8')), { files: { 'bad.md': id } })

  // The human drops the bad field. That ingest completes on the same
  // concept, and the record goes.
  await writeFile(join(dir, 'bad.md'), '---\ntype: note\n---\nbody\n')
  const ops = await w.ingestFile('bad.md')
  assert.deepEqual(ops.map((o) => o.type), ['set-body'])
  assert.deepEqual(await conceptIds(v), [id])
  assert.equal((await v.val(K.cRev(id, await v.val(K.cBody(id))))).text, 'body')
  await assert.rejects(readFile(join(dir, '.okf-pending.json')), { code: 'ENOENT' }, 'no record is left')
})

/** The _id of every concept in a vault's view, sorted. */
async function conceptIds(v) {
  await v.update()
  const ids = []
  for await (const { key } of v.scan('c/')) if (key.endsWith('/meta')) ids.push(K.parseKey(key)[1])
  return ids.sort()
}

/** The _id of each seed/<i> concept. */
async function seedIds(v) {
  const ids = []
  for (let i = 0; i < 16; i++) ids.push(await v.val(K.path(`seed/${i}`)))
  return ids
}

/** The emission manifest of a bundle directory. */
async function manifestOf(dir) {
  return JSON.parse(await readFile(join(dir, '.okf-manifest.json'), 'utf8'))
}

/** The pending record of a bundle directory (D-055 Q2). */
async function pendingOf(dir) {
  return JSON.parse(await readFile(join(dir, '.okf-pending.json'), 'utf8'))
}

/** Every flag/rejected record in a vault's view, as { key: reason }. */
async function rejectedOf(v) {
  const out = {}
  for await (const { key, value } of v.scan('flag/rejected/')) out[key] = value.reason
  return out
}
