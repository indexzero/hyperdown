// The committed out/ of each example under okf/examples is an I9 fixture. If
// a test fails after an intended change, regenerate out/ with
// `node okf/examples/<name>/<script>` and commit it. Do not edit it by hand.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { REPO, runScript, treeHashes } from './helpers.js'
import { checkOkfConformance } from '../../faces/test/okf-conformance.js'

const RUN = `run-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

// The output of an example is documentation: each claim it makes must appear.
// `claims` holds one [pattern, assertion message] pair per claim.
const EXAMPLES = [
  {
    name: 'agent-session',
    script: 'session.js',
    env: (scratch) => ({
      OKF_AGENT_SESSION_OUT: join(scratch, 'out'),
      OKF_AGENT_SESSION_STORAGE: join(scratch, 'storage')
    }),
    claims: [
      [/tags UNIONED across writers: \[reviewed, urgent\]/, 'I5 OR-set union'],
      [/1 flag\/clobber record\(s\)/, '§5 LWW supersession surfaced'],
      [/1 flag\/conflict record\(s\)/, '§5 body conflict kept'],
      [/flag\/conflict drained by the ResolveConflict op: 0 left/, '§5 resolution'],
      [/WANTS unwritten concepts: determinations\/sharding \(1 ref\)/, '§9 wanted/ demand']
    ]
  },
  {
    name: 'slop-archive',
    script: 'archive.js',
    env: (scratch) => ({
      OKF_SLOP_ARCHIVE_OUT: join(scratch, 'out'),
      OKF_SLOP_ARCHIVE_STORAGE: join(scratch, 'storage')
    }),
    claims: [
      [/appendOnly = true/, '§8 append-only constant'],
      [/recovered body from history/, 'tombstone keeps bytes'],
      [/flag\/undelete audit records: 1/, '§8 undelete recovery'],
      [/ops that destroy bytes: 0/, 'no byte-destroying op in the wire contract']
    ]
  },
  {
    name: 'vlurp-library',
    script: 'import.js',
    // OKF_VLURP_USE_BINARY stays unset, so the run is offline and reads the committed fixture.
    env: (scratch) => ({
      OKF_VLURP_OUT: join(scratch, 'out'),
      OKF_VLURP_STAGING: join(scratch, 'staging'),
      OKF_VLURP_STORAGE: join(scratch, 'storage')
    }),
    claims: [
      [/offline committed fixture/, 'runs offline from the fixture'],
      [/first import ---\nminted 3, updated 0, unchanged 0/, 'first import mints'],
      [/re-import\)\s*---\nminted 0, updated 0, unchanged 3/, 're-import mints nothing'],
      [/concepts in the vault: 3 .* no duplicates/, 'path->id lookup deduped']
    ]
  }
]

for (const { name, script, env, claims } of EXAMPLES) {
  test(`${name} regenerates the committed out/ byte-identically (I9), prints its claims, and is OKF-conformant`, async () => {
    const example = join(REPO, 'okf', 'examples', name)
    const scratch = join(REPO, 'sslop', '035', 'tmp', RUN, name)
    await mkdir(scratch, { recursive: true })
    const outDir = join(scratch, 'out')

    const { code, stdout, stderr } = await runScript(join(example, script), env(scratch))
    assert.equal(code, 0, `example failed:\n${stdout}\n${stderr}`)

    for (const [pattern, message] of claims) assert.match(stdout, pattern, message)

    const fresh = await treeHashes(outDir)
    const committed = await treeHashes(join(example, 'out'))
    assert.ok(committed.size > 0, `committed out/ exists (run \`node okf/examples/${name}/${script}\`)`)
    assert.deepEqual(
      [...fresh.entries()],
      [...committed.entries()],
      'fresh run differs from committed out/ — regenerate and commit'
    )

    const conf = await checkOkfConformance(outDir)
    assert.ok(conf.ok, 'OKF conformance violations: ' + JSON.stringify(conf.violations, null, 2))
  })
}
