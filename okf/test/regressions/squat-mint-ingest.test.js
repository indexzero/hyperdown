// Regression (T10 adversarial review, finding F2 — MAJOR, §6 P1): when a
// squatter pre-adopts a writer's future mint id (writerKey || seq) before
// that writer is admitted, apply mints a SHA fallback for the genuine
// concept and leaves the tag-id pointing at the squatter's concept. The
// ingest watcher used the create op's tag as the concept id for its
// follow-on frontmatter/body diffs, so a minted file's fields were written
// onto the SQUATTER's concept (identity capture / silent misrouting).
//
// Fix: ingest resolves the minted id from the VIEW (path/<path> whose
// meta.created === tag, else a c/ scan), never from the op tag.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  Bundle,
  createIngestWatcher,
  K,
  makeTag,
  pair,
  converged,
  until,
  tmpDir
} from '../faces-helpers.js'

test('P1: a squatted mint id does not capture an ingested file’s fields', async () => {
  const A = await Bundle.init(await tmpDir('A'))
  const E = await Bundle.join(await tmpDir('E'), A.keyHex)
  const unpair = pair(A, E)
  await converged([A, E])

  const Ehex = Buffer.from(E.localKey).toString('hex')
  const squatId = makeTag(Ehex, 0) // E's first mint will carry tag Ehex||0

  // 1) A pre-squats E's future mint id (E not yet a known writer → allowed).
  await A.createConcept('squat/pre', 'note', { id: squatId })
  await converged([A, E])
  // 2) A admits E.
  await A.addWriter(E.localKey, { indexer: false })
  await until(async () => { await E.update(); return E.writable })
  await converged([A, E])

  // 3) E ingests a fresh file with NO _id at e/genuine (a mint) carrying a
  //    distinctive title. With the bug the title lands on A's squat concept.
  const dir = await tmpDir('E-bundle')
  await mkdir(join(dir, 'e'), { recursive: true })
  await writeFile(
    join(dir, 'e', 'genuine.md'),
    '---\ntype: note\ntitle: GENUINE\n---\ngenuine body\n'
  )
  const w = await createIngestWatcher(E, dir, { watch: false })
  await w.ingestFile('e/genuine.md')
  await w.close()
  await converged([A, E])

  // The squat concept (tag-id, at squat/pre) must NOT have absorbed the title.
  const squatTitle = await A.val(K.cField(squatId, 'title'))
  assert.equal(squatTitle, undefined, 'squatter must not capture the ingested title')

  // The genuine concept (the SHA fallback that claimed e/genuine) must carry it.
  const genuineId = await A.val(K.path('e/genuine'))
  assert.ok(genuineId && genuineId !== squatId, 'genuine concept minted under a fresh id')
  const rec = await A.val(K.cField(genuineId, 'title'))
  assert.ok(rec && rec.values && rec.values[0] === 'GENUINE', 'title landed on the genuine concept')

  unpair()
  await A.close()
  await E.close()
})
