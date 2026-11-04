// A directory move through the watcher must lose no concept. Two traps.
// fs.watch can report the old path first. Then a DeleteConcept lands before
// the SetPath of the moved file, and the next materialize unlinks it. macOS
// fs.watch reports a subtree move as directory renames only, so a watcher
// that drops non-.md paths emits no op. See okf/faces/lib/ingest.js.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Bundle, createIngestWatcher, materialize, K, until, tmpDir } from '../faces-helpers.js'

const BODY = 'A precious body the human wrote.\n'

async function seededBundle(name, path = 'Recipes/Soup') {
  const v = await Bundle.init(await tmpDir(name))
  const { tag: id } = await v.createConcept(path, 'Recipe')
  await v.setField(id, 'title', 'Soup')
  await v.setBody(id, null, BODY)
  await v.update()
  const bdir = await tmpDir(`${name}-bundle`)
  await materialize(v, bdir)
  return { v, id, bdir }
}

async function hasUndeleteFlag(v, id) {
  for await (const _ of v.scan(K.flagPrefix('undelete', id))) return true
  return false
}

test('#30(1): delete-before-move ordering resurrects the moved concept (no data loss)', async () => {
  const { v, id, bdir } = await seededBundle('A')
  // The moved file keeps its _id frontmatter.
  await rename(join(bdir, 'Recipes'), join(bdir, 'Cooking'))

  const w = await createIngestWatcher(v, bdir, { watch: false, confirmDelete: async () => true })
  // the old path first, the order that fs.watch can deliver
  await w._maybeDelete('Recipes/Soup.md')
  await v.update()
  assert.ok((await v.val(K.cMeta(id))).deleted != null, 'precondition: the delete tombstoned the concept')

  await w.ingestFile('Cooking/Soup.md')
  await v.update()

  const meta = await v.val(K.cMeta(id))
  assert.equal(meta.deleted, undefined, 'ingest of the moved file undid the tombstone')
  assert.equal((await v.val(K.cPath(id))).path, 'Cooking/Soup')
  assert.equal(await v.val(K.path('Cooking/Soup')), id, 'moved path claim held')
  assert.equal(await v.val(K.path('Recipes/Soup')), undefined, 'old path vacated')
  const rev = await v.val(K.cRev(id, await v.val(K.cBody(id))))
  assert.ok(rev.text.startsWith('A precious body'), 'body intact')
  assert.ok(await hasUndeleteFlag(v, id), 'the resurrection is audited (flag/undelete)')

  const rep = await materialize(v, bdir)
  assert.deepEqual(rep.removed, [], 'materialize unlinks nothing')
  const txt = await readFile(join(bdir, 'Cooking/Soup.md'), 'utf8')
  assert.ok(txt.includes('A precious body'), 'moved file survives on disk')
  await w.close()
  await v.close()
})

test('#30(2): live event ordering — deferred delete never tombstones a moved concept', async () => {
  const { v, id, bdir } = await seededBundle('B')
  await rename(join(bdir, 'Recipes'), join(bdir, 'Cooking'))

  const deleted = []
  const w = await createIngestWatcher(v, bdir, {
    watch: false,
    debounce: 20,
    settle: 10,
    confirmDelete: async (_id, rel) => {
      deleted.push(rel)
      return true
    }
  })
  // the vanished old path first
  w._dirty('Recipes/Soup.md')
  w._dirty('Cooking/Soup.md')

  assert.ok(
    await until(async () => {
      await v.update()
      return (await v.val(K.path('Cooking/Soup'))) === id
    }),
    'the moved file ingested (SetPath landed)'
  )
  // wait for the quiet window of the deferred delete
  assert.ok(
    await until(() => w._pendingDeletes.size === 0 && w._drainTimer === null && w._timers.size === 0),
    'delete queue drained'
  )
  await v.update()
  assert.equal((await v.val(K.cMeta(id))).deleted, undefined, 'never tombstoned')
  assert.equal(await hasUndeleteFlag(v, id), false, 'ordering fix alone sufficed — no resurrection needed')
  assert.deepEqual(deleted, [], 'the confirmation guard was never even consulted')
  await w.close()
  await v.close()
})

test('#30(3): a directory event triggers a rescan that lands the move', async () => {
  const { v, id, bdir } = await seededBundle('C')
  await rename(join(bdir, 'Recipes'), join(bdir, 'Cooking'))

  const w = await createIngestWatcher(v, bdir, { watch: false, debounce: 20, settle: 10 })
  // What macOS fs.watch delivers for `mv Recipes Cooking`: a rename of
  // each directory, and no .md path.
  w._dirty('Recipes')
  w._dirty('Cooking')

  assert.ok(
    await until(async () => {
      await v.update()
      return (await v.val(K.path('Cooking/Soup'))) === id
    }),
    'the scoped rescan ingested the moved file'
  )
  await v.update()
  assert.equal((await v.val(K.cMeta(id))).deleted, undefined, 'concept live')
  assert.equal(await v.val(K.path('Recipes/Soup')), undefined, 'old claim vacated')
  const rep = await materialize(v, bdir)
  assert.deepEqual(rep.removed, [], 'no duplicated/orphaned bundle: nothing to remove')
  await w.close()
  await v.close()
})

test('#30(4): restoring a deleted file on disk undeletes the concept', async () => {
  const { v, id, bdir } = await seededBundle('D', 'Notes/Keep')
  const bytes = await readFile(join(bdir, 'Notes/Keep.md'), 'utf8')

  await v.deleteConcept(id)
  await v.update()
  const rep = await materialize(v, bdir)
  assert.ok(rep.removed.includes('Notes/Keep.md'), 'precondition: deletion unlinked the file')

  // the restored file keeps its old _id
  await mkdir(join(bdir, 'Notes'), { recursive: true })
  await writeFile(join(bdir, 'Notes/Keep.md'), bytes)

  const w = await createIngestWatcher(v, bdir, { watch: false })
  const ops = await w.ingestFile('Notes/Keep.md')
  assert.ok(ops.some((o) => o.type === 'undelete-concept'), 'ingest emitted the undelete')
  await v.update()
  assert.equal((await v.val(K.cMeta(id))).deleted, undefined, 'concept restored')
  assert.equal(await v.val(K.path('Notes/Keep')), id, 'path claim restored')
  assert.ok(await hasUndeleteFlag(v, id), 'audited via flag/undelete')
  await w.close()
  await v.close()
})
