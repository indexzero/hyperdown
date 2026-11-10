// The contract of each auto-okf command, on the real binary: the arguments,
// the exit code, and each line that a caller parses. What a command does to
// the vault or to the bundle is proved in okf/store/test and okf/faces/test.
// The CLI has no write command, so content is seeded through the store API.
// Scratch stays on disk after a run.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { createSocket } from 'node:dgram'
import { mkdir, readdir, readFile, rm, writeFile, access } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Bundle } from '../../store/index.js'
import { keyspace as K } from '../../core/index.js'
import { materialize } from '../../faces/index.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const BIN = join(ROOT, 'okf', 'cli', 'bin', 'auto-okf.js')
const RUN = `run-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let seq = 0

async function tmpDir(name) {
  const dir = join(ROOT, 'sslop', '034', 'tmp', RUN, `${name}-${seq++}`)
  await mkdir(dir, { recursive: true })
  return dir
}

/** Run the CLI to completion. Resolves { code, stdout, stderr }. */
function cli(args) {
  return new Promise((resolve) => {
    execFile('node', [BIN, ...args], { cwd: ROOT, timeout: 90000 }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code ?? 1 : 0, stdout, stderr })
    })
  })
}

/** Spawn a foreground command. Collects its output in `out.log`. */
function foreground(args) {
  const child = spawn('node', [BIN, ...args], { cwd: ROOT })
  const out = { log: '' }
  child.stdout.on('data', (d) => (out.log += d))
  child.stderr.on('data', (d) => (out.log += d))
  out.exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)))
  out.child = child
  return out
}

async function waitFor(fn, ms) {
  const t0 = Date.now()
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 100))
  }
}

/** The view hash of a vault, to show that a command appended no op. */
async function snapshotHash(storage) {
  const v = await Bundle.open(storage)
  try {
    return await v.snapshotHash()
  } finally {
    await v.close()
  }
}

/** The entries of a directory, sorted. */
async function entries(dir) {
  return (await readdir(dir)).sort()
}

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

const KEY_LINE = /^vault key: {3}([0-9a-f]{64})$/m
const WRITER_LINE = /^writer key: {2}([0-9a-f]{64})$/m
const SWARM_LINE = /^swarm key: {3}([0-9a-f]{64})$/m

const ENC_KEY = 'cd'.repeat(32) // the key of the predecessor
const NEW_KEY = 'ef'.repeat(32) // a generation has a key of its own
const SECRET = 'TOP-SECRET-PAYLOAD'

/** An escaped RegExp source for the literal `s`. */
const lit = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// ---------- the command line ----------

test('help exits 0; no command, an unknown command, a missing argument, a bad key and a resolve without --keep exit 2', async () => {
  const help = await cli(['--help'])
  assert.equal(help.code, 0)
  assert.match(help.stdout, /Usage: auto-okf <command>/)

  const none = await cli([])
  assert.equal(none.code, 2, 'no command is a usage error')

  const unknown = await cli(['frobnicate'])
  assert.equal(unknown.code, 2)
  assert.match(unknown.stderr, /^auto-okf: unknown command 'frobnicate'$/m)

  const badArgs = await cli(['add-writer', 'only-one-arg'])
  assert.equal(badArgs.code, 2, 'missing positionals are a usage error')
  assert.match(badArgs.stderr, /^auto-okf add-writer: missing required argument <writer-key>$/m)

  const badKey = await cli(['join', await tmpDir('badkey'), 'not-hex'])
  assert.equal(badKey.code, 2)
  assert.match(badKey.stderr, /64 hex characters/)

  const resolveNoKeep = await cli(['resolve', await tmpDir('nokeep'), 'someid'])
  assert.equal(resolveNoKeep.code, 2, '--keep is required')
})

test('a command on a directory that holds no vault exits 1 and names init and join', async () => {
  const dir = join(await tmpDir('unpinned'), 'nothing-here')
  for (const args of [['flags', dir], ['wanted', dir], ['materialize', dir, dir + '-face']]) {
    const res = await cli(args)
    assert.equal(res.code, 1, args.join(' '))
    assert.match(res.stderr, /is not a vault \(no okf-vault\.json\); run `auto-okf init` or `auto-okf join` first$/m)
  }
})

test('every command that takes a vault directory refuses a vault-ld vault by its marker, exits 1 and names autovault-ld (ADR-006)', async () => {
  const dir = join(await tmpDir('wrong-tool'), 'vault')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'vault-ld.json'), '{"vaultKey":"stub"}\n')

  const attempts = [
    ['flags', dir],
    ['init', dir],
    ['join', dir, 'f'.repeat(64)],
    ['materialize', dir, dir + '-face'],
    ['import', dir + '-face', dir]
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

// ---------- init, keys, join and the writers ----------

test('keys prints the swarm key before the directory holds a vault; init prints the same swarm key with the vault key, the writer key and the generation; a second init exits 1', async () => {
  const storage = join(await tmpDir('keys'), 'vault')
  const early = await cli(['keys', storage])
  assert.equal(early.code, 0, early.stderr)
  const swarmKey = early.stdout.match(SWARM_LINE)[1]
  assert.doesNotMatch(early.stdout, WRITER_LINE, 'no writer key before a vault exists')
  assert.match(early.stderr, /holds no vault yet/)

  const init = await cli(['init', storage])
  assert.equal(init.code, 0, init.stderr)
  assert.match(init.stdout, KEY_LINE)
  assert.match(init.stdout, WRITER_LINE)
  assert.equal(init.stdout.match(SWARM_LINE)[1], swarmKey, 'init prints the same swarm key')
  assert.match(init.stdout, new RegExp(`^storage: {5}${lit(storage)}$`, 'm'))
  assert.match(init.stdout, /^generation: {2}root$/m)
  assert.match(init.stdout, /genesis indexer/)

  const keys = await cli(['keys', storage])
  assert.equal(keys.code, 0, keys.stderr)
  assert.equal(keys.stdout.match(WRITER_LINE)[1], init.stdout.match(WRITER_LINE)[1])
  assert.equal(keys.stdout.match(SWARM_LINE)[1], swarmKey, 'the swarm key is stable')
  assert.equal(keys.stdout.match(KEY_LINE)[1], init.stdout.match(KEY_LINE)[1])

  const again = await cli(['init', storage])
  assert.equal(again.code, 1)
  assert.match(again.stderr, /already a vault/)
})

test('--swarm-allow of init pins each key in the invite, and of join writes the local list and leaves the invite; a bad or repeated key exits 2 before either command writes', async () => {
  const base = await tmpDir('swarm-allow')
  const k1 = 'ab'.repeat(32)
  const k2 = '12'.repeat(32)
  const origin = join(base, 'origin')
  const init = await cli(['init', origin, '--swarm-allow', k1, '--swarm-allow', k2.toUpperCase()])
  assert.equal(init.code, 0, init.stderr)
  const own = init.stdout.match(SWARM_LINE)[1]
  assert.deepEqual((await invite(origin)).swarm.allow, [k1, k2, own].sort(), 'every value is pinned')
  const vaultKey = init.stdout.match(KEY_LINE)[1]
  const metadata = join(origin, 'okf-vault.json')

  const peer = join(base, 'peer')
  const joined = await cli(['join', peer, vaultKey, '--metadata', metadata, '--swarm-allow', k1, '--swarm-allow', k2.toUpperCase()])
  assert.equal(joined.code, 0, joined.stderr)
  assert.match(joined.stdout, new RegExp(`^local allow: {2}${k2}$`, 'm'))
  assert.match(joined.stdout, new RegExp(`^local allow: {2}${k1}$`, 'm'))
  assert.deepEqual(JSON.parse(await readFile(join(peer, 'okf-swarm-allow.json'), 'utf8')), { allow: [k2, k1] })
  assert.deepEqual(await invite(peer), await invite(origin), 'the pinned metadata is the invite')

  // A later join replaces the list.
  const again = await cli(['join', peer, '--swarm-allow', k1])
  assert.equal(again.code, 0, again.stderr)
  assert.deepEqual(JSON.parse(await readFile(join(peer, 'okf-swarm-allow.json'), 'utf8')), { allow: [k1] })

  // One key per value: a comma list is not a key.
  const bad = [
    ['nothex', ['--swarm-allow', 'nothex'], /--swarm-allow must be 64 hex characters/],
    ['comma', ['--swarm-allow', `${k1},${k2}`], /--swarm-allow must be 64 hex characters/],
    ['twice', ['--swarm-allow', k1, '--swarm-allow', k1.toUpperCase()], new RegExp(`--swarm-allow lists ${k1} twice`)]
  ]
  for (const [name, flags, re] of bad) {
    for (const [command, args] of [['init', []], ['join', [vaultKey, '--metadata', metadata]]]) {
      const dir = join(base, `bad-${command}-${name}`)
      const res = await cli([command, dir, ...args, ...flags])
      assert.equal(res.code, 2, `${command} ${name}: a usage error: ${res.stderr}`)
      assert.match(res.stderr, re, `${command} ${name}`)
      await assert.rejects(access(dir), `${command} ${name}: the store does not exist`)
    }
  }
})

test('join exits 2 on fresh storage without the invite, and 1 on an invite that it cannot read, by name, before it creates anything; a reopen needs no invite; a directory that joined without the invite refuses it later by name', async () => {
  const base = await tmpDir('join-invite')
  const origin = join(base, 'origin')
  const init = await cli(['init', origin])
  const vaultKey = init.stdout.match(KEY_LINE)[1]

  // Without the invite the peer pins its own metadata, with no swarm key of
  // the creator, so the private swarm admits nobody.
  const peer = join(base, 'peer')
  const bare = await cli(['join', peer, vaultKey])
  assert.equal(bare.code, 2, bare.stderr)
  assert.match(bare.stderr, /join needs the invite to join fresh storage: --metadata <okf-vault.json>/)
  await assert.rejects(access(peer), 'nothing is created')

  const junk = join(base, 'junk.json')
  await writeFile(junk, '{ not json')
  const badFile = await cli(['join', peer, vaultKey, '--metadata', junk])
  assert.equal(badFile.code, 1, badFile.stderr)
  assert.match(badFile.stderr, new RegExp(lit(`auto-okf join: --metadata ${junk}: `)))
  const missing = join(base, 'nope.json')
  const noFile = await cli(['join', peer, vaultKey, '--metadata', missing])
  assert.equal(noFile.code, 1, noFile.stderr)
  assert.match(noFile.stderr, new RegExp(lit(`auto-okf join: --metadata ${missing}: no such file`)))
  await assert.rejects(access(peer), 'nothing is created')

  const joined = await cli(['join', peer, vaultKey, '--metadata', join(origin, 'okf-vault.json')])
  assert.equal(joined.code, 0, joined.stderr)
  assert.deepEqual(await invite(peer), await invite(origin), 'the pinned metadata is the invite')
  assert.equal((await cli(['join', peer])).code, 0)

  const keyOnly = join(base, 'key-only')
  const v = await Bundle.join(keyOnly, Buffer.from(vaultKey, 'hex'))
  await v.close()
  const late = await cli(['join', keyOnly, '--metadata', join(origin, 'okf-vault.json')])
  assert.equal(late.code, 1, late.stderr)
  assert.match(late.stderr, /^auto-okf join: VAULT_JOINED_WITHOUT_INVITE: .*join again in a new directory with the invite/m)
})

test('join prints the keys of the peer, and the same writer key on a reopen; add-writer needs a bound swarm key and prints the record; remove-writer prints the removal; add-writer from a peer that is not writable exits 1 (§8)', async () => {
  const base = await tmpDir('writers')
  const origin = join(base, 'origin')
  const peer = join(base, 'peer')
  const init = await cli(['init', origin])
  const vaultKey = init.stdout.match(KEY_LINE)[1]

  const joined = await cli(['join', peer, vaultKey, '--metadata', join(origin, 'okf-vault.json')])
  assert.equal(joined.code, 0, joined.stderr)
  assert.equal(joined.stdout.match(KEY_LINE)[1], vaultKey)
  const writerKey = joined.stdout.match(WRITER_LINE)[1]
  const swarmKey = joined.stdout.match(SWARM_LINE)[1]
  assert.match(joined.stdout, /--swarm-key/, 'join names the flag that admits its swarm key')

  // a reopen needs no key
  const reopen = await cli(['join', peer])
  assert.equal(reopen.code, 0, reopen.stderr)
  assert.equal(reopen.stdout.match(WRITER_LINE)[1], writerKey)

  const bad = await cli(['add-writer', origin, writerKey, '--swarm-key', 'nothex'])
  assert.equal(bad.code, 2)
  assert.match(bad.stderr, /--swarm-key must be 64 hex characters/)

  // Without a bound swarm key, a later remove-writer cannot cut the key of
  // this writer from the allowlist. The CLI refuses before the append.
  const before = await snapshotHash(origin)
  const refused = await cli(['add-writer', origin, writerKey])
  assert.equal(refused.code, 2, refused.stderr)
  assert.match(refused.stderr, new RegExp(`add-writer needs --swarm-key <hex64>: no gov/writer record binds a swarm key to ${writerKey}`))
  assert.equal(await snapshotHash(origin), before, 'a refused add-writer appends nothing')

  const added = await cli(['add-writer', origin, writerKey, '--swarm-key', swarmKey])
  assert.equal(added.code, 0, added.stderr)
  assert.match(added.stdout, new RegExp(`^writer added: ${writerKey} \\(indexer: false\\)$`, 'm'))
  assert.match(added.stdout, new RegExp(`^swarm key: {3}${swarmKey} `, 'm'))

  // The record binds the swarm key now, so a promotion needs no flag.
  const promoted = await cli(['add-writer', origin, writerKey, '--indexer'])
  assert.equal(promoted.code, 0, promoted.stderr)
  assert.match(promoted.stdout, new RegExp(`^writer added: ${writerKey} \\(indexer: true\\)$`, 'm'))
  assert.match(promoted.stdout, new RegExp(`^swarm key: {3}${swarmKey} `, 'm'), 'the record keeps the bound key')

  // The invite binds the creator's swarm key as swarm.genesis, so no flag is needed.
  const creator = await cli(['add-writer', origin, vaultKey, '--indexer'])
  assert.equal(creator.code, 0, creator.stderr)

  const removed = await cli(['remove-writer', origin, writerKey])
  assert.equal(removed.code, 0, removed.stderr)
  assert.match(removed.stdout, new RegExp(`^writer removed: ${writerKey} `, 'm'))

  // The peer never replicated, so its store is not writable and refuses the append.
  const rogue = await cli(['add-writer', peer, vaultKey])
  assert.equal(rogue.code, 1, 'an add-writer from a peer that is not writable must fail')
  assert.match(rogue.stderr, /^auto-okf add-writer: Not writable: .*`auto-okf add-writer`/m)
})

// ---------- materialize ----------

test('materialize exits 0 on a clean run, 3 when only files that wait for an ingest remain, and 1 on a failure (ADR-004)', async () => {
  const base = await tmpDir('taxonomy')
  const storage = join(base, 'vault')
  const bundle = join(base, 'bundle')
  await cli(['init', storage])

  const clean = await cli(['materialize', storage, bundle])
  assert.equal(clean.code, 0, 'clean run exits 0')
  assert.equal(clean.stdout, `materialized ${bundle}: 2 written, 0 unchanged, 0 removed\n`)

  // a file that another writer did not ingest yet is not a failure
  await writeFile(join(bundle, 'foreign.md'), '---\ntype: note\n---\nMid-authoring.\n')
  const pending = await cli(['materialize', storage, bundle])
  assert.equal(pending.code, 3, `pending-only exits 3, stderr:\n${pending.stderr}`)
  assert.equal(pending.stderr, 'notice: pending ingest (unsaved external edit, left in place): foreign.md\n')
  assert.match(pending.stdout, /^materialized /m, 'the owned projection still completed')

  const broken = await cli(['materialize', join(base, 'no-vault'), bundle])
  assert.equal(broken.code, 1)
  assert.match(broken.stderr, /not a vault/)

  await cli(['ingest', storage, bundle])
  const after = await cli(['materialize', storage, bundle])
  assert.equal(after.code, 0, after.stderr)
})

/** An encrypted vault from `auto-okf init --encryption-key`. `seed(v)` writes its content. */
async function initEncrypted(storage, seed) {
  const init = await cli(['init', storage, '--encryption-key', ENC_KEY])
  assert.equal(init.code, 0, init.stderr)
  const v = await Bundle.open(storage)
  try {
    assert.equal(v.metadata.encrypted, true, 'setup: --encryption-key must make the vault encrypted')
    await seed(v)
    await v.update()
  } finally {
    await v.close()
  }
}

test('materialize exits 1 and prints one warning line for each value that the face cannot hold; for an encrypted vault the line holds the _id only, and no value, path or key', async () => {
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

  // For an encrypted vault the warning names the _id only. The path, the key
  // and the values are contents of the vault, and stderr can reach a log.
  const enc = join(base, 'enc')
  let secretRef
  await initEncrypted(enc, async (ev) => {
    secretRef = (await ev.createConcept('notes/secret-ref', 'note')).tag
    await ev.setField(secretRef, 'reference', { ref: SECRET })
  })
  const e = await cli(['materialize', enc, join(base, 'enc-face')])
  assert.equal(e.code, 1, e.stdout + e.stderr)
  assert.match(e.stderr, new RegExp(`^warning: the face cannot hold a value of the concept with _id ${secretRef}; the path, the key and the values are not printed: the vault is encrypted$`, 'm'))
  for (const plain of [SECRET, 'secret-ref', 'reference']) assert.ok(!e.stderr.includes(plain), `${plain}: ${e.stderr}`)
})

/** The plaintext warning of the CLI for `dir`. */
function plaintextLine(dir) {
  return `warning: ${dir}: now holds the contents of an encrypted vault as plaintext\n`
}

/** Does `face`/a.md hold SECRET? */
async function secretIn(face) {
  return (await readFile(join(face, 'a.md'), 'utf8').catch(() => '')).includes(SECRET)
}

test('materialize of an encrypted vault prints the plaintext warning once, before the first plaintext write, so a failure partway or a crash finds it printed; an unencrypted vault gets no warning', async () => {
  const base = await tmpDir('enc-warn')
  const storage = join(base, 'vault')
  // materialize writes a.md, index.md and log.md before z.md, in byte order.
  await initEncrypted(storage, async (v) => {
    const { tag } = await v.createConcept('a', 'note')
    await v.setBody(tag, null, SECRET)
    await v.createConcept('z', 'note')
  })

  // The warning does not change the exit code.
  const bundle = join(base, 'bundle')
  const mat = await cli(['materialize', storage, bundle])
  assert.equal(mat.code, 0, mat.stderr)
  assert.equal(mat.stderr, plaintextLine(bundle))

  // z.md is a directory: materialize writes a.md, then fails with EISDIR.
  const partial = join(base, 'partial')
  await mkdir(join(partial, 'z.md'), { recursive: true })
  const r = await cli(['materialize', storage, partial])
  assert.equal(r.code, 1, r.stdout + r.stderr)
  assert.ok(r.stderr.startsWith(plaintextLine(partial)), r.stderr)
  assert.match(r.stderr, /^auto-okf materialize: EISDIR/m)
  assert.equal(r.stderr.split(plaintextLine(partial)).length, 2, 'the warning is printed once')
  assert.equal(await secretIn(partial), true, 'setup: a.md must hold the plaintext')

  // A crash after a.md. z.md is a named pipe, so the read of z.md blocks
  // after a.md holds the plaintext. SIGKILL then stops the process: no
  // handler runs. The warning must be on stderr already.
  const crash = join(base, 'crash')
  await mkdir(crash, { recursive: true })
  await new Promise((resolve, reject) => execFile('mkfifo', [join(crash, 'z.md')], (err) => (err ? reject(err) : resolve())))
  const child = spawn('node', [BIN, 'materialize', storage, crash], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (d) => (stderr += d))
  child.stdout.resume()
  const closed = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })))
  const t0 = Date.now()
  while (!(await secretIn(crash))) {
    if (Date.now() - t0 > 60000) {
      child.kill('SIGKILL')
      throw new Error(`a.md never held the plaintext; stderr: ${stderr}`)
    }
    await new Promise((r) => setTimeout(r, 20))
  }
  child.kill('SIGKILL')
  assert.deepEqual(await closed, { code: null, signal: 'SIGKILL' })
  assert.equal(stderr, plaintextLine(crash), 'the crash found no warning on stderr')

  const plain = join(base, 'plain')
  const pv = await Bundle.init(plain)
  await pv.createConcept('a', 'note')
  await pv.close()
  const pmat = await cli(['materialize', plain, join(base, 'plain-bundle')])
  assert.equal(pmat.code, 0, pmat.stderr)
  assert.equal(pmat.stderr, '')
})

// ---------- ingest ----------

test('ingest prints one line for each file with its ops, then a summary line that counts the files already up to date (ADR-003)', async () => {
  const base = await tmpDir('ingest')
  const storage = join(base, 'vault')
  const bundle = join(base, 'bundle')
  await cli(['init', storage])
  await mkdir(bundle, { recursive: true })

  // with no skip, the clause is omitted, never "0"
  const empty = await cli(['ingest', storage, bundle])
  assert.equal(empty.code, 0, empty.stderr)
  assert.equal(empty.stdout, 'ingest complete: 0 op(s) from 0 file(s)\n')

  await writeFile(join(bundle, 'hello.md'), '---\ntype: note\ntitle: Hello\n---\nA hand-authored body.\n')
  const ing = await cli(['ingest', storage, bundle])
  assert.equal(ing.code, 0, ing.stderr)
  assert.equal(ing.stdout, 'ingested hello.md: create-concept, set-field, set-body\ningest complete: 3 op(s) from 1 file(s)\n')
  await cli(['materialize', storage, bundle]) // stamps _id and _rev, and records the hash

  // every file matches its manifest hash
  const again = await cli(['ingest', storage, bundle])
  assert.equal(again.code, 0, again.stderr)
  assert.equal(again.stdout, 'ingest complete: 0 op(s) from 0 file(s); 1 file(s) already up to date\n')
})

test('ingest with paths ingests the named files only; a path outside the bundle, a missing path or a path that is no .md file exits 1 by name before any op (ADR-001)', async () => {
  const base = await tmpDir('scoped')
  const storage = join(base, 'vault')
  const bundle = join(base, 'bundle')
  await cli(['init', storage])
  await mkdir(join(bundle, 'drafts'), { recursive: true })
  await writeFile(join(base, 'outside.md'), '---\ntype: note\n---\nNot in the bundle.\n')
  await writeFile(join(bundle, 'drafts', 'mine.md'), '---\ntype: note\n---\nMine.\n')
  await writeFile(join(bundle, 'drafts', 'theirs.md'), '---\ntype: note\n---\nTheirs, mid-write.\n')
  const baseline = await snapshotHash(storage)

  // one bad path stops the run before any op, the good sibling included
  for (const [paths, message] of [
    [['../outside.md'], /^auto-okf ingest: path resolves outside the bundle root: \.\.\/outside\.md$/m],
    [['drafts/ghost.md'], /^auto-okf ingest: no such file in the bundle: drafts\/ghost\.md$/m],
    [['drafts'], /^auto-okf ingest: not a concept file \(\.md\): drafts$/m],
    [['drafts/mine.md', 'drafts/ghost.md'], /^auto-okf ingest: no such file in the bundle: drafts\/ghost\.md$/m]
  ]) {
    const res = await cli(['ingest', storage, bundle, ...paths])
    assert.equal(res.code, 1, paths.join(' '))
    assert.match(res.stderr, message)
  }
  assert.equal(await snapshotHash(storage), baseline, 'zero ops appended across the refusals')

  const ing = await cli(['ingest', storage, bundle, 'drafts/mine.md'])
  assert.equal(ing.code, 0, ing.stderr)
  assert.match(ing.stdout, /^ingested drafts\/mine\.md: create-concept/m)
  assert.doesNotMatch(ing.stdout, /theirs\.md/, "the other writer's file was not swept up")
  assert.match(ing.stdout, /^ingest complete: \d+ op\(s\) from 1 file\(s\)$/m)
})

test('ingest exits 1 on an oversize file, and its line prints the encoded size of the op and the limit, never the size of the body', async () => {
  // The preflight measures the encoded op. A line that prints the body size
  // calls a body below the limit too large.
  const base = await tmpDir('oversize-op')
  const storage = join(base, 'vault')
  const bundle = join(base, 'bundle')
  const v = await Bundle.init(storage, { metadata: { limits: { maxOpBytes: 4096 } } })
  await v.close()
  await mkdir(bundle, { recursive: true })
  await writeFile(join(bundle, 'edge.md'), `---\ntype: note\n---\n${'x'.repeat(4000)}\n`)
  const r = await cli(['ingest', storage, bundle])
  assert.equal(r.code, 1, r.stdout + r.stderr)
  const m = /^error: edge\.md: its set-body op is ([\d,]+) bytes encoded; maxOpBytes is 4,096$/m.exec(r.stderr)
  assert.ok(m, r.stderr)
  assert.ok(Number(m[1].replace(/,/g, '')) > 4096, m[1])
  assert.ok(!r.stderr.includes('4,000'), 'the line names no body size')
  assert.doesNotMatch(r.stdout, /ingested edge\.md/)
})

const REJECTED_LINE = /^error: other\/x\.md: core rejected its set-body op \(policy-namespace\), and the file stays pending$/m

/**
 * A vault whose policy lets the writer write under team/ only, and its face.
 * other/x predates the policy, and the face holds a human edit of its body,
 * so core rejects the set-body of that edit as policy-namespace. team/y.md is
 * a new file that ingests.
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

test('ingest exits 1 and names each op that core rejects, with the file and the reason; without --confirm-deletes it skips a delete by name, and with it a rejected delete is named too', async () => {
  const { storage, bundle } = await rejectingFace(await tmpDir('ingest-rejected'))
  const ing = await cli(['ingest', storage, bundle])
  assert.equal(ing.code, 1, `a rejected op is an error exit\n${ing.stdout}${ing.stderr}`)
  assert.match(ing.stderr, REJECTED_LINE)
  assert.match(ing.stdout, /^ingested team\/y\.md: create-concept/m)
  assert.doesNotMatch(ing.stdout, /ingested other\/x\.md/)

  await rm(join(bundle, 'other', 'x.md'))
  const skipped = await cli(['ingest', storage, bundle])
  assert.equal(skipped.code, 0, `${skipped.stdout}${skipped.stderr}`)
  assert.match(skipped.stderr, /^delete skipped \(no --confirm-deletes\): other\/x\.md$/m)

  const del = await cli(['ingest', storage, bundle, '--confirm-deletes'])
  assert.equal(del.code, 1, `a rejected delete is an error exit\n${del.stdout}${del.stderr}`)
  assert.match(del.stderr, /^error: other\/x\.md: core rejected its delete-concept op \(policy-namespace\), and the delete stays pending$/m)
  assert.doesNotMatch(del.stdout, /ingested other\/x\.md/)
})

// ---------- status, wanted, flags, resolve and undelete ----------

test('status prints one "state<TAB>path" row for each file and the count on stderr; --json prints rows of exactly { path, state }, sorted by path, the same bytes on each run (ADR-002)', async () => {
  const base = await tmpDir('status')
  const storage = join(base, 'vault')
  const bundle = join(base, 'bundle')
  await cli(['init', storage])
  await mkdir(bundle, { recursive: true })
  await writeFile(join(bundle, 'note.md'), '---\ntype: note\ntitle: Stable\n---\nBody.\n')

  const before = await cli(['status', storage, bundle])
  assert.equal(before.code, 0, before.stderr)
  assert.match(before.stdout, /^pending-ingest\tnote\.md$/m)

  await cli(['ingest', storage, bundle])
  await cli(['materialize', storage, bundle])
  const after = await cli(['status', storage, bundle])
  assert.equal(after.code, 0, after.stderr)
  assert.equal(after.stdout, 'in-log\tindex.md\nin-log\tlog.md\nin-log\tnote.md\n')
  assert.equal(after.stderr, '3 file(s)\n')

  const j1 = await cli(['status', storage, bundle, '--json'])
  const j2 = await cli(['status', storage, bundle, '--json'])
  assert.equal(j1.code, 0, j1.stderr)
  assert.equal(j1.stderr, '')
  assert.equal(j1.stdout, j2.stdout, 'byte-identical across consecutive runs with no intervening ops')
  const rows = ['index.md', 'log.md', 'note.md'].map((path) => ({ path, state: 'in-log' }))
  assert.equal(j1.stdout, JSON.stringify(rows, null, 2) + '\n', 'the schema is exactly { path, state }, in that key order')
})

test('wanted prints one "count<TAB>path<TAB><- referrers" row for each unresolved link and the count on stderr, and --json prints the rows', async () => {
  const base = await tmpDir('wanted')
  const storage = join(base, 'vault')
  const bundle = join(base, 'bundle')
  await cli(['init', storage])
  await mkdir(bundle, { recursive: true })
  await writeFile(join(bundle, 'src.md'), '---\ntype: note\n---\nSee [the ghost](/ghost) page.\n')
  const ing = await cli(['ingest', storage, bundle])
  assert.equal(ing.code, 0, ing.stderr)

  const w = await cli(['wanted', storage])
  assert.equal(w.code, 0, w.stderr)
  const row = /^1\tghost\t<- ([0-9a-f]+)\n$/.exec(w.stdout)
  assert.ok(row, w.stdout)
  assert.equal(w.stderr, '1 wanted path(s), most-referenced first\n')

  const wj = await cli(['wanted', storage, '--json'])
  assert.equal(wj.code, 0, wj.stderr)
  assert.deepEqual(JSON.parse(wj.stdout), [{ path: 'ghost', count: 1, referrers: [row[1]] }])
})

/**
 * Seed a body conflict with one writer: a SetBody that cites an unknown base
 * is flagged against the head (SPEC §5). Returns { id, keep, supersede }.
 */
async function seedConflict(storage) {
  const v = await Bundle.init(storage)
  const { tag: id } = await v.createConcept('notes/a', 'note')
  await v.setBody(id, null, 'version one')
  await v.update()
  const keep = await v.val(K.cBody(id))
  await v.setBody(id, 'f'.repeat(64), 'version two') // an unknown base: a conflict
  await v.update()
  let supersede = null
  for await (const { key } of v.scan(K.flagPrefix('conflict', id))) {
    supersede = K.parseKey(key)[4] // flag/conflict/<id>/<head>/<new>
  }
  await v.close()
  return { id, keep, supersede }
}

test('flags prints one "key<TAB>value" row for each flag of the family and the count on stderr, and --json prints the rows; resolve prints the new head and the count of conflict flags still open', async () => {
  const base = await tmpDir('conflict')
  const storage = join(base, 'vault')
  const { id, keep, supersede } = await seedConflict(storage)

  const flags = await cli(['flags', storage, 'conflict'])
  assert.equal(flags.code, 0, flags.stderr)
  assert.match(flags.stdout, new RegExp(`^flag/conflict/${id}/${keep}/${supersede}\\t\\{.*\\}\\n$`))
  assert.equal(flags.stderr, '1 flag(s) in flag/conflict/\n')

  const fj = await cli(['flags', storage, 'conflict', '--json'])
  const rows = JSON.parse(fj.stdout)
  assert.deepEqual(rows.map((r) => Object.keys(r)), [['key', 'value']], 'exactly one open conflict, as { key, value }')
  assert.equal(rows[0].key, `flag/conflict/${id}/${keep}/${supersede}`)

  const all = await cli(['flags', storage])
  assert.match(all.stderr, /^\d+ flag\(s\)\n$/, 'no family: the count names none')

  const resolved = await cli(['resolve', storage, id, '--keep', keep, '--supersede', supersede])
  assert.equal(resolved.code, 0, resolved.stderr)
  assert.equal(resolved.stdout, `resolved ${id}: head := ${keep}; 0 conflict flag(s) still open on this concept\n`)

  const cleared = await cli(['flags', storage, 'conflict'])
  assert.equal(cleared.stderr, '0 flag(s) in flag/conflict/\n')
})

test('undelete exits 0 on a tombstoned concept and prints its id', async () => {
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
  assert.match(out.stdout, new RegExp(`^undeleted ${id}: concept restored`, 'm'))

  // The command prints "restored" only after it reads the view, so one more
  // read here shows that the op reached the vault.
  const audit = await cli(['flags', storage, 'undelete'])
  assert.match(audit.stdout, new RegExp(`^flag/undelete/${id}/`, 'm'))
})

// ---------- watch and bootstrap ----------

test('watch prints each ingest and each op that core rejects, keeps running, ingests a file saved while it runs, and exits 0 on SIGINT', async () => {
  const { storage, bundle } = await rejectingFace(await tmpDir('watch'))
  const watch = foreground(['watch', storage, bundle])
  try {
    // The scan at the start finds both files.
    await waitFor(() => watch.log.includes('watching') && REJECTED_LINE.test(watch.log), 30000)
    assert.match(watch.log, /^ingested team\/y\.md: create-concept/m)
    assert.match(watch.log, new RegExp(`^watching ${lit(bundle)} \\(foreground; Ctrl-C to stop\\)$`, 'm'))
    assert.equal(watch.child.exitCode, null, `watch keeps running after the rejection, log:\n${watch.log}`)

    await writeFile(join(bundle, 'team', 'z.md'), '---\ntype: note\n---\nSaved while watch runs.\n')
    await waitFor(() => /^ingested team\/z\.md: create-concept/m.test(watch.log), 30000)
  } finally {
    watch.child.kill('SIGINT')
  }
  assert.equal(await watch.exited, 0, `clean shutdown, log:\n${watch.log}`)
})

test('watch exits 2 by name on a --swarm without a DHT choice, a DHT flag without --swarm and a bad --bootstrap, before it opens the vault; bootstrap exits 2 on a missing or bad --port and a --host that is not IPv4', async () => {
  const base = await tmpDir('watch-dht')
  const missing = join(base, 'no-vault-here') // a refusal after the open says "not a vault" instead
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

test('bootstrap prints its address and exits 0 on SIGINT; watch --swarm --bootstrap joins the private swarm through it, so an admitted peer folds the ops of the vault, and prints the size of the local list of join', { timeout: 120000 }, async (t) => {
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

  peer = await Bundle.join(join(base, 'peer'), Buffer.from(vaultKey, 'hex'), { metadata: await invite(origin) })
  const peerSwarmKey = peer.swarmKey.toString('hex')
  const added = await cli(['add-writer', origin, peer.localKey.toString('hex'), '--swarm-key', peerSwarmKey])
  assert.equal(added.code, 0, added.stderr)

  watch = foreground(['watch', origin, bundle, '--swarm', '--bootstrap', `127.0.0.1:${port}`])
  await waitFor(() => watch.log.includes('watching'), 30000)
  assert.match(watch.log, new RegExp(`^joined the private swarm on the vault's auto-okf/2 topic \\(bootstrap 127\\.0\\.0\\.1:${port}\\)$`, 'm'))
  assert.match(watch.log, new RegExp(`^swarm key: {3}${init.stdout.match(SWARM_LINE)[1]} `, 'm'))
  assert.doesNotMatch(watch.log, /local allow/, 'no local list, no line')

  // The one proof that --bootstrap reaches the swarm of the store.
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

  // watch reads the local list that `join --swarm-allow` wrote.
  assert.equal((await cli(['join', origin, '--swarm-allow', peerSwarmKey])).code, 0)
  watch = foreground(['watch', origin, bundle, '--swarm', '--bootstrap', `127.0.0.1:${port}`])
  await waitFor(() => watch.log.includes('watching'), 30000)
  assert.match(watch.log, new RegExp(`^local allow: {2}1 key\\(s\\) from ${lit(join(origin, 'okf-swarm-allow.json'))}$`, 'm'))
  watch.child.kill('SIGINT')
  assert.equal(await watch.exited, 0, watch.log)

  node.child.kill('SIGINT')
  assert.equal(await node.exited, 0, node.log)
})

