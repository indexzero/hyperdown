// okf/examples/slop-archive is executable documentation AND an I9 fixture:
// this test RUNS the script into a fresh scratch dir and asserts the freshly
// generated out/ is byte-identical to the committed tree and OKF-conformant,
// and that the narrative demonstrates the append-only guarantee (tombstone +
// recovery + zero byte-destroying ops).
// Regenerate with `node okf/examples/slop-archive/archive.js` — never hand-edit out/.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { REPO, runScript, treeHashes } from './example-helpers.js'
import { checkOkfConformance } from './okf-conformance.js'

const EXAMPLE = join(REPO, 'okf', 'examples', 'slop-archive')
const RUN = `run-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

test('slop-archive regenerates the committed out/ byte-identically (I9) and is OKF-conformant', async () => {
  const scratch = join(REPO, 'sslop', '035', 'tmp', RUN, 'slop-archive')
  await mkdir(scratch, { recursive: true })
  const outDir = join(scratch, 'out')

  const { code, stdout, stderr } = await runScript(join(EXAMPLE, 'archive.js'), {
    OKF_SLOP_ARCHIVE_OUT: outDir,
    OKF_SLOP_ARCHIVE_STORAGE: join(scratch, 'storage')
  })
  assert.equal(code, 0, `example failed:\n${stdout}\n${stderr}`)

  assert.match(stdout, /appendOnly = true/, '§8 append-only constant')
  assert.match(stdout, /recovered body from history/, 'tombstone keeps bytes')
  assert.match(stdout, /flag\/undelete audit records: 1/, '§8 undelete recovery')
  assert.match(stdout, /ops that destroy bytes: 0/, 'no byte-destroying op in the wire contract')

  const fresh = await treeHashes(outDir)
  const committed = await treeHashes(join(EXAMPLE, 'out'))
  assert.ok(committed.size > 0, 'committed out/ exists (run `node okf/examples/slop-archive/archive.js`)')
  assert.deepEqual(
    [...fresh.entries()],
    [...committed.entries()],
    'fresh run differs from committed out/ — regenerate and commit'
  )

  const conf = await checkOkfConformance(outDir)
  assert.ok(conf.ok, 'OKF conformance violations: ' + JSON.stringify(conf.violations, null, 2))
})
