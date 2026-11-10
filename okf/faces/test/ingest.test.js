import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { encodeOp } from '../../core/index.js'
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
} from './helpers.js'

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

  const ops2 = await w.scan()
  assert.equal(ops2.length, 0, 'stable bundle must not re-emit ops: ' + JSON.stringify(ops2))
  const r = await materialize(v, dir)
  assert.equal(r.written.length, 0, 'stable materialize wrote: ' + JSON.stringify(r.written))
  assert.equal(bundleDiff(snapshot, await readBundle(dir)), null)
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
  const base = await b.val(K.cBody(id)) // the base that B cites after the partition

  unpair()
  await a.setPath(id, 'notes/final')
  await b.setBody(id, base, 'version one')

  // The edit follows the _id across the rename.
  unpair = pair(a, b)
  assert.ok(await converged([a, b]), 'post-partition converge failed')

  const dir = await tmpDir('bundle')
  await materialize(a, dir)
  const bundle = await readBundle(dir)
  assert.ok(bundle.has('notes/final.md'), 'renamed path missing')
  assert.ok(!bundle.has('notes/draft.md'), 'old path should be gone')
  assert.match(bundle.get('notes/final.md'), /version one/, 'concurrent edit lost')

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

  const wSkip = await createIngestWatcher(v, dir, { watch: false })
  const skipped = []
  wSkip.on('delete-skipped', (e) => skipped.push(e))
  const opsSkip = await wSkip._maybeDelete('guides/intro.md')
  assert.equal(opsSkip.length, 0)
  assert.equal(skipped.length, 1)
  assert.equal(await v.val(K.cMeta(id)).then((m) => m.deleted ?? null), null, 'concept must survive an unconfirmed delete')
  await wSkip.close()

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
  await materialize(v, dir) // the bundle exists first: manifest, index.md, log.md

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
  await materialize(v, dir) // the bundle exists first: manifest, index.md, log.md

  // big.md is one byte over as a body, and more as an encoded op.
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

// ---------- the preflight checks the encoded op ----------

test('the oversize preflight encodes the set-body op: a body just below maxOpBytes whose op is over it appends nothing and stays pending (D-048 F02)', async (t) => {
  // apply measures the encoded op, which adds the id, the base, the clock and
  // `at` to the body. If the preflight measures the body instead, core rejects
  // the op of over.md as oversize-op, and the next materialize overwrites the
  // file with the empty concept.
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
  // The set-body op as the store appends it here: the id minted at the seq
  // before, no base, and a clock of self only.
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
  // The preflight encodes the op with the shorter of the file's _id and a
  // 65-byte tag, in UTF-8 bytes. If it counts code units, this 32-character
  // _id of 96 bytes looks shorter, and the preflight refuses a body that is
  // below maxOpBytes.
  // Core adopts only lowercase hex (SPEC §6), so the file stays pending.
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
  // The policy lets the writer write under team/ only, so core rejects the
  // set-body of other/x. If ingest records the file as ingested before the
  // verdict of core, the next materialize overwrites the human edit.
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
  // The policy lets the writer write under team/ only, so core rejects each
  // delete under other/. If ingest drops the manifest entry and the pending
  // record before the verdict of core, no later scan retries the delete.
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
  // The ingest of other/new.md throws after its create-concept, so the
  // pending record holds its concept.
  await writeFile(join(dir, 'other/new.md'), '---\ntype: note\ncount:\n  value: abc\n  datatype: http://www.w3.org/2001/XMLSchema#integer\n---\nbody\n')
  await assert.rejects(w.ingestFile('other/new.md'))
  await v.update()
  const newId = await v.val(K.path('other/new'))
  assert.deepEqual(await pendingOf(dir), { 'other/new.md': { id: newId, gone: false } })
  await v.writers.setPolicy(v.localKey, { namespacePrefixes: ['team'] })
  await v.update()
  await rm(join(dir, 'other/x.md'))
  await rm(join(dir, 'other/new.md'))
  const rejected = []
  const ingested = []
  w.on('rejected', (e) => rejected.push(e))
  w.on('ops', (e) => ingested.push(e.path))

  // scan() deletes each path that the manifest or the pending record lists
  // and the disk no longer holds, in byte order.
  const deletes = async () => (await w.scan()).map((o) => o.type)
  assert.deepEqual(await deletes(), ['delete-concept', 'delete-concept'])
  assert.deepEqual(rejected, [
    { path: 'other/new.md', op: 'delete-concept', reason: 'policy-namespace' },
    { path: 'other/x.md', op: 'delete-concept', reason: 'policy-namespace' }
  ])
  assert.deepEqual(ingested, [], "no 'ops' event for a rejected delete")
  assert.equal((await v.val(K.cMeta(id))).deleted ?? null, null, 'other/x stays live')
  assert.ok(Object.hasOwn((await manifestOf(dir)).files, 'other/x.md'), 'the manifest keeps other/x.md')
  assert.deepEqual(await pendingOf(dir), { 'other/new.md': { id: newId, gone: true } }, 'the pending record stays, marked gone')

  // With the policy lifted, the next scan retries the delete.
  await v.writers.setPolicy(v.localKey, { namespacePrefixes: [] })
  await v.update()
  assert.deepEqual(await deletes(), ['delete-concept', 'delete-concept'])
  assert.equal(rejected.length, 2, 'core takes the retries')
  assert.deepEqual(ingested, ['other/new.md', 'other/x.md'])
  assert.notEqual((await v.val(K.cMeta(id))).deleted ?? null, null, 'the retry deletes other/x')
  assert.ok(!Object.hasOwn((await manifestOf(dir)).files, 'other/x.md'), 'the manifest drops other/x.md')
  await assert.rejects(readFile(join(dir, '.okf-pending.json')), { code: 'ENOENT' }, 'no pending record is left')
})

