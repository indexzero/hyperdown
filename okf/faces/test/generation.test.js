// I11: a generation (materialize, then import into a fresh vault) keeps the
// _id, type, fields, tags, path and head body of every live concept. It sheds
// history by design. See SPEC §10 and §11.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  Bundle,
  K,
  materialize,
  importFace,
  createIngestWatcher,
  readView,
  readLog,
  tmpDir,
  readBundle,
  bundleDiff,
  listFiles,
  treeHash,
  writeTree,
  liveConcepts,
  generation
} from './helpers.js'

// SPEC §14 judges fidelity without the _rev lines and log.md. Both re-derive
// in the new vault: an edited head re-roots at base null, so its revHash changes.
function normalizeBundle(m) {
  const out = new Map()
  for (const [k, v] of m) {
    if (k === 'log.md') continue
    out.set(k, v.replace(/^_rev: .*\n/m, ''))
  }
  return out
}

async function revCount(vault, id) {
  let n = 0
  for await (const _ of vault.scan(`c/${id}/rev/`)) n++
  return n
}

async function logKinds(vault) {
  const kinds = new Set()
  for (const rec of await readLog(vault)) for (const ev of rec.events) kinds.add(ev.kind)
  return kinds
}

/**
 * Seed one writer with nested paths, tags, a rename, an edit, unmapped keys,
 * a resolved conflict and a tombstone. Returns the ids.
 */
async function buildNonTrivial(v) {
  // A: two revisions, tags, unmapped keys.
  const { tag: a } = await v.createConcept('datasets/finance/revenue', 'Dataset')
  await v.setField(a, 'title', 'Revenue')
  await v.setField(a, 'description', 'Quarterly revenue tables.')
  await v.setField(a, 'owner', 'analytics-team')
  await v.setField(a, 'host', 'bq://prod-project')
  await v.setField(a, 'regions', ['us', 'eu'])
  await v.addTag(a, 'q3')
  await v.addTag(a, 'core')
  await v.setBody(a, null, 'Revenue overview. See [orders](/tables/orders-v2.md).')
  await v.update()
  const aHead1 = await v.val(K.cBody(a))
  await v.setBody(a, aHead1, 'Revenue overview, revised. See [orders](/tables/orders-v2.md).')

  // B: renamed.
  const { tag: b } = await v.createConcept('tables/orders', 'Table')
  await v.setField(b, 'title', 'Orders')
  await v.addTag(b, 'core')
  await v.setBody(b, null, 'One row per order.')
  await v.update()
  await v.setPath(b, 'tables/orders-v2')

  // C: a conflict, then resolved.
  const { tag: c } = await v.createConcept('guides/intro', 'Guide')
  await v.setField(c, 'title', 'Introduction')
  await v.setBody(c, null, 'r1')
  await v.update()
  const c1 = await v.val(K.cBody(c))
  await v.setBody(c, c1, 'r2a')
  await v.update()
  await v.setBody(c, c1, 'r2b') // cites c1 too: a conflict
  await v.update()
  const cHead = await v.val(K.cBody(c))
  const cRevs = []
  for await (const { key } of v.scan(`c/${c}/rev/`)) cRevs.push(K.parseKey(key)[3])
  const loser = cRevs.find((h) => h !== cHead && h !== c1)
  await v.resolveConflict(c, cHead, { supersede: [loser] })
  await v.update()

  // D: a tombstone. The face must not hold it.
  const { tag: d } = await v.createConcept('notes/scratch', 'Note')
  await v.setBody(d, null, 'temporary scratch')
  await v.update()
  await v.deleteConcept(d)
  await v.update()

  return { a, b, c, d }
}

const hexOf = (key) => Buffer.from(key).toString('hex')

/** Every .md file under `root`, dot paths included: Map<rel, string>. */
async function readNotes(root) {
  const out = new Map()
  for (const rel of await listFiles(root)) {
    if (rel.endsWith('.md')) out.set(rel, await readFile(join(root, rel), 'utf8'))
  }
  return out
}

/** The bundle without its root log.md: _rev lines kept. */
function withoutLog(m) {
  const out = new Map(m)
  out.delete('log.md')
  return out
}

