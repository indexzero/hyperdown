// Faces scope item 2: the ingest watcher (§9.2/§9.3) — minimal op sets,
// never whole-file ops; UnsetField for removed lines; DeleteSubject behind
// the confirmation guard; wiki-link grammar per vault-ld §4.4.1; vld:path
// consumed, never stored as a field.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Vault, K, faces, revHash, tmpDir, seedVault, captureOps, readText } from './faces-helpers.js'

const { materialize, createIngestWatcher } = faces

async function fixture(t, name) {
  const v = await Vault.init(await tmpDir(`${name}-vault`))
  await seedVault(v)
  const dir = await tmpDir(`${name}-face`)
  await materialize(v, dir)
  const w = await createIngestWatcher(v, dir, { watch: false })
  t.after(async () => {
    await w.close()
    await v.close()
  })
  return { v, dir, w, ops: captureOps(w) }
}

test('editing one frontmatter field emits exactly one SetField (§9.2 minimality)', async (t) => {
  const { v, dir, w, ops } = await fixture(t, 'ing-one')
  const home = await readText(dir, 'Home.md')
  await writeFile(join(dir, 'Home.md'), home.replace('title: Welcome home', 'title: Hello there'))
  await w.ingestFile('Home.md')
  assert.equal(ops.length, 1, 'exactly one op')
  assert.equal(ops[0].type, 'set-field')
  assert.equal(ops[0].payload.p, 'title')
  assert.equal(ops[0].payload.o, 'Hello there')
  assert.equal(ops[0].payload.ctxKind, 'scalar', '§5.7 kind pinned to the resolved kind')
  await v.update()
  const rec = await v.val(K.nField('Home', 'title'))
  assert.deepEqual(rec.reg.values, ['Hello there'])
})

test('deleting a frontmatter line emits exactly one UnsetField (§9.2)', async (t) => {
  const { v, dir, w, ops } = await fixture(t, 'ing-unset')
  const home = await readText(dir, 'Home.md')
  await writeFile(join(dir, 'Home.md'), home.replace('servings: 4\n', ''))
  await w.ingestFile('Home.md')
  assert.equal(ops.length, 1, 'exactly one op')
  assert.equal(ops[0].type, 'unset-field')
  assert.equal(ops[0].payload.p, 'servings')
  await v.update()
  assert.equal(await v.val(K.nField('Home', 'servings')), undefined, 'register cleared')
})

test('a body edit emits exactly one SetBody citing the observed head (§9.2)', async (t) => {
  const { v, dir, w, ops } = await fixture(t, 'ing-body')
  const head = await v.val(K.nBody('Home'))
  assert.equal(head, revHash(null, 'Hello **world**'), 'fixture head as expected')
  const home = await readText(dir, 'Home.md')
  await writeFile(join(dir, 'Home.md'), home.replace('Hello **world**', 'A new body.'))
  await w.ingestFile('Home.md')
  assert.equal(ops.length, 1, 'exactly one op')
  assert.equal(ops[0].type, 'set-body')
  assert.equal(ops[0].payload.base, head, 'cites the observed head revision')
  assert.equal(ops[0].payload.text, 'A new body.')
  await v.update()
  assert.equal(await v.val(K.nBody('Home')), revHash(head, 'A new body.'))
})

test('or-set edits: one AddMember per added value, one RemMember citing every tag (§5.3)', async (t) => {
  const { v, dir, w, ops } = await fixture(t, 'ing-set')
  // second tag for the same member value (dedup is per-tag in an OR-set)
  await v.addMember('Home', 'topic', 'p2p')
  await v.update()
  await materialize(v, dir)

  const home = await readText(dir, 'Home.md')
  assert.match(home, /topic: \["\[\[Recipe\]\]", p2p\]/)
  await writeFile(
    join(dir, 'Home.md'),
    home.replace('topic: ["[[Recipe]]", p2p]', 'topic: ["[[Recipe]]", swarm]')
  )
  await w.ingestFile('Home.md')
  assert.equal(ops.length, 2, 'one add + one remove')
  const add = ops.find((o) => o.type === 'add-member')
  const rem = ops.find((o) => o.type === 'rem-member')
  assert.equal(add.payload.o, 'swarm')
  assert.equal(add.payload.ctxKind, 'set')
  assert.equal(rem.payload.tags.length, 2, 'cites BOTH tags mapped to p2p (§5.3 citation contract)')
  await v.update()
  const rec = await v.val(K.nField('Home', 'topic'))
  const members = Object.values(rec.els).map((el) => (el.v.ref ? `[[${el.v.ref}]]` : el.v)).sort()
  assert.deepEqual(members, ['[[Recipe]]', 'swarm'])
})