test('a later ingest of a pending new file reuses the concept that its first ingest created, also in a new watcher: core rejected a later op (D-055 Q2)', async (t) => {
  // A new file has no _id until materialize stamps it. Core rejects the
  // set-body as oversize-op, so the file stays pending. Without the pending
  // record, each later ingest mints another concept.
  // The 16 seeds give the tag and the clock entry two-digit seqs, so the op
  // passes the lower bound of the preflight.
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
  // A typed literal with a bad lexical form makes ingest throw in the field
  // diff, after the create-concept. Without the pending record, each later
  // ingest mints another concept.
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
  assert.deepEqual(await pendingOf(dir), { 'bad.md': { id, gone: false } })

  await writeFile(join(dir, 'bad.md'), '---\ntype: note\n---\nbody\n')
  const ops = await w.ingestFile('bad.md')
  assert.deepEqual(ops.map((o) => o.type), ['set-body'])
  assert.deepEqual(await conceptIds(v), [id])
  assert.equal((await v.val(K.cRev(id, await v.val(K.cBody(id))))).text, 'body')
  await assert.rejects(readFile(join(dir, '.okf-pending.json')), { code: 'ENOENT' }, 'no record is left')
})

test('scan() deletes a pending file that is gone, though the manifest never listed it: a new watcher, with confirmDelete (D-061 R02)', async (t) => {
  // The note is pending: the pending record holds its concept, and the
  // manifest does not list it. The file goes while no watcher runs. If scan()
  // walks the manifest only, it emits no delete, and the next materialize
  // restores the file.
  const limit = 4096
  const v = await Bundle.init(await tmpDir('vault'), { metadata: { limits: { maxOpBytes: limit } } })
  const dir = await tmpDir('bundle')
  let w = await createIngestWatcher(v, dir, { watch: false })
  t.after(async () => {
    await w.close()
    await v.close()
  })
  await materialize(v, dir)
  const near = await nearLimitNote(v, limit)
  await writeFile(join(dir, 'new.md'), near)
  const rejected = []
  w.on('rejected', (e) => rejected.push(e))
  await w.ingestFile('new.md')
  assert.deepEqual(rejected, [{ path: 'new.md', op: 'set-body', reason: 'oversize-op' }], 'setup: core rejects the body')
  const id = await v.val(K.path('new'))
  assert.ok(!Object.hasOwn((await manifestOf(dir)).files, 'new.md'), 'setup: the manifest does not list new.md')
  await w.close()

  await rm(join(dir, 'new.md'))
  w = await createIngestWatcher(v, dir, { watch: false, confirmDelete: async () => true })
  const ops = await w.scan()
  assert.deepEqual(ops.map((o) => [o.type, o.payload.id]), [['delete-concept', id]])
  assert.notEqual((await v.val(K.cMeta(id))).deleted ?? null, null, 'the concept is deleted')
  await assert.rejects(readFile(join(dir, '.okf-pending.json')), { code: 'ENOENT' }, 'no pending record is left')
  const report = await materialize(v, dir)
  assert.ok(!report.written.includes('new.md'), 'materialize does not restore new.md')
})

