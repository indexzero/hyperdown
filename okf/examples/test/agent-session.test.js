// The committed out/ of okf/examples/agent-session is an I9 fixture. If this
// test fails after an intended change, regenerate out/ with
// `node okf/examples/agent-session/session.js` and commit it. Do not edit it by hand.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { REPO, runScript, treeHashes } from './helpers.js'
import { checkOkfConformance } from '../../faces/test/okf-conformance.js'

const EXAMPLE = join(REPO, 'okf', 'examples', 'agent-session')
const RUN = `run-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

test('agent-session regenerates the committed out/ byte-identically (I9) and is OKF-conformant', async () => {
  const scratch = join(REPO, 'sslop', '035', 'tmp', RUN, 'agent-session')
  await mkdir(scratch, { recursive: true })
  const outDir = join(scratch, 'out')

  const { code, stdout, stderr } = await runScript(join(EXAMPLE, 'session.js'), {
    OKF_AGENT_SESSION_OUT: outDir,
    OKF_AGENT_SESSION_STORAGE: join(scratch, 'storage')
  })
  assert.equal(code, 0, `example failed:\n${stdout}\n${stderr}`)

  // The output of the example is documentation: each claim it makes must appear.
  assert.match(stdout, /tags UNIONED across writers: \[reviewed, urgent\]/, 'I5 OR-set union')
  assert.match(stdout, /1 flag\/clobber record\(s\)/, '§5 LWW supersession surfaced')
  assert.match(stdout, /1 flag\/conflict record\(s\)/, '§5 body conflict kept')
  assert.match(stdout, /flag\/conflict drained by the ResolveConflict op: 0 left/, '§5 resolution')
  assert.match(stdout, /WANTS unwritten concepts: determinations\/sharding \(1 ref\)/, '§9 wanted/ demand')

  const fresh = await treeHashes(outDir)
  const committed = await treeHashes(join(EXAMPLE, 'out'))
  assert.ok(committed.size > 0, 'committed out/ exists (run `node okf/examples/agent-session/session.js`)')
  assert.deepEqual(
    [...fresh.entries()],
    [...committed.entries()],
    'fresh run differs from committed out/ — regenerate and commit'
  )

  const conf = await checkOkfConformance(outDir)
  assert.ok(conf.ok, 'OKF conformance violations: ' + JSON.stringify(conf.violations, null, 2))
})
