// @auto-okf/cli smoke tests (SPEC §13): the real `auto-okf` binary spawned
// against real vaults on disk. Test dirs are unique per run under
// sslop/034/tmp/ (never /tmp, never cleaned up — handles are closed, files
// are left for post-mortem). Content that the CLI cannot author (it has no
// write command — content flows in via ingest or the store API) is seeded
// through @auto-okf/store, exactly as a library caller would.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { createSocket } from 'node:dgram'
import { readFileSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile, access } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Bundle } from '../store/index.js'
import { keyspace as K } from '../core/index.js'
import { importFace, materialize } from '../faces/index.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const BIN = join(ROOT, 'okf', 'cli', 'bin', 'auto-okf.js')
const RUN = `run-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let seq = 0

async function tmpDir(name) {
  const dir = join(ROOT, 'sslop', '034', 'tmp', RUN, `${name}-${seq++}`)
  await mkdir(dir, { recursive: true })
  return dir
}

/** Run the CLI to completion; resolves { code, stdout, stderr }. */
function cli(args) {
  return new Promise((resolve) => {
    execFile('node', [BIN, ...args], { cwd: ROOT, timeout: 90000 }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code ?? 1 : 0, stdout, stderr })
    })
  })
}

/** Full-view hash (store I2/I3 surface), for zero-ops/read-only assertions. */
async function snapshotHash(storage) {
  const v = await Bundle.open(storage)
  try {
    return await v.snapshotHash()
  } finally {
    await v.close()
  }
}

const KEY_LINE = /^vault key: {3}([0-9a-f]{64})$/m
const WRITER_LINE = /^writer key: {2}([0-9a-f]{64})$/m

async function waitFor(fn, ms) {
  const t0 = Date.now()
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 100))
  }
}

test('help and usage errors carry the documented exit codes', async () => {
  const help = await cli(['--help'])
  assert.equal(help.code, 0)
  assert.match(help.stdout, /Usage: auto-okf <command>/)

  const none = await cli([])
  assert.equal(none.code, 2, 'no command is a usage error')

  const unknown = await cli(['frobnicate'])
  assert.equal(unknown.code, 2)
  assert.match(unknown.stderr, /unknown command 'frobnicate'/)

  const badArgs = await cli(['add-writer', 'only-one-arg'])
  assert.equal(badArgs.code, 2, 'missing positionals are a usage error')

  const badKey = await cli(['join', await tmpDir('badkey'), 'not-hex'])
  assert.equal(badKey.code, 2)
  assert.match(badKey.stderr, /64 hex characters/)

  const resolveNoKeep = await cli(['resolve', await tmpDir('nokeep'), 'someid'])
  assert.equal(resolveNoKeep.code, 2, '--keep is required')
})

test('init creates a pinned vault and refuses to re-init', async () => {
  const storage = join(await tmpDir('init'), 'vault')
  const out = await cli(['init', storage])
  assert.equal(out.code, 0, out.stderr)
  assert.match(out.stdout, KEY_LINE)
  assert.match(out.stdout, /genesis indexer/)
  assert.match(out.stdout, /generation: {2}root/)
  await access(join(storage, 'okf-vault.json')) // metadata pin exists

  const again = await cli(['init', storage])
  assert.equal(again.code, 1)
  assert.match(again.stderr, /already a vault/)
})

test('commands on unpinned storage fail with guidance, not junk vaults', async () => {
  const dir = join(await tmpDir('unpinned'), 'nothing-here')
  for (const args of [['flags', dir], ['wanted', dir], ['materialize', dir, dir + '-face']]) {
    const res = await cli(args)
    assert.equal(res.code, 1, args.join(' '))
    assert.match(res.stderr, /not a vault/)
  }
})

test('ingest a hand-authored file mints a concept; materialize round-trips it with _id/_rev', async () => {
  const base = await tmpDir('ingest')
  const storage = join(base, 'vault')
  const bundle = join(base, 'bundle')
  await cli(['init', storage])
  await mkdir(bundle, { recursive: true })
  await writeFile(
    join(bundle, 'hello.md'),
    '---\ntype: note\ntitle: Hello\n---\nA hand-authored body.\n'
  )

  const ing = await cli(['ingest', storage, bundle])
  assert.equal(ing.code, 0, ing.stderr)
  assert.match(ing.stdout, /ingested hello\.md: create-concept.*set-body/)
  assert.match(ing.stdout, /ingest complete: \d+ op\(s\) from 1 file\(s\)/)

  const mat = await cli(['materialize', storage, bundle])
  assert.equal(mat.code, 0, mat.stderr)
  assert.match(mat.stdout, /materialized .*: \d+ written/)
  await access(join(bundle, 'index.md')) // per-directory index (OKF §6)
  await access(join(bundle, 'log.md')) // root update log (OKF §7)
  const emitted = await readFile(join(bundle, 'hello.md'), 'utf8')
  assert.match(emitted, /_id:/, 'the mint stamped an _id into the emitted frontmatter')
  assert.match(emitted, /_rev:/, 'the body head produced a _rev')
  assert.match(emitted, /A hand-authored body\./)
})

test('refuses a vault-ld vault by marker, naming the right tool (ADR-006)', async () => {
  const dir = join(await tmpDir('wrong-tool'), 'vault')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'vault-ld.json'), '{"vaultKey":"stub"}\n')

  const attempts = [
    ['flags', dir],
    ['init', dir],
    ['join', dir, 'f'.repeat(64)],
    ['materialize', dir, dir + '-face']
  ]
  for (const args of attempts) {
    const res = await cli(args)
    assert.equal(res.code, 1, args.join(' '))
    assert.match(
      res.stderr,
      /^error: .* is a vault-ld vault \(vault-ld\.json present\); use autovault-ld, not auto-okf$/m,
      args.join(' ')
    )
  }
  assert.deepEqual(await readdir(dir), ['vault-ld.json'], 'storage untouched')
})

test('materialize exit taxonomy: 0 clean, 3 pending-only, 1 failure (ADR-004)', async () => {
  const base = await tmpDir('taxonomy')
  const storage = join(base, 'vault')
  const bundle = join(base, 'bundle')
  await cli(['init', storage])

  const clean = await cli(['materialize', storage, bundle])
  assert.equal(clean.code, 0, 'clean run exits 0')

  // a concurrent writer's not-yet-ingested file: healthy, not a failure
  await writeFile(join(bundle, 'foreign.md'), '---\ntype: note\n---\nMid-authoring.\n')
  const pending = await cli(['materialize', storage, bundle])
  assert.equal(pending.code, 3, `pending-only exits 3, stderr:\n${pending.stderr}`)
  assert.match(
    pending.stderr,
    /^notice: pending ingest \(unsaved external edit, left in place\): foreign\.md$/m
  )
  assert.match(pending.stdout, /^materialized /m, 'the owned projection still completed')
  const kept = await readFile(join(bundle, 'foreign.md'), 'utf8')
  assert.match(kept, /Mid-authoring\./, 'the foreign file was left in place')

  // real failure still exits 1
  const broken = await cli(['materialize', join(base, 'no-vault'), bundle])
  assert.equal(broken.code, 1)
  assert.match(broken.stderr, /not a vault/)

  // once the foreign file is ingested the same bundle materializes clean
  await cli(['ingest', storage, bundle])
  const after = await cli(['materialize', storage, bundle])
  assert.equal(after.code, 0, after.stderr)
})

test('ingest reports hash-match skips as already up to date (ADR-003)', async () => {
  const base = await tmpDir('uptodate')
  const storage = join(base, 'vault')
  const bundle = join(base, 'bundle')
  await cli(['init', storage])
  await mkdir(bundle, { recursive: true })

  // an empty bundle prints NO skip clause (decided once: omitted, never "0")
  const empty = await cli(['ingest', storage, bundle])
  assert.equal(empty.code, 0, empty.stderr)
  assert.match(empty.stdout, /^ingest complete: 0 op\(s\) from 0 file\(s\)$/m)

  await writeFile(join(bundle, 'note.md'), '---\ntype: note\n---\nConverged body.\n')
  await cli(['ingest', storage, bundle])
  await cli(['materialize', storage, bundle]) // stamps _id/_rev + manifest hash

  // the swept-writer scenario (F1): every candidate hash-matches the manifest
  const again = await cli(['ingest', storage, bundle])
  assert.equal(again.code, 0, again.stderr)
  assert.match(
    again.stdout,
    /^ingest complete: 0 op\(s\) from 0 file\(s\); 1 file\(s\) already up to date$/m
  )
})

test('ingest preflights maxOpBytes: oversize file named, siblings unaffected (ADR-005)', async () => {
  const base = await tmpDir('oversize')
  const storage = join(base, 'vault')
  const bundle = join(base, 'bundle')
  await cli(['init', storage])
  await mkdir(bundle, { recursive: true })
  await writeFile(join(bundle, 'big.md'), `---\ntype: note\n---\n${'x'.repeat(70000)}\n`)
  await writeFile(join(bundle, 'small.md'), '---\ntype: note\n---\nComfortably under the limit.\n')

  const ing = await cli(['ingest', storage, bundle])
  assert.equal(ing.code, 1, 'an oversize preflight refusal is an error exit')
  assert.match(ing.stderr, /^error: big\.md body is 70,000 bytes; maxOpBytes is 65,536$/m)
  assert.match(ing.stdout, /ingested small\.md: create-concept/, 'the sibling still ingested')
  assert.doesNotMatch(ing.stdout, /ingested big\.md/)

  // zero ops were appended for the oversize file: no concept claims its path
  const v = await Bundle.open(storage)
  try {
    await v.update()
    assert.equal(await v.val(K.path('big')), undefined)
    assert.notEqual(await v.val(K.path('small')), undefined)
  } finally {
    await v.close()
  }
})

test('path-scoped ingest folds only the named file (ADR-001)', async () => {
  const base = await tmpDir('scoped')
  const storage = join(base, 'vault')
  const bundle = join(base, 'bundle')
  await cli(['init', storage])
  await mkdir(join(bundle, 'drafts'), { recursive: true })
  await writeFile(join(bundle, 'drafts', 'mine.md'), '---\ntype: note\n---\nMine.\n')
  await writeFile(join(bundle, 'drafts', 'theirs.md'), '---\ntype: note\n---\nTheirs, mid-write.\n')

  const ing = await cli(['ingest', storage, bundle, 'drafts/mine.md'])
  assert.equal(ing.code, 0, ing.stderr)
  assert.match(ing.stdout, /ingested drafts\/mine\.md: create-concept/)
  assert.doesNotMatch(ing.stdout, /theirs\.md/, "the other writer's file was not swept up")
  assert.match(ing.stdout, /^ingest complete: \d+ op\(s\) from 1 file\(s\)$/m)

  const v = await Bundle.open(storage)
  try {
    await v.update()
    assert.notEqual(await v.val(K.path('drafts/mine')), undefined)
    assert.equal(await v.val(K.path('drafts/theirs')), undefined, 'the unnamed file stays out of the log')
  } finally {
    await v.close()
  }

  // the unnamed file remains pending-ingest: materialize leaves it in place
  const mat = await cli(['materialize', storage, bundle])
  assert.equal(mat.code, 3, mat.stderr)
  assert.match(mat.stderr, /pending ingest .*: drafts\/theirs\.md/)
})

test('path-scoped ingest refuses bad paths by name, appending zero ops (ADR-001)', async () => {
  const base = await tmpDir('scoped-bad')
  const storage = join(base, 'vault')
  const bundle = join(base, 'bundle')
  await cli(['init', storage])
  await mkdir(join(bundle, 'drafts'), { recursive: true })
  await writeFile(join(base, 'outside.md'), '---\ntype: note\n---\nNot in the bundle.\n')
  await writeFile(join(bundle, 'drafts', 'real.md'), '---\ntype: note\n---\nReal.\n')
  const baseline = await snapshotHash(storage)

  const esc = await cli(['ingest', storage, bundle, '../outside.md'])
  assert.equal(esc.code, 1, 'a path escaping the bundle root is an error')
  assert.match(esc.stderr, /outside the bundle root: \.\.\/outside\.md/)

  const ghost = await cli(['ingest', storage, bundle, 'drafts/ghost.md'])
  assert.equal(ghost.code, 1, 'a nonexistent path is an error')
  assert.match(ghost.stderr, /no such file in the bundle: drafts\/ghost\.md/)

  // one bad path aborts the whole run before any op — the good sibling too
  const mixed = await cli(['ingest', storage, bundle, 'drafts/real.md', 'drafts/ghost.md'])
  assert.equal(mixed.code, 1)
  assert.match(mixed.stderr, /drafts\/ghost\.md/)

  assert.equal(await snapshotHash(storage), baseline, 'zero ops appended across all three refusals')
})

test('status: a file another process ingested reports in-log, not pending-ingest (ADR-002)', async () => {
  const base = await tmpDir('status')
  const storage = join(base, 'vault')
  const bundle = join(base, 'bundle')
  await cli(['init', storage])
  await mkdir(bundle, { recursive: true })
  await writeFile(
    join(bundle, 'note.md'),
    '---\ntype: note\ntitle: Clerk\n---\nSwept while I looked away.\n'
  )

  // hand-authored, not yet ingested: pending-ingest
  const before = await cli(['status', storage, bundle])
  assert.equal(before.code, 0, before.stderr)
  assert.match(before.stdout, /^pending-ingest\tnote\.md$/m)

  // the swept-writer incident: a SECOND process ingests + materializes it
  // (every cli() call spawns its own auto-okf process)
  await cli(['ingest', storage, bundle])
  await cli(['materialize', storage, bundle])

  const after = await cli(['status', storage, bundle])
  assert.equal(after.code, 0, after.stderr)
  assert.match(after.stdout, /^in-log\tnote\.md$/m)
  assert.doesNotMatch(after.stdout, /pending-ingest/)
  // the derived faces are part of the projection and equally in-log
  assert.match(after.stdout, /^in-log\tindex\.md$/m)
  assert.match(after.stdout, /^in-log\tlog\.md$/m)
})

test('status reports a foreign mid-write file and never ingests it (ADR-002)', async () => {
  const base = await tmpDir('status-foreign')
  const storage = join(base, 'vault')
  const bundle = join(base, 'bundle')
  await cli(['init', storage])
  await mkdir(bundle, { recursive: true })
  await writeFile(join(bundle, 'note.md'), '---\ntype: note\n---\nSettled.\n')
  await cli(['ingest', storage, bundle])
  await cli(['materialize', storage, bundle])

  // another writer's WIP: no parseable frontmatter/type yet
  await writeFile(join(bundle, 'wip.md'), '# scratch\nmid-write, no frontmatter yet\n')
  const manifestBefore = await readFile(join(bundle, '.okf-manifest.json'), 'utf8')
  const viewBefore = await snapshotHash(storage)

  const st = await cli(['status', storage, bundle])
  assert.equal(st.code, 0, st.stderr)
  assert.match(st.stdout, /^foreign\twip\.md$/m)

  // strictly read-only: no ops appended, no manifest write, file untouched
  assert.equal(await snapshotHash(storage), viewBefore, 'status appended no ops')
  assert.equal(
    await readFile(join(bundle, '.okf-manifest.json'), 'utf8'),
    manifestBefore,
    'status touched no manifest'
  )
  assert.match(await readFile(join(bundle, 'wip.md'), 'utf8'), /mid-write/)
})

test('status --json is stable across runs and covers dirty and absent (ADR-002)', async () => {
  const base = await tmpDir('status-json')
  const storage = join(base, 'vault')
  const bundle = join(base, 'bundle')
  await cli(['init', storage])
  await mkdir(bundle, { recursive: true })
  await writeFile(join(bundle, 'note.md'), '---\ntype: note\ntitle: Stable\n---\nBody.\n')
  await cli(['ingest', storage, bundle])
  await cli(['materialize', storage, bundle])

  const j1 = await cli(['status', storage, bundle, '--json'])
  const j2 = await cli(['status', storage, bundle, '--json'])
  assert.equal(j1.code, 0, j1.stderr)
  assert.equal(j1.stdout, j2.stdout, 'byte-identical across consecutive runs with no intervening ops')
  const rows = JSON.parse(j1.stdout)
  for (const r of rows) {
    assert.deepEqual(Object.keys(r), ['path', 'state'], 'the schema is exactly { path, state }')
    assert.ok(['in-log', 'pending-ingest', 'dirty', 'absent', 'foreign'].includes(r.state))
  }
  assert.ok(rows.some((r) => r.path === 'note.md' && r.state === 'in-log'))
  const paths = rows.map((r) => r.path)
  assert.deepEqual(paths, [...paths].sort(), 'rows are sorted by path')

  // dirty: in the log, hand-edited after materialize
  const note = await readFile(join(bundle, 'note.md'), 'utf8')
  await writeFile(join(bundle, 'note.md'), note + '\nA hand edit.\n')
  const dirty = await cli(['status', storage, bundle])
  assert.match(dirty.stdout, /^dirty\tnote\.md$/m)

  // absent: in the log, missing from disk (materialize would restore)
  await rm(join(bundle, 'note.md'))
  const absent = await cli(['status', storage, bundle])
  assert.match(absent.stdout, /^absent\tnote\.md$/m)
})

test('wanted lists an unresolved link, ranked', async () => {
  const base = await tmpDir('wanted')
  const storage = join(base, 'vault')
  const bundle = join(base, 'bundle')
  await cli(['init', storage])
  await mkdir(bundle, { recursive: true })
  await writeFile(
    join(bundle, 'src.md'),
    '---\ntype: note\n---\nSee [the ghost](/ghost) page.\n'
  )
  const ing = await cli(['ingest', storage, bundle])
  assert.equal(ing.code, 0, ing.stderr)

  const w = await cli(['wanted', storage])
  assert.equal(w.code, 0, w.stderr)
  assert.match(w.stdout, /\bghost\b/)
  assert.match(w.stderr, /wanted path\(s\)/)

  const wj = await cli(['wanted', storage, '--json'])
  const rows = JSON.parse(wj.stdout)
  assert.ok(rows.some((r) => r.path === 'ghost' && r.count >= 1), 'ghost is a wanted path')
})

test('join + add-writer + remove-writer round trip (§8 governance plumbing)', async () => {
  const base = await tmpDir('writers')
  const origin = join(base, 'origin')
  const peer = join(base, 'peer')

  const init = await cli(['init', origin])
  const vaultKey = init.stdout.match(KEY_LINE)[1]

  const joined = await cli(['join', peer, vaultKey])
  assert.equal(joined.code, 0, joined.stderr)
  const writerKey = joined.stdout.match(WRITER_LINE)[1]
  assert.notEqual(writerKey, vaultKey, 'the peer has its own writer core')
  await access(join(peer, 'okf-vault.json')) // joined storage is pinned

  // reopen pinned storage without a key: reprints identity
  const reopen = await cli(['join', peer])
  assert.equal(reopen.code, 0, reopen.stderr)
  assert.equal(reopen.stdout.match(WRITER_LINE)[1], writerKey)

  const added = await cli(['add-writer', origin, writerKey, '--indexer'])
  assert.equal(added.code, 0, added.stderr)
  assert.match(added.stdout, new RegExp(`writer added: ${writerKey} \\(indexer: true\\)`))

  const removed = await cli(['remove-writer', origin, writerKey])
  assert.equal(removed.code, 0, removed.stderr)
  assert.match(removed.stdout, /writer removed/)

  // the unadmitted peer cannot issue governance ops at all: it is not yet a
  // writer, so the local store refuses the append outright (§8 authority is
  // moot — there is nothing to append to).
  const rogue = await cli(['add-writer', peer, vaultKey])
  assert.equal(rogue.code, 1, 'an unadmitted peer add-writer must fail')
  assert.match(rogue.stderr, /Not writable|did not take effect/)
})

const SWARM_LINE = /^swarm key: {3}([0-9a-f]{64})$/m

/** The metadata that a vault directory pins (okf-vault.json, the invite). */
async function invite(dir) {
  return JSON.parse(await readFile(join(dir, 'okf-vault.json'), 'utf8'))
}

/** A UDP port that was free a moment ago, for a DHT bootstrap node. */
async function freeUdpPort() {
  const s = createSocket('udp4')
  await new Promise((resolve) => s.bind(0, '127.0.0.1', resolve))
  const { port } = s.address()
  await new Promise((resolve) => s.close(resolve))
  return port
}

/** Spawn a foreground command; collects its output in `out.log`. */
function foreground(args) {
  const child = spawn('node', [BIN, ...args], { cwd: ROOT })
  const out = { log: '' }
  child.stdout.on('data', (d) => (out.log += d))
  child.stderr.on('data', (d) => (out.log += d))
  out.exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)))
  out.child = child
  return out
}

test('keys prints the writer key and the swarm key, and the swarm key before the directory holds a vault (T25)', async () => {
  const storage = join(await tmpDir('keys'), 'vault')
  const early = await cli(['keys', storage])
  assert.equal(early.code, 0, early.stderr)
  const swarmKey = early.stdout.match(SWARM_LINE)[1]
  assert.doesNotMatch(early.stdout, WRITER_LINE, 'no writer key before a vault exists')
  assert.match(early.stderr, /holds no vault yet/)

  const init = await cli(['init', storage])
  assert.equal(init.code, 0, init.stderr)
  assert.equal(init.stdout.match(SWARM_LINE)[1], swarmKey, 'init prints the same swarm key')
  assert.ok((await invite(storage)).swarm.allow.includes(swarmKey), "the invite lists the creator's swarm key")

  const keys = await cli(['keys', storage])
  assert.equal(keys.code, 0, keys.stderr)
  assert.equal(keys.stdout.match(WRITER_LINE)[1], init.stdout.match(WRITER_LINE)[1])
  assert.equal(keys.stdout.match(SWARM_LINE)[1], swarmKey, 'the swarm key is stable')
  assert.equal(keys.stdout.match(KEY_LINE)[1], init.stdout.match(KEY_LINE)[1])
})

test('init --swarm-allow pins the listed keys and the creator key in the invite, and refuses a bad key (T25)', async () => {
  const base = await tmpDir('swarm-allow')
  const k1 = 'ab'.repeat(32)
  const k2 = '12'.repeat(32)
  const storage = join(base, 'vault')
  const out = await cli(['init', storage, '--swarm-allow', `${k1},${k2.toUpperCase()}`])
  assert.equal(out.code, 0, out.stderr)
  const own = out.stdout.match(SWARM_LINE)[1]
  assert.deepEqual((await invite(storage)).swarm.allow, [k1, k2, own].sort())

  const bad = await cli(['init', join(base, 'bad'), '--swarm-allow', `${k1},nothex`])
  assert.equal(bad.code, 2, 'a bad key is a usage error')
  assert.match(bad.stderr, /--swarm-allow must be a comma-separated list of 64-hex swarm keys/)
  await assert.rejects(access(join(base, 'bad', 'okf-vault.json')), 'nothing is pinned')
})

test('add-writer --swarm-key puts the swarm key on gov/writer, and a bad key is a usage error (T25)', async () => {
  const base = await tmpDir('add-swarm')
  const origin = join(base, 'origin')
  const peer = join(base, 'peer')
  const init = await cli(['init', origin])
  const vaultKey = init.stdout.match(KEY_LINE)[1]
  const joined = await cli(['join', peer, vaultKey, '--metadata', join(origin, 'okf-vault.json')])
  assert.equal(joined.code, 0, joined.stderr)
  const writerKey = joined.stdout.match(WRITER_LINE)[1]
  const swarmKey = joined.stdout.match(SWARM_LINE)[1]
  assert.match(joined.stdout, /--swarm-key/, 'join names the flag that admits its swarm key')

  const before = await snapshotHash(origin)
  const bad = await cli(['add-writer', origin, writerKey, '--swarm-key', 'nothex'])
  assert.equal(bad.code, 2)
  assert.match(bad.stderr, /--swarm-key must be 64 hex characters/)
  assert.equal(await snapshotHash(origin), before, 'a refused add-writer appends nothing')

  const added = await cli(['add-writer', origin, writerKey, '--swarm-key', swarmKey])
  assert.equal(added.code, 0, added.stderr)
  assert.match(added.stdout, new RegExp(`writer added: ${writerKey} \\(indexer: false\\)`))
  assert.match(added.stdout, new RegExp(`swarm key: {3}${swarmKey}`))
  const v = await Bundle.open(origin)
  try {
    assert.equal((await v.val(K.govWriter(writerKey))).swarmKey, swarmKey)
  } finally {
    await v.close()
  }
})

test('watch --swarm refuses by name without --bootstrap or --public-dht, before it opens the vault (T25)', async () => {
  const base = await tmpDir('watch-dht')
  const missing = join(base, 'no-vault-here') // a refusal after the open would say "not a vault"
  const bundle = join(base, 'bundle')
  const cases = [
    [['--swarm'], /--swarm needs --bootstrap <host:port,\.\.\.>.*or --public-dht/],
    [['--bootstrap', '127.0.0.1:1'], /--bootstrap and --public-dht need --swarm/],
    [['--public-dht'], /--bootstrap and --public-dht need --swarm/],
    [['--swarm', '--bootstrap', '127.0.0.1:1', '--public-dht'], /--bootstrap or --public-dht, not both/],
    [['--swarm', '--bootstrap', 'no-port'], /--bootstrap must be host:port/],
    [['--swarm', '--bootstrap', '127.0.0.1:99999'], /--bootstrap must be host:port/]
  ]
  for (const [flags, re] of cases) {
    const res = await cli(['watch', missing, bundle, ...flags])
    assert.equal(res.code, 2, `${flags.join(' ')}: ${res.stderr}`)
    assert.match(res.stderr, re, flags.join(' '))
  }
  await assert.rejects(access(missing), 'no storage was created')
})

test('bootstrap refuses a missing or bad port and a host that is not IPv4 (T25)', async () => {
  for (const [args, re] of [
    [['bootstrap'], /--port <n> is required/],
    [['bootstrap', '--port', '0'], /--port must be an integer from 1 to 65535/],
    [['bootstrap', '--port', '70000'], /--port must be an integer from 1 to 65535/],
    [['bootstrap', '--port', '4000', '--host', 'localhost'], /--host must be an IPv4 address/],
    [['bootstrap', '--port', '4000', '--host', '0.0.0.0'], /--host must be an IPv4 address/]
  ]) {
    const res = await cli(args)
    assert.equal(res.code, 2, `${args.join(' ')}: ${res.stderr}`)
    assert.match(res.stderr, re)
  }
})

test('bootstrap runs a private DHT node, and watch --swarm --bootstrap replicates to an admitted peer through it (T25)', { timeout: 120000 }, async (t) => {
  const base = await tmpDir('private-swarm')
  const origin = join(base, 'origin')
  const bundle = join(base, 'bundle')
  const port = await freeUdpPort()
  const node = foreground(['bootstrap', '--port', String(port)])
  let watch = null
  let peer = null
  t.after(async () => {
    if (peer) await peer.close()
    for (const p of [watch, node]) {
      if (p && p.child.exitCode === null) p.child.kill('SIGINT')
    }
  })
  await waitFor(() => node.log.includes('bootstrap node: 127.0.0.1:' + port), 30000)

  const init = await cli(['init', origin])
  const vaultKey = init.stdout.match(KEY_LINE)[1]
  await mkdir(bundle, { recursive: true })
  await writeFile(join(bundle, 'hello.md'), '---\ntype: note\ntitle: Hello\n---\nOver the private swarm.\n')
  assert.equal((await cli(['ingest', origin, bundle])).code, 0)

  // The peer joins with the invite, which lists the origin's swarm key, and
  // the origin admits the peer's swarm key.
  peer = await Bundle.join(join(base, 'peer'), Buffer.from(vaultKey, 'hex'), { metadata: await invite(origin) })
  const added = await cli([
    'add-writer', origin, peer.localKey.toString('hex'), '--swarm-key', peer.swarmKey.toString('hex')
  ])
  assert.equal(added.code, 0, added.stderr)

  watch = foreground(['watch', origin, bundle, '--swarm', '--bootstrap', `127.0.0.1:${port}`])
  await waitFor(() => watch.log.includes('watching'), 30000)
  assert.match(watch.log, /joined the private swarm/)

  await peer.swarm({ bootstrap: [`127.0.0.1:${port}`] })
  const deadline = Date.now() + 30000
  let id
  while (!(id = await peer.val(K.path('hello'))) && Date.now() < deadline) {
    await peer.update()
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.ok(id, 'the admitted peer folds the origin ops over the private swarm')
  await peer.close()
  peer = null

  watch.child.kill('SIGINT')
  assert.equal(await watch.exited, 0, watch.log)
  node.child.kill('SIGINT')
  assert.equal(await node.exited, 0, node.log)
})

test('join --swarm-allow keeps a local list of swarm keys apart from the invite, and refuses a bad or repeated key (G3-P9 F03)', async () => {
  const base = await tmpDir('join-allow')
  const origin = join(base, 'origin')
  const init = await cli(['init', origin])
  const vaultKey = init.stdout.match(KEY_LINE)[1]
  const k1 = 'ab'.repeat(32)
  const k2 = '12'.repeat(32)

  const peer = join(base, 'peer')
  const joined = await cli([
    'join', peer, vaultKey, '--metadata', join(origin, 'okf-vault.json'),
    '--swarm-allow', k1, '--swarm-allow', k2.toUpperCase()
  ])
  assert.equal(joined.code, 0, joined.stderr)
  assert.match(joined.stdout, new RegExp(`local allow: {2}${k2}`))
  assert.match(joined.stdout, new RegExp(`local allow: {2}${k1}`))
  // This peer only: the local list is its own file, and the invite does
  // not change.
  assert.deepEqual(JSON.parse(await readFile(join(peer, 'okf-swarm-allow.json'), 'utf8')), { allow: [k2, k1] })
  assert.deepEqual(await invite(peer), await invite(origin), 'the pinned metadata is the invite')
  assert.equal((await invite(peer)).swarm.allow.includes(k1), false)

  // A later join on the pinned directory states the list again.
  const again = await cli(['join', peer, '--swarm-allow', k1])
  assert.equal(again.code, 0, again.stderr)
  assert.deepEqual(JSON.parse(await readFile(join(peer, 'okf-swarm-allow.json'), 'utf8')), { allow: [k1] })

  for (const [flags, re] of [
    [['--swarm-allow', 'nothex'], /--swarm-allow must be 64 hex characters/],
    [['--swarm-allow', `${k1},${k2}`], /--swarm-allow must be 64 hex characters/],
    [['--swarm-allow', k1, '--swarm-allow', k1.toUpperCase()], new RegExp(`--swarm-allow lists ${k1} twice`)]
  ]) {
    const dir = join(base, `bad-${flags.length}-${flags[1].length}`)
    const bad = await cli(['join', dir, vaultKey, '--metadata', join(origin, 'okf-vault.json'), ...flags])
    assert.equal(bad.code, 2, `${flags.join(' ')}: ${bad.stderr}`)
    assert.match(bad.stderr, re)
    await assert.rejects(access(join(dir, 'okf-vault.json')), 'nothing is pinned')
    await assert.rejects(access(join(dir, 'okf-swarm-allow.json')), 'no local list is written')
  }
})

test('watch --swarm admits the local list of join: a late joiner whose creator is offline connects to the admitting indexer and becomes writable (G3-P9 F03)', { timeout: 180000 }, async (t) => {
  const base = await tmpDir('offline-creator')
  const origin = join(base, 'origin')
  const late = join(base, 'late')
  const lateBundle = join(base, 'late-bundle')
  const port = await freeUdpPort()
  const node = foreground(['bootstrap', '--port', String(port)])
  let watch = null
  let indexer = null
  t.after(async () => {
    if (indexer) await indexer.close()
    for (const p of [watch, node]) {
      if (p && p.child.exitCode === null) p.child.kill('SIGINT')
    }
  })
  await waitFor(() => node.log.includes('bootstrap node: 127.0.0.1:' + port), 30000)

  // The creator admits a second indexer, hands it the ops over a direct
  // stream, and goes offline for good.
  const init = await cli(['init', origin])
  const vaultKey = init.stdout.match(KEY_LINE)[1]
  indexer = await Bundle.join(join(base, 'indexer'), Buffer.from(vaultKey, 'hex'), { metadata: await invite(origin) })
  const indexerSwarmKey = indexer.swarmKey.toString('hex')
  const admitted = await cli([
    'add-writer', origin, indexer.localKey.toString('hex'), '--indexer', '--swarm-key', indexerSwarmKey
  ])
  assert.equal(admitted.code, 0, admitted.stderr)
  const o = await Bundle.open(origin)
  const s1 = o.replicate(true)
  const s2 = indexer.replicate(false)
  s1.on('error', () => {})
  s2.on('error', () => {})
  s1.pipe(s2).pipe(s1)
  const deadline = Date.now() + 30000
  while (!indexer.isIndexer && Date.now() < deadline) {
    await indexer.update()
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.ok(indexer.isIndexer, 'the second indexer folds its admission')
  s1.destroy()
  s2.destroy()
  await o.close()

  // The late joiner gets the invite and the indexer's swarm key. The
  // indexer admits it.
  const joined = await cli([
    'join', late, vaultKey, '--metadata', join(origin, 'okf-vault.json'), '--swarm-allow', indexerSwarmKey
  ])
  assert.equal(joined.code, 0, joined.stderr)
  await indexer.addWriter(Buffer.from(joined.stdout.match(WRITER_LINE)[1], 'hex'), {
    swarmKey: joined.stdout.match(SWARM_LINE)[1]
  })
  await indexer.update()
  await indexer.swarm({ bootstrap: [`127.0.0.1:${port}`] })

  await mkdir(lateBundle, { recursive: true })
  watch = foreground(['watch', late, lateBundle, '--swarm', '--bootstrap', `127.0.0.1:${port}`])
  await waitFor(() => watch.log.includes('watching'), 30000)
  assert.match(watch.log, /local allow: {2}1 key/)

  // A note ingests once the joiner is writable. Until then each ingest
  // fails Not writable, so the test writes a new note every second.
  let n = 0
  const ingested = () => /ingested late-(\d+)\.md/.exec(watch.log)
  const writeUntil = Date.now() + 60000
  while (!ingested() && Date.now() < writeUntil) {
    await writeFile(join(lateBundle, `late-${n}.md`), `---\ntype: note\ntitle: Late ${n}\n---\nFrom the late joiner.\n`)
    n++
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  assert.ok(ingested(), `the late joiner becomes writable and ingests a note:\n${watch.log}`)
  const path = `late-${ingested()[1]}`
  const foldUntil = Date.now() + 30000
  let id
  while (!(id = await indexer.val(K.path(path))) && Date.now() < foldUntil) {
    await indexer.update()
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.ok(id, "the indexer folds the late joiner's note over the swarm")

  watch.child.kill('SIGINT')
  assert.equal(await watch.exited, 0, watch.log)
  node.child.kill('SIGINT')
  assert.equal(await node.exited, 0, node.log)
})

/**
 * Seed a body conflict single-writer via the unknown-base rule (SPEC §5): a
 * SetBody citing a base absent from the concept's revisions is stored and
 * flagged flag/conflict against the current head, never becoming head until
 * ResolveConflict. Returns { id, keep, supersede }.
 */
async function seedConflict(storage) {
  const v = await Bundle.init(storage)
  const { tag: id } = await v.createConcept('notes/a', 'note')
  await v.setBody(id, null, 'version one')
  await v.update()
  const keep = await v.val(K.cBody(id)) // the real head revHash (R1)
  await v.setBody(id, 'f'.repeat(64), 'version two') // fabricated base → conflict
  await v.update()
  let supersede = null
  for await (const { key } of v.scan(K.flagPrefix('conflict', id))) {
    supersede = K.parseKey(key)[4] // flag/conflict/<id>/<head>/<new>
  }
  await v.close()
  return { id, keep, supersede }
}

test('flags lists a seeded conflict; resolve clears it', async () => {
  const base = await tmpDir('conflict')
  const storage = join(base, 'vault')
  const { id, keep, supersede } = await seedConflict(storage)

  const flags = await cli(['flags', storage, 'conflict'])
  assert.equal(flags.code, 0, flags.stderr)
  assert.match(flags.stdout, new RegExp(`flag/conflict/${id}/`))
  assert.match(flags.stderr, /1 flag\(s\) in flag\/conflict\//)

  const fj = await cli(['flags', storage, 'conflict', '--json'])
  const rows = JSON.parse(fj.stdout)
  assert.equal(rows.length, 1, 'exactly one open conflict')

  // resolve it
  const resolved = await cli(['resolve', storage, id, '--keep', keep, '--supersede', supersede])
  assert.equal(resolved.code, 0, resolved.stderr)
  assert.match(resolved.stdout, /0 conflict flag\(s\) still open/)

  const cleared = await cli(['flags', storage, 'conflict'])
  assert.match(cleared.stderr, /0 flag\(s\)/)

  // with no conflict open, a generation is materialize, then import (§10)
  const face = await cli(['materialize', storage, join(base, 'face')])
  assert.equal(face.code, 0, face.stderr)
  const key = KEY_LINE.exec((await cli(['join', storage])).stdout)[1]
  const generation = await cli(['import', join(base, 'face'), join(base, 'generation2'), '--metadata', join(storage, 'okf-vault.json'), '--predecessor', key])
  assert.equal(generation.code, 0, generation.stderr)
  assert.match(generation.stdout, /^generation: {2}[0-9a-f]{64}$/m)
  await access(join(base, 'generation2', 'okf-vault.json')) // the new vault is pinned
})

// ---------- T17: encryption and plaintext (decision 8) ----------

const ENC_KEY = 'cd'.repeat(32) // the predecessor's key
const NEW_KEY = 'ef'.repeat(32) // the new vault's key: a generation names its own key
const SECRET = 'TOP-SECRET-PAYLOAD'

/** The entries of a directory, sorted. */
async function entries(dir) {
  return (await readdir(dir)).sort()
}

/** The metadata that a vault directory pins. */
async function pinned(dir) {
  return JSON.parse(await readFile(join(dir, 'okf-vault.json'), 'utf8'))
}

/** Seed one concept whose body is SECRET. Returns its _id. */
async function seedSecret(v) {
  const { tag } = await v.createConcept('secret/plan', 'note')
  await v.setBody(tag, null, SECRET)
  await v.update()
  return tag
}

/** An encrypted vault made by `auto-okf init --encryption-key`, with SECRET seeded. Returns its _id. */
async function initEncrypted(storage) {
  const init = await cli(['init', storage, '--encryption-key', ENC_KEY])
  assert.equal(init.code, 0, init.stderr)
  const v = await Bundle.open(storage)
  try {
    assert.equal(v.metadata.encrypted, true, 'setup: the vault must be encrypted')
    return await seedSecret(v)
  } finally {
    await v.close()
  }
}

/** The head body text of concept `id`. */
async function headText(v, id) {
  await v.update()
  const head = await v.val(K.cBody(id))
  const rev = head === undefined ? undefined : await v.val(K.cRev(id, head))
  return rev ? rev.text : undefined
}

/**
 * The stored blocks of the writer, system and view cores that hold
 * `plain`. get({ raw: true }) returns the bytes at rest, not decrypted, as
 * in store-encryption.test.js.
 */
async function rawHits(v, plain) {
  const hits = []
  const cores = { writer: v.db.local, system: v.db.system.bee.core, view: v.db.bee.core }
  for (const [name, core] of Object.entries(cores)) {
    for (let i = 0; i < core.length; i++) {
      if ((await core.get(i, { raw: true })).includes(plain)) hits.push(`${name}/${i}`)
    }
  }
  return hits
}

/** The read-back of a vault: is it encrypted, can it read SECRET, and which raw blocks hold SECRET. */
async function inspectSecret(v, id) {
  return { encrypted: v.metadata.encrypted, text: await headText(v, id), rawHits: (await rawHits(v, Buffer.from(SECRET))).length > 0 }
}

/** The CLI's plaintext warning for `dir` (decision 8). */
function plaintextLine(dir) {
  return `warning: ${dir}: now holds the contents of an encrypted vault as plaintext\n`
}

test('T17: materialize warns when it writes an encrypted vault as plaintext, and keeps its exit code; import of that face warns about nothing; an unencrypted vault gets no warning', async () => {
  const base = await tmpDir('enc-warn')
  const storage = join(base, 'vault')
  await initEncrypted(storage)

  // materialize: exit 0, one warning that names the bundle directory.
  const bundle = join(base, 'bundle')
  const mat = await cli(['materialize', storage, bundle])
  assert.equal(mat.code, 0, mat.stderr)
  assert.equal(mat.stderr, plaintextLine(bundle))
  assert.match(await readFile(join(bundle, 'secret', 'plan.md'), 'utf8'), new RegExp(SECRET))

  // import reads that plaintext face and writes no plaintext: no warning.
  const imp = await cli(['import', bundle, join(base, 'out'), '--metadata', join(storage, 'okf-vault.json'), '--encryption-key', NEW_KEY])
  assert.equal(imp.code, 0, imp.stdout + imp.stderr)
  assert.equal(imp.stderr, '')

  // An unencrypted vault: no warning.
  const plain = join(base, 'plain')
  const pv = await Bundle.init(plain)
  await seedSecret(pv)
  await pv.close()
  const pmat = await cli(['materialize', plain, join(base, 'plain-bundle')])
  assert.equal(pmat.code, 0, pmat.stderr)
  assert.equal(pmat.stderr, '')
})

test('T24: auto-okf materialize exits 1 and names each value that the face cannot hold; an encrypted vault prints no value', async () => {
  const base = await tmpDir('mat-lossy')
  const storage = join(base, 'vault')
  const v = await Bundle.init(storage)
  const { tag: ref } = await v.createConcept('notes/ref', 'note')
  await v.setField(ref, 'reference', { ref: 'target' })
  const { tag: ok } = await v.createConcept('notes/ok', 'note')
  await v.setField(ok, 'title', 'Fine')
  await v.update()
  await v.close()
  const r = await cli(['materialize', storage, join(base, 'face')])
  assert.equal(r.code, 1, r.stdout + r.stderr)
  assert.match(r.stderr, new RegExp(`^warning: notes/ref\\.md: the face cannot hold the value of 'reference' \\(_id ${ref}\\): the vault holds \\[\\{"ref":"target"\\}\\], the face holds \\["target"\\]$`, 'm'))
  assert.match(r.stderr, /^error: 1 value\(s\) that the face cannot hold; fix each one in the vault before import \(SPEC §10\)$/m)
  assert.ok(!r.stderr.includes('notes/ok'), r.stderr)
  // The face is written all the same: it is the export.
  assert.match(r.stdout, /^materialized /m)
  await access(join(base, 'face', 'notes', 'ref.md'))

  // An encrypted vault: the warning names the note, the key and the _id,
  // and holds no value, because stderr can reach a log.
  const enc = join(base, 'enc')
  await initEncrypted(enc)
  const ev = await Bundle.open(enc)
  const { tag: secretRef } = await ev.createConcept('notes/secret-ref', 'note')
  await ev.setField(secretRef, 'reference', { ref: SECRET })
  await ev.close()
  const e = await cli(['materialize', enc, join(base, 'enc-face')])
  assert.equal(e.code, 1, e.stdout + e.stderr)
  assert.match(e.stderr, new RegExp(`^warning: notes/secret-ref\\.md: the face cannot hold the value of 'reference' \\(_id ${secretRef}\\); values not printed: the vault is encrypted$`, 'm'))
  assert.ok(!e.stderr.includes(SECRET), e.stderr)
})

// ---------- G3-P5 F03: the plaintext warning comes before the plaintext write ----------

/**
 * An encrypted vault that holds concept `a` (body SECRET) and concept `z`.
 * materialize writes a.md, index.md and log.md before z.md, in byte order.
 */
async function initEncryptedAZ(storage) {
  const init = await cli(['init', storage, '--encryption-key', ENC_KEY])
  assert.equal(init.code, 0, init.stderr)
  const v = await Bundle.open(storage)
  try {
    const { tag } = await v.createConcept('a', 'note')
    await v.setBody(tag, null, SECRET)
    await v.createConcept('z', 'note')
    await v.update()
  } finally {
    await v.close()
  }
}

/** A face directory whose z.md is a directory: materialize writes a.md, then fails with EISDIR on z.md. */
async function faceWithDirAtZ(face) {
  await mkdir(join(face, 'z.md'), { recursive: true })
  return face
}

/** Does `face`/a.md hold SECRET? */
async function secretIn(face) {
  return (await readFile(join(face, 'a.md'), 'utf8').catch(() => '')).includes(SECRET)
}

test('F03: the in-process materialize announces the plaintext directory before the first write, and a failure partway carries the warning', async () => {
  // D-029 F03: a materialize that wrote a.md and then failed threw no
  // warning. materialize now calls onPlaintext, and awaits it, before the
  // first write, and puts the warning in the report and in a later error.
  const base = await tmpDir('enc-announce')
  const storage = join(base, 'vault')
  await initEncryptedAZ(storage)
  const warning = (dir) => ({ kind: 'plaintext', path: dir, message: 'now holds the contents of an encrypted vault as plaintext' })
  const v = await Bundle.open(storage)
  try {
    /** An onPlaintext that records each warning, and what the face held at that moment. */
    const recorder = (face) => {
      const calls = []
      return { calls, onPlaintext: async (w) => calls.push({ w, secretWritten: await secretIn(face) }) }
    }

    // materialize, success: the warning in the report, announced before a.md.
    const ok = join(base, 'mat-ok')
    const okRec = recorder(ok)
    const report = await materialize(v, ok, { onPlaintext: okRec.onPlaintext })
    assert.deepEqual(report.warnings, [warning(ok)])
    assert.deepEqual(okRec.calls, [{ w: warning(ok), secretWritten: false }])
    assert.equal(await secretIn(ok), true)

    // materialize, a failure after a.md: the error carries the warning.
    const face = await faceWithDirAtZ(join(base, 'partial-materialize'))
    const rec = recorder(face)
    await assert.rejects(
      () => materialize(v, face, { onPlaintext: rec.onPlaintext }),
      (err) => {
        assert.equal(err.code, 'EISDIR', err.stack)
        assert.deepEqual(err.warnings, [warning(face)])
        return true
      }
    )
    assert.deepEqual(rec.calls, [{ w: warning(face), secretWritten: false }])
    assert.equal(await secretIn(face), true, 'setup: a.md must hold the plaintext')
  } finally {
    await v.close()
  }

  // An unencrypted vault: no warning, and no call.
  const plain = await Bundle.init(join(base, 'plain'))
  const calls = []
  const plainReport = await materialize(plain, join(base, 'plain-bundle'), { onPlaintext: (w) => calls.push(w) })
  assert.deepEqual(plainReport.warnings, [])
  assert.deepEqual(calls, [])
  await plain.close()
})

test('F03: auto-okf materialize prints the plaintext warning before the first plaintext write, so a failure partway or a crash finds it printed', async () => {
  const base = await tmpDir('enc-announce-cli')
  const storage = join(base, 'vault')
  await initEncryptedAZ(storage)

  // A failure after a.md: stderr starts with the warning, then the error.
  for (const [name, args] of [['materialize', (face) => ['materialize', storage, face]]]) {
    const face = await faceWithDirAtZ(join(base, `partial-${name}`))
    const r = await cli(args(face))
    assert.equal(r.code, 1, r.stdout + r.stderr)
    assert.ok(r.stderr.startsWith(plaintextLine(face)), `${name}: ${r.stderr}`)
    assert.match(r.stderr, new RegExp(`^auto-okf ${name}: EISDIR`, 'm'))
    assert.equal(r.stderr.split(plaintextLine(face)).length, 2, `${name}: the warning is printed once`)
    assert.equal(await secretIn(face), true, `${name}: setup: a.md must hold the plaintext`)
  }

  // A crash after a.md. z.md is a named pipe, so the read of z.md blocks
  // after a.md holds the plaintext. SIGKILL then stops the process: no
  // handler runs. The warning must be on stderr already.
  for (const [name, args] of [['materialize', (face) => ['materialize', storage, face]]]) {
    const face = join(base, `crash-${name}`)
    await mkdir(face, { recursive: true })
    await new Promise((resolve, reject) => execFile('mkfifo', [join(face, 'z.md')], (err) => (err ? reject(err) : resolve())))
    const child = spawn('node', [BIN, ...args(face)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (d) => (stderr += d))
    child.stdout.resume()
    const closed = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })))
    const t0 = Date.now()
    while (!(await secretIn(face))) {
      if (Date.now() - t0 > 60000) {
        child.kill('SIGKILL')
        throw new Error(`${name}: a.md never held the plaintext; stderr: ${stderr}`)
      }
      await new Promise((r) => setTimeout(r, 20))
    }
    child.kill('SIGKILL')
    assert.deepEqual(await closed, { code: null, signal: 'SIGKILL' }, name)
    assert.equal(stderr, plaintextLine(face), `${name}: the crash found no warning on stderr`)
  }
})

// ---------- tree hashes ----------

/** A sha256 over every file under `root`, dot-files included: each path and its bytes. */
async function treeHash(root) {
  const h = createHash('sha256')
  const files = (await readdir(root, { recursive: true, withFileTypes: true }))
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name))
    .sort()
  for (const file of files) {
    h.update(`${file}\0`)
    h.update(await readFile(file))
    h.update('\0')
  }
  return h.digest('hex')
}

test('undelete restores a tombstoned concept', async () => {
  const base = await tmpDir('undelete')
  const storage = join(base, 'vault')
  const v = await Bundle.init(storage)
  const { tag: id } = await v.createConcept('notes/gone', 'note')
  await v.setBody(id, null, 'still here')
  await v.deleteConcept(id)
  await v.update()
  const meta = await v.val(K.cMeta(id))
  assert.ok(meta.deleted, 'seeded concept is tombstoned')
  await v.close()

  const out = await cli(['undelete', storage, id])
  assert.equal(out.code, 0, out.stderr)
  assert.match(out.stdout, new RegExp(`undeleted ${id}`))

  const audit = await cli(['flags', storage, 'undelete'])
  assert.match(audit.stdout, new RegExp(`flag/undelete/${id}/`), 'undelete wrote its audit flag (§8)')
})

test('watch ingests a human edit in the foreground and exits on SIGINT', async () => {
  const base = await tmpDir('watch')
  const storage = join(base, 'vault')
  const bundle = join(base, 'bundle')
  await cli(['init', storage])
  await mkdir(bundle, { recursive: true })
  await writeFile(join(bundle, 'note.md'), '---\ntype: note\ntitle: First\n---\nOriginal body.\n')
  await cli(['ingest', storage, bundle])
  await cli(['materialize', storage, bundle]) // stamp _id/_rev so the edit diffs cleanly

  const child = spawn('node', [BIN, 'watch', storage, bundle], { cwd: ROOT })
  let log = ''
  child.stdout.on('data', (d) => (log += d))
  child.stderr.on('data', (d) => (log += d))
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)))

  await waitFor(() => log.includes('watching'), 30000)
  const notePath = join(bundle, 'note.md')
  const note = await readFile(notePath, 'utf8')
  await writeFile(notePath, note.replace('First', 'Second'))
  await waitFor(() => /ingested note\.md: set-field/.test(log), 30000)

  child.kill('SIGINT')
  const code = await exited
  assert.equal(code, 0, `clean shutdown, log:\n${log}`)
})

// ---------- D-055 Q1: ingest and watch name each op that core rejects ----------

const REJECTED_LINE = /^error: other\/x\.md: core rejected its set-body op \(policy-namespace\), and the file stays pending$/m

/**
 * A vault whose writer may write under team/ only, and its face. other/x
 * predates the policy, and the face holds a human edit of its body, so core
 * rejects the set-body of that edit policy-namespace. team/y.md is a new
 * file that ingests.
 */
async function rejectingFace(base) {
  const storage = join(base, 'vault')
  const bundle = join(base, 'bundle')
  const v = await Bundle.init(storage)
  try {
    const { tag: id } = await v.createConcept('other/x', 'note')
    await v.setBody(id, null, 'first')
    await v.update()
    assert.equal((await materialize(v, bundle)).ok, true)
    await v.writers.setPolicy(v.localKey, { namespacePrefixes: ['team'] })
    await v.update()
  } finally {
    await v.close()
  }
  const f = join(bundle, 'other', 'x.md')
  await writeFile(f, (await readFile(f, 'utf8')).replace('first', 'second'))
  await mkdir(join(bundle, 'team'), { recursive: true })
  await writeFile(join(bundle, 'team', 'y.md'), '---\ntype: note\n---\nInside the namespace.\n')
  return { storage, bundle }
}

test('ingest names each op that core rejects, with the file and the reason, and exits 1; the file stays pending (D-055 Q1)', async () => {
  const { storage, bundle } = await rejectingFace(await tmpDir('ingest-rejected'))
  const ing = await cli(['ingest', storage, bundle])
  assert.equal(ing.code, 1, `a rejected op is an error exit\n${ing.stdout}${ing.stderr}`)
  assert.match(ing.stderr, REJECTED_LINE)
  assert.match(ing.stdout, /ingested team\/y\.md: create-concept/, 'the sibling still ingested')
  assert.doesNotMatch(ing.stdout, /ingested other\/x\.md/)
  const mat = await cli(['materialize', storage, bundle])
  assert.match(mat.stderr, /pending ingest .*other\/x\.md/, 'materialize keeps the edit pending')
  assert.match(await readFile(join(bundle, 'other', 'x.md'), 'utf8'), /second/)
})

test('watch prints each op that core rejects, by name, and keeps running (D-055 Q1)', async () => {
  const { storage, bundle } = await rejectingFace(await tmpDir('watch-rejected'))
  const child = spawn('node', [BIN, 'watch', storage, bundle], { cwd: ROOT })
  let log = ''
  child.stdout.on('data', (d) => (log += d))
  child.stderr.on('data', (d) => (log += d))
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)))
  try {
    await waitFor(() => log.includes('watching') && REJECTED_LINE.test(log), 30000)
    assert.match(log, /ingested team\/y\.md: create-concept/)
    assert.equal(child.exitCode, null, `watch keeps running after the rejection, log:\n${log}`)
  } finally {
    child.kill('SIGINT')
  }
  assert.equal(await exited, 0, `clean shutdown, log:\n${log}`)
})

// ---------- T24: auto-okf import <face-dir> <dir> ----------

/** Every file under `dir` whose bytes hold `plain`, as relative paths: what an encrypted vault must never hold. */
async function plaintextFiles(dir, plain) {
  const hits = []
  for (const e of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue
    const file = join(e.parentPath, e.name)
    if ((await readFile(file)).includes(Buffer.from(plain))) hits.push(file.slice(dir.length + 1))
  }
  return hits.sort()
}

/** A vault at `<base>/old` seeded by `seed(v)`, and its face at `<base>/face`. Returns the vault's metadata and seed result. */
async function oldWithFace(base, seed, opts = {}) {
  const v = await Bundle.init(join(base, 'old'), opts)
  try {
    const seeded = await seed(v)
    await v.update()
    assert.equal((await materialize(v, join(base, 'face'))).ok, true)
    return { keyHex: v.keyHex, metadata: v.metadata, seeded }
  } finally {
    await v.close()
  }
}

test('T24: auto-okf import makes a vault from a face, prints the counts and the check, and writes nothing to the face', async () => {
  const base = await tmpDir('imp-cli')
  const { keyHex, seeded: id } = await oldWithFace(base, async (v) => {
    const { tag } = await v.createConcept('notes/one', 'note')
    await v.setBody(tag, null, 'one')
    await v.createConcept('notes/two', 'note')
    return tag
  })
  const face = join(base, 'face')
  const before = await treeHash(face)
  const r = await cli(['import', face, join(base, 'new')])
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.stderr, '', 'a clean import prints no warning')
  assert.match(r.stdout, KEY_LINE)
  assert.match(r.stdout, /^generation: {2}root$/m)
  assert.match(r.stdout, /^predecessor: \(none: a root vault\)$/m)
  assert.match(r.stdout, /^notes: {7}2 read, 2 imported$/m)
  assert.match(r.stdout, /^fidelity: {4}every note of the new vault matches the face/m)
  assert.match(r.stdout, /--metadata/, 'the output tells how a joiner gets the metadata')
  assert.equal(await treeHash(face), before, 'import changed the face')
  assert.deepEqual(await entries(base), ['face', 'new', 'old'])
  const nu = await Bundle.open(join(base, 'new'))
  try {
    assert.equal(await headText(nu, id), 'one')
    assert.notEqual(nu.keyHex, keyHex)
  } finally {
    await nu.close()
  }
})

test('T24: auto-okf import carries --metadata and records --predecessor in the new okf-vault.json', async () => {
  const base = await tmpDir('imp-cli-meta')
  const limits = { maxOpBytes: 400000, maxPathBytes: 2048, maxPathDepth: 100 }
  const { keyHex, seeded: id } = await oldWithFace(
    base,
    async (v) => {
      const { tag } = await v.createConcept('big/report', 'note')
      await v.setBody(tag, null, 'x'.repeat(100000))
      return tag
    },
    { metadata: { limits, rate: { defaultCeiling: 8 }, schemaVersion: 3 } }
  )
  const out = join(base, 'new')
  const r = await cli(['import', join(base, 'face'), out, '--metadata', join(base, 'old', 'okf-vault.json'), '--predecessor', keyHex])
  assert.equal(r.code, 0, r.stdout + r.stderr)
  const meta = await pinned(out)
  const old = await pinned(join(base, 'old'))
  assert.deepEqual([meta.limits, meta.rate, meta.schemaVersion], [old.limits, old.rate, old.schemaVersion])
  assert.equal(meta.predecessorKey, keyHex)
  assert.equal(meta.generation, createHash('sha256').update(Buffer.from(keyHex, 'hex')).digest('hex'))
  assert.ok(!('predecessorCheckpoint' in meta))
  assert.match(r.stdout, new RegExp(`^predecessor: ${keyHex}$`, 'm'))
  assert.match(r.stdout, new RegExp(`^generation: {2}${meta.generation}$`, 'm'))
  const nu = await Bundle.open(out)
  try {
    assert.equal(await headText(nu, id), 'x'.repeat(100000))
  } finally {
    await nu.close()
  }

  // Without --metadata the new vault takes the default maxOpBytes, and the
  // preflight refuses the 100 KB body by name. The new directory is removed.
  const bare = await cli(['import', join(base, 'face'), join(base, 'bare')])
  assert.equal(bare.code, 1, bare.stdout + bare.stderr)
  assert.match(bare.stderr, /^auto-okf import: IMPORT_OVERSIZE: big\/report\.md: its set-body op is \d+ bytes encoded; maxOpBytes is 65536$/m)
  assert.deepEqual(await entries(base), ['face', 'new', 'old'])

  // A --metadata file that is missing, or not metadata of this release,
  // is refused by name before import writes anything.
  await writeFile(join(base, 'v1.json'), JSON.stringify({ ...old, version: 1 }))
  for (const [file, message] of [
    [join(base, 'missing.json'), /^auto-okf import: --metadata \S+missing\.json: no such file$/m],
    [join(base, 'v1.json'), /^auto-okf import: --metadata \S+v1\.json: unsupported vault metadata version: 1$/m]
  ]) {
    const res = await cli(['import', join(base, 'face'), join(base, 'refused'), '--metadata', file])
    assert.equal(res.code, 1, res.stdout + res.stderr)
    assert.match(res.stderr, message)
  }
  assert.deepEqual(await entries(base), ['face', 'new', 'old', 'v1.json'])
})

test('T24: auto-okf import --encryption-key makes a vault whose files hold no plaintext of the face; an unencrypted control holds it; no plaintext warning', async () => {
  const base = await tmpDir('imp-cli-enc')
  const { seeded: id } = await oldWithFace(base, seedSecret)
  const out = join(base, 'enc')
  const r = await cli(['import', join(base, 'face'), out, '--encryption-key', NEW_KEY])
  assert.equal(r.code, 0, r.stdout + r.stderr)
  assert.equal(r.stderr, '', 'import reads plaintext and writes none, so it warns about nothing')
  assert.equal((await pinned(out)).encrypted, true)
  // No file of the new vault holds the body or the concept path, not only
  // the cores (D-047 F01: a side file in an encrypted directory leaked paths).
  assert.deepEqual({ body: await plaintextFiles(out, SECRET), path: await plaintextFiles(out, 'secret/plan') }, { body: [], path: [] })
  const nu = await Bundle.open(out)
  try {
    assert.deepEqual(await inspectSecret(nu, id), { encrypted: true, text: SECRET, rawHits: false })
  } finally {
    await nu.close()
  }

  // The control: the same face, no key. Its files and its raw blocks hold
  // the plaintext, so the checks above can see it.
  const ctl = join(base, 'plain')
  const c = await cli(['import', join(base, 'face'), ctl])
  assert.equal(c.code, 0, c.stdout + c.stderr)
  assert.equal((await pinned(ctl)).encrypted, false)
  assert.notDeepEqual(await plaintextFiles(ctl, SECRET), [])
  const cv = await Bundle.open(ctl)
  try {
    assert.deepEqual(await inspectSecret(cv, id), { encrypted: false, text: SECRET, rawHits: true })
  } finally {
    await cv.close()
  }
})

test('T24: auto-okf import refuses by name before it writes: a pinned or non-empty <dir>, a vault-ld <dir>, an open collision, a missing face', async () => {
  const base = await tmpDir('imp-cli-refuse')
  const { seeded: y } = await oldWithFace(base, async (v) => {
    await v.createConcept('shared/note', 'note')
    const { tag } = await v.createConcept('shared/note', 'note') // the collision loser
    return tag
  })
  const face = join(base, 'face')
  const init = await cli(['init', join(base, 'pinned')])
  assert.equal(init.code, 0, init.stderr)
  await mkdir(join(base, 'used'))
  await writeFile(join(base, 'used', 'keep.txt'), 'keep\n')
  await mkdir(join(base, 'sibling'))
  await writeFile(join(base, 'sibling', 'vault-ld.json'), '{}\n')
  const state = async () => ({ entries: await entries(base), face: await treeHash(face), pinned: await treeHash(join(base, 'pinned')) })
  const before = await state()

  const copy = `shared/note.conflict-${createHash('sha256').update(y).digest('hex').slice(0, 8)}.md`
  const cases = [
    ['pinned', [face, join(base, 'pinned')], /^auto-okf import: IMPORT_DIR_NOT_EMPTY: \S+pinned is already a vault \(okf-vault\.json exists\)/m],
    // s1.mjs K: a key never goes to an existing store (G16).
    ['pinned, with a key', [face, join(base, 'pinned'), '--encryption-key', NEW_KEY], /^auto-okf import: IMPORT_DIR_NOT_EMPTY: \S+pinned is already a vault/m],
    ['used', [face, join(base, 'used')], /^auto-okf import: IMPORT_DIR_NOT_EMPTY: \S+used is not empty \(keep\.txt\)/m],
    ['vault-ld', [face, join(base, 'sibling')], /^error: \S+sibling is a vault-ld vault \(vault-ld\.json present\); use autovault-ld, not auto-okf$/m],
    ['collision', [face, join(base, 'out')], new RegExp(`^auto-okf import: IMPORT_CONFLICT_COPY: the face \\S+ holds a conflicted copy.*: ${copy.replace(/\./g, '\\.')}$`, 'm')],
    ['no face', [join(base, 'no-face'), join(base, 'out')], /^auto-okf import: ENOENT: .*no-face/m]
  ]
  for (const [name, args, message] of cases) {
    const r = await cli(['import', ...args])
    assert.equal(r.code, 1, `${name}: ${r.stdout}${r.stderr}`)
    assert.match(r.stderr, message, name)
    assert.deepEqual(await state(), before, `${name}: the refusal wrote something`)
  }
})

test('T24: auto-okf import usage errors exit 2 and write nothing (bad or empty key, bad predecessor, a missing argument)', async () => {
  const base = await tmpDir('imp-cli-usage')
  await oldWithFace(base, async (v) => v.createConcept('notes/a', 'note'))
  const face = join(base, 'face')
  const cases = [
    ['bad key', ['import', face, join(base, 'out'), '--encryption-key', 'not-hex'], /--encryption-key must be 64 hex characters/],
    ['empty key', ['import', face, join(base, 'out'), '--encryption-key', ''], /--encryption-key/],
    ['bad predecessor', ['import', face, join(base, 'out'), '--predecessor', 'abc'], /--predecessor must be 64 hex characters/],
    ['one argument', ['import', face], /missing required argument <dir>/]
  ]
  for (const [name, args, message] of cases) {
    const r = await cli(args)
    assert.equal(r.code, 2, `${name}: ${r.stdout}${r.stderr}`)
    assert.match(r.stderr, message, name)
  }
  assert.deepEqual(await entries(base), ['face', 'old'], 'a usage error created something')
})

test('T24: auto-okf import prints every difference and every warning, and exits 1 on IMPORT_FIDELITY', async () => {
  const base = await tmpDir('imp-cli-fid')
  await oldWithFace(base, async (v) => {
    const { tag } = await v.createConcept('notes/a', 'note')
    await v.setBody(tag, null, 'body a')
    await v.createConcept('.drafts/idea', 'note')
  })
  // A note cut short inside its frontmatter: no closing --- line.
  const notePath = join(base, 'face', 'notes', 'a.md')
  const text = await readFile(notePath, 'utf8')
  await writeFile(notePath, text.slice(0, text.indexOf('type:')))

  const r = await cli(['import', join(base, 'face'), join(base, 'out')])
  assert.equal(r.code, 1, r.stdout + r.stderr)
  assert.match(r.stderr, /^warning: notes\/a\.md: cannot create concept: no non-empty `type` in frontmatter$/m)
  assert.match(r.stderr, /^notes: {7}2 read, 1 imported$/m)
  assert.match(r.stderr, /^auto-okf import: IMPORT_FIDELITY: /m)
  assert.match(r.stderr, /^ {2}missing notes\/a\.md$/m)
  // The dot-path note is read and imported, so no difference names it (T14).
  assert.ok(!r.stderr.includes('.drafts'), r.stderr)
  assert.deepEqual(await entries(base), ['face', 'old'], 'the failure left the new directory')
})

test('F02 (T24): the in-process import refuses a key that is not 32 bytes by name, false, empty and zero included, before it writes; and a factory that drops the key', async () => {
  // D-029 F02: the store reads a false value as no key. import never reads
  // a value that is not a key as no key.
  const base = await tmpDir('imp-badkey')
  await oldWithFace(base, seedSecret)
  const face = join(base, 'face')
  const bad = [false, '', 0, NEW_KEY, Buffer.alloc(16, 1), Buffer.alloc(33, 1), [...Buffer.from(NEW_KEY, 'hex')]]
  for (const [i, encryptionKey] of bad.entries()) {
    await assert.rejects(
      () => importFace(Bundle.init, face, join(base, `out-${i}`), { encryptionKey }),
      (err) => {
        assert.equal(err.code, 'IMPORT_ENCRYPTION_KEY_INVALID', `${JSON.stringify(encryptionKey)}: ${err.stack}`)
        assert.ok(!err.message.includes(NEW_KEY), 'the message holds the key')
        return true
      }
    )
  }
  assert.deepEqual(await entries(base), ['face', 'old'], 'a refusal created something')

  // initBundle is injected. A factory that does not pass the key on gives
  // an unencrypted vault. import reads its metadata before the first note,
  // and removes the new directory.
  const created = []
  const dropKey = async (dir, { encryptionKey, ...opts }) => {
    const v = await Bundle.init(dir, opts)
    return new Proxy(v, {
      get(target, prop, receiver) {
        if (prop === 'createConcept') created.push(prop)
        return Reflect.get(target, prop, receiver)
      }
    })
  }
  await assert.rejects(
    () => importFace(dropKey, face, join(base, 'out'), { encryptionKey: Buffer.from(NEW_KEY, 'hex') }),
    (err) => err.code === 'IMPORT_NOT_ENCRYPTED'
  )
  assert.deepEqual(created, [], 'the import wrote content to the unencrypted vault')
  assert.deepEqual(await entries(base), ['face', 'old'])
})

test('T24, decision 8: import refuses to make an unencrypted generation of an encrypted vault, by name, before it writes', async () => {
  // The face of an encrypted vault is its plaintext export. --metadata says
  // that the predecessor is encrypted, and a generation never makes an
  // unencrypted copy of an encrypted vault, so import needs a key for it.
  const base = await tmpDir('imp-keyreq')
  await oldWithFace(base, seedSecret, { encryptionKey: Buffer.from(ENC_KEY, 'hex') })
  const face = join(base, 'face')
  const meta = join(base, 'old', 'okf-vault.json')
  assert.equal((await pinned(join(base, 'old'))).encrypted, true, 'setup: the predecessor must be encrypted')

  const refused = await cli(['import', face, join(base, 'out'), '--metadata', meta])
  assert.equal(refused.code, 1, refused.stdout + refused.stderr)
  assert.match(refused.stderr, /^auto-okf import: IMPORT_ENCRYPTION_KEY_REQUIRED: .*--encryption-key/m)
  await assert.rejects(
    () => importFace(Bundle.init, face, join(base, 'out'), { metadata: JSON.parse(readFileSync(meta, 'utf8')) }),
    (err) => err.code === 'IMPORT_ENCRYPTION_KEY_REQUIRED'
  )
  assert.deepEqual(await entries(base), ['face', 'old'], 'the refusal created something')

  const ok = await cli(['import', face, join(base, 'out'), '--metadata', meta, '--encryption-key', NEW_KEY])
  assert.equal(ok.code, 0, ok.stdout + ok.stderr)
  assert.equal((await pinned(join(base, 'out'))).encrypted, true)
  assert.deepEqual(await plaintextFiles(join(base, 'out'), SECRET), [])
})
