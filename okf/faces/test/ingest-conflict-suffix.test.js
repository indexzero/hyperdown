// A file with more than one `.conflict-<hex>` suffix must ingest at the base
// path with every suffix stripped. One strip leaves a reserved path, apply
// rejects the CreateConcept `reserved-path`, and the file stays pending for
// good. materialize never writes a double suffix (SPEC §7), so such a file
// is always human-authored.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Bundle, materialize, createIngestWatcher, K, tmpDir } from './helpers.js'

test('P7 (#28): a double-suffixed human file ingests to the fully-stripped base path', async () => {
  const v = await Bundle.init(await tmpDir('vault'))
  const dir = await tmpDir('bundle')
  await materialize(v, dir) // writes the emission manifest and the reserved files

  const rel = 'note.conflict-aabbccdd.conflict-11223344.md'
  await writeFile(join(dir, rel), '---\ntype: Reference\ntitle: Double\n---\n\nbody\n')

  const w = await createIngestWatcher(v, dir, { watch: false })
  const ops = await w.ingestFile(rel)
  await v.update()

  assert.ok(
    ops.some((o) => o.type === 'create-concept'),
    'double-suffixed file must ingest, not be rejected reserved-path'
  )
  const id = await v.val(K.path('note'))
  assert.ok(id, 'a concept must live at the fully-stripped base path "note"')
  assert.equal(
    await v.val(K.path('note.conflict-aabbccdd')),
    undefined,
    'no concept at the still-reserved single-stripped path'
  )

  await w.close()
  await v.close()
})
