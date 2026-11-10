// importFace(initBundle, face, dir): what it refuses before it writes, the
// claim file, what it removes after a failure, the fidelity check and the
// metadata of the new vault. See okf/faces/lib/import.js and SPEC §10.
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { mkdir, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  Bundle,
  K,
  materialize,
  importFace,
  tmpDir,
  listFiles,
  treeHash,
  entries,
  writeTree,
  liveConcepts,
  generation
} from './helpers.js'
import { compareNotes } from '../lib/verify.js'

/** The §7 conflicted-copy file name of `id` at `shared/note`: the first 8 hex of SHA-256(_id). */
const copyOf = (id) => `shared/note.conflict-${createHash('sha256').update(id).digest('hex').slice(0, 8)}.md`

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

// ---------- refusals before any write ----------

test('import refuses a face that holds a .conflict- copy, a reserved .okf- note or a symlink, by name, before it writes', async () => {
  // Y claims shared/note after X, so materialize writes Y as a conflicted copy (SPEC §7).
  const old = await Bundle.init(await tmpDir('imp-refuse-vault'))
  const { tag: x } = await old.createConcept('shared/note', 'note')
  const { tag: y } = await old.createConcept('shared/note', 'note')
  await old.createConcept('notes/.okf-state', 'note') // core accepts the name, the faces reserve it
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

test('import refuses a note under a directory with a reserved .okf- name, in any case, by name, before it writes', async () => {
  // If the check reads the last segment only, a face with
  // .okf-manifest.json/n.md imports, and each materialize of the new vault
  // then fails EISDIR.
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

test('import refuses a note whose frontmatter holds no _id, by name, before it writes; a note that does not import fails the import with its warning; a successful import returns no warnings', async () => {
  // A note that warns does not round-trip, so a successful import carries no warnings.
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

  // A note with an _id and no type creates no concept.
  await rm(join(face, 'notes', 'fresh.md'))
  await writeFile(join(face, 'notes', 'untitled.md'), `---\n_id: ${'ef'.repeat(32)}\ntitle: x\n---\n\nno type\n`)
  const fid = await expectFailure(run, 'IMPORT_FIDELITY', base)
  assert.deepEqual(fid.differences, [{ path: 'notes/untitled.md', kind: 'missing' }])
  assert.deepEqual(fid.warnings.map((w) => [w.kind, w.path]), [['ingest', 'notes/untitled.md']])

  await rm(join(face, 'notes', 'untitled.md'))
  const res = await run()
  assert.deepEqual(Object.keys(res).sort(), ['counts', 'dir', 'generation', 'vault'])
  await res.vault.close()
})

test('import refuses a pinned, non-empty or non-directory <dir> by name and writes nothing; a trailing slash names the same <dir>', async () => {
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

// ---------- the claim file ----------

/**
 * Two imports into one `dir`, through the injected initBundle: import A
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

test('a second import into the same <dir> refuses by name before its initBundle and deletes nothing; the vault, pin and files of the first import stay, for an absent and an existing empty <dir>', async () => {
  // mkdir succeeds on an existing directory, so it is no claim. If both
  // imports claim <dir>, B fails on the corestore lock, and its cleanup
  // removes the vault of A.
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
    assert.ok(!(await entries(join(dir, 'db'))).includes('okf-import-claim'), `${name}: no claim is left in <dir>/db/`)
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

test('a successful import leaves no claim file, at the top of <dir> or in <dir>/db/, where the store moves it at init', async () => {
  // The first open of the store moves each unknown file at the top of a new
  // storage directory into <dir>/db/, the claim file too. Import must remove
  // the claim from both places.
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

// ---------- a failure after the new vault exists removes it ----------

test('import checks each op against maxOpBytes as encoded, before it appends', async () => {
  // The body is below the limit, but the encoded op, with the id, the base,
  // the clock and `at`, is above it.
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

  const ok = await tmpDir('imp-pre-ok')
  await writeTree(join(ok, 'face'), face(limit - 400))
  const res = await importFace(recording([]), join(ok, 'face'), join(ok, 'vault'))
  assert.equal((await liveConcepts(res.vault)).get('ab'.repeat(32)).headText, 'y'.repeat(limit - 400))
  await res.vault.close()
})

test('an op that core rejects fails the import by name, and import removes the new directory', async () => {
  // 1. The metadata shows a larger maxOpBytes than the vault pins, so the
  //    preflight passes the op and core rejects it.
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

// ---------- the fidelity check ----------

test('compareNotes reports every difference by path, without _rev lines', () => {
  const note = (rev, body) => Buffer.from(`---\n_id: 0123abcd\n_rev: ${rev}\ntype: note\n---\n\n${body}\n`)
  const face = new Map([
    ['a.md', note('1'.repeat(64), 'same body')],
    ['.drafts/idea.md', note('2'.repeat(64), 'dot path')],
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

test('a truncated note fails the import by name with IMPORT_FIDELITY, and import removes the new directory', async () => {
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

  await mkdir(join(base, 'vault'))
  await assert.rejects(() => importFace(Bundle.init, face, join(base, 'vault')), (e) => e.code === 'IMPORT_FIDELITY')
  assert.deepEqual(await entries(join(base, 'vault')), [], 'the failure left files in an existing <dir>')
  await old.close()
})

test("import mode reads no .okf-pending.json of the face: a stale record attaches no note, and a record that does not parse is not read", async () => {
  // The pending record is ingest state of a live bundle directory, not of a
  // face. If import reads it, a stale record moves a concept to the path of
  // the copy, and a bad record throws a bare SyntaxError.
  const X = 'ab'.repeat(32)
  const b = `---\n_id: ${X}\ntype: note\n---\n\nnote b, a copy of a\n`
  const notes = [
    ['a.md', `---\n_id: ${X}\ntype: note\n---\n\nnote a\n`],
    ['b.md', b]
  ]
  // A record in the format of ingest: X at b.md, with the bytes of b.md,
  // while X is at the path a.
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

test('a collision resolved in the face imports, and each _id keeps its note', async () => {
  // The operator gives the copy a path of its own. index.md still lists the
  // copy, but import does not read index files.
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

// ---------- the metadata of the new vault ----------

test('the new vault carries limits, rate and schemaVersion, so a 100 KB body and a deep path survive', async () => {
  // The defaults refuse both: maxOpBytes 65536 and maxPathDepth 64.
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

  // Without the carried metadata the new vault takes the defaults: the
  // preflight refuses the body, and core rejects the deep path.
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

test('import refuses a <dir> that is a dangling symlink, by name, and rejects with the error of the file system when it cannot read <dir>; it writes nothing', async () => {
  const old = await Bundle.init(await tmpDir('imp-dir-link-vault'))
  await old.createConcept('notes/a', 'note')
  await old.update()
  const base = await tmpDir('imp-dir-link')
  const face = join(base, 'face')
  await materialize(old, face)
  await old.close()

  // mkdir cannot make a directory at a dangling symlink, and a symlink is
  // not a new directory: the vault would land at its target.
  await symlink(join(base, 'nowhere'), join(base, 'dangling'))
  const err = await expectRefusal(() => importFace(Bundle.init, face, join(base, 'dangling')), 'IMPORT_DIR_NOT_EMPTY', base, [face])
  assert.match(err.message, /dangling is not a directory/)

  // A symlink to itself: readdir fails ELOOP, which is not "absent".
  await symlink(join(base, 'loop'), join(base, 'loop'))
  await expectRefusal(() => importFace(Bundle.init, face, join(base, 'loop')), 'ELOOP', base, [face])
})

// ---------- encryption ----------

const SECRET = 'TOP-SECRET-PAYLOAD'
const NEW_KEY = 'ef'.repeat(32) // a generation has a key of its own

/** Seed one concept whose body is SECRET. Returns its _id. */
async function seedSecret(v) {
  const { tag } = await v.createConcept('secret/plan', 'note')
  await v.setBody(tag, null, SECRET)
  await v.update()
  return tag
}

/** A vault at `<base>/old` seeded by `seed(v)`, and its face at `<base>/face`. Returns the vault's metadata and seed result. */
async function oldWithFace(base, seed, opts = {}) {
  const v = await Bundle.init(join(base, 'old'), opts)
  try {
    const seeded = await seed(v)
    await v.update()
    assert.equal((await materialize(v, join(base, 'face'))).ok, true)
    return { keyHex: v.keyHex, metadata: v.metadata, seeded }
  } finally {
    await v.close()
  }
}

/** Every file under `dir` whose bytes hold `plain`, as relative paths. */
async function plaintextFiles(dir, plain) {
  const hits = []
  for (const e of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue
    const file = join(e.parentPath, e.name)
    if ((await readFile(file)).includes(Buffer.from(plain))) hits.push(file.slice(dir.length + 1))
  }
  return hits.sort()
}

test('import refuses a key that is not 32 bytes by name, false, empty and zero included, before it writes; and a factory that drops the key', async () => {
  // The store reads a false value as no key. import must refuse every value
  // that is not a key.
  const base = await tmpDir('imp-badkey')
  await oldWithFace(base, seedSecret)
  const face = join(base, 'face')
  const bad = [false, '', 0, NEW_KEY, Buffer.alloc(16, 1), Buffer.alloc(33, 1), [...Buffer.from(NEW_KEY, 'hex')]]
  for (const [i, encryptionKey] of bad.entries()) {
    await assert.rejects(
      () => importFace(Bundle.init, face, join(base, `out-${i}`), { encryptionKey }),
      (err) => {
        assert.equal(err.code, 'IMPORT_ENCRYPTION_KEY_INVALID', `${JSON.stringify(encryptionKey)}: ${err.stack}`)
        assert.ok(!err.message.includes(NEW_KEY), 'the message holds the key')
        return true
      }
    )
  }
  assert.deepEqual(await entries(base), ['face', 'old'], 'a refusal created something')

  // A factory that drops the key gives an unencrypted vault. import must read
  // its metadata before the first note.
  const created = []
  const dropKey = async (dir, { encryptionKey, ...opts }) => {
    const v = await Bundle.init(dir, opts)
    return new Proxy(v, {
      get(target, prop, receiver) {
        if (prop === 'createConcept') created.push(prop)
        return Reflect.get(target, prop, receiver)
      }
    })
  }
  await assert.rejects(
    () => importFace(dropKey, face, join(base, 'out'), { encryptionKey: Buffer.from(NEW_KEY, 'hex') }),
    (err) => err.code === 'IMPORT_NOT_ENCRYPTED'
  )
  assert.deepEqual(created, [], 'the import wrote content to the unencrypted vault')
  assert.deepEqual(await entries(base), ['face', 'old'])
})

test('import refuses to make an unencrypted generation of an encrypted vault, by name, before it writes: the metadata of the predecessor says encrypted, or the face holds .okf-encrypted; with a key the new vault is encrypted', async () => {
  // Without the mark, an import with no metadata and no key makes a
  // plaintext vault of an encrypted one in silence.
  const base = await tmpDir('imp-keyreq')
  const { metadata, seeded: id } = await oldWithFace(base, seedSecret, { encryptionKey: Buffer.alloc(32, 0xcd) })
  const face = join(base, 'face')
  assert.equal(metadata.encrypted, true, 'setup: the predecessor must be encrypted')
  assert.ok((await entries(face)).includes('.okf-encrypted'), 'setup: materialize must mark the face')

  const byMark = await expectRefusal(() => importFace(Bundle.init, face, join(base, 'out')), 'IMPORT_ENCRYPTION_KEY_REQUIRED', base, [face])
  assert.match(byMark.message, /holds \.okf-encrypted: .*opts\.encryptionKey/)

  // The metadata alone refuses too: a face that lost its mark.
  const bare = join(base, 'bare')
  await oldWithFace(bare, seedSecret)
  const byMetadata = await expectRefusal(
    () => importFace(Bundle.init, join(bare, 'face'), join(bare, 'out'), { metadata }),
    'IMPORT_ENCRYPTION_KEY_REQUIRED',
    bare,
    [join(bare, 'face')]
  )
  assert.match(byMetadata.message, /the predecessor's metadata says encrypted/)

  const res = await importFace(Bundle.init, face, join(base, 'out'), { metadata, encryptionKey: Buffer.from(NEW_KEY, 'hex') })
  assert.equal(res.vault.metadata.encrypted, true)
  assert.equal((await liveConcepts(res.vault)).get(id).headText, SECRET)
  await res.vault.close()
})

test('any entry at .okf-encrypted marks the face: import without a key refuses a directory or a dangling symlink at that name', async () => {
  // import reads the mark with lstat, so it fails closed.
  for (const [name, mark] of [
    ['directory', (at) => mkdir(at)],
    ['dangling symlink', (at) => symlink(join(at, '..', 'nowhere'), at)]
  ]) {
    const base = await tmpDir('imp-mark-kind')
    await oldWithFace(base, seedSecret)
    const face = join(base, 'face')
    await mark(join(face, '.okf-encrypted'))
    const err = await expectRefusal(() => importFace(Bundle.init, face, join(base, 'out')), 'IMPORT_ENCRYPTION_KEY_REQUIRED', base)
    assert.match(err.message, /holds \.okf-encrypted/, name)
  }
})

test('an import with a key makes a vault whose files hold no plaintext of the face, neither a body nor a path; an unencrypted control holds both', async () => {
  const base = await tmpDir('imp-enc-rest')
  const { seeded: id } = await oldWithFace(base, seedSecret)
  const face = join(base, 'face')
  const out = join(base, 'enc')
  const enc = await importFace(Bundle.init, face, out, { encryptionKey: Buffer.from(NEW_KEY, 'hex') })
  assert.equal(enc.vault.metadata.encrypted, true)
  assert.equal((await liveConcepts(enc.vault)).get(id).headText, SECRET)
  await enc.vault.close()
  // Every file of the new vault, not only the cores: a side file can leak paths.
  assert.deepEqual({ body: await plaintextFiles(out, SECRET), path: await plaintextFiles(out, 'secret/plan') }, { body: [], path: [] })

  // The control shows that the checks above can see plaintext.
  const ctl = join(base, 'plain')
  const plain = await importFace(Bundle.init, face, ctl)
  assert.equal(plain.vault.metadata.encrypted, false)
  await plain.vault.close()
  assert.notDeepEqual(await plaintextFiles(ctl, SECRET), [])
  assert.notDeepEqual(await plaintextFiles(ctl, 'secret/plan'), [])
})
