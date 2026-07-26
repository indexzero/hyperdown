// Regression (issue #28 / OKF-SPEC-REVIEW-3 P7): a human-authored bundle file
// carrying MORE THAN ONE reserved `.conflict-<hex>` suffix must ingest at the
// fully suffix-stripped base path. The prior single-strip left a still-reserved
// path (`p.conflict-<hex>`), so apply rejected the CreateConcept `reserved-path`
// and the file was PERMANENTLY pending-ingest. materialize never emits a
// double-suffix path (§7), so such a file is always human-authored.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { initVault, materialize, createIngestWatcher, K, tmpDir } from '../faces-helpers.js'

test('P7 (#28): a double-suffixed human file ingests to the fully-stripped base path', async () => {
  const v = await initVault(await tmpDir('vault'))
  const dir = await tmpDir('bundle')
  await materialize(v, dir) // establish the manifest + reserved faces

  // Two stacked reserved suffixes — impossible for materialize to emit (§7).
  const rel = 'note.conflict-aabbccdd.conflict-11223344.md'
  await writeFile(join(dir, rel), '---\ntype: Reference\ntitle: Double\n---\n\nbody\n')

  const w = await createIngestWatcher(v, dir, { watch: false })
  const ops = await w.ingestFile(rel)
  await v.update()

  // It ingested (was NOT rejected reserved-path) ...
  assert.ok(
    ops.some((o) => o.type === 'create-concept'),
    'double-suffixed file must ingest, not be rejected reserved-path'
  )
  // ... at the FULLY stripped base path 'note' ...
  const id = await v.val(K.path('note'))
  assert.ok(id, 'a concept must live at the fully-stripped base path "note"')
  // ... and NEVER at the still-reserved single-stripped path.
  assert.equal(
    await v.val(K.path('note.conflict-aabbccdd')),
    undefined,
    'no concept at the still-reserved single-stripped path'
  )

  await w.close()
  await v.close()
})