test('a new file becomes semantic ops, never a whole-file op (§3/§9.2)', async (t) => {
  const { v, dir, w, ops } = await fixture(t, 'ing-new')
  await writeFile(
    join(dir, 'Snack.md'),
    '---\ntitle: Midnight snack\ntopic: ["[[Recipe]]"]\n---\n\nCrackers.\n'
  )
  await w.ingestFile('Snack.md')
  const types = ops.map((o) => o.type).sort()
  assert.deepEqual(types, ['add-member', 'set-body', 'set-field'], 'minimal semantic ops only')
  for (const op of ops) assert.equal(op.payload.s, 'Snack')
  await v.update()
  assert.deepEqual((await v.val(K.nField('Snack', 'title'))).reg.values, ['Midnight snack'])
  const rev = await v.val(K.nRev('Snack', await v.val(K.nBody('Snack'))))
  assert.equal(rev.text, 'Crackers.')
  // at the reconstructable default (root): no SetPath emitted (minimality)
  assert.equal(await v.val(K.nPath('Snack')), undefined)
})

test('file moves emit SetPath with the authored context-relative path (§9.3)', async (t) => {
  const { v, dir, w, ops } = await fixture(t, 'ing-move')
  const home = await readText(dir, 'Home.md')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(join(dir, 'Guides'), { recursive: true })
  await writeFile(join(dir, 'Guides/Home.md'), home)
  await w.ingestFile('Guides/Home.md')
  assert.equal(ops.length, 1, 'only the path changed')
  assert.equal(ops[0].type, 'set-path')
  assert.deepEqual(ops[0].payload, { s: 'Home', path: 'Guides/Home', scope: null })
  await v.update()
  assert.equal((await v.val(K.nPath('Home'))).path, 'Guides/Home')
})

test('wiki-link grammar: alias ignored, fragment discarded with warning, path kept (§9.2/vault-ld §4.4.1)', async (t) => {
  const { v, dir, w, ops } = await fixture(t, 'ing-links')
  const warnings = []
  w.on('warning', (e) => warnings.push(e.message))
  const home = await readText(dir, 'Home.md')
  await writeFile(
    join(dir, 'Home.md'),
    home.replace(
      'topic: ["[[Recipe]]", p2p]',
      'topic: ["[[Recipe|the recipe note]]", "[[Guides/Deep/Nested#Section]]", p2p]'
    )
  )
  await w.ingestFile('Home.md')
  assert.equal(ops.length, 1, 'alias spelling of an existing member is NOT a change; one add')
  assert.equal(ops[0].type, 'add-member')
  assert.deepEqual(ops[0].payload.o, { ref: 'Guides/Deep/Nested' }, 'path-qualified target kept; fragment discarded')
  assert.ok(
    warnings.some((m) => m.includes('fragment')),
    'fragment discard warned'
  )
})

test('vld:path frontmatter is consumed, never stored as a field (§9.3/§10.4)', async (t) => {
  const { v, dir, w, ops } = await fixture(t, 'ing-vldpath')
  await writeFile(
    join(dir, 'Imported.md'),
    '---\ntitle: from a roundtrip face\n"vld:path": "Elsewhere/Imported.md"\n---\n'
  )
  await w.ingestFile('Imported.md')
  assert.ok(!ops.some((o) => o.payload && o.payload.p === 'vld:path'), 'no field op for vld:path')
  await v.update()
  assert.equal(await v.val(K.nField('Imported', 'vld:path')), undefined, 'not stored as a field')
})