test('I11: materialize, then import, round-trips a non-trivial bundle with identity and byte fidelity', async () => {
  const old = await Bundle.init(await tmpDir('imp-rt-vault'))
  const ids = await buildNonTrivial(old)
  await old.update()
  const base = await tmpDir('imp-rt')
  const face = join(base, 'face')
  assert.equal((await materialize(old, face)).ok, true)
  const faceBytes = await treeHash(face)

  const res = await importFace(Bundle.init, face, join(base, 'vault'), { metadata: old.metadata, predecessorKey: old.keyHex })
  const nu = res.vault
  // D is tombstoned, so the face holds A, B and C only.
  assert.deepEqual(res.counts, { notes: 3, imported: 3 })
  assert.ok(!('warnings' in res), 'a successful import has no warning')
  assert.equal(res.dir, join(base, 'vault'))
  assert.equal(await treeHash(face), faceBytes, 'import changed the face')

  // SPEC §10: the chain is predecessorKey alone, and the key pair is fresh.
  assert.equal(nu.metadata.predecessorKey, old.keyHex)
  assert.equal(res.generation, nu.generation)
  assert.notEqual(nu.generation, 'root')
  assert.notEqual(hexOf(nu.localKey), hexOf(old.localKey), 'a writer key pair must not recur across generations')
  assert.notEqual(nu.keyHex, old.keyHex)

  // Import leaves no note and no log in the new directory.
  assert.deepEqual((await listFiles(join(base, 'vault'))).filter((f) => f.endsWith('.md') || f.startsWith('log/')), [])

  const newDir = join(base, 'new-face')
  assert.equal((await materialize(nu, newDir)).ok, true)
  assert.equal(bundleDiff(normalizeBundle(await readBundle(newDir)), normalizeBundle(await readBundle(face))), null)

  const oldLive = await liveConcepts(old)
  const newLive = await liveConcepts(nu)
  assert.deepEqual([...newLive.keys()].sort(), [...oldLive.keys()].sort(), 'the live _id set changed')
  assert.ok(!newLive.has(ids.d), 'a tombstoned concept crossed the generation')
  for (const [id, oc] of oldLive) {
    const nc = newLive.get(id)
    assert.equal(nc.type, oc.type, `type changed for ${id}`)
    assert.equal(nc.path, oc.path, `path changed for ${id}`)
    assert.equal(nc.headText, oc.headText, `head body changed for ${id}`)
  }
  assert.equal(newLive.get(ids.b).path, 'tables/orders-v2')

  // History is shed: one revision per concept, and a log of creations only.
  assert.equal(await revCount(old, ids.a), 2, 'setup: A should have 2 revisions')
  assert.equal(await revCount(old, ids.c), 3, 'setup: C should have 3 revisions')
  assert.equal(await revCount(nu, ids.a), 1)
  assert.equal(await revCount(nu, ids.c), 1)
  assert.deepEqual([...(await logKinds(nu))].sort(), ['create'])

  await old.close()
  await nu.close()
})

test('I11: a second generation round-trips, and keeps even _rev', async () => {
  const gen = await Bundle.init(await tmpDir('imp-chain-vault'))
  await buildNonTrivial(gen)
  await gen.update()
  const r1 = await generation(gen, await tmpDir('imp-chain-1'))
  const e1 = r1.vault
  const b1 = await readNotes((await materialize(e1, await tmpDir('imp-chain-1-out'))).root)
  const r2 = await generation(e1, await tmpDir('imp-chain-2'))
  const e2 = r2.vault
  const b2 = await readNotes((await materialize(e2, await tmpDir('imp-chain-2-out'))).root)

  assert.equal(e1.metadata.predecessorKey, gen.keyHex)
  assert.equal(e2.metadata.predecessorKey, e1.keyHex)
  assert.notEqual(e2.generation, e1.generation)
  assert.notEqual(e2.generation, 'root')
  // After one generation every head is a base:null revision, so the second
  // import keeps each _rev too. Only log.md re-derives.
  assert.equal(bundleDiff(withoutLog(b2), withoutLog(b1)), null, 'the second generation did not round-trip')
  assert.deepEqual([...(await liveConcepts(e2)).keys()].sort(), [...(await liveConcepts(gen)).keys()].sort())
  await gen.close()
  await e1.close()
  await e2.close()
})