// ---------- import ----------

/** A vault at `<base>/old` seeded by `seed(v)`, and its face at `<base>/face`. Returns the vault's key. */
async function oldWithFace(base, seed, opts = {}) {
  const v = await Bundle.init(join(base, 'old'), opts)
  try {
    await seed(v)
    await v.update()
    assert.equal((await materialize(v, join(base, 'face'))).ok, true)
    return v.keyHex
  } finally {
    await v.close()
  }
}

test('import prints the keys, the generation, the predecessor, the counts, the fidelity line and the invite line, and nothing on stderr; --metadata, --predecessor and --encryption-key reach the new okf-vault.json', async () => {
  const base = await tmpDir('imp-cli')
  const limits = { maxOpBytes: 400000, maxPathBytes: 2048, maxPathDepth: 100 }
  const keyHex = await oldWithFace(
    base,
    async (v) => {
      const { tag } = await v.createConcept('notes/one', 'note')
      await v.setBody(tag, null, 'one')
      await v.createConcept('notes/two', 'note')
    },
    { metadata: { limits } }
  )
  const face = join(base, 'face')
  const root = join(base, 'root')
  const r = await cli(['import', face, root])
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.stderr, '', 'a clean import prints no warning')
  assert.match(r.stdout, KEY_LINE)
  assert.match(r.stdout, WRITER_LINE)
  assert.match(r.stdout, SWARM_LINE)
  assert.match(r.stdout, new RegExp(`^storage: {5}${lit(root)}$`, 'm'))
  assert.match(r.stdout, /^generation: {2}root$/m)
  assert.match(r.stdout, /^predecessor: \(none: a root vault\)$/m)
  assert.match(r.stdout, /^notes: {7}2 read, 2 imported$/m)
  assert.match(r.stdout, /^fidelity: {4}every note of the new vault matches the face/m)
  assert.match(r.stdout, /^invite: .*--metadata/m, 'the output tells how a joiner gets the metadata')
  const plain = await invite(root)
  assert.deepEqual([plain.encrypted, plain.predecessorKey ?? null], [false, null])
  assert.notDeepEqual(plain.limits, limits, 'setup: without --metadata the new vault takes the default limits')

  const out = join(base, 'generation2')
  const g = await cli([
    'import', face, out, '--metadata', join(base, 'old', 'okf-vault.json'), '--predecessor', keyHex.toUpperCase(), '--encryption-key', NEW_KEY
  ])
  assert.equal(g.code, 0, g.stdout + g.stderr)
  assert.equal(g.stderr, '', 'import reads plaintext and writes none, so it warns about nothing')
  const meta = await invite(out)
  assert.deepEqual([meta.limits, meta.predecessorKey, meta.encrypted], [limits, keyHex, true])
  assert.match(g.stdout, new RegExp(`^predecessor: ${keyHex}$`, 'm'))
  assert.match(g.stdout, new RegExp(`^generation: {2}${createHash('sha256').update(Buffer.from(keyHex, 'hex')).digest('hex')}$`, 'm'))
})

