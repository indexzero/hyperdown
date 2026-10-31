// I11 Roundtrip (okf SPEC §10 generations, §11 I11, §14 acceptance):
// materialize, then import the face into a FRESH vault (a generation),
// preserves every live concept's _id, type, fields, tags, path and head body
// byte-for-byte, while HISTORY (old revisions, per-op attribution) is shed
// by design. T24 (decision 10) made a generation materialize, then import:
// these tests port the fidelity criteria of T13 to T18 to importFace.
//
// These run on REAL @auto-okf/store vaults (autobee + corestore on disk, no
// stubs). Scratch lives under sslop/033/tmp/, unique per run; handles are
// closed but files are NEVER deleted (post-mortem), and nothing under sslop/
// (or /tmp) is removed by the test.
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { mkdir, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Bundle } from '../store/index.js'
import { materialize, importFace, createIngestWatcher, readView, readLog, parseNote, renderNote } from '../faces/index.js'
import { compareNotes } from '../faces/lib/verify.js'
import { keyspace as K } from '../core/index.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const RUN = `run-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let seq = 0

/** Unique on-disk scratch dir under sslop/033/tmp/ (never cleaned up). */
async function tmpDir(name) {
  const dir = join(ROOT, 'sslop', '033', 'tmp', RUN, `${name}-${seq++}`)
  await mkdir(dir, { recursive: true })
  return dir
}

