// status(vault, dir) gives one state per `.md` file of a bundle: in-log,
// pending-ingest, dirty, absent or foreign. It reads only. See SPEC §9 and
// okf/docs/decisions/ADR-002-status-command.md.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Bundle, materialize, createIngestWatcher, status, tmpDir, treeHash, writeTree } from './helpers.js'

/**
 * A vault with three concepts, and its bundle directory after one
 * materialize: three notes, index.md in the root and in each directory, and
 * log.md.
 */
async function seeded(t) {
  const v = await Bundle.init(await tmpDir('status-vault'))
  t.after(() => v.close())
  const ids = {}
  for (const path of ['guides/intro', 'guides/setup', 'overview']) {
    const { tag } = await v.createConcept(path, 'note')
    await v.setBody(tag, null, `body of ${path}`)
    ids[path] = tag
  }
  await v.update()
  const dir = await tmpDir('status-bundle')
  assert.equal((await materialize(v, dir)).ok, true, 'setup: the bundle must be clean')
  return { v, dir, ids }
}

/**
 * The rows of status(v, dir). Fails if the call appends an op, changes the
 * view, or changes one byte or one entry under `dir`.
 */
async function readOnlyStatus(v, dir) {
  const state = async () => ({ ops: v.db.local.length, view: await v.snapshotHash(), files: await treeHash(dir) })
  await v.update()
  const before = await state()
  const rows = await status(v, dir)
  assert.deepEqual(await state(), before, 'status appended an op or wrote a file')
  return rows
}

/** The rows as { <path>: <state> }. */
const byPath = (rows) => Object.fromEntries(rows.map((r) => [r.path, r.state]))

const ALL_IN_LOG = {
  'guides/index.md': 'in-log',
  'guides/intro.md': 'in-log',
  'guides/setup.md': 'in-log',
  'index.md': 'in-log',
  'log.md': 'in-log',
  'overview.md': 'in-log'
}

test('in-log: each file that holds the bytes that materialize writes is in-log, index.md and log.md included', async (t) => {
  const { v, dir } = await seeded(t)
  const rows = await readOnlyStatus(v, dir)
  assert.deepEqual(byPath(rows), ALL_IN_LOG)
  assert.deepEqual(rows[0], { path: 'guides/index.md', state: 'in-log' }, 'a row holds path and state only')
})

test('in-log does not need the emission manifest: the bytes of the plan decide', async (t) => {
  // A bundle copied without its dot-files has no manifest. The files still
  // hold the bytes of the plan.
  const { v, dir } = await seeded(t)
  await rm(join(dir, '.okf-manifest.json'))
  assert.deepEqual(byPath(await readOnlyStatus(v, dir)), ALL_IN_LOG)
})

test('the rows are in byte order of path, not in UTF-16 order', async (t) => {
  // U+FF5E sorts after U+1F600 by UTF-16 code unit and before it by UTF-8 byte.
  const v = await Bundle.init(await tmpDir('status-order-vault'))
  t.after(() => v.close())
  for (const path of ['\u{1F600}', '～', 'a', 'Z']) await v.createConcept(path, 'note')
  await v.update()
  const rows = await readOnlyStatus(v, await tmpDir('status-order'))
  assert.deepEqual(rows.map((r) => r.path), ['Z.md', 'a.md', 'index.md', 'log.md', '～.md', '\u{1F600}.md'])
})

test('absent: a file of the plan that the directory does not hold is absent', async (t) => {
  const { v, dir } = await seeded(t)
  await rm(join(dir, 'guides', 'intro.md'))
  await rm(join(dir, 'log.md'))
  assert.deepEqual(byPath(await readOnlyStatus(v, dir)), { ...ALL_IN_LOG, 'guides/intro.md': 'absent', 'log.md': 'absent' })
})

test('absent: a directory that does not exist gives every file of the plan as absent, and status does not create it', async (t) => {
  const { v } = await seeded(t)
  const dir = join(await tmpDir('status-missing'), 'not-yet')
  const rows = await status(v, dir)
  assert.deepEqual(byPath(rows), Object.fromEntries(Object.keys(ALL_IN_LOG).map((p) => [p, 'absent'])))
  await assert.rejects(stat(dir), { code: 'ENOENT' }, 'status created the directory')
})

test('dirty: a file of the manifest whose bytes differ from the plan is dirty, after an edit on disk or a change in the vault', async (t) => {
  const { v, dir, ids } = await seeded(t)
  const intro = join(dir, 'guides', 'intro.md')
  await writeFile(intro, (await readFile(intro, 'utf8')).replace('body of', 'a human edit of'))
  assert.deepEqual(byPath(await readOnlyStatus(v, dir)), { ...ALL_IN_LOG, 'guides/intro.md': 'dirty' })

  // The vault moves on, and no materialize follows: the file of the concept
  // holds old bytes.
  await v.setBody(ids.overview, null, 'a later body')
  assert.deepEqual(byPath(await readOnlyStatus(v, dir)), {
    ...ALL_IN_LOG,
    'guides/intro.md': 'dirty',
    'overview.md': 'dirty'
  })
})

