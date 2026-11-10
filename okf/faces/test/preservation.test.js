// materialize must never delete or overwrite a file whose bytes differ from
// its emission manifest. See SPEC §9.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, stat, mkdir } from 'node:fs/promises'
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
} from './helpers.js'

const exists = async (p) => {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

test('materialize never deletes or overwrites a hand-authored .md, and reports it as pending-ingest', async () => {
  const v = await Bundle.init(await tmpDir('vault'))
  const { tag: id } = await v.createConcept('a', 'Note')
  await v.setBody(id, null, 'concept a')
  await v.update()
  const dir = await tmpDir('bundle')
  await materialize(v, dir)

  await mkdir(join(dir, 'notes'), { recursive: true })
  const humanPath = join(dir, 'notes/human.md')
  const humanBytes = '---\ntype: Playbook\ntitle: Hand written\n---\n\nDo not touch me.\n'
  await writeFile(humanPath, humanBytes)

  const r = await materialize(v, dir)
  assert.equal(await exists(humanPath), true, 'human file was deleted')
  assert.equal(await readFile(humanPath, 'utf8'), humanBytes, 'human file was overwritten')
  assert.ok(r.pendingIngest.includes('notes/human.md'), 'human file not surfaced as pending-ingest')
  assert.equal(r.ok, false, 'run should report not-ok while a pending-ingest file exists')
  await v.close()
})

test('a failed ingest (type-less file) never lets materialize delete the human file', async () => {
  const v = await Bundle.init(await tmpDir('vault'))
  const { tag: id } = await v.createConcept('a', 'Note')
  await v.setBody(id, null, 'a')
  await v.update()
  const dir = await tmpDir('bundle')
  await materialize(v, dir)

  // A note with no `type` creates no concept. If ingest still records the file
  // in the manifest, the next materialize deletes it.
  const humanPath = join(dir, 'draft.md')
  const humanBytes = '---\ntitle: Draft, no type yet\n---\n\nwork in progress\n'
  await writeFile(humanPath, humanBytes)

  const w = await createIngestWatcher(v, dir, { watch: false })
  const ops = await w.ingestFile('draft.md')
  assert.equal(ops.length, 0, 'a type-less file must not create a concept')
  await w.close()

  const r = await materialize(v, dir)
  assert.equal(await exists(humanPath), true, 'materialize deleted a human file a failed ingest had touched')
  assert.equal(await readFile(humanPath, 'utf8'), humanBytes, 'human file was overwritten')
  assert.ok(r.pendingIngest.includes('draft.md'), 'type-less human file not surfaced as pending-ingest')
  await v.close()
})

test('materialize prunes the old path of a renamed concept from the manifest, so the same bytes back at that path are not deleted', async () => {
  const v = await Bundle.init(await tmpDir('vault'))
  const { tag: id } = await v.createConcept('a', 'Note')
  await v.setBody(id, null, 'body')
  await v.update()
  const dir = await tmpDir('bundle')
  await materialize(v, dir)
  const aPath = join(dir, 'a.md')
  const generated = await readFile(aPath, 'utf8')

  // materialize removes a.md, its own output, and must drop it from the manifest.
  await v.setPath(id, 'b')
  await v.update()
  const r1 = await materialize(v, dir)
  assert.ok(r1.removed.includes('a.md'))
  assert.equal(await exists(aPath), false)

  // The same bytes return at a.md, where no concept lives now. A stale
  // manifest entry matches them and deletes the file.
  await writeFile(aPath, generated)
  const r2 = await materialize(v, dir)
  assert.equal(await exists(aPath), true, 'stale manifest entry let materialize delete a human file')
  assert.equal(await readFile(aPath, 'utf8'), generated, 'recreated human file was overwritten')
  assert.ok(r2.pendingIngest.includes('a.md'), 'recreated human file not surfaced as pending-ingest')
  assert.ok(!r2.removed.includes('a.md'))
  await v.close()
})

test('materialize keeps a human edit of a materialized concept file, and does not overwrite it', async () => {
  const v = await Bundle.init(await tmpDir('vault'))
  const { tag: id } = await v.createConcept('a', 'Note')
  await v.setField(id, 'title', 'A')
  await v.setBody(id, null, 'body')
  await v.update()
  const dir = await tmpDir('bundle')
  await materialize(v, dir)

  const f = join(dir, 'a.md')
  const edited = (await readFile(f, 'utf8')).replace('body', 'body edited by a human, not yet ingested')
  await writeFile(f, edited)

  const r = await materialize(v, dir)
  assert.equal(await readFile(f, 'utf8'), edited, 'human edit was overwritten')
  assert.ok(r.pendingIngest.includes('a.md'))
  assert.ok(!r.written.includes('a.md'))
  await v.close()
})

test('materialize removes its own output at the old path of a renamed concept, and prunes the empty directory', async () => {
  const v = await Bundle.init(await tmpDir('vault'))
  const { tag: id } = await v.createConcept('old/name', 'Note')
  await v.setBody(id, null, 'x')
  await v.update()
  const dir = await tmpDir('bundle')
  await materialize(v, dir)
  assert.equal(await exists(join(dir, 'old/name.md')), true)

  await v.setPath(id, 'new/name')
  await v.update()
  const r = await materialize(v, dir)
  assert.equal(await exists(join(dir, 'new/name.md')), true, 'renamed file missing')
  assert.equal(await exists(join(dir, 'old/name.md')), false, 'old materialized file not reclaimed')
  assert.ok(r.removed.includes('old/name.md'))
  assert.equal(await exists(join(dir, 'old')), false, 'empty directory not pruned')
  await v.close()
})

test('forceMirror overwrites a human edit of a manifest file, and leaves a file that no manifest lists', async () => {
  const v = await Bundle.init(await tmpDir('vault'))
  const { tag: id } = await v.createConcept('a', 'Note')
  await v.setBody(id, null, 'body')
  await v.update()
  const dir = await tmpDir('bundle')
  await materialize(v, dir)

  const f = join(dir, 'a.md')
  await writeFile(f, 'clobber me\n')
  await writeFile(join(dir, 'stray.md'), '---\ntype: X\n---\n\nstray\n')

  const r = await materialize(v, dir, { forceMirror: true })
  assert.match(await readFile(f, 'utf8'), /type: Note/, 'forceMirror did not restore canonical bytes')
  assert.equal(r.pendingIngest.length, 0)
  // forceMirror removes manifest entries only. stray.md is in no manifest, so it stays.
  assert.equal(await exists(join(dir, 'stray.md')), true)
  await v.close()
})

test('a pathcollision loser materializes as a conflicted copy, and its ingest emits no op', async () => {
  const a = await Bundle.init(await tmpDir('vault-a'))
  const b = await Bundle.join(await tmpDir('vault-b'), a.key)
  let unpair = pair(a, b)
  assert.ok(await converged([a, b]), 'initial converge failed')
  await a.writers.add(b.localKey)
  assert.ok(await converged([a, b]), 'writer-add converge failed')

  // The partition makes the two claims concurrent.
  unpair()
  const { tag: idA } = await a.createConcept('shared/note', 'Note')
  await a.setBody(idA, null, 'A wrote this')
  const { tag: idB } = await b.createConcept('shared/note', 'Note')
  await b.setBody(idB, null, 'B wrote this')

  unpair = pair(a, b)
  assert.ok(await converged([a, b]), 'post-partition converge failed')

  const holder = await a.val(K.path('shared/note'))
  assert.ok(holder === idA || holder === idB)
  const loser = holder === idA ? idB : idA

  const dir = await tmpDir('bundle')
  const r1 = await materialize(a, dir)
  assert.ok(r1.ok)
  const bundle = await readBundle(dir)
  assert.ok(bundle.has('shared/note.md'), 'winner file missing')
  const conflictName = [...bundle.keys()].find((k) => /shared\/note\.conflict-[0-9a-f]{8,}\.md$/.test(k))
  assert.ok(conflictName, 'conflicted copy not emitted')
  assert.match(bundle.get(conflictName), new RegExp(`_id: "?${loser}"?`))

  // Ingest maps the conflicted copy to the path of the loser, which is already
  // its path, so no op follows.
  const w = await createIngestWatcher(a, dir, { watch: false })
  const ops = await w.scan()
  assert.equal(ops.length, 0, 'conflict-copy bundle re-emitted ops: ' + JSON.stringify(ops))

  await a.update()
  const r2 = await materialize(a, dir)
  assert.equal(r2.written.length, 0, 'conflict bundle not stable: ' + JSON.stringify(r2.written))
  assert.equal(bundleDiff(bundle, await readBundle(dir)), null)

  await w.close()
  unpair()
  await a.close()
  await b.close()
})