test('concepts at dot-segment paths survive the import, and the ordinary ingest still ignores them', async () => {
  const old = await Bundle.init(await tmpDir('imp-dot-vault'))
  const r1 = await old.createConcept('.drafts/idea', 'note')
  await old.createConcept('notes/.hidden', 'note')
  await old.createConcept('notes/visible', 'note')
  await old.setBody(r1.tag, null, 'dot dir body')
  const res = await generation(old, await tmpDir('imp-dot'))
  assert.deepEqual(res.counts, { notes: 3, imported: 3 })
  const pathById = async (v) => new Map([...(await liveConcepts(v))].map(([id, c]) => [id, c.path]))
  const oldPaths = await pathById(old)
  assert.deepEqual([...oldPaths.values()].sort(), ['.drafts/idea', 'notes/.hidden', 'notes/visible'])
  assert.deepEqual(await pathById(res.vault), oldPaths)
  assert.equal((await liveConcepts(res.vault)).get(r1.tag).headText, 'dot dir body')
  await old.close()
  await res.vault.close()

  // The ordinary ingest ignores every dot path (SPEC §9).
  const plainDir = await tmpDir('imp-dot-plain')
  await writeTree(plainDir, new Map([
    ['.drafts/idea.md', '---\ntype: note\n---\n\ndot dir body\n'],
    ['notes/.hidden.md', '---\ntype: note\n---\n'],
    ['notes/visible.md', '---\ntype: note\n---\n']
  ]))
  const plain = await Bundle.init(await tmpDir('imp-dot-plain-vault'))
  const watcher = await createIngestWatcher(plain, plainDir, { watch: false })
  assert.deepEqual(await watcher.ingestFile('.drafts/idea.md'), [])
  assert.deepEqual(await watcher.ingestFile('notes/.hidden.md'), [])
  await watcher.scan()
  await watcher.close()
  assert.deepEqual([...(await liveConcepts(plain)).values()].map((c) => c.path), ['notes/visible'])
  await plain.close()
})

test('a body of "text\\n\\n" round-trips byte for byte', async () => {
  const old = await Bundle.init(await tmpDir('imp-nl-vault'))
  const { tag } = await old.createConcept('notes/blank', 'note')
  await old.setBody(tag, null, 'text\n\n')
  const base = await tmpDir('imp-nl')
  const res = await generation(old, base)
  assert.deepEqual(res.counts, { notes: 1, imported: 1 })
  assert.equal((await liveConcepts(res.vault)).get(tag).headText, 'text\n\n')
  const face = await readFile(join(base, 'face', 'notes', 'blank.md'), 'utf8')
  assert.ok(face.endsWith('\ntype: note\n---\n\ntext\n\n\n'), JSON.stringify(face))
  await old.close()
  await res.vault.close()
})

test('the face holds each head only, so a body conflict open in the predecessor crosses as its head', async () => {
  // The face holds the head only (SPEC §9). A losing sibling stays behind in
  // the predecessor unless the operator resolves the conflict first.
  const v = await Bundle.init(await tmpDir('imp-conf-vault'))
  const { tag: id } = await v.createConcept('c', 'note')
  await v.setBody(id, null, 'r1')
  await v.update()
  const r1 = await v.val(K.cBody(id))
  await v.setBody(id, r1, 'r2a')
  await v.update()
  await v.setBody(id, r1, 'r2b')
  await v.update()
  let open = 0
  for await (const _ of v.scan(K.flagPrefix('conflict'))) open++
  assert.equal(open, 1, 'setup should leave one open conflict')
  const head = (await liveConcepts(v)).get(id).headText

  const res = await generation(v, await tmpDir('imp-conf'))
  let newOpen = 0
  for await (const _ of res.vault.scan(K.flagPrefix('conflict'))) newOpen++
  assert.equal(newOpen, 0)
  assert.equal(await revCount(res.vault, id), 1)
  assert.equal((await liveConcepts(res.vault)).get(id).headText, head)
  await v.close()
  await res.vault.close()
})

// ---------- the lossy report: what to fix in the vault before an import ----------

test('materialize reports every value that the face cannot hold, by _id and key; fixed in the vault, the generation round-trips', async () => {
  // The face cannot hold a null, a second type value, a reference or an
  // object. materialize reads each note back and reports each value that
  // differs from the view (report.lossy). See SPEC §10.
  const old = await Bundle.init(await tmpDir('lossy-vault'))
  const cases = [
    ['nullable', null],
    ['reference', { ref: 'target' }],
    ['object', { hello: 'world' }],
    ['type', ['note', 'other']],
    ['plain', 'text'],
    ['list', ['a', 'b']],
    ['number', 42]
  ]
  const ids = {}
  for (const [key, value] of cases) {
    const { tag } = await old.createConcept(`notes/${key}`, 'note')
    await old.setField(tag, key, value)
    ids[key] = tag
  }
  await old.update()
  const face = await tmpDir('lossy-face')
  const report = await materialize(old, face)
  assert.deepEqual(report.lossy, [
    { id: ids.nullable, path: 'notes/nullable.md', key: 'nullable', before: [null], after: [] },
    { id: ids.object, path: 'notes/object.md', key: 'object', before: [{ hello: 'world' }], after: ['{"hello":"world"}'] },
    { id: ids.reference, path: 'notes/reference.md', key: 'reference', before: [{ ref: 'target' }], after: ['target'] },
    { id: ids.type, path: 'notes/type.md', key: 'type', before: ['note', 'other'], after: ['note'] }
  ])

  await old.setField(ids.nullable, 'nullable', 'none')
  await old.setField(ids.reference, 'reference', 'target')
  await old.setField(ids.object, 'object', '{"hello":"world"}')
  await old.setField(ids.type, 'type', 'note')
  await old.update()
  const base = await tmpDir('lossy-fixed')
  assert.deepEqual((await materialize(old, join(base, 'face'))).lossy, [])
  const res = await importFace(Bundle.init, join(base, 'face'), join(base, 'vault'), { metadata: old.metadata, predecessorKey: old.keyHex })
  const before = await readView(old)
  const after = await readView(res.vault)
  for (const [key] of cases) {
    assert.deepEqual(after.concepts.get(ids[key]).fields.get(key).values, before.concepts.get(ids[key]).fields.get(key).values, key)
  }
  await old.close()
  await res.vault.close()
})

