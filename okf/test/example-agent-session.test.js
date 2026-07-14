// The flagship example is executable documentation AND an I9 fixture: this
// test RUNS okf/examples/agent-session end to end (four real vault peers on
// disk, partitioned then healed) into a fresh scratch dir and asserts the
// freshly generated bundle is byte-identical to the committed out/ tree, and
// that it passes the independent OKF v0.1 conformance check.
// If this fails after an intentional semantic change, regenerate with
// `node okf/examples/agent-session/session.js` and commit out/ — never hand-edit it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { REPO, runScript, treeHashes } from './example-helpers.js'
import { checkOkfConformance } from './okf-conformance.js'

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

  // the narrative hits the semantics it claims to demonstrate
  assert.match(stdout, /tags UNIONED across writers: \[reviewed, urgent\]/, 'I5 OR-set union')
  assert.match(stdout, /1 flag\/clobber record\(s\)/, '§5 LWW supersession surfaced')
  assert.match(stdout, /1 flag\/conflict record\(s\)/, '§5 body conflict kept')
  assert.match(stdout, /flag\/conflict drained by the ResolveConflict op: 0 left/, '§5 resolution')
  assert.match(stdout, /WANTS unwritten concepts: determinations\/sharding \(1 ref\)/, '§9 wanted/ demand')

  // byte-identical regeneration of the committed tree (I9)
  const fresh = await treeHashes(outDir)
  const committed = await treeHashes(join(EXAMPLE, 'out'))
  assert.ok(committed.size > 0, 'committed out/ exists (run `node okf/examples/agent-session/session.js`)')
  assert.deepEqual(
    [...fresh.entries()],
    [...committed.entries()],
    'fresh run differs from committed out/ — regenerate and commit'
  )

  // the emitted bundle is an independently-checked OKF v0.1 bundle
  const conf = await checkOkfConformance(outDir)
  assert.ok(conf.ok, 'OKF conformance violations: ' + JSON.stringify(conf.violations, null, 2))
})