test('dirty: a file of the manifest that the plan no longer holds is dirty while it is on disk, and gets no row once it is gone', async (t) => {
  // The concept is deleted in the vault, and no materialize follows. The
  // manifest entry with no file and no plan is retired state: no row.
  const { v, dir, ids } = await seeded(t)
  await v.deleteConcept(ids.overview)
  const stale = { ...ALL_IN_LOG, 'index.md': 'dirty', 'log.md': 'dirty' }
  assert.deepEqual(byPath(await readOnlyStatus(v, dir)), { ...stale, 'overview.md': 'dirty' })

  await rm(join(dir, 'overview.md'))
  const manifest = JSON.parse(await readFile(join(dir, '.okf-manifest.json'), 'utf8'))
  assert.ok(Object.hasOwn(manifest.files, 'overview.md'), 'setup: the manifest still lists overview.md')
  const { 'overview.md': _, ...rest } = stale
  assert.deepEqual(byPath(await readOnlyStatus(v, dir)), rest)
})

test('dirty: an index.md or log.md that the manifest does not list is dirty, never pending-ingest or foreign', async (t) => {
  // ingest ignores both names in every directory and in any case, so
  // pending-ingest is false for them, with a `type` or without one.
  // materialize reconciles them.
  const { v, dir } = await seeded(t)
  await writeTree(dir, new Map([
    ['extra/index.md', '---\ntype: note\n---\n\na hand-written index\n'],
    ['extra/deep/Log.md', 'no frontmatter\n'],
    ['other/INDEX.md', '# Contents\n']
  ]))
  assert.deepEqual(byPath(await readOnlyStatus(v, dir)), {
    ...ALL_IN_LOG,
    'extra/deep/Log.md': 'dirty',
    'extra/index.md': 'dirty',
    'other/INDEX.md': 'dirty'
  })
})

// The frontmatter of a file that the manifest does not list, and whether the
// `type` gate of ingest makes a concept of it.
const GATE = [
  ['typed.md', '---\ntype: note\n---\n\nbody\n', true],
  ['typed-list.md', '---\ntype: [note, other]\n---\n\nbody\n', true],
  ['no-frontmatter.md', 'plain text, no frontmatter\n', false],
  ['no-type.md', '---\ntitle: Draft\n---\n\nbody\n', false],
  ['empty-type.md', '---\ntype: ""\n---\n\nbody\n', false],
  ['number-type.md', '---\ntype: 42\n---\n\nbody\n', false],
  ['empty-list-type.md', '---\ntype: []\n---\n\nbody\n', false],
  ['map-type.md', '---\ntype:\n  name: note\n---\n\nbody\n', false]
]

test('pending-ingest and foreign: a file that the manifest does not list is pending-ingest when its frontmatter passes the `type` gate of ingest, and foreign when it does not', async (t) => {
  const { v, dir } = await seeded(t)
  await writeTree(dir, new Map(GATE.map(([name, text]) => [`drafts/${name}`, text])))
  const expected = Object.fromEntries(GATE.map(([name, , passes]) => [`drafts/${name}`, passes ? 'pending-ingest' : 'foreign']))
  assert.deepEqual(byPath(await readOnlyStatus(v, dir)), { ...ALL_IN_LOG, ...expected })

  // The gate of status must match the gate of the watcher. If the two
  // differ, status promises an ingest that makes no concept, or hides one.
  const w = await createIngestWatcher(v, dir, { watch: false })
  t.after(() => w.close())
  for (const [name, , passes] of GATE) {
    const ops = await w.ingestFile(`drafts/${name}`)
    assert.equal(ops.some((o) => o.type === 'create-concept'), passes, `ingest and status differ on ${name}`)
  }
})

test('pending-ingest: a hand-written file at a path of the plan, in a directory with no manifest, is judged by its own frontmatter', async (t) => {
  // No materialize wrote here, so no file is dirty: nothing of the manifest
  // can be lost.
  const { v } = await seeded(t)
  const dir = await tmpDir('status-fresh')
  await writeTree(dir, new Map([
    ['overview.md', '---\ntype: note\n---\n\nwritten by hand\n'],
    ['guides/intro.md', 'written by hand, no frontmatter\n']
  ]))
  assert.deepEqual(byPath(await readOnlyStatus(v, dir)), {
    'guides/index.md': 'absent',
    'guides/intro.md': 'foreign',
    'guides/setup.md': 'absent',
    'index.md': 'absent',
    'log.md': 'absent',
    'overview.md': 'pending-ingest'
  })
})

test('a file under a dot name, or one that is not .md, gets no row', async (t) => {
  const { v, dir } = await seeded(t)
  await writeTree(dir, new Map([
    ['.drafts/idea.md', '---\ntype: note\n---\n\nbody\n'],
    ['guides/.hidden.md', '---\ntype: note\n---\n\nbody\n'],
    ['guides/notes.txt', 'text\n']
  ]))
  assert.deepEqual(byPath(await readOnlyStatus(v, dir)), ALL_IN_LOG)
})

test('status rejects with the error of the file system when it cannot read the directory or a file of the plan', async (t) => {
  // Only ENOENT means absent. Another error must not turn into a state.
  const { v } = await seeded(t)
  const base = await tmpDir('status-errors')
  await writeFile(join(base, 'file'), 'a file\n')
  await assert.rejects(status(v, join(base, 'file', 'bundle')), { code: 'ENOTDIR' })

  await mkdir(join(base, 'bundle', 'overview.md'), { recursive: true })
  await assert.rejects(status(v, join(base, 'bundle')), { code: 'EISDIR' })
})
