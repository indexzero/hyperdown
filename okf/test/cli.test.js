// @auto-okf/cli smoke tests (SPEC §13): the real `auto-okf` binary spawned
// against real vaults on disk. Test dirs are unique per run under
// sslop/034/tmp/ (never /tmp, never cleaned up — handles are closed, files
// are left for post-mortem). Content that the CLI cannot author (it has no
// write command — content flows in via ingest or the store API) is seeded
// through @auto-okf/store, exactly as a library caller would.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { mkdir, readdir, readFile, rm, writeFile, access } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Bundle } from '../store/index.js'
import { keyspace as K } from '../core/index.js'
import { compact } from '../faces/index.js'

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

test('flags lists a seeded conflict; compact refuses until resolved; resolve clears it', async () => {
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

  // compact MUST refuse while a conflict is open (SPEC §10 guardrail)
  const refused = await cli(['compact', storage, join(base, 'generation2')])
  assert.equal(refused.code, 1, 'compact refuses on an open conflict')
  assert.match(refused.stderr, /refusing to compact with open conflicts/)

  // resolve it
  const resolved = await cli(['resolve', storage, id, '--keep', keep, '--supersede', supersede])
  assert.equal(resolved.code, 0, resolved.stderr)
  assert.match(resolved.stdout, /0 conflict flag\(s\) still open/)

  const cleared = await cli(['flags', storage, 'conflict'])
  assert.match(cleared.stderr, /0 flag\(s\)/)

  // now compact succeeds and produces a fresh generation vault
  const compacted = await cli(['compact', storage, join(base, 'generation2')])
  assert.equal(compacted.code, 0, compacted.stderr)
  assert.match(compacted.stdout, /compacted .* -> .* \(generation [0-9a-f]{64}\)/)
  await access(join(base, 'generation2', 'okf-vault.json')) // fresh vault is pinned
})

// ---------- T17: compaction never drops encryption (decision 8) ----------

const ENC_KEY = 'cd'.repeat(32) // the predecessor's key
const NEW_KEY = 'ef'.repeat(32) // the fresh vault's key: compaction never carries a key over
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

/** The read-back of a compacted vault: is it encrypted, can it read SECRET, and which raw blocks hold SECRET. */
async function inspectSecret(v, id) {
  return { encrypted: v.metadata.encrypted, text: await headText(v, id), rawHits: (await rawHits(v, Buffer.from(SECRET))).length > 0 }
}

/** The CLI's plaintext warning for `dir` (decision 8). */
function plaintextLine(dir) {
  return `warning: ${dir}: now holds the contents of an encrypted vault as plaintext\n`
}

test('T17: compact refuses an encrypted vault without --encryption-key by name, and creates nothing (s1.mjs A, G14)', async () => {
  // scratch-D/s1.mjs scenario A: an encrypted vault compacted without a key
  // gave an unencrypted vault and exit 0. No flag makes an unencrypted copy.
  const base = await tmpDir('enc-refuse')
  const storage = join(base, 'vault')
  await initEncrypted(storage)
  const before = await snapshotHash(storage)

  const refused = await cli(['compact', storage, join(base, 'out')])
  assert.equal(refused.code, 1, refused.stdout + refused.stderr)
  assert.match(refused.stderr, /^auto-okf compact: COMPACT_ENCRYPTION_KEY_REQUIRED: .*--encryption-key/m)
  assert.doesNotMatch(refused.stderr, /plaintext\n/, 'no face was written, so no plaintext warning')
  // An empty key is no key.
  const empty = await cli(['compact', storage, join(base, 'out'), '--encryption-key', ''])
  assert.notEqual(empty.code, 0, empty.stdout + empty.stderr)
  assert.deepEqual(await entries(base), ['vault'], 'the refusal created no out-dir, face or stage')
  assert.equal(await snapshotHash(storage), before, 'the refusal changed the predecessor')

  // The in-process compact refuses by the same name, before it creates or writes anything.
  const v = await Bundle.open(storage)
  try {
    for (const encryptionKey of [undefined, null]) {
      await assert.rejects(
        () => compact(v, { initBundle: Bundle.init, toDir: join(base, 'face'), vaultDir: join(base, 'out'), encryptionKey }),
        (err) => err.code === 'COMPACT_ENCRYPTION_KEY_REQUIRED'
      )
    }
  } finally {
    await v.close()
  }
  assert.deepEqual(await entries(base), ['vault'], 'the in-process refusal created something')
  assert.equal(await snapshotHash(storage), before)
})

