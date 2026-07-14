// okf/examples/vlurp-library is executable documentation AND an I9 fixture:
// this test RUNS the import script FULLY OFFLINE (committed fixture, no vlurp
// binary, no network) into a fresh scratch dir and asserts the freshly
// generated out/ is byte-identical to the committed tree and OKF-conformant,
// and that re-import reused every _id (no duplicate concepts).
// Regenerate with `node okf/examples/vlurp-library/import.js` — never hand-edit out/.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { REPO, runScript, treeHashes } from './example-helpers.js'
import { checkOkfConformance } from './okf-conformance.js'

const EXAMPLE = join(REPO, 'okf', 'examples', 'vlurp-library')
const RUN = `run-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

test('vlurp-library regenerates the committed out/ byte-identically (I9), offline, OKF-conformant', async () => {
  const scratch = join(REPO, 'sslop', '035', 'tmp', RUN, 'vlurp-library')
  await mkdir(scratch, { recursive: true })
  const outDir = join(scratch, 'out')

  // OKF_VLURP_USE_BINARY is left unset: the run is guaranteed offline (fixture).
  const { code, stdout, stderr } = await runScript(join(EXAMPLE, 'import.js'), {
    OKF_VLURP_OUT: outDir,
    OKF_VLURP_STAGING: join(scratch, 'staging'),
    OKF_VLURP_STORAGE: join(scratch, 'storage')
  })
  assert.equal(code, 0, `example failed:\n${stdout}\n${stderr}`)

  assert.match(stdout, /offline committed fixture/, 'runs offline from the fixture')
  assert.match(stdout, /first import ---\nminted 3, updated 0, unchanged 0/, 'first import mints')
  assert.match(stdout, /re-import\)\s*---\nminted 0, updated 0, unchanged 3/, 're-import mints nothing')
  assert.match(stdout, /concepts in the vault: 3 .* no duplicates/, 'path->id lookup deduped')

  const fresh = await treeHashes(outDir)
  const committed = await treeHashes(join(EXAMPLE, 'out'))
  assert.ok(committed.size > 0, 'committed out/ exists (run `node okf/examples/vlurp-library/import.js`)')
  assert.deepEqual(
    [...fresh.entries()],
    [...committed.entries()],
    'fresh run differs from committed out/ — regenerate and commit'
  )

  const conf = await checkOkfConformance(outDir)
  assert.ok(conf.ok, 'OKF conformance violations: ' + JSON.stringify(conf.violations, null, 2))
})