// ---------- the pending record attaches a file only on evidence ----------

/**
 * A vault whose maxOpBytes is 4096, its bundle directory, a watcher, and a
 * pending new note at a.md: core accepts its create-concept and rejects its
 * set-body (nearLimitNote). Returns { v, dir, w, id, near, seeds }.
 */
async function pendingNote(t, opts = {}) {
  const limit = 4096
  const v = await Bundle.init(await tmpDir('vault'), { metadata: { limits: { maxOpBytes: limit } } })
  const dir = await tmpDir('bundle')
  const w = await createIngestWatcher(v, dir, { watch: false, ...opts })
  t.after(async () => {
    await w.close()
    await v.close()
  })
  await materialize(v, dir)
  const near = await nearLimitNote(v, limit)
  const seeds = await seedIds(v)
  await writeFile(join(dir, 'a.md'), near)
  await w.scan()
  const id = await v.val(K.path('a'))
  assert.notEqual(id, undefined, 'setup: core accepted the create')
  return { v, dir, w, id, near, seeds }
}

/** The concepts of a vault's view that are not in `known`, sorted. */
async function newConcepts(v, known) {
  return (await conceptIds(v)).filter((c) => !known.includes(c))
}

test('a renamed pending file keeps its concept: scan() moves the concept with it and attaches no second one (D-060 F04)', async (t) => {
  // If the record is keyed by path, b.md mints a second concept, and
  // materialize writes the first one back as a.md.
  const { v, dir, w, id, seeds } = await pendingNote(t)
  await rename(join(dir, 'a.md'), join(dir, 'b.md'))
  await w.scan()
  assert.deepEqual(await newConcepts(v, seeds), [id], 'no second concept')
  assert.equal((await v.val(K.cPath(id))).path, 'b', 'the concept follows the file')

  // The human shortens the body: that ingest completes on the same concept.
  await writeFile(join(dir, 'b.md'), '---\ntype: note\n---\nshort\n')
  await w.scan()
  assert.deepEqual(await newConcepts(v, seeds), [id])
  await assert.rejects(readFile(join(dir, '.okf-pending.json')), { code: 'ENOENT' }, 'no record is left')
  const report = await materialize(v, dir)
  assert.ok(report.written.includes('b.md') && !report.written.includes('a.md'), JSON.stringify(report.written))
})