test('T17: auto-okf compact --encryption-key makes an encrypted vault whose raw blocks lack the plaintext; an unencrypted control holds it', async () => {
  const base = await tmpDir('enc-cli')
  const storage = join(base, 'vault')
  const id = await initEncrypted(storage)
  const out = join(base, 'out')
  const r = await cli(['compact', storage, out, '--encryption-key', NEW_KEY])
  assert.equal(r.code, 0, r.stderr)
  assert.equal((await pinned(out)).encrypted, true)
  const nu = await Bundle.open(out)
  try {
    assert.deepEqual(await inspectSecret(nu, id), { encrypted: true, text: SECRET, rawHits: false })
  } finally {
    await nu.close()
  }

  // The control: the same content in an unencrypted vault. Its compacted
  // vault holds SECRET in its raw blocks, so the check above can see it.
  const ctlStorage = join(base, 'control')
  const ctl = await Bundle.init(ctlStorage)
  const ctlId = await seedSecret(ctl)
  await ctl.close()
  const ctlOut = join(base, 'control-out')
  const c = await cli(['compact', ctlStorage, ctlOut])
  assert.equal(c.code, 0, c.stderr)
  assert.equal((await pinned(ctlOut)).encrypted, false)
  const cv = await Bundle.open(ctlOut)
  try {
    assert.deepEqual(await inspectSecret(cv, ctlId), { encrypted: false, text: SECRET, rawHits: true })
  } finally {
    await cv.close()
  }
})

test('T17: the in-process compact with a key makes an encrypted vault whose raw blocks lack the plaintext; an unencrypted control holds it', async () => {
  const base = await tmpDir('enc-lib')
  const old = await Bundle.init(join(base, 'vault'), { encryptionKey: Buffer.from(ENC_KEY, 'hex') })
  const id = await seedSecret(old)
  const res = await compact(old, {
    initBundle: Bundle.init,
    toDir: join(base, 'face'),
    vaultDir: join(base, 'out'),
    encryptionKey: Buffer.from(NEW_KEY, 'hex')
  })
  try {
    assert.equal(res.ok, true)
    assert.deepEqual(await inspectSecret(res.vault, id), { encrypted: true, text: SECRET, rawHits: false })
  } finally {
    await res.vault.close()
    await old.close()
  }

  const ctl = await Bundle.init(join(base, 'control'))
  const ctlId = await seedSecret(ctl)
  const ctlRes = await compact(ctl, { initBundle: Bundle.init, toDir: join(base, 'control-face'), vaultDir: join(base, 'control-out') })
  try {
    assert.deepEqual(await inspectSecret(ctlRes.vault, ctlId), { encrypted: false, text: SECRET, rawHits: true })
  } finally {
    await ctlRes.vault.close()
    await ctl.close()
  }
})