/** Is the file system of `dir` case-insensitive? Writes a probe file in `dir`. */
async function caseInsensitive(dir) {
  await writeFile(join(dir, 'Case-Probe'), '')
  return readFile(join(dir, 'case-probe')).then(() => true, () => false)
}

test('materialize reports each path whose spelling folds together with another one as lossy (key path), on every file system; fixed in the vault, the generation keeps every path', async () => {
  // Core sees no collision, because the full paths differ casefolded. But
  // Notes/ and notes/ fold together as directories. A case-insensitive file
  // system holds both in the directory written first, and materialize writes
  // in byte order, so notes/b.md lands in Notes/. Without the report, the
  // import renames the concept.
  const old = await Bundle.init(await tmpDir('fold-vault'))
  const ids = {}
  for (const path of ['Notes/a', 'notes/b', 'notes/Sub/c', 'Notes/sub/d']) {
    const { tag } = await old.createConcept(path, 'note')
    await old.setBody(tag, null, `body of ${path}`)
    ids[path] = tag
  }
  await old.update()
  const base = await tmpDir('fold')
  const report = await materialize(old, join(base, 'face'))
  assert.deepEqual(report.lossy, [
    { id: ids['notes/Sub/c'], path: 'notes/Sub/c.md', key: 'path', before: ['notes/Sub/c'], after: ['Notes/sub/c'] },
    { id: ids['notes/b'], path: 'notes/b.md', key: 'path', before: ['notes/b'], after: ['Notes/b'] }
  ])
  if (await caseInsensitive(base)) {
    // What the report prevents: the import changes each reported path.
    const res = await importFace(Bundle.init, join(base, 'face'), join(base, 'vault'))
    const live = await liveConcepts(res.vault)
    assert.equal(live.get(ids['notes/b']).path, 'Notes/b')
    assert.equal(live.get(ids['notes/Sub/c']).path, 'Notes/sub/c')
    await res.vault.close()
  }

  await old.setPath(ids['notes/b'], 'Notes/b')
  await old.setPath(ids['notes/Sub/c'], 'Notes/sub/c')
  await old.update()
  const fixed = await tmpDir('fold-fixed')
  assert.deepEqual((await materialize(old, join(fixed, 'face'))).lossy, [])
  const res = await importFace(Bundle.init, join(fixed, 'face'), join(fixed, 'vault'), { metadata: old.metadata, predecessorKey: old.keyHex })
  const pathById = async (v) => new Map([...(await liveConcepts(v))].map(([id, c]) => [id, c.path]))
  assert.deepEqual(await pathById(res.vault), await pathById(old))
  await res.vault.close()
  await old.close()
})

test('materialize reports a field value that holds a lone UTF-16 surrogate: the note gets U+FFFD in its place', async () => {
  // A set-field value travels as JSON, so the view keeps a lone surrogate.
  // UTF-8 cannot hold one, so the file gets U+FFFD. The report must compare
  // the bytes written, not the JavaScript string.
  const old = await Bundle.init(await tmpDir('lossy-surrogate-vault'))
  const { tag } = await old.createConcept('notes/s', 'note')
  await old.setField(tag, 'label', 'a\uD800b')
  await old.update()
  const report = await materialize(old, await tmpDir('lossy-surrogate-face'))
  assert.deepEqual(report.lossy, [{ id: tag, path: 'notes/s.md', key: 'label', before: ['a\uD800b'], after: ['a\uFFFDb'] }])
  await old.close()
})
