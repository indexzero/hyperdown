// A squatter can adopt the future mint id of a writer before its admission.
// apply then mints a SHA fallback for the genuine concept, and the tag id
// points at the squatter. If ingest takes the op tag as the concept id, the
// fields of the minted file land on the squatter. See SPEC §6.
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
  const squatId = makeTag(Ehex, 0) // the tag of E's first mint

  // E is not yet a known writer, so apply allows the adoption.
  await A.createConcept('squat/pre', 'note', { id: squatId })
  await converged([A, E])
  await A.addWriter(E.localKey, { indexer: false })
  await until(async () => { await E.update(); return E.writable })
  await converged([A, E])

  // a file with no _id, so a mint
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

  const squatTitle = await A.val(K.cField(squatId, 'title'))
  assert.equal(squatTitle, undefined, 'squatter must not capture the ingested title')

  const genuineId = await A.val(K.path('e/genuine'))
  assert.ok(genuineId && genuineId !== squatId, 'genuine concept minted under a fresh id')
  const rec = await A.val(K.cField(genuineId, 'title'))
  assert.ok(rec && rec.values && rec.values[0] === 'GENUINE', 'title landed on the genuine concept')

  unpair()
  await A.close()
  await E.close()
})
