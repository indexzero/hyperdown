// @auto-okf/faces N3 preservation ("deletion is dangerous") and conflict-
// copy round-trip on REAL @auto-okf/store vaults. These are the load-bearing
// safety properties: materialize must NEVER delete or overwrite a file it
// did not itself materialize-and-track, and a materialized conflicted copy
// must ingest back to a stable no-op.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, stat, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  initVault,
  joinVault,
  materialize,
  createIngestWatcher,
  K,
  tmpDir,
  readBundle,
  bundleDiff,
  pair,
  converged
} from './faces-helpers.js'

const exists = async (p) => {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

test('N3: a hand-authored .md is never deleted or overwritten by materialize', async () => {
  const v = await initVault(await tmpDir('vault'))
  const { tag: id } = await v.createConcept('a', 'Note')
  await v.setBody(id, null, 'concept a')
  await v.update()
  const dir = await tmpDir('bundle')
  await materialize(v, dir)

  // Drop a brand-new human file the system has never seen.
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

test('N3: a human EDIT to a materialized concept file is preserved, not clobbered', async () => {
  const v = await initVault(await tmpDir('vault'))
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

test('materialize removes only its own prior outputs (renamed concept old path)', async () => {
  const v = await initVault(await tmpDir('vault'))
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
  // the now-empty old/ directory is pruned
  assert.equal(await exists(join(dir, 'old')), false, 'empty directory not pruned')
  await v.close()
})

test('forceMirror overwrites and deletes unconditionally (operator escape hatch)', async () => {
  const v = await initVault(await tmpDir('vault'))
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
  // stray.md has no manifest entry and is not planned, so it is left as-is
  // even under forceMirror (removal only touches manifest-tracked files).
  assert.equal(await exists(join(dir, 'stray.md')), true)
  await v.close()
})

test('conflict-copy round-trip: a pathcollision loser materializes and re-ingests stably', async () => {
  const a = await initVault(await tmpDir('vault-a'))
  const b = await joinVault(await tmpDir('vault-b'), a.key)
  let unpair = pair(a, b)
  assert.ok(await converged([a, b]), 'initial converge failed')
  await a.writers.add(b.localKey)
  assert.ok(await converged([a, b]), 'writer-add converge failed')

  // Partition, then both writers claim the SAME path concurrently.
  unpair()
  const { tag: idA } = await a.createConcept('shared/note', 'Note')
  await a.setBody(idA, null, 'A wrote this')
  const { tag: idB } = await b.createConcept('shared/note', 'Note')
  await b.setBody(idB, null, 'B wrote this')

  unpair = pair(a, b)
  assert.ok(await converged([a, b]), 'post-partition converge failed')

  // Exactly one holds path/shared/note; the other is a pathcollision loser.
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
  // The conflicted copy carries the loser _id.
  assert.match(bundle.get(conflictName), new RegExp(`_id: "?${loser}"?`))

  // Re-ingest the whole bundle: the conflict copy strips its suffix to the
  // loser's view path, which already equals it => no SetPath, no changes.
  const w = await createIngestWatcher(a, dir, { watch: false })
  const ops = await w.scan()
  assert.equal(ops.length, 0, 'conflict-copy bundle re-emitted ops: ' + JSON.stringify(ops))

  // And materialize is a stable fixpoint.
  await a.update()
  const r2 = await materialize(a, dir)
  assert.equal(r2.written.length, 0, 'conflict bundle not stable: ' + JSON.stringify(r2.written))
  assert.equal(bundleDiff(bundle, await readBundle(dir)), null)

  await w.close()
  unpair()
  await a.close()
  await b.close()
})