/** Read every .md in a bundle into Map<relPath, string>. */
async function readBundle(root, rel = '', out = new Map()) {
  const abs = rel === '' ? root : join(root, rel)
  let entries
  try {
    entries = await readdir(abs, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (e.name.startsWith('.')) continue
    const cr = rel === '' ? e.name : `${rel}/${e.name}`
    if (e.isDirectory()) await readBundle(root, cr, out)
    else if (e.isFile() && cr.endsWith('.md')) out.set(cr, await readFile(join(root, cr), 'utf8'))
  }
  return out
}

/** Every file under a directory, dot-files included, as sorted relative paths. */
async function listFiles(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  return entries
    .filter((e) => e.isFile())
    .map((e) => relative(root, join(e.parentPath, e.name)))
    .sort()
}

// §14: byte-fidelity is judged "modulo the _rev frontmatter lines and the
// regenerated log.md" (both necessarily re-derive in the new generation — a head
// that was an EDIT re-roots at base:null, changing its revHash). Everything
// else — _id, type, all fields, tags, path (the filename), body — must be
// byte-identical.
function normalizeBundle(m) {
  const out = new Map()
  for (const [k, v] of m) {
    if (k === 'log.md') continue
    out.set(k, v.replace(/^_rev: .*\n/m, ''))
  }
  return out
}

function bundleDiff(a, b) {
  const keys = new Set([...a.keys(), ...b.keys()])
  for (const k of [...keys].sort()) {
    if (!a.has(k)) return `only in B: ${k}`
    if (!b.has(k)) return `only in A: ${k}`
    if (a.get(k) !== b.get(k)) return `differ: ${k}\n--A--\n${a.get(k)}\n--B--\n${b.get(k)}`
  }
  return null
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

/** Live (non-tombstoned, path-bearing) concepts of a vault, by _id. */
async function liveConcepts(vault) {
  const { concepts } = await readView(vault)
  const live = new Map()
  for (const c of concepts.values()) if (!c.deleted && c.path !== undefined) live.set(c.id, c)
  return live
}

/**
 * Build a NON-TRIVIAL bundle in one vault (single writer, deterministic):
 * multiple concepts at nested paths, OR-set tags, a rename, a body revision
 * (edit), arbitrary "unmapped"/host frontmatter keys, a RESOLVED conflict
 * (so flag/conflict is drained), and a tombstoned concept (suppressed).
 * Returns the concept ids.
 */
async function buildNonTrivial(v) {
  // A: nested path, edited body (2 revisions), tags, unmapped + host keys.
  const { tag: a } = await v.createConcept('datasets/finance/revenue', 'Dataset')
  await v.setField(a, 'title', 'Revenue')
  await v.setField(a, 'description', 'Quarterly revenue tables.')
  await v.setField(a, 'owner', 'analytics-team') // unmapped producer key
  await v.setField(a, 'host', 'bq://prod-project') // "host" key
  await v.setField(a, 'regions', ['us', 'eu']) // array-valued unmapped key
  await v.addTag(a, 'q3')
  await v.addTag(a, 'core')
  await v.setBody(a, null, 'Revenue overview. See [orders](/tables/orders-v2.md).')
  await v.update()
  const aHead1 = await v.val(K.cBody(a))
  await v.setBody(a, aHead1, 'Revenue overview, revised. See [orders](/tables/orders-v2.md).') // body revision (edit)

  // B: created then RENAMED (LWW path); tag.
  const { tag: b } = await v.createConcept('tables/orders', 'Table')
  await v.setField(b, 'title', 'Orders')
  await v.addTag(b, 'core')
  await v.setBody(b, null, 'One row per order.')
  await v.update()
  await v.setPath(b, 'tables/orders-v2') // rename

  // C: a RESOLVED conflict — two siblings citing the same non-null base,
  // then ResolveConflict drains flag/conflict.
  const { tag: c } = await v.createConcept('guides/intro', 'Guide')
  await v.setField(c, 'title', 'Introduction')
  await v.setBody(c, null, 'r1')
  await v.update()
  const c1 = await v.val(K.cBody(c))
  await v.setBody(c, c1, 'r2a')
  await v.update()
  await v.setBody(c, c1, 'r2b') // sibling of r2a -> flag/conflict
  await v.update()
  const cHead = await v.val(K.cBody(c))
  const cRevs = []
  for await (const { key } of v.scan(`c/${c}/rev/`)) cRevs.push(K.parseKey(key)[3])
  const loser = cRevs.find((h) => h !== cHead && h !== c1)
  await v.resolveConflict(c, cHead, { supersede: [loser] })
  await v.update()

  // D: created then DELETED (tombstone) — must be suppressed post-cycle.
  const { tag: d } = await v.createConcept('notes/scratch', 'Note')
  await v.setBody(d, null, 'temporary scratch')
  await v.update()
  await v.deleteConcept(d)
  await v.update()

  return { a, b, c, d }
}

/** The §7 conflicted-copy file name of `id` at `shared/note`: the first 8 hex of SHA-256(_id). */
const copyOf = (id) => `shared/note.conflict-${createHash('sha256').update(id).digest('hex').slice(0, 8)}.md`

/** Write `files` (Map<rel, string>) under `root`, creating directories. */
async function writeTree(root, files) {
  for (const [rel, text] of files) {
    await mkdir(dirname(join(root, rel)), { recursive: true })
    await writeFile(join(root, rel), text)
  }
}

/** The entries of a directory, sorted. */
async function entries(dir) {
  return (await readdir(dir)).sort()
}

/** A vault's state: its full-view hash. */
async function vaultState(v) {
  await v.update()
  return v.snapshotHash()
}

/** A sha256 over every file under `root`, dot-files included: each path and its bytes. */
async function treeHash(root) {
  const h = createHash('sha256')
  for (const rel of await listFiles(root)) {
    h.update(`${rel}\0`)
    h.update(await readFile(join(root, rel)))
    h.update('\0')
  }
  return h.digest('hex')
}

test("T15: the ordinary ingest preflight checks a body against the vault's own maxOpBytes (G26)", async () => {
  // The preflight refuses a body before apply does (ADR-005), so it uses
  // the limit that apply uses: the vault's pinned maxOpBytes. It measures
  // the encoded set-body op, as apply does (D-048 F02), and its event names
  // the body bytes and the op bytes. The import of a face checks each op:
  // the D-048 F02 tests below.
  const ingestOne = async (name, maxOpBytes, bodyBytes) => {
    const dir = await tmpDir(`pre-${name}`)
    await writeTree(dir, new Map([[`${name}.md`, `---\ntype: note\n---\n\n${'x'.repeat(bodyBytes)}\n`]]))
    const v = await Bundle.init(await tmpDir(`pre-${name}-vault`), { metadata: { limits: { maxOpBytes } } })
    const w = await createIngestWatcher(v, dir, { watch: false })
    const oversize = []
    w.on('oversize', ({ opBytes, ...e }) => {
      assert.ok(opBytes > e.bytes, `${name}: the encoded op (${opBytes} bytes) holds more than the body`)
      oversize.push(e)
    })
    const ops = await w.ingestFile(`${name}.md`)
    await w.close()
    await v.update()
    const id = await v.val(K.path(name))
    const headText = id === undefined ? undefined : (await liveConcepts(v)).get(id).headText
    await v.close()
    const body = headText === undefined ? 'none' : headText === 'x'.repeat(bodyBytes) ? 'whole' : 'changed'
    return { oversize, ops: ops.map((o) => o.type), body }
  }
  // A vault that pins 400000 takes a 100 KB body. DEFAULT_LIMITS (65536) refused it.
  assert.deepEqual(await ingestOne('wide', 400000, 100000), {
    oversize: [],
    ops: ['create-concept', 'set-body'],
    body: 'whole'
  })
  // A vault that pins 2000 refuses a 3000-byte body by name, with its own
  // limit, and appends no op. DEFAULT_LIMITS let it through to apply.
  assert.deepEqual(await ingestOne('tight', 2000, 3000), {
    oversize: [{ path: 'tight.md', bytes: 3000, limit: 2000 }],
    ops: [],
    body: 'none'
  })
})

// ---------- T15: body bytes survive ingest and materialize ----------

test('T15: parseNote inverts renderNote for every body, trailing newlines included (G25)', () => {
  const pairs = [['type', 'note']]
  const bodies = ['', 'text', 'text\n', 'text\n\n', 'text\n\n\n', '\n', '\n\n', '\ntext', '\n\ntext\n\n', 'a\n\nb\n', 'a\r\n']
  for (const body of bodies) {
    assert.deepEqual(parseNote(renderNote(pairs, body)), { fm: { type: 'note' }, body, warnings: [] }, JSON.stringify(body))
  }
  // The layout: the frontmatter block, one blank separator line, the body,
  // and one file newline. A body without a trailing newline keeps the bytes
  // it had before T15. An empty body writes the frontmatter block only.
  assert.equal(renderNote(pairs, 'text'), '---\ntype: note\n---\n\ntext\n')
  assert.equal(renderNote(pairs, 'text\n'), '---\ntype: note\n---\n\ntext\n\n')
  assert.equal(renderNote(pairs, 'text\n\n'), '---\ntype: note\n---\n\ntext\n\n\n')
  assert.equal(renderNote(pairs, ''), '---\ntype: note\n---\n')
})

test('T15: a hand-written note with one trailing newline parses and ingests as before', async () => {
  // parseNote does not change in T15. It removes the blank separator line
  // and one file newline, so the body of this note is 'body text'. The
  // ordinary ingest stores that body, and materialize writes the note back
  // with the same bytes, plus the _id and _rev lines.
  const text = '---\ntype: note\n---\n\nbody text\n'
  assert.deepEqual(parseNote(text), { fm: { type: 'note' }, body: 'body text', warnings: [] })
  const dir = await tmpDir('hand-one')
  await writeTree(dir, new Map([['notes/hand.md', text]]))
  const v = await Bundle.init(await tmpDir('hand-one-vault'))
  const w = await createIngestWatcher(v, dir, { watch: false })
  const ops = await w.ingestFile('notes/hand.md')
  await w.close()
  assert.deepEqual(
    ops.map((o) => [o.type, o.payload.text]),
    [['create-concept', undefined], ['set-body', 'body text']]
  )
  const [concept] = (await liveConcepts(v)).values()
  assert.equal(concept.headText, 'body text')
  const out = await tmpDir('hand-one-out')
  await materialize(v, out)
  const back = await readFile(join(out, 'notes', 'hand.md'), 'utf8')
  assert.equal(back.replace(/^_id: .*\n_rev: .*\n/m, ''), text)
  await v.close()
})

test('T15: a hand-written body that ends in a newline keeps it through ingest and materialize (G25)', async () => {
  // The file ends in two newlines: one is the file newline, and one is the
  // body's. The ingest stores 'body text\n'. materialize writes the file
  // newline after it, so the note comes back with the same bytes, and a
  // second ingest of those bytes changes nothing.
  const text = '---\ntype: note\n---\n\nbody text\n\n'
  assert.equal(parseNote(text).body, 'body text\n')
  const dir = await tmpDir('hand-two')
  await writeTree(dir, new Map([['notes/hand.md', text]]))
  const v = await Bundle.init(await tmpDir('hand-two-vault'))
  const w = await createIngestWatcher(v, dir, { watch: false })
  await w.ingestFile('notes/hand.md')
  await w.close()
  const [concept] = (await liveConcepts(v)).values()
  assert.equal(concept.headText, 'body text\n')
  const out = await tmpDir('hand-two-out')
  await materialize(v, out)
  const back = await readFile(join(out, 'notes', 'hand.md'), 'utf8')
  assert.equal(back.replace(/^_id: .*\n_rev: .*\n/m, ''), text)
  assert.equal(parseNote(back).body, concept.headText, 'the materialized note parses to another body')
  await v.close()
})

// ---------- G3-P5 F05: face reconciliation stays in the face ----------

test('F05: a symlink in the face that leads out of it fails materialize by name before any change, and the files outside stay', async () => {
  // D-029 F05: the face's notes/ directory is a symlink to a directory
  // outside the face. The concept moved, so reconciliation removed its old
  // notes, and atomicUnlink checked only lexical containment. It deleted
  // both files outside the face through the symlink. materialize now checks
  // the real parent of every path that it can create, overwrite or delete
  // before it changes anything.
  const base = await tmpDir('face-escape')
  const old = await Bundle.init(join(base, 'vault'))
  const { tag } = await old.createConcept('notes/a', 'note')
  await old.setBody(tag, null, 'outside victim content')
  await old.update()
  const face = join(base, 'face')
  assert.equal((await materialize(old, face)).ok, true)
  const outside = join(base, 'outside')
  await rename(join(face, 'notes'), outside)
  await symlink(outside, join(face, 'notes'))
  await old.setPath(tag, 'new/a')
  await old.update()
  const state = async () => ({
    outsideFiles: await listFiles(outside),
    outsideBytes: await treeHash(outside),
    faceEntries: await entries(face),
    faceBytes: await treeHash(face),
    vault: await vaultState(old)
  })
  const before = await state()
  assert.deepEqual(before.outsideFiles, ['a.md', 'index.md'])
  await assert.rejects(
    () => materialize(old, face),
    (err) => {
      assert.equal(err.code, 'UNSAFE_PATH', err.stack)
      assert.match(err.message, /'notes\/(a|index)\.md' resolves outside the bundle root/)
      return true
    }
  )
  assert.deepEqual(await state(), before, 'materialize changed the face, the files outside it or the vault')
  assert.deepEqual(await entries(base), ['face', 'outside', 'vault'])
  await old.close()

  // A write through a symlink: <face>/new leads to an empty directory
  // outside the face. The mkdir of a planned note's parent created a
  // directory there before the real-path check of atomicWrite refused it.
  const base2 = await tmpDir('face-escape-write')
  const v = await Bundle.init(join(base2, 'vault'))
  await v.createConcept('new/sub/a', 'note')
  await v.update()
  const face2 = join(base2, 'face')
  const elsewhere = join(base2, 'elsewhere')
  await mkdir(elsewhere)
  await mkdir(face2)
  await symlink(elsewhere, join(face2, 'new'))
  await assert.rejects(
    () => materialize(v, face2),
    (err) => {
      assert.equal(err.code, 'UNSAFE_PATH', err.stack)
      assert.match(err.message, /'new\/(index|sub\/a|sub\/index)\.md' resolves outside the bundle root/)
      return true
    }
  )
  assert.deepEqual(await entries(elsewhere), [], 'materialize created something outside the face')
  assert.deepEqual(await entries(face2), ['new'], 'materialize wrote to the face')
  assert.deepEqual(await entries(base2), ['elsewhere', 'face', 'vault'])
  await v.close()
})

// ---------- T24: materialize, then import (decision 10) ----------

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

/**
 * One generation of `old`: materialize it into `<base>/face`, then import
 * that face into `<base>/vault`, carrying the metadata and the vault key.
 */
async function generation(old, base, opts = {}) {
  const face = join(base, 'face')
  assert.equal((await materialize(old, face)).ok, true, 'setup: the face must be clean')
  return importFace(Bundle.init, face, join(base, 'vault'), { metadata: old.metadata, predecessorKey: old.keyHex, ...opts })
}

/**
 * Run `run` and expect it to throw `code` before it writes anything: the
 * entries of `base` and the bytes of each directory in `dirs` stay as they
 * were. Returns the error.
 */
async function expectRefusal(run, code, base, dirs = []) {
  const before = { entries: await entries(base), bytes: await Promise.all(dirs.map(treeHash)) }
  let caught = null
  try {
    const res = await run()
    await res.vault.close()
  } catch (err) {
    caught = err
  }
  assert.ok(caught, `expected ${code}, and the import returned`)
  assert.equal(caught.code, code, caught.stack)
  assert.deepEqual({ entries: await entries(base), bytes: await Promise.all(dirs.map(treeHash)) }, before, `${code}: the refusal wrote something`)
  return caught
}

test('I11 (T24): materialize, then import, round-trips a non-trivial bundle with identity and byte fidelity', async () => {
  const old = await Bundle.init(await tmpDir('imp-rt-vault'))
  const ids = await buildNonTrivial(old)
  await old.update()
  const base = await tmpDir('imp-rt')
  const face = join(base, 'face')
  assert.equal((await materialize(old, face)).ok, true)
  const faceBytes = await treeHash(face)

  const res = await importFace(Bundle.init, face, join(base, 'vault'), { metadata: old.metadata, predecessorKey: old.keyHex })
  const nu = res.vault
  // A, B and C are live. D is tombstoned, so the face does not hold it.
  assert.deepEqual(res.counts, { notes: 3, imported: 3 })
  assert.ok(!('warnings' in res), 'a successful import has no warning (D-060 F06)')
  assert.equal(res.dir, join(base, 'vault'))
  // The face is inert source: import writes nothing to it.
  assert.equal(await treeHash(face), faceBytes, 'import changed the face')

  // §10: the chain is predecessorKey alone, and the writer key pair is fresh.
  assert.equal(nu.metadata.predecessorKey, old.keyHex)
  assert.equal(res.generation, nu.generation)
  assert.notEqual(nu.generation, 'root')
  assert.notEqual(hexOf(nu.localKey), hexOf(old.localKey), 'a writer key pair must not recur across generations')
  assert.notEqual(nu.keyHex, old.keyHex)

  // The new directory holds only what the store writes: no note, no copy of
  // the face and no generation log.
  assert.deepEqual((await listFiles(join(base, 'vault'))).filter((f) => f.endsWith('.md') || f.startsWith('log/')), [])

  // Byte fidelity: the new vault materializes the face, modulo _rev and log.md (§14).
  const newDir = join(base, 'new-face')
  assert.equal((await materialize(nu, newDir)).ok, true)
  assert.equal(bundleDiff(normalizeBundle(await readBundle(newDir)), normalizeBundle(await readBundle(face))), null)

  // Identity and state per live concept.
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

  // History is shed: one base:null revision per concept, and a log of creations only.
  assert.equal(await revCount(old, ids.a), 2, 'setup: A should have 2 revisions')
  assert.equal(await revCount(old, ids.c), 3, 'setup: C should have 3 revisions')
  assert.equal(await revCount(nu, ids.a), 1)
  assert.equal(await revCount(nu, ids.c), 1)
  assert.deepEqual([...(await logKinds(nu))].sort(), ['create'])

  await old.close()
  await nu.close()
})

test('I11 (T24): a second generation round-trips, and keeps even _rev', async () => {
  const gen = await Bundle.init(await tmpDir('imp-chain-vault'))
  await buildNonTrivial(gen)
  await gen.update()
  const r1 = await generation(gen, await tmpDir('imp-chain-1'))
  const e1 = r1.vault
  const b1 = await readNotes((await materialize(e1, await tmpDir('imp-chain-1-out'))).root)
  const r2 = await generation(e1, await tmpDir('imp-chain-2'))
  const e2 = r2.vault
  const b2 = await readNotes((await materialize(e2, await tmpDir('imp-chain-2-out'))).root)

  // root <- generation 1 <- generation 2
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

test('T14 (T24): concepts at dot-segment paths survive the import, and the ordinary ingest still ignores them (G24)', async () => {
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

  // The ordinary watcher: ingestFile and scan() ignore every dot path (§9).
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

test('T24: import refuses a face that holds a .conflict- copy, a reserved .okf- note or a symlink, by name, before it writes', async () => {
  // A path collision: Y claims shared/note after X, so materialize writes
  // Y as the conflicted copy shared/note.conflict-<h8>.md (§7).
  const old = await Bundle.init(await tmpDir('imp-refuse-vault'))
  const { tag: x } = await old.createConcept('shared/note', 'note')
  const { tag: y } = await old.createConcept('shared/note', 'note')
  await old.createConcept('notes/.okf-state', 'note') // core accepts it; the faces reserve the name
  await old.update()
  assert.equal(await old.val(K.path('shared/note')), x, 'setup: X must hold shared/note')
  const base = await tmpDir('imp-refuse')
  const face = join(base, 'face')
  await materialize(old, face)
  const copy = copyOf(y)
  assert.ok((await listFiles(face)).includes(copy), 'setup: the face must hold the conflicted copy')

  const run = () => importFace(Bundle.init, face, join(base, 'vault'))
  const conflict = await expectRefusal(run, 'IMPORT_CONFLICT_COPY', base, [face])
  assert.deepEqual(conflict.paths, [copy])
  assert.ok(conflict.message.includes(copy), conflict.message)

  // Resolved in the face (the copy removed), the reserved name is next.
  await rm(join(face, copy))
  const reserved = await expectRefusal(run, 'IMPORT_RESERVED_NAME', base, [face])
  assert.deepEqual(reserved.paths, ['notes/.okf-state.md'])
  assert.ok(reserved.message.includes('notes/.okf-state.md'), reserved.message)

  // A symlink: import reads only regular files and directories.
  await rm(join(face, 'notes', '.okf-state.md'))
  await writeFile(join(base, 'outside.md'), '---\ntype: note\n---\n\noutside the face\n')
  await symlink(join(base, 'outside.md'), join(face, 'notes', 'linked.md'))
  const link = await expectRefusal(run, 'IMPORT_FACE_ENTRY', base, [face])
  assert.deepEqual(link.paths, ['notes/linked.md'])
  await old.close()
})

test('T16 (T24): a collision resolved in the face imports, and each _id keeps its note (G28)', async () => {
  // Open collisions are resolved in the face first. Here the operator gives
  // the conflicted copy a path of its own. The index.md files of the face
  // still list the copy: they are regenerated faces, which import does not read.
  const old = await Bundle.init(await tmpDir('imp-resolved-vault'))
  const { tag: x } = await old.createConcept('shared/note', 'note')
  await old.setBody(x, null, 'X body')
  const { tag: y } = await old.createConcept('shared/note', 'note')
  await old.setBody(y, null, 'Y body')
  await old.update()
  const base = await tmpDir('imp-resolved')
  const face = join(base, 'face')
  await materialize(old, face)
  await rename(join(face, copyOf(y)), join(face, 'shared', 'note-y.md'))

  const res = await importFace(Bundle.init, face, join(base, 'vault'))
  assert.deepEqual(res.counts, { notes: 2, imported: 2 })
  const live = await liveConcepts(res.vault)
  assert.equal(await res.vault.val(K.path('shared/note')), x, 'the owner of shared/note lost the path')
  assert.equal(live.get(x).headText, 'X body')
  assert.equal(live.get(y).path, 'shared/note-y')
  assert.equal(live.get(y).headText, 'Y body')
  let collisions = 0
  for await (const _ of res.vault.scan(K.flagPrefix('pathcollision'))) collisions++
  assert.equal(collisions, 0)
  await old.close()
  await res.vault.close()
})

test('T15 (T24): a body of "text\\n\\n" round-trips byte for byte (G25)', async () => {
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

test('T15 (T24): the new vault carries limits, rate and schemaVersion, so a 100 KB body and a deep path survive (G26, D-047 F16)', async () => {
  // scratch-D/s7.mjs: maxOpBytes 400000 and a 100 KB body. The default is
  // 65536, and maxPathDepth 64 rejects a path at depth 70.
  const pinned = {
    limits: { maxOpBytes: 400000, maxPathBytes: 2048, maxPathDepth: 100 },
    rate: { defaultCeiling: 8 },
    schemaVersion: 3
  }
  const old = await Bundle.init(await tmpDir('imp-lim-vault'), { metadata: pinned })
  const big = await old.createConcept('big/report', 'note')
  await old.setBody(big.tag, null, 'x'.repeat(100000))
  const deep = Array.from({ length: 70 }, (_, i) => `d${i}`).join('/')
  const { tag: deepId } = await old.createConcept(deep, 'note')
  const small = await old.createConcept('small/note', 'note')
  await old.setBody(small.tag, null, 'ok')
  await old.update()

  const res = await generation(old, await tmpDir('imp-lim'))
  assert.deepEqual(res.counts, { notes: 3, imported: 3 })
  for (const key of ['limits', 'rate', 'schemaVersion']) assert.deepEqual(res.vault.metadata[key], old.metadata[key], key)
  const live = await liveConcepts(res.vault)
  assert.equal(live.get(big.tag).headText, 'x'.repeat(100000))
  assert.equal(live.get(deepId).path, deep)
  assert.equal(live.get(small.tag).headText, 'ok')
  await res.vault.close()

  // Without the carried metadata the new vault takes the defaults. The
  // import fails by name: the preflight refuses the body, and core rejects
  // the deep path. Each failure removes the new directory.
  const base = await tmpDir('imp-lim-default')
  await materialize(old, join(base, 'face'))
  const run = () => importFace(Bundle.init, join(base, 'face'), join(base, 'vault'))
  const oversize = await expectFailure(run, 'IMPORT_OVERSIZE', base)
  assert.equal(oversize.path, 'big/report.md')
  assert.equal(oversize.limit, 65536)
  assert.ok(oversize.bytes > 100000, String(oversize.bytes))
  await rm(join(base, 'face', 'big'), { recursive: true })
  const rejected = await expectFailure(run, 'IMPORT_REJECTED', base)
  assert.equal(rejected.path, `${deep}.md`)
  assert.equal(rejected.reason, 'depth-exceeded')
  await old.close()
})

/**
 * Run `run`, expect `code` after the new vault exists, and check that the
 * failure removed the new directory: `base` holds only the face. Returns the error.
 */
async function expectFailure(run, code, base) {
  let caught = null
  try {
    const res = await run()
    await res.vault.close()
  } catch (err) {
    caught = err
  }
  assert.ok(caught, `expected ${code}, and the import returned`)
  assert.equal(caught.code, code, caught.stack)
  assert.ok(caught.message.includes(caught.path || ''), caught.message)
  assert.deepEqual(await entries(base), ['face'], `${code}: the failure left the new directory`)
  return caught
}

test('D-048 F02 (T24): import checks each op against maxOpBytes as encoded, before it appends', async () => {
  // A body below the limit whose encoded set-body op is above it: the op
  // also holds the id, the base, the clock and the time.
  const limit = 4000
  const face = (bodyBytes) => new Map([['notes/edge.md', `---\n_id: ${'ab'.repeat(32)}\ntype: note\n---\n\n${'y'.repeat(bodyBytes)}\n`]])
  /** A Bundle.init that records each op type that the import appends. */
  const recording = (appended) => async (dir, opts) => {
    const v = await Bundle.init(dir, { ...opts, metadata: { ...opts.metadata, limits: { maxOpBytes: limit } } })
    return new Proxy(v, {
      get(target, prop, receiver) {
        if (prop === 'createConcept' || prop === 'setBody') appended.push(prop)
        return Reflect.get(target, prop, receiver)
      }
    })
  }
  const base = await tmpDir('imp-pre')
  await writeTree(join(base, 'face'), face(limit - 10))
  const appended = []
  const err = await expectFailure(() => importFace(recording(appended), join(base, 'face'), join(base, 'vault')), 'IMPORT_OVERSIZE', base)
  assert.equal(err.path, 'notes/edge.md')
  assert.equal(err.op, 'set-body')
  assert.equal(err.limit, limit)
  assert.ok(err.bytes > limit, String(err.bytes))
  assert.deepEqual(appended, ['createConcept'], 'the oversize set-body was appended')

  // A body well inside the limit imports.
  const ok = await tmpDir('imp-pre-ok')
  await writeTree(join(ok, 'face'), face(limit - 400))
  const res = await importFace(recording([]), join(ok, 'face'), join(ok, 'vault'))
  assert.equal((await liveConcepts(res.vault)).get('ab'.repeat(32)).headText, 'y'.repeat(limit - 400))
  await res.vault.close()
})

test('D-048 F02 (T24): an op that core rejects fails the import by name, and import removes the new directory', async () => {
  // 1. A vault whose metadata shows a larger maxOpBytes than the one it
  //    pins: the preflight reads the shown limit, and core rejects the op.
  const base = await tmpDir('imp-rej')
  await writeTree(join(base, 'face'), new Map([['notes/big.md', `---\n_id: ${'ab'.repeat(32)}\ntype: note\n---\n\n${'z'.repeat(3000)}\n`]]))
  const lying = async (dir, opts) => {
    const v = await Bundle.init(dir, { ...opts, metadata: { ...opts.metadata, limits: { maxOpBytes: 2000 } } })
    const shown = { ...v.metadata, limits: { ...v.metadata.limits, maxOpBytes: 1000000 } }
    return new Proxy(v, { get: (target, prop, receiver) => (prop === 'metadata' ? shown : Reflect.get(target, prop, receiver)) })
  }
  const big = await expectFailure(() => importFace(lying, join(base, 'face'), join(base, 'vault')), 'IMPORT_REJECTED', base)
  assert.deepEqual([big.path, big.op, big.reason], ['notes/big.md', 'set-body', 'oversize-op'])

  // 2. An _id that core does not adopt (§6: lowercase hex only).
  const bad = await tmpDir('imp-rej-id')
  await writeTree(join(bad, 'face'), new Map([['notes/a.md', '---\n_id: not-hex\ntype: note\n---\n\nbody\n']]))
  const id = await expectFailure(() => importFace(Bundle.init, join(bad, 'face'), join(bad, 'vault')), 'IMPORT_REJECTED', bad)
  assert.deepEqual([id.path, id.op, id.reason], ['notes/a.md', 'create-concept', 'bad-id'])
})

test('T13 (T24): a truncated note fails the import by name with IMPORT_FIDELITY, and import removes the new directory', async () => {
  const old = await Bundle.init(await tmpDir('imp-trunc-vault'))
  const { tag } = await old.createConcept('notes/a', 'note')
  await old.addTag(tag, 'one')
  await old.setBody(tag, null, 'body a')
  await old.createConcept('notes/b', 'note')
  await old.update()
  const base = await tmpDir('imp-trunc')
  const face = join(base, 'face')
  await materialize(old, face)
  // The note is cut short inside its frontmatter: no closing --- line.
  const notePath = join(face, 'notes', 'a.md')
  const text = await readFile(notePath, 'utf8')
  await writeFile(notePath, text.slice(0, text.indexOf('type:')))

  const err = await expectFailure(() => importFace(Bundle.init, face, join(base, 'vault')), 'IMPORT_FIDELITY', base)
  assert.deepEqual(err.differences, [{ path: 'notes/a.md', kind: 'missing' }])
  assert.match(err.message, /^IMPORT_FIDELITY: .*\n {2}missing notes\/a\.md$/s)
  assert.deepEqual(err.counts, { notes: 2, imported: 1 })
  assert.ok(err.warnings.some((w) => w.path === 'notes/a.md' && /type/.test(w.message)), JSON.stringify(err.warnings))

  // A <dir> that existed empty stays, empty.
  await mkdir(join(base, 'vault'))
  await assert.rejects(() => importFace(Bundle.init, face, join(base, 'vault')), (e) => e.code === 'IMPORT_FIDELITY')
  assert.deepEqual(await entries(join(base, 'vault')), [], 'the failure left files in an existing <dir>')
  await old.close()
})

test('T18 (T24): import refuses a pinned, non-empty or non-directory <dir> by name and writes nothing; a trailing slash names the same <dir> (G16, G19)', async () => {
  const old = await Bundle.init(await tmpDir('imp-dir-vault'))
  const { tag } = await old.createConcept('notes/a', 'note')
  await old.setBody(tag, null, 'a')
  await old.update()
  const base = await tmpDir('imp-dir')
  const face = join(base, 'face')
  await materialize(old, face)
  const pinned = await Bundle.init(join(base, 'pinned'))
  await pinned.close()
  await writeTree(base, new Map([['used/keep.txt', 'keep\n'], ['file', 'a file\n']]))

  const cases = [
    ['pinned', /is already a vault \(okf-vault\.json exists\)/],
    ['used', /is not empty \(keep\.txt\)/],
    ['file', /is not a directory/]
  ]
  for (const [name, message] of cases) {
    const err = await expectRefusal(() => importFace(Bundle.init, face, join(base, name)), 'IMPORT_DIR_NOT_EMPTY', base, [face, join(base, 'pinned'), join(base, 'used')])
    assert.match(err.message, message, name)
    assert.ok(err.message.includes(join(base, name)), err.message)
  }

  const res = await importFace(Bundle.init, `${face}/`, `${join(base, 'out')}/`)
  assert.equal(res.dir, join(base, 'out'))
  assert.equal((await liveConcepts(res.vault)).get(tag).headText, 'a')
  await res.vault.close()
  await old.close()
})

/**
 * The schedule of G3-P8 F01, through the injected initBundle: import A
 * pauses in its initBundle, after its claim on `dir`. Import B starts on
 * the same `dir`. Then A goes on and returns its vault, and then B goes on,
 * if it reached its initBundle. Returns { a, b, bInitialized }: `b` holds
 * `res` or `err`.
 */
async function concurrentImports(face, dir) {
  const gate = () => {
    let open
    const promise = new Promise((resolve) => (open = resolve))
    return { promise, open }
  }
  const [enteredA, runA, enteredB, runB] = [gate(), gate(), gate(), gate()]
  const paused = (entered, run) => async (d, opts) => {
    entered.open()
    await run.promise
    return Bundle.init(d, opts)
  }
  const pA = importFace(paused(enteredA, runA), face, dir)
  await enteredA.promise
  const pB = importFace(paused(enteredB, runB), face, dir).then((res) => ({ res }), (err) => ({ err }))
  // B settles before its initBundle, or it reaches its initBundle.
  const early = await Promise.race([pB, enteredB.promise.then(() => null)])
  runA.open()
  const a = await pA
  runB.open()
  const b = await pB
  if (b.res) await b.res.vault.close()
  return { a, b, bInitialized: early === null }
}

test('G3-P8 F01 (T24): a second import into the same <dir> refuses by name before its initBundle and deletes nothing; the vault, pin and files of the first import stay, for an absent and an existing empty <dir>', async () => {
  // Before the fix, both imports claimed <dir>: mkdir succeeds on an
  // existing directory too. B failed in Bundle.init on the corestore lock,
  // and its cleanup removed the vault that A had returned.
  const old = await Bundle.init(await tmpDir('imp-race-vault'))
  const { tag } = await old.createConcept('notes/a', 'note')
  await old.setBody(tag, null, 'kept')
  await old.update()
  const base = await tmpDir('imp-race')
  const face = join(base, 'face')
  await materialize(old, face)
  await old.close()

  for (const [name, setup] of [['absent', async () => {}], ['empty', (dir) => mkdir(dir)]]) {
    const dir = join(base, name)
    await setup(dir)
    const { a, b, bInitialized } = await concurrentImports(face, dir)
    const files = await entries(dir)
    await a.vault.close()
    assert.deepEqual(files, ['CORESTORE', 'db', 'okf-vault.json'], `${name}: the files of the first import stay, and no claim is left`)
    assert.ok(!(await entries(join(dir, 'db'))).includes('okf-import-claim'), `${name}: no claim is left in <dir>/db/ (D-060 F05)`)
    assert.ok(b.err, `${name}: the second import returned`)
    assert.equal(b.err.code, 'IMPORT_DIR_CLAIMED', `${name}: ${b.err.stack}`)
    assert.ok(b.err.message.includes(dir), b.err.message)
    assert.equal(bInitialized, false, `${name}: the second import ran its initBundle`)
    const reopened = await Bundle.open(dir)
    assert.equal((await liveConcepts(reopened)).get(tag).headText, 'kept', `${name}: the vault of the first import opens`)
    await reopened.close()
  }

  // A signal stopped an import after its claim: a rerun refuses by name.
  await writeTree(join(base, 'stopped'), new Map([['okf-import-claim', '']]))
  const err = await expectRefusal(() => importFace(Bundle.init, face, join(base, 'stopped')), 'IMPORT_DIR_CLAIMED', base, [face, join(base, 'stopped')])
  assert.ok(err.message.includes(join(base, 'stopped')), err.message)
})

test('T24: the face holds each head only, so a body conflict open in the predecessor crosses as its head', async () => {
  // The face shows no body conflict (§9 materializes the head). So the
  // operator resolves open conflicts before the materialize (`auto-okf
  // flags`), or the losing sibling stays behind in the predecessor.
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

test('T24: compareNotes reports every difference by path, without _rev lines', () => {
  const note = (rev, body) => Buffer.from(`---\n_id: 0123abcd\n_rev: ${rev}\ntype: note\n---\n\n${body}\n`)
  const face = new Map([
    ['a.md', note('1'.repeat(64), 'same body')], // equal modulo _rev
    ['.drafts/idea.md', note('2'.repeat(64), 'dot path')], // only in the face
    ['body.md', Buffer.from('---\ntype: note\n---\n\n_rev: one\n')] // a body line is never stripped
  ])
  const vault = new Map([
    ['a.md', note('3'.repeat(64), 'same body')],
    ['body.md', Buffer.from('---\ntype: note\n---\n\n_rev: two\n')],
    ['extra.md', note('4'.repeat(64), 'only in the new vault')]
  ])
  assert.deepEqual(compareNotes(face, vault), [
    { path: '.drafts/idea.md', kind: 'missing' },
    { path: 'body.md', kind: 'differs' },
    { path: 'extra.md', kind: 'extra' }
  ])
  assert.deepEqual(compareNotes(face, face), [], 'a face must equal itself')
})

test('T24: materialize reports every value that the face cannot hold, by _id and key; fixed in the vault, the generation round-trips', async () => {
  // The face is a lossy projection: a scalar null is omitted, only the
  // first type value is written, and a reference or an object is written as
  // a string. materialize parses each note back and reports each field
  // value that differs from the view (report.lossy), so an operator fixes
  // it before import. The probe values of D-050 (sslop/D-050/probes):
  // four that the face cannot hold, and plain values that it can.
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

  // The operator fixes each value in the vault. The next materialize
  // reports nothing, and the generation keeps every value.
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

/** Is the file system of `dir` case-insensitive? It writes `Case-Probe` in `dir`, then reads `case-probe`. */
async function caseInsensitive(dir) {
  await writeFile(join(dir, 'Case-Probe'), '')
  return readFile(join(dir, 'case-probe')).then(() => true, () => false)
}

test('F03 (D-060): materialize reports each path whose spelling folds together with another one as lossy (key path), on every file system; fixed in the vault, the generation keeps every path', async () => {
  // Core sees no collision: the full paths differ when casefolded. But the
  // directories Notes/ and notes/ fold together, and so do Notes/sub/ and
  // notes/Sub/. A case-insensitive file system (APFS by default) holds each
  // pair in one directory, the one written first. materialize writes in
  // byte order, so notes/b.md lands in Notes/, and the import gives the
  // concept the path Notes/b. Before the fix, report.lossy was empty.
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

  // The operator gives each concept one spelling. The next materialize
  // reports nothing, and the generation keeps every path.
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

test("F21 (D-060): import mode reads no .okf-pending.json of the face: a stale record attaches no note, and a record that does not parse is not read", async () => {
  // The pending record is ingest state of a live bundle directory. Before
  // the fix, import mode read the face's record for a copy: a record that
  // named the _id of an earlier note moved that concept to the copy's path
  // (the fidelity error then named both notes), and a record that does not
  // parse threw a bare SyntaxError.
  const X = 'ab'.repeat(32)
  const b = `---\n_id: ${X}\ntype: note\n---\n\nnote b, a copy of a\n`
  const notes = [
    ['a.md', `---\n_id: ${X}\ntype: note\n---\n\nnote a\n`],
    ['b.md', b]
  ]
  // A record in the format of ingest (D-060 F04) that names X for b.md,
  // with the bytes of b.md, while X is at the path a.
  const stale = { concepts: { [X]: { at: 'a', path: 'b.md', sha256: createHash('sha256').update(b).digest('hex') } } }
  for (const [name, record] of [
    ['stale', JSON.stringify(stale) + '\n'],
    ['unparseable', '{"concepts": {']
  ]) {
    const base = await tmpDir(`imp-pending-${name}`)
    await writeTree(join(base, 'face'), new Map([...notes, ['.okf-pending.json', record]]))
    const err = await expectFailure(() => importFace(Bundle.init, join(base, 'face'), join(base, 'vault')), 'IMPORT_FIDELITY', base)
    // Only the copy differs: import minted a new _id for it (a 'copy' warning).
    assert.deepEqual(err.differences, [{ path: 'b.md', kind: 'differs' }], name)
    assert.deepEqual(err.warnings.map((w) => [w.kind, w.path]), [['copy', 'b.md']], name)
  }
})

test('F05 (D-060): a successful import leaves no claim file, at the top of <dir> or in <dir>/db/, where the store moves it at init', async () => {
  // The store's first open moves each file that it does not know at the top
  // of a new storage directory into <dir>/db/ (hypercore-storage), the claim
  // file too. Before the fix, done() removed <dir>/okf-import-claim only, so
  // every imported vault kept the claim in its db/ directory.
  const old = await Bundle.init(await tmpDir('imp-claim-vault'))
  const { tag } = await old.createConcept('notes/a', 'note')
  await old.setBody(tag, null, 'a')
  const base = await tmpDir('imp-claim')
  const res = await generation(old, base)
  const dir = join(base, 'vault')
  assert.deepEqual(await entries(dir), ['CORESTORE', 'db', 'okf-vault.json'])
  assert.ok(!(await entries(join(dir, 'db'))).includes('okf-import-claim'), 'the claim stays in <dir>/db/')
  await res.vault.close()
  await old.close()
})

test('F06 (D-060): import refuses a note whose frontmatter holds no _id, by name, before it writes; a note that does not import fails the import with its warning; a successful import returns no warnings', async () => {
  // Before the fix, a note without _id got a minted _id, and the import
  // failed IMPORT_FIDELITY ('differs') with no warning. And importFace
  // documented warnings on success, which no successful import can carry:
  // a note that warns does not round-trip.
  const base = await tmpDir('imp-noid')
  const face = join(base, 'face')
  await writeTree(face, new Map([
    ['notes/ok.md', `---\n_id: ${'cd'.repeat(32)}\ntype: note\n---\n\nok\n`],
    ['notes/fresh.md', '---\ntype: note\n---\n\nfresh\n'],
    ['notes/untitled.md', '---\ntitle: x\n---\n\nno type and no _id\n']
  ]))
  const run = () => importFace(Bundle.init, face, join(base, 'vault'))
  const err = await expectRefusal(run, 'IMPORT_MISSING_ID', base, [face])
  assert.deepEqual(err.paths, ['notes/fresh.md', 'notes/untitled.md'])
  assert.ok(err.message.includes('notes/fresh.md, notes/untitled.md'), err.message)

  // A note with an _id and no type establishes no concept: the import
  // fails IMPORT_FIDELITY, and the warning says why.
  await rm(join(face, 'notes', 'fresh.md'))
  await writeFile(join(face, 'notes', 'untitled.md'), `---\n_id: ${'ef'.repeat(32)}\ntitle: x\n---\n\nno type\n`)
  const fid = await expectFailure(run, 'IMPORT_FIDELITY', base)
  assert.deepEqual(fid.differences, [{ path: 'notes/untitled.md', kind: 'missing' }])
  assert.deepEqual(fid.warnings.map((w) => [w.kind, w.path]), [['ingest', 'notes/untitled.md']])

  // A successful import returns no warnings: it has none.
  await rm(join(face, 'notes', 'untitled.md'))
  const res = await run()
  assert.deepEqual(Object.keys(res).sort(), ['counts', 'dir', 'generation', 'vault'])
  await res.vault.close()
})

test('F07 (D-060): materialize reports a field value that holds a lone UTF-16 surrogate: the note gets U+FFFD in its place', async () => {
  // A set-field value travels as JSON, so the view keeps a lone surrogate.
  // The note is UTF-8, which cannot hold one: the file gets U+FFFD.
  // Before the fix, lossyFields parsed the JavaScript string, not the
  // bytes written, so report.lossy was empty and the import changed the value.
  const old = await Bundle.init(await tmpDir('lossy-surrogate-vault'))
  const { tag } = await old.createConcept('notes/s', 'note')
  await old.setField(tag, 'label', 'a\uD800b')
  await old.update()
  const report = await materialize(old, await tmpDir('lossy-surrogate-face'))
  assert.deepEqual(report.lossy, [{ id: tag, path: 'notes/s.md', key: 'label', before: ['a\uD800b'], after: ['a\uFFFDb'] }])
  await old.close()
})

test('F08 (D-060): import refuses a note under a directory with a reserved .okf- name, in any case, by name, before it writes', async () => {
  // Before the fix, the check read the last path segment only. A face with
  // .okf-manifest.json/n.md imported, and each materialize and ingest of
  // the new vault then failed EISDIR on the directory.
  const base = await tmpDir('imp-okf-dir')
  const face = join(base, 'face')
  const note = (id) => `---\n_id: ${id}\ntype: note\n---\n\nbody\n`
  await writeTree(face, new Map([
    ['.okf-manifest.json/n.md', note('ab'.repeat(32))],
    ['notes/.OKF-State/m.md', note('cd'.repeat(32))],
    ['plain.md', note('ef'.repeat(32))]
  ]))
  const err = await expectRefusal(() => importFace(Bundle.init, face, join(base, 'vault')), 'IMPORT_RESERVED_NAME', base, [face])
  assert.deepEqual(err.paths, ['.okf-manifest.json/n.md', 'notes/.OKF-State/m.md'])
})