test('host keys: whole-value SetField, stored under host/, never flagged unmapped (§5.6)', async (t) => {
  const { v, dir, w, ops } = await fixture(t, 'ing-host')
  const home = await readText(dir, 'Home.md')
  await writeFile(join(dir, 'Home.md'), home.replace('tags: [demo, wiki]', 'tags: [demo, wiki, faces]'))
  await w.ingestFile('Home.md')
  assert.equal(ops.length, 1)
  assert.equal(ops[0].type, 'set-field')
  assert.equal(ops[0].payload.p, 'tags')
  await v.update()
  assert.deepEqual(
    (await v.val(K.nHost('Home', 'tags'))).value,
    ['demo', 'wiki', 'faces'],
    'host values keep their authored shape verbatim'
  )
  assert.equal(await v.val(K.flag('unmapped', 'Home', 'tags')), undefined, 'host keys never flag (vault-ld §4.3)')
})

test('deleting a file: guarded DeleteSubject; deletion survives a materialize cycle (§9.2)', async (t) => {
  const { v, dir, w, ops } = await fixture(t, 'ing-del')

  // without a confirmDelete handler the DeleteSubject is NEVER emitted
  let skipped = null
  w.on('delete-skipped', (e) => (skipped = e))
  await rm(join(dir, 'Notes/Deep/Pinned.md'))
  await w.scan()
  assert.equal(ops.length, 0, 'no ops without confirmation (§9.2 guard)')
  assert.equal(skipped.subject, 'Pinned')

  // with the guard confirming, the tombstone lands and is not resurrected
  const w2 = await createIngestWatcher(v, dir, { watch: false, confirmDelete: async () => true })
  t.after(() => w2.close())
  const ops2 = captureOps(w2)
  await w2.scan()
  assert.deepEqual(
    ops2.map((o) => o.type),
    ['delete-subject'],
    'exactly one DeleteSubject'
  )
  assert.equal(ops2[0].payload.s, 'Pinned')
  await v.update()
  assert.ok(await v.val(K.nDeleted('Pinned')), 'tombstone written (§9.2)')

  const report = await materialize(v, dir)
  assert.ok(!report.written.includes('Notes/Deep/Pinned.md'), 'deletion not resurrected by materialize')
  const again = await w2.scan()
  assert.equal(again.length, 0, 'post-materialize scan is quiescent')
})

test('unmapped values round-trip; removals rebuild the accumulation (§5.6/§10.3)', async (t) => {
  const { v, dir, w, ops } = await fixture(t, 'ing-unmapped')
  const home = await readText(dir, 'Home.md')
  // pure addition: exactly one SetField (apply accumulates + dedups)
  await writeFile(join(dir, 'Home.md'), home.replace('mood: blue', 'mood: [blue, green]'))
  await w.ingestFile('Home.md')
  assert.deepEqual(ops.map((o) => o.type), ['set-field'])
  assert.equal(ops[0].payload.ctxKind, undefined, 'unmapped is not pinnable (§5.7)')
  await v.update()
  assert.deepEqual(
    (await v.val(K.nField('Home', 'mood'))).un.items.map((i) => i.v),
    ['blue', 'green']
  )

  // removal: UnsetField + SetField re-asserting the survivors
  ops.length = 0
  await materialize(v, dir)
  const home2 = await readText(dir, 'Home.md')
  await writeFile(join(dir, 'Home.md'), home2.replace('mood: [blue, green]', 'mood: green'))
  await w.ingestFile('Home.md')
  assert.deepEqual(ops.map((o) => o.type), ['unset-field', 'set-field'])
  await v.update()
  assert.deepEqual((await v.val(K.nField('Home', 'mood'))).un.items.map((i) => i.v), ['green'])
})

test('NFC normalization: NFD file names from the filesystem ingest as NFC subjects (§3.1)', async (t) => {
  const { v, dir, w, ops } = await fixture(t, 'ing-nfc')
  const nfd = 'Cafe\u0301' // decomposed 'Caf\u00e9', as APFS/HFS+ may deliver (§3.1)
  const nfcName = 'Caf\u00e9'
  await writeFile(join(dir, nfd + '.md'), '---\ntitle: coffee\n---\n')
  await w.ingestFile(nfd + '.md')
  assert.ok(ops.length >= 1)
  for (const op of ops) assert.equal(op.payload.s, nfcName, 'subject NFC-normalized (§3.1)')
  await v.update()
  assert.deepEqual((await v.val(K.nField(nfcName, 'title'))).reg.values, ['coffee'])
})
