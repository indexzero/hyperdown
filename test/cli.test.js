// CLI smoke tests (assignment scope item 4): the real `autovault-ld` binary
// spawned against real vaults on disk. Test dirs are unique per run under
// sslop/015/tmp/ (never /tmp, never cleaned up — handles are closed, files
// are left for post-mortem).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { mkdir, readFile, access, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Vault } from '../packages/store/index.js'
import { keyspace as K } from '../packages/core/index.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BIN = join(ROOT, 'packages', 'cli', 'bin', 'autovault-ld.js')
const RUN = `run-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let seq = 0

async function tmpDir(name) {
  const dir = join(ROOT, 'sslop', '015', 'tmp', RUN, `${name}-${seq++}`)
  await mkdir(dir, { recursive: true })
  return dir
}

/** Run the CLI to completion; resolves { code, stdout, stderr }. */
function cli(args) {
  return new Promise((resolve) => {
    execFile('node', [BIN, ...args], { cwd: ROOT, timeout: 60000 }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code ?? 1 : 0, stdout, stderr })
    })
  })
}

const KEY_LINE = /^vault key: {3}([0-9a-f]{64})$/m
const WRITER_LINE = /^writer key: {2}([0-9a-f]{64})$/m

test('help and usage errors carry the documented exit codes', async () => {
  const help = await cli(['--help'])
  assert.equal(help.code, 0)
  assert.match(help.stdout, /Usage: autovault-ld <command>/)

  const none = await cli([])
  assert.equal(none.code, 2, 'no command is a usage error')

  const unknown = await cli(['frobnicate'])
  assert.equal(unknown.code, 2)
  assert.match(unknown.stderr, /unknown command 'frobnicate'/)

  const badArgs = await cli(['add-writer', 'only-one-arg'])
  assert.equal(badArgs.code, 2, 'missing positionals are usage errors')

  const badKey = await cli(['join', await tmpDir('badkey'), 'not-hex'])
  assert.equal(badKey.code, 2)
  assert.match(badKey.stderr, /64 hex characters/)
})

test('init creates a pinned vault and refuses to re-init', async () => {
  const storage = join(await tmpDir('init'), 'vault')
  const out = await cli(['init', storage])
  assert.equal(out.code, 0, out.stderr)
  assert.match(out.stdout, KEY_LINE)
  assert.match(out.stdout, /genesis indexer/)
  await access(join(storage, 'vault-ld.json')) // metadata pin exists

  const again = await cli(['init', storage])
  assert.equal(again.code, 1)
  assert.match(again.stderr, /already a vault/)
})

test('commands on unpinned storage fail with guidance, not junk vaults', async () => {
  const dir = join(await tmpDir('unpinned'), 'nothing-here')
  for (const args of [['flags', dir], ['materialize', dir, dir + '-face'], ['export', dir, dir + '-rdf']]) {
    const res = await cli(args)
    assert.equal(res.code, 1, args.join(' '))
    assert.match(res.stderr, /not a vault/)
  }
})

test('join + add-writer + remove-writer round trip (§8.0/§8.3 plumbing)', async () => {
  const base = await tmpDir('writers')
  const origin = join(base, 'origin')
  const peer = join(base, 'peer')

  const init = await cli(['init', origin])
  const vaultKey = init.stdout.match(KEY_LINE)[1]

  const joined = await cli(['join', peer, vaultKey])
  assert.equal(joined.code, 0, joined.stderr)
  const writerKey = joined.stdout.match(WRITER_LINE)[1]
  assert.notEqual(writerKey, vaultKey, 'peer has its own writer core')
  await access(join(peer, 'vault-ld.json'), undefined, 'joined storage is pinned')

  // reopen pinned storage without a key: reprints identity
  const reopen = await cli(['join', peer])
  assert.equal(reopen.code, 0)
  assert.equal(reopen.stdout.match(WRITER_LINE)[1], writerKey)

  const added = await cli(['add-writer', origin, writerKey, '--indexer'])
  assert.equal(added.code, 0, added.stderr)
  assert.match(added.stdout, new RegExp(`writer added: ${writerKey} \\(indexer: true\\)`))

  const removed = await cli(['remove-writer', origin, writerKey])
  assert.equal(removed.code, 0, removed.stderr)
  assert.match(removed.stdout, /writer removed/)

  // the unadmitted peer cannot issue governance ops at all
  const rogue = await cli(['add-writer', peer, vaultKey])
  assert.equal(rogue.code, 1, 'unadmitted peer add-writer must fail')
})

/** Seed a vault with content through the store API (the CLI has no write command). */
async function seed(storage) {
  const v = await Vault.open(storage)
  await v.defineScope('core', 'https://ex.example/core#', 'ex')
  await v.defineTerm('core', 'title', { '@id': 'ex:title' })
  await v.defineTerm('core', 'topic', { '@id': 'ex:topic', '@container': '@set' })
  await v.setField('Home', 'title', 'Hello CLI')
  await v.addMember('Home', 'topic', { ref: 'Nowhere' }) // dangling ref (§7)
  await v.setField('Home', 'mood', 'blue') // unmapped term (§5.6)
  await v.setBody('Home', null, 'A body written by the seeder.')
  await v.update()
  await v.close()
}

test('materialize + export + flags against a seeded vault', async () => {
  const base = await tmpDir('faces')
  const storage = join(base, 'vault')
  await cli(['init', storage])
  await seed(storage)

  const face = join(base, 'face')
  const mat = await cli(['materialize', storage, face])
  assert.equal(mat.code, 0, mat.stderr)
  assert.match(mat.stdout, /2 written/) // Home.md + context.jsonld
  const home = await readFile(join(face, 'Home.md'), 'utf8')
  assert.match(home, /title: Hello CLI/)
  assert.match(home, /topic: \["\[\[Nowhere\]\]"\]/)
  assert.match(home, /mood: blue/, 'unmapped terms round-trip on the face')
  assert.match(home, /A body written by the seeder\./)

  const rdf = join(base, 'rdf')
  const exp = await cli(['export', storage, rdf, '--roundtrip'])
  assert.equal(exp.code, 0, exp.stderr)
  const data = await readFile(join(rdf, 'data.ttl'), 'utf8')
  assert.match(data, /<vault:\/\/data\/Home> ex:title "Hello CLI"/)
  assert.doesNotMatch(data, /mood/, 'unmapped terms are never exported as triples (§10.3)')

  const all = await cli(['flags', storage])
  assert.equal(all.code, 0)
  assert.match(all.stdout, /^flag\/dangling\/Nowhere\t/m)
  assert.match(all.stdout, /^flag\/unmapped\/Home\/mood\t/m)

  const fam = await cli(['flags', storage, 'dangling'])
  assert.match(fam.stdout, /flag\/dangling\/Nowhere/)
  assert.doesNotMatch(fam.stdout, /unmapped/, 'family filter narrows the scan')

  const asJson = await cli(['flags', storage, 'dangling', '--json'])
  const rows = JSON.parse(asJson.stdout)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].key, 'flag/dangling/Nowhere')
  assert.equal(rows[0].value.count, 1)
})

test('watch ingests a human edit in the foreground and exits on SIGINT', async () => {
  const base = await tmpDir('watch')
  const storage = join(base, 'vault')
  await cli(['init', storage])
  await seed(storage)
  const face = join(base, 'face')
  await cli(['materialize', storage, face])

  const child = spawn('node', [BIN, 'watch', storage, face], { cwd: ROOT })
  let log = ''
  child.stdout.on('data', (d) => {
    log += d
  })
  child.stderr.on('data', (d) => {
    log += d
  })
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))

  await waitFor(() => log.includes('watching'), 20000)
  const notePath = join(face, 'Home.md')
  const note = await readFile(notePath, 'utf8')
  await writeFile(notePath, note.replace('Hello CLI', 'Hello WATCH'))
  await waitFor(() => log.includes('ingested Home.md: set-field'), 20000)

  child.kill('SIGINT')
  const { code } = await exited
  assert.equal(code, 0, `clean shutdown, log:\n${log}`)

  const v = await Vault.open(storage)
  try {
    await v.update()
    const rec = await v.val(K.nField('Home', 'title'))
    assert.deepEqual(rec.reg.values, ['Hello WATCH'], 'the edit re-entered the log as one SetField')
  } finally {
    await v.close()
  }
})

async function waitFor(fn, ms) {
  const t0 = Date.now()
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 100))
  }
}