test('import exits 1 with "auto-okf import: <CODE>: ..." on a refusal of the library, and with the path on a --metadata file that it cannot use; it creates nothing; the face of an encrypted vault imports with a key, with no plaintext warning', async () => {
  const base = await tmpDir('imp-cli-refuse')
  await oldWithFace(
    base,
    async (v) => {
      const { tag } = await v.createConcept('secret/plan', 'note')
      await v.setBody(tag, null, SECRET)
    },
    { encryptionKey: Buffer.from(ENC_KEY, 'hex') }
  )
  const face = join(base, 'face')
  const meta = join(base, 'old', 'okf-vault.json')
  const out = join(base, 'out')
  // Version 3 is a metadata version that no release wrote.
  await writeFile(join(base, 'v3.json'), JSON.stringify({ ...(await invite(join(base, 'old'))), version: 3 }))
  const before = await entries(base)

  const cases = [
    ['a vault at <dir>', [face, join(base, 'old'), '--encryption-key', NEW_KEY], /^auto-okf import: IMPORT_DIR_NOT_EMPTY: \S+old is already a vault \(okf-vault\.json exists\)/m],
    ['no key, a marked face', [face, out], /^auto-okf import: IMPORT_ENCRYPTION_KEY_REQUIRED: the face \S+ holds \.okf-encrypted: .*--encryption-key/m],
    ['no key, encrypted metadata', [face, out, '--metadata', meta], /^auto-okf import: IMPORT_ENCRYPTION_KEY_REQUIRED: the predecessor's metadata says encrypted.*--encryption-key/m],
    ['no face', [join(base, 'no-face'), out], /^auto-okf import: ENOENT: .*no-face/m],
    ['no metadata file', [face, out, '--metadata', join(base, 'missing.json')], /^auto-okf import: --metadata \S+missing\.json: no such file$/m],
    ['metadata of another version', [face, out, '--metadata', join(base, 'v3.json')], /^auto-okf import: --metadata \S+v3\.json: unsupported vault metadata version: 3$/m]
  ]
  for (const [name, args, message] of cases) {
    const r = await cli(['import', ...args])
    assert.equal(r.code, 1, `${name}: ${r.stdout}${r.stderr}`)
    assert.match(r.stderr, message, name)
    assert.deepEqual(await entries(base), before, `${name}: the refusal created something`)
  }

  const ok = await cli(['import', face, out, '--metadata', meta, '--encryption-key', NEW_KEY])
  assert.equal(ok.code, 0, ok.stdout + ok.stderr)
  assert.equal(ok.stderr, '')
  assert.equal((await invite(out)).encrypted, true)
})

test('import exits 2 and creates nothing on a bad or empty --encryption-key, a bad --predecessor and a missing <dir>', async () => {
  const base = await tmpDir('imp-cli-usage')
  const face = join(base, 'face')
  await mkdir(face)
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
  assert.deepEqual(await entries(base), ['face'], 'a usage error created something')
})

test('import exits 1 on IMPORT_FIDELITY and prints each warning, the counts and each difference on stderr', async () => {
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
  // The dot-path note is read and imported, so no difference names it.
  assert.ok(!r.stderr.includes('.drafts'), r.stderr)
})