test('a stale pending record attaches no file: its concept moved with a note that carries its _id, or another writer moved it (D-060 F04)', async (t) => {
  // 1. x.md carries the _id of the pending concept, and a.md goes. If the
  //    stale record of a.md stays, an unrelated new note at a.md takes the
  //    concept over.
  const one = await pendingNote(t)
  await writeFile(join(one.dir, 'x.md'), `---\n_id: ${one.id}\ntype: note\n---\nkept\n`)
  await rm(join(one.dir, 'a.md'))
  await one.w.scan()
  assert.equal((await one.v.val(K.cPath(one.id))).path, 'x', 'setup: the concept moved to x')
  await writeFile(join(one.dir, 'a.md'), '---\ntype: note\n---\nan unrelated new note\n')
  await one.w.scan()
  const [fresh] = await newConcepts(one.v, [...one.seeds, one.id])
  assert.equal(await one.v.val(K.path('a')), fresh, 'the new note has a concept of its own')
  assert.equal((await one.v.val(K.cPath(one.id))).path, 'x', 'the concept stays at x')
  assert.equal(await headTextOf(one.v, one.id), 'kept')

  // 2. Another writer moves the concept while a.md is pending. The next
  //    ingest of a.md must not move it back.
  const two = await pendingNote(t)
  await two.v.setPath(two.id, 'moved')
  await two.v.update()
  await writeFile(join(two.dir, 'a.md'), '---\ntype: note\n---\nshort\n')
  await two.w.scan()
  assert.equal((await two.v.val(K.cPath(two.id))).path, 'moved', 'the concept stays where the other writer moved it')
  const [own] = await newConcepts(two.v, [...two.seeds, two.id])
  assert.equal(await two.v.val(K.path('a')), own)
})

test('a pending record whose file a scan found gone attaches only the same bytes back, never a new note (D-060 F04)', async (t) => {
  // Without confirmDelete the scan skips the delete, and the record stays.
  // An unrelated new note at a.md must not take the concept over.
  const { v, dir, w, id, near, seeds } = await pendingNote(t)
  const skipped = []
  w.on('delete-skipped', (e) => skipped.push(e.path))
  await rm(join(dir, 'a.md'))
  await w.scan()
  assert.deepEqual(skipped, ['a.md'])

  await writeFile(join(dir, 'a.md'), near)
  await w.scan()
  assert.deepEqual(await newConcepts(v, seeds), [id], 'the same bytes reattach the concept')

  await rm(join(dir, 'a.md'))
  await w.scan()
  await writeFile(join(dir, 'a.md'), '---\ntype: note\n---\nan unrelated new note\n')
  await w.scan()
  const fresh = await newConcepts(v, [...seeds, id])
  assert.equal(fresh.length, 1, 'the new note has a concept of its own')
  assert.equal(await headTextOf(v, fresh[0]), 'an unrelated new note')
  assert.equal((await v.val(K.cPath(id))).path, 'a', 'the concept keeps its path')
})

/** The head body text of concept `id`. */
async function headTextOf(v, id) {
  await v.update()
  const head = await v.val(K.cBody(id))
  return head === undefined ? undefined : (await v.val(K.cRev(id, head))).text
}

/**
 * A new note whose set-body op is 1 byte over `limit` as the next node of
 * this writer: core accepts its create-concept and rejects its set-body as
 * oversize-op. The 16 seeds give the minted tag and the clock entry two hex
 * digits of seq, so the op is over the lower bound of the preflight.
 */
async function nearLimitNote(v, limit) {
  for (let i = 0; i < 16; i++) await v.createConcept(`seed/${i}`, 'note')
  const n = v.db.local.length
  const self = v.localKey.toString('hex')
  const opBytes = (len) =>
    encodeOp('set-body', { id: makeTag(v.localKey, n), base: null, text: 'x'.repeat(len), clock: [[self, n + 1]], at: Date.now() }).byteLength
  let len = limit
  while (opBytes(len) > limit + 1) len--
  assert.equal(opBytes(len), limit + 1, 'setup: the set-body op of the note is one byte over maxOpBytes')
  return `---\ntype: note\n---\n${'x'.repeat(len)}\n`
}

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

/** The pending record of a bundle directory, by file: { <path>: { id, gone } }. */
async function pendingOf(dir) {
  const { concepts } = JSON.parse(await readFile(join(dir, '.okf-pending.json'), 'utf8'))
  const out = {}
  for (const [id, e] of Object.entries(concepts)) out[e.path] = { id, gone: e.gone === true }
  return out
}

/** Every flag/rejected record in a vault's view, as { key: reason }. */
async function rejectedOf(v) {
  const out = {}
  for await (const { key, value } of v.scan('flag/rejected/')) out[key] = value.reason
  return out
}