test('T17: materialize and compact warn when they write an encrypted vault as plaintext, and keep their exit codes; an unencrypted vault gets no warning', async () => {
  const base = await tmpDir('enc-warn')
  const storage = join(base, 'vault')
  await initEncrypted(storage)

  // materialize: exit 0, one warning that names the bundle directory.
  const bundle = join(base, 'bundle')
  const mat = await cli(['materialize', storage, bundle])
  assert.equal(mat.code, 0, mat.stderr)
  assert.equal(mat.stderr, plaintextLine(bundle))
  assert.match(await readFile(join(bundle, 'secret', 'plan.md'), 'utf8'), new RegExp(SECRET))

  // compact, success: exit 0, the warning names the face.
  const face = join(base, 'face')
  const ok = await cli(['compact', storage, join(base, 'out'), '--face', face, '--encryption-key', NEW_KEY])
  assert.equal(ok.code, 0, ok.stderr)
  assert.equal(ok.stderr, plaintextLine(face))
  assert.ok(!(await entries(base)).some((e) => e.includes('.verify-')), 'a verification directory remains')

  // compact, failure after the face step: exit 1 (COMPACT_FIDELITY, a
  // reserved .okf- name is not staged), and the warning still names the face.
  const failStorage = join(base, 'vault-fail')
  await initEncrypted(failStorage)
  const fv = await Bundle.open(failStorage)
  await fv.createConcept('notes/.okf-state', 'note')
  await fv.close()
  const failFace = join(base, 'face-fail')
  const failed = await cli(['compact', failStorage, join(base, 'out-fail'), '--face', failFace, '--encryption-key', NEW_KEY])
  assert.equal(failed.code, 1, failed.stdout + failed.stderr)
  assert.match(failed.stderr, /COMPACT_FIDELITY/)
  assert.ok(failed.stderr.startsWith(plaintextLine(failFace)), failed.stderr)
  assert.ok(!(await entries(base)).some((e) => e.includes('.verify-')), 'a verification directory remains')

  // An unencrypted vault: no warning from either command.
  const plain = join(base, 'plain')
  const pv = await Bundle.init(plain)
  await seedSecret(pv)
  await pv.close()
  const pmat = await cli(['materialize', plain, join(base, 'plain-bundle')])
  assert.equal(pmat.code, 0, pmat.stderr)
  assert.equal(pmat.stderr, '')
  const pcom = await cli(['compact', plain, join(base, 'plain-out')])
  assert.equal(pcom.code, 0, pcom.stderr)
  assert.equal(pcom.stderr, '')
})

test('T17: the in-process compact reports the plaintext face as a warning, on success and on a failure after the face step', async () => {
  const base = await tmpDir('enc-lib-warn')
  const old = await Bundle.init(join(base, 'vault'), { encryptionKey: Buffer.from(ENC_KEY, 'hex') })
  await seedSecret(old)
  const key = Buffer.from(NEW_KEY, 'hex')
  const warning = (dir) => ({ kind: 'plaintext', path: dir, message: 'now holds the contents of an encrypted vault as plaintext' })

  const res = await compact(old, { initBundle: Bundle.init, toDir: join(base, 'face'), vaultDir: join(base, 'out'), encryptionKey: key })
  assert.deepEqual(res.warnings, [warning(join(base, 'face'))])
  await res.vault.close()

  // A hand-authored note makes the face dirty. compact refuses it with
  // COMPACT_DIRTY_TARGET after the face step, and the error carries the warning.
  const dirty = join(base, 'face-dirty')
  await mkdir(dirty, { recursive: true })
  await writeFile(join(dirty, 'hand.md'), '---\ntype: note\n---\n\nby hand\n')
  await assert.rejects(
    () => compact(old, { initBundle: Bundle.init, toDir: dirty, vaultDir: join(base, 'out-dirty'), encryptionKey: key }),
    (err) => {
      assert.equal(err.code, 'COMPACT_DIRTY_TARGET', err.stack)
      assert.deepEqual(err.warnings, [warning(dirty)])
      return true
    }
  )
  await old.close()

  // An unencrypted vault: no plaintext warning.
  const ctl = await Bundle.init(join(base, 'control'))
  await seedSecret(ctl)
  const ctlRes = await compact(ctl, { initBundle: Bundle.init, toDir: join(base, 'control-face'), vaultDir: join(base, 'control-out') })
  assert.deepEqual(ctlRes.warnings, [])
  await ctlRes.vault.close()
  await ctl.close()
})

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
