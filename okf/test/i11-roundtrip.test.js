// I11 Roundtrip (okf SPEC §10 generation cycling, §11 I11, §14 acceptance):
// materialize -> ingest into a FRESH vault (a generation cycle) preserves every
// live concept's _id, type, fields, tags, path and head body byte-for-byte,
// while HISTORY (old revisions, per-op attribution) is shed by design.
//
// These run on REAL @auto-okf/store vaults (autobee + corestore on disk, no
// stubs). Scratch lives under sslop/033/tmp/, unique per run; handles are
// closed but files are NEVER deleted (post-mortem), and nothing under sslop/
// (or /tmp) is removed by the test.
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import assert from 'node:assert/strict'
import { mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Bundle } from '../store/index.js'
import { materialize, compact, createIngestWatcher, readView, readLog, parseNote, renderNote } from '../faces/index.js'
import { compareTrees } from '../faces/lib/verify.js'
import { keyspace as K } from '../core/index.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Direct replication stream pair between two vaults; returns unpair(). */
function pair(a, b) {
  const s1 = a.replicate(true)
  const s2 = b.replicate(false)
  s1.on('error', () => {})
  s2.on('error', () => {})
  s1.pipe(s2).pipe(s1)
  return () => {
    s1.destroy()
    s2.destroy()
  }
}

/** Wait until every vault reports the same non-null view hash. */
async function converged(vaults, ms = 30000) {
  const t0 = Date.now()
  for (;;) {
    const hashes = []
    for (const v of vaults) {
      await v.update()
      hashes.push(await v.snapshotHash())
    }
    if (hashes.every((h) => h != null && h === hashes[0])) return true
    if (Date.now() - t0 >= ms) return false
    await sleep(50)
  }
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const RUN = `run-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let seq = 0

/** Unique on-disk scratch dir under sslop/033/tmp/ (never cleaned up). */
async function tmpDir(name) {
  const dir = join(ROOT, 'sslop', '033', 'tmp', RUN, `${name}-${seq++}`)
  await mkdir(dir, { recursive: true })
  return dir
}

/** Read every .md in a bundle into Map<relPath, string>. */
async function readBundle(root, rel = '', out = new Map()) {
  const abs = rel === '' ? root : join(root, rel)
  let entries
  try {
    entries = await readdir(abs, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (e.name.startsWith('.')) continue
    const cr = rel === '' ? e.name : `${rel}/${e.name}`
    if (e.isDirectory()) await readBundle(root, cr, out)
    else if (e.isFile() && cr.endsWith('.md')) out.set(cr, await readFile(join(root, cr), 'utf8'))
  }
  return out
}

/** Every file under a directory, dot-files included, as sorted relative paths. */
async function listFiles(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  return entries
    .filter((e) => e.isFile())
    .map((e) => relative(root, join(e.parentPath, e.name)))
    .sort()
}

// §14: byte-fidelity is judged "modulo the _rev frontmatter lines and the
// regenerated log.md" (both necessarily re-derive in the new generation — a head
// that was an EDIT re-roots at base:null, changing its revHash). Everything
// else — _id, type, all fields, tags, path (the filename), body — must be
// byte-identical.
function normalizeBundle(m) {
  const out = new Map()
  for (const [k, v] of m) {
    if (k === 'log.md') continue
    out.set(k, v.replace(/^_rev: .*\n/m, ''))
  }
  return out
}

function bundleDiff(a, b) {
  const keys = new Set([...a.keys(), ...b.keys()])
  for (const k of [...keys].sort()) {
    if (!a.has(k)) return `only in B: ${k}`
    if (!b.has(k)) return `only in A: ${k}`
    if (a.get(k) !== b.get(k)) return `differ: ${k}\n--A--\n${a.get(k)}\n--B--\n${b.get(k)}`
  }
  return null
}

async function revCount(vault, id) {
  let n = 0
  for await (const _ of vault.scan(`c/${id}/rev/`)) n++
  return n
}

async function logKinds(vault) {
  const kinds = new Set()
  for (const rec of await readLog(vault)) for (const ev of rec.events) kinds.add(ev.kind)
  return kinds
}

/** Live (non-tombstoned, path-bearing) concepts of a vault, by _id. */
async function liveConcepts(vault) {
  const { concepts } = await readView(vault)
  const live = new Map()
  for (const c of concepts.values()) if (!c.deleted && c.path !== undefined) live.set(c.id, c)
  return live
}

/**
 * Build a NON-TRIVIAL bundle in one vault (single writer, deterministic):
 * multiple concepts at nested paths, OR-set tags, a rename, a body revision
 * (edit), arbitrary "unmapped"/host frontmatter keys, a RESOLVED conflict
 * (so flag/conflict is drained), and a tombstoned concept (suppressed).
 * Returns the concept ids.
 */
async function buildNonTrivial(v) {
  // A: nested path, edited body (2 revisions), tags, unmapped + host keys.
  const { tag: a } = await v.createConcept('datasets/finance/revenue', 'Dataset')
  await v.setField(a, 'title', 'Revenue')
  await v.setField(a, 'description', 'Quarterly revenue tables.')
  await v.setField(a, 'owner', 'analytics-team') // unmapped producer key
  await v.setField(a, 'host', 'bq://prod-project') // "host" key
  await v.setField(a, 'regions', ['us', 'eu']) // array-valued unmapped key
  await v.addTag(a, 'q3')
  await v.addTag(a, 'core')
  await v.setBody(a, null, 'Revenue overview. See [orders](/tables/orders-v2.md).')
  await v.update()
  const aHead1 = await v.val(K.cBody(a))
  await v.setBody(a, aHead1, 'Revenue overview, revised. See [orders](/tables/orders-v2.md).') // body revision (edit)

  // B: created then RENAMED (LWW path); tag.
  const { tag: b } = await v.createConcept('tables/orders', 'Table')
  await v.setField(b, 'title', 'Orders')
  await v.addTag(b, 'core')
  await v.setBody(b, null, 'One row per order.')
  await v.update()
  await v.setPath(b, 'tables/orders-v2') // rename

  // C: a RESOLVED conflict — two siblings citing the same non-null base,
  // then ResolveConflict drains flag/conflict.
  const { tag: c } = await v.createConcept('guides/intro', 'Guide')
  await v.setField(c, 'title', 'Introduction')
  await v.setBody(c, null, 'r1')
  await v.update()
  const c1 = await v.val(K.cBody(c))
  await v.setBody(c, c1, 'r2a')
  await v.update()
  await v.setBody(c, c1, 'r2b') // sibling of r2a -> flag/conflict
  await v.update()
  const cHead = await v.val(K.cBody(c))
  const cRevs = []
  for await (const { key } of v.scan(`c/${c}/rev/`)) cRevs.push(K.parseKey(key)[3])
  const loser = cRevs.find((h) => h !== cHead && h !== c1)
  await v.resolveConflict(c, cHead, { supersede: [loser] })
  await v.update()

  // D: created then DELETED (tombstone) — must be suppressed post-cycle.
  const { tag: d } = await v.createConcept('notes/scratch', 'Note')
  await v.setBody(d, null, 'temporary scratch')
  await v.update()
  await v.deleteConcept(d)
  await v.update()

  return { a, b, c, d }
}

test('I11: a generation cycle round-trips a non-trivial bundle (state + identity fidelity)', async () => {
  const old = await Bundle.init(await tmpDir('old-vault'))
  const ids = await buildNonTrivial(old)
  await old.update()

  // Guardrail precondition: the resolved conflict drained flag/conflict, and
  // there is no path collision — so compact runs WITHOUT force.
  let openConflicts = 0
  for await (const _ of old.scan(K.flagPrefix('conflict'))) openConflicts++
  assert.equal(openConflicts, 0, 'setup left an open flag/conflict; conflict was not drained')

  const oldDir = await tmpDir('old-bundle')
  const rOld = await materialize(old, oldDir)
  assert.equal(rOld.ok, true)
  const oldBundle = await readBundle(oldDir)

  // --- the generation cycle ---
  const res = await compact(old, {
    toDir: await tmpDir('compact-face'),
    vaultDir: await tmpDir('new-vault'),
    initBundle: Bundle.init
  })
  const nu = res.vault

  // §10 generation chain metadata is recorded in the new vault.
  assert.equal(res.predecessorKey, old.keyHex)
  assert.equal(nu.metadata.predecessorKey, old.keyHex)
  assert.match(nu.metadata.predecessorCheckpoint.viewHash, /^[0-9a-f]{64}$/)
  assert.equal(res.predecessorPath, old.dir, 'compact must return the predecessor path (never deletes it)')

  // §10/N2 generation key-freshness: fresh generation namespace + fresh writer keypair,
  // which is exactly why adoption of the predecessor's mint-shaped ids does
  // not deadlock on mint-collision-risk.
  assert.notEqual(nu.generation, 'root', 'new vault must have a fresh (non-root) generation namespace')
  assert.notEqual(
    Buffer.from(nu.localKey).toString('hex'),
    Buffer.from(old.localKey).toString('hex'),
    'new vault must use a fresh writer keypair (a keypair MUST NOT recur across generations)'
  )

  // §10 generation log entry recorded in the new vault's log/.
  const logEntry = JSON.parse(await readFile(res.logPath, 'utf8'))
  assert.equal(logEntry.kind, 'generation')
  assert.equal(logEntry.predecessorKey, old.keyHex)
  assert.equal(logEntry.generation, nu.generation)

  // --- I11 byte fidelity: new bundle == old bundle (modulo _rev + log.md) ---
  const newDir = await tmpDir('new-bundle')
  const rNew = await materialize(nu, newDir)
  assert.equal(rNew.ok, true)
  const newBundle = await readBundle(newDir)
  assert.equal(
    bundleDiff(normalizeBundle(newBundle), normalizeBundle(oldBundle)),
    null,
    'new materialized bundle is not byte-identical to the old (modulo _rev + log.md)'
  )

  // --- explicit identity + state fidelity per live concept ---
  const oldLive = await liveConcepts(old)
  const newLive = await liveConcepts(nu)
  assert.deepEqual([...newLive.keys()].sort(), [...oldLive.keys()].sort(), 'live _id set changed across the cycle')
  assert.ok(!newLive.has(ids.d), 'tombstoned concept survived the cycle (should be suppressed)')
  for (const [id, oc] of oldLive) {
    const nc = newLive.get(id)
    assert.equal(nc.type, oc.type, `type changed for ${id}`)
    assert.equal(nc.path, oc.path, `path changed for ${id}`)
    assert.equal(nc.headText, oc.headText, `head body changed for ${id}`)
  }
  // the renamed concept B lives at its NEW path, and only there.
  assert.equal(newLive.get(ids.b).path, 'tables/orders-v2')

  // --- history is SHED (assert positively) ---
  // 1. Old revisions are gone: A had 2 revisions (an edit), C had 3 (two
  //    siblings + r1); each survives as exactly ONE base:null revision.
  assert.equal(await revCount(old, ids.a), 2, 'setup: A should have 2 revisions')
  assert.equal(await revCount(old, ids.c), 3, 'setup: C should have 3 revisions')
  assert.equal(await revCount(nu, ids.a), 1, 'A history not shed: new vault should hold one revision')
  assert.equal(await revCount(nu, ids.c), 1, 'C history not shed: new vault should hold one revision')

  // 2. Per-op attribution is gone: the old vault narrates renames + conflict
  //    resolutions + deletions; the new vault narrates ONLY creations.
  const oldKinds = await logKinds(old)
  assert.ok(oldKinds.has('rename') && oldKinds.has('resolve') && oldKinds.has('delete'), 'setup: old log missing history events')
  const newKinds = await logKinds(nu)
  assert.deepEqual([...newKinds].sort(), ['create'], `new vault log should narrate only creations, saw: ${[...newKinds]}`)

  await old.close()
  await nu.close()
})

test('I11 guardrail: compact refuses an undrained conflict without force, proceeds with it', async () => {
  const v = await Bundle.init(await tmpDir('conf-vault'))
  const { tag: id } = await v.createConcept('c', 'Note')
  await v.setBody(id, null, 'r1')
  await v.update()
  const r1 = await v.val(K.cBody(id))
  await v.setBody(id, r1, 'r2a')
  await v.update()
  await v.setBody(id, r1, 'r2b') // sibling -> OPEN flag/conflict (not resolved)
  await v.update()
  let open = 0
  for await (const _ of v.scan(K.flagPrefix('conflict'))) open++
  assert.equal(open, 1, 'setup should leave one open conflict')

  // Without force: REFUSE (SPEC §10 guardrail).
  const rejFace = await tmpDir('rej-face')
  const rejVault = await tmpDir('rej-vault')
  await assert.rejects(
    () => compact(v, { toDir: rejFace, vaultDir: join(rejVault, 'x'), initBundle: Bundle.init }),
    (err) => err.code === 'COMPACT_REFUSED',
    'compact must refuse an open conflict without force'
  )

  // With force: proceeds — the head wins, the losing sibling is shed, and the
  // new vault carries no conflict.
  const res = await compact(v, {
    toDir: await tmpDir('force-face'),
    vaultDir: await tmpDir('force-vault'),
    initBundle: Bundle.init,
    force: true
  })
  const nu = res.vault
  await nu.update()
  let newOpen = 0
  for await (const _ of nu.scan(K.flagPrefix('conflict'))) newOpen++
  assert.equal(newOpen, 0, 'forced compaction should carry no body conflict into the new vault')
  assert.equal(await revCount(nu, id), 1, 'forced compaction should shed the losing sibling')

  await v.close()
  await nu.close()
})

test('I11: a second generation cycle (generation chain of length 2) still round-trips', async () => {
  const gen = await Bundle.init(await tmpDir('gen-vault'))
  await buildNonTrivial(gen)
  await gen.update()

  // cycle 1: root -> generation1
  const dir1 = await tmpDir('e1-bundle')
  const res1 = await compact(gen, { toDir: await tmpDir('e1-face'), vaultDir: await tmpDir('e1-vault'), initBundle: Bundle.init })
  const e1 = res1.vault
  const b1 = await readBundle((await materialize(e1, dir1), dir1))

  // cycle 2: generation1 -> generation2
  const dir2 = await tmpDir('e2-bundle')
  const res2 = await compact(e1, { toDir: await tmpDir('e2-face'), vaultDir: await tmpDir('e2-vault'), initBundle: Bundle.init })
  const e2 = res2.vault
  const b2 = await readBundle((await materialize(e2, dir2), dir2))

  // generation chain of length 2: root <- generation1 <- generation2.
  assert.equal(e1.metadata.predecessorKey, gen.keyHex)
  assert.equal(e2.metadata.predecessorKey, e1.keyHex)
  assert.notEqual(e2.generation, e1.generation)
  assert.notEqual(e2.generation, 'root')

  // The second cycle round-trips: once history is shed every body is a
  // base:null revision, so a further cycle preserves even _rev.
  assert.equal(bundleDiff(normalizeBundle(b2), normalizeBundle(b1)), null, 'second generation cycle did not round-trip')

  // Identity still preserved end-to-end (root live ids == generation2 live ids).
  const genLive = await liveConcepts(gen)
  const e2Live = await liveConcepts(e2)
  assert.deepEqual([...e2Live.keys()].sort(), [...genLive.keys()].sort(), 'identity lost across two generation cycles')

  await gen.close()
  await e1.close()
  await e2.close()
})

test('I11: --force over a path collision fails COMPACT_FIDELITY until T16 keeps the winner (G28)', async () => {
  const a = await Bundle.init(await tmpDir('cc-a'))
  const b = await Bundle.join(await tmpDir('cc-b'), a.key)
  let unpair = pair(a, b)
  assert.ok(await converged([a, b]), 'initial converge failed')
  await a.writers.add(b.localKey)
  assert.ok(await converged([a, b]), 'writer-add converge failed')

  // Partition, then both writers claim the SAME path -> a path collision.
  unpair()
  const { tag: idA } = await a.createConcept('shared/note', 'Note')
  await a.setBody(idA, null, 'A body')
  const { tag: idB } = await b.createConcept('shared/note', 'Note')
  await b.setBody(idB, null, 'B body')
  unpair = pair(a, b)
  assert.ok(await converged([a, b]), 'post-partition converge failed')

  // A live pathcollision exists, so compact MUST refuse without force...
  const ccRejFace = await tmpDir('cc-rej-face')
  const ccRejVault = await tmpDir('cc-rej-vault')
  await assert.rejects(
    () => compact(a, { toDir: ccRejFace, vaultDir: join(ccRejVault, 'x'), initBundle: Bundle.init }),
    (err) => err.code === 'COMPACT_REFUSED'
  )

  // ...and with force, the T13 check finds G28. The stage ingests in byte
  // order, so the conflicted copy `shared/note.conflict-<h8>.md` claims
  // `shared/note` in the fresh vault before the predecessor's winner does.
  // The new vault then swaps the winner and the loser, and compact fails
  // loudly. T16 ingests primary paths first, and puts back the carry-across
  // assertions that this test held at f4facef.
  // The copy named for the predecessor's loser is missing, and a copy named
  // for its winner is extra.
  const err = await expectFidelityFailure(a, await tmpDir('cc-force'), { force: true })
  const byKind = (kind) => err.differences.filter((d) => d.kind === kind).map((d) => d.path)
  const copyOf = (id) => `shared/note.conflict-${createHash('sha256').update(id).digest('hex').slice(0, 8)}.md`
  assert.deepEqual(byKind('differs'), ['shared/index.md', 'shared/note.md'])
  assert.equal(byKind('missing').length, 1, JSON.stringify(err.differences))
  assert.equal(byKind('extra').length, 1, JSON.stringify(err.differences))
  assert.deepEqual([...byKind('missing'), ...byKind('extra')].sort(), [copyOf(idA), copyOf(idB)].sort())

  unpair()
  await a.close()
  await b.close()
})

test('I11: the face that compact writes holds only what materialize writes (§10)', async () => {
  const old = await Bundle.init(await tmpDir('face-vault'))
  await buildNonTrivial(old)
  await old.update()

  const plainDir = await tmpDir('face-plain')
  assert.equal((await materialize(old, plainDir)).ok, true)

  const faceDir = await tmpDir('face-compact')
  const res = await compact(old, {
    toDir: faceDir,
    vaultDir: await tmpDir('face-new-vault'),
    initBundle: Bundle.init
  })

  assert.deepEqual(
    await listFiles(faceDir),
    await listFiles(plainDir),
    'compact left a file in the face that materialize does not write'
  )

  await old.close()
  await res.vault.close()
})

// ---------- T13: compaction checks its own output ----------

/** Write `files` (Map<rel, string>) under `root`, creating directories. */
async function writeTree(root, files) {
  for (const [rel, text] of files) {
    await mkdir(dirname(join(root, rel)), { recursive: true })
    await writeFile(join(root, rel), text)
  }
}

test('T13: compareTrees reports every difference by path, without _rev lines and log.md (§14)', async () => {
  const note = (rev, body) => `---\n_id: 0123abcd\n_rev: ${rev}\ntype: note\n---\n\n${body}\n`
  const face = await tmpDir('cmp-face')
  const nu = await tmpDir('cmp-new')
  await writeTree(
    face,
    new Map([
      ['a.md', note('1'.repeat(64), 'same body')], // equal modulo _rev
      ['log.md', '# Update Log\n\nold history\n'], // excluded (§14)
      ['.drafts/idea.md', note('2'.repeat(64), 'dot path')], // only in the face
      ['index.md', '# Contents\n\n* [a](a.md)\n'], // differs
      ['body.md', '---\ntype: note\n---\n\n_rev: one\n'], // a body line is never stripped
      ['.okf-manifest.json', '{"files":{}}\n'] // not a bundle note
    ])
  )
  await writeTree(
    nu,
    new Map([
      ['a.md', note('3'.repeat(64), 'same body')],
      ['log.md', '# Update Log\n'],
      ['index.md', '# Contents\n'],
      ['body.md', '---\ntype: note\n---\n\n_rev: two\n'],
      ['extra.md', note('4'.repeat(64), 'only in the new tree')], // only in the new tree
      ['.okf-manifest.json', '{"files":{"a.md":"x"}}\n']
    ])
  )
  assert.deepEqual(await compareTrees(face, nu), [
    { path: '.drafts/idea.md', kind: 'missing' },
    { path: 'body.md', kind: 'differs' },
    { path: 'extra.md', kind: 'extra' },
    { path: 'index.md', kind: 'differs' }
  ])
  assert.deepEqual(await compareTrees(face, face), [], 'a tree must equal itself')
})

/** The entries of a directory, sorted: what a compaction leaves next to its out-dir. */
async function entries(dir) {
  return (await readdir(dir)).sort()
}

/** The predecessor's state: its full-view hash and its checkpoint. */
async function predecessorState(v) {
  await v.update()
  return { hash: await v.snapshotHash(), checkpoint: await v.checkpoint() }
}

/**
 * Compact `old` into `<base>/out`, with the face at `<base>/face`, and expect
 * COMPACT_FIDELITY. Then check what the failure leaves: the entries of `base`
 * are `leaves` (so no verification directory and no new vault remain), and
 * the predecessor is unchanged. Returns the error.
 */
async function expectFidelityFailure(old, base, { leaves = ['face', 'out.compact-src'], ...opts } = {}) {
  const before = await predecessorState(old)
  let res = null
  let caught = null
  try {
    res = await compact(old, { toDir: join(base, 'face'), vaultDir: join(base, 'out'), initBundle: Bundle.init, ...opts })
  } catch (err) {
    caught = err
  }
  if (res) await res.vault.close()
  assert.ok(caught, 'compact returned ok:true; it must fail with COMPACT_FIDELITY')
  assert.equal(caught.code, 'COMPACT_FIDELITY', caught.stack)
  assert.ok(caught.differences.length > 0, 'COMPACT_FIDELITY must carry its differences')
  for (const d of caught.differences) assert.ok(caught.message.includes(d.path), `the message must name ${d.path}`)
  assert.deepEqual(await entries(base), leaves, 'a failed compaction left a verification directory or a partial out-dir')
  assert.deepEqual(await predecessorState(old), before, 'a failed compaction changed the predecessor')
  return caught
}

test('T13: the clean buildNonTrivial fixture passes the fidelity check, and compact reports its counts', async () => {
  const old = await Bundle.init(await tmpDir('fid-clean-vault'))
  await buildNonTrivial(old)
  const before = await predecessorState(old)
  const base = await tmpDir('fid-clean')
  const res = await compact(old, { toDir: join(base, 'face'), vaultDir: join(base, 'out'), initBundle: Bundle.init })
  assert.equal(res.ok, true)
  // A, B and C are live. D is tombstoned, so the face does not hold it.
  assert.deepEqual(res.counts, { walked: 3, staged: 3, ingested: 3 })
  assert.deepEqual(res.warnings, [])
  // The stage stays (T17 owns its lifetime). No verification directory stays.
  assert.deepEqual(await entries(base), ['face', 'out', 'out.compact-src'])
  assert.deepEqual(await predecessorState(old), before, 'compaction changed the predecessor')
  await old.close()
  await res.vault.close()
})

test('T14: concepts at dot-segment paths survive compaction and pass the T13 check (G24)', async () => {
  // scratch-D/s1.mjs scenario G. The stage walks the emission manifest of
  // the face, not the directory, and the compaction import ingests each
  // staged path. So the dot-path concepts reach the new vault.
  const old = await Bundle.init(await tmpDir('fid-dot-vault'))
  const r1 = await old.createConcept('.drafts/idea', 'note')
  await old.createConcept('notes/.hidden', 'note')
  await old.createConcept('notes/visible', 'note')
  await old.setBody(r1.tag, null, 'dot dir body')
  const before = await predecessorState(old)
  const base = await tmpDir('fid-dot')
  const res = await compact(old, { toDir: join(base, 'face'), vaultDir: join(base, 'out'), initBundle: Bundle.init })
  assert.equal(res.ok, true)
  assert.deepEqual(res.counts, { walked: 3, staged: 3, ingested: 3 })
  assert.deepEqual(res.warnings, [])
  // The three live concepts stay three, each with its _id at its path.
  const pathById = async (v) => new Map([...(await liveConcepts(v))].map(([id, c]) => [id, c.path]))
  const oldPaths = await pathById(old)
  assert.deepEqual([...oldPaths.values()].sort(), ['.drafts/idea', 'notes/.hidden', 'notes/visible'])
  assert.deepEqual(await pathById(res.vault), oldPaths)
  assert.equal((await liveConcepts(res.vault)).get(r1.tag).headText, 'dot dir body')
  assert.deepEqual(await entries(base), ['face', 'out', 'out.compact-src'])
  assert.deepEqual(await predecessorState(old), before, 'compaction changed the predecessor')
  await old.close()
  await res.vault.close()
})

test('T14: the stage excludes a reserved .okf- name with a warning, and the T13 check fails on it', async () => {
  // Core accepts the path notes/.okf-state, but the faces reserve the .okf-
  // dot-file names for their own state. The stage walks the note, warns,
  // and does not stage it. The face still holds it, so the check fails.
  const old = await Bundle.init(await tmpDir('fid-okf-vault'))
  await old.createConcept('notes/.okf-state', 'note')
  await old.createConcept('notes/visible', 'note')
  const err = await expectFidelityFailure(old, await tmpDir('fid-okf'))
  assert.deepEqual(err.differences, [
    { path: 'notes/.okf-state.md', kind: 'missing' },
    { path: 'notes/index.md', kind: 'differs' }
  ])
  assert.deepEqual(err.counts, { walked: 2, staged: 1, ingested: 1 })
  assert.deepEqual(err.warnings, [
    { kind: 'reserved', path: 'notes/.okf-state.md', message: 'a reserved .okf- dot-file name; not staged' }
  ])
  await old.close()
})

test('T14: the compaction import ingests a dot-segment path, and the ordinary ingest still ignores it (G24)', async () => {
  const files = new Map([
    ['.drafts/idea.md', '---\ntype: note\n---\n\ndot dir body\n'],
    ['notes/.hidden.md', '---\ntype: note\n---\n'],
    ['notes/visible.md', '---\ntype: note\n---\n'],
    ['notes/.okf-state.md', '---\ntype: note\n---\n'] // a reserved .okf- dot-file name
  ])
  const livePaths = async (v) => [...(await liveConcepts(v)).values()].map((c) => c.path).sort()

  // The ordinary watcher: ingestFile and scan() ignore every dot path (§9).
  const plainDir = await tmpDir('imp-plain')
  await writeTree(plainDir, files)
  const plain = await Bundle.init(await tmpDir('imp-plain-vault'))
  const watcher = await createIngestWatcher(plain, plainDir, { watch: false })
  assert.deepEqual(await watcher.ingestFile('.drafts/idea.md'), [])
  assert.deepEqual(await watcher.ingestFile('notes/.hidden.md'), [])
  await watcher.scan()
  await watcher.close()
  assert.deepEqual(await livePaths(plain), ['notes/visible'])

  // The compaction import: a dot-segment path is a concept path. A reserved
  // .okf- name stays out.
  const stageDir = await tmpDir('imp-stage')
  await writeTree(stageDir, files)
  const nu = await Bundle.init(await tmpDir('imp-stage-vault'))
  const imp = await createIngestWatcher(nu, stageDir, { watch: false })
  for (const rel of files.keys()) await imp.ingestFile(rel, { compaction: true })
  await imp.close()
  assert.deepEqual(await livePaths(nu), ['.drafts/idea', 'notes/.hidden', 'notes/visible'])
  const idea = [...(await liveConcepts(nu)).values()].find((c) => c.path === '.drafts/idea')
  assert.equal(idea.headText, 'dot dir body')

  await plain.close()
  await nu.close()
})

test('T14: the stage refuses a manifest path that leads out of the face, and writes nothing outside the stage', async () => {
  // The emission manifest is peer-local state in the face, so the stage
  // checks each path that it lists: lexical containment, then the real path,
  // so a symlink cannot lead out either. A walk of the directory never left it.
  const old = await Bundle.init(await tmpDir('fid-esc-vault'))
  await old.createConcept('notes/a', 'note')
  const outside = '---\n_id: 0123abcd\n_rev: ' + '1'.repeat(64) + '\ntype: note\n---\n\noutside the face\n'
  const manifest = (rel) => JSON.stringify({ files: { [rel]: '0'.repeat(64) } }) + '\n'

  // A listed path with a '..' segment.
  const up = await tmpDir('fid-esc-up')
  await writeTree(up, new Map([['outside.md', outside], ['face/.okf-manifest.json', manifest('../outside.md')]]))
  await assert.rejects(
    () => compact(old, { toDir: join(up, 'face'), vaultDir: join(up, 'out'), initBundle: Bundle.init }),
    (err) => err.code === 'UNSAFE_PATH'
  )
  assert.equal(await readFile(join(up, 'outside.md'), 'utf8'), outside, 'the stage wrote outside the stage')
  assert.deepEqual(await entries(up), ['face', 'out.compact-src', 'outside.md'])

  // A listed path that is a symlink to a file outside the face. The link
  // makes the face dirty, so only --force reaches the stage.
  const link = await tmpDir('fid-esc-link')
  await writeTree(link, new Map([['outside.md', outside], ['face/.okf-manifest.json', manifest('notes/a.md')]]))
  await mkdir(join(link, 'face', 'notes'))
  await symlink(join(link, 'outside.md'), join(link, 'face', 'notes', 'a.md'))
  await assert.rejects(
    () => compact(old, { toDir: join(link, 'face'), vaultDir: join(link, 'out'), initBundle: Bundle.init, force: true }),
    (err) => err.code === 'UNSAFE_PATH'
  )
  assert.deepEqual(await listFiles(join(link, 'out.compact-src')), [], 'the stage copied a file from outside the face')
  assert.deepEqual(await entries(link), ['face', 'out.compact-src', 'outside.md'])
  await old.close()
})

test('T13: an oversize note fails compaction with COMPACT_FIDELITY, and the oversize warning surfaces (G26)', async () => {
  // scratch-D/s7.mjs: the predecessor pins maxOpBytes 400000, and the ingest
  // checks a body against DEFAULT_LIMITS. T15 makes it pass.
  const old = await Bundle.init(await tmpDir('fid-big-vault'), { metadata: { limits: { maxOpBytes: 400000 } } })
  const a = await old.createConcept('big/report', 'note')
  await old.setBody(a.tag, null, 'x'.repeat(100000))
  const b = await old.createConcept('small/note', 'note')
  await old.setBody(b.tag, null, 'ok')
  const err = await expectFidelityFailure(old, await tmpDir('fid-big'))
  assert.ok(err.differences.some((d) => d.kind === 'missing' && d.path === 'big/report.md'), JSON.stringify(err.differences))
  assert.deepEqual(err.counts, { walked: 2, staged: 2, ingested: 1 })
  assert.ok(err.warnings.some((w) => w.kind === 'oversize' && w.path === 'big/report.md'), JSON.stringify(err.warnings))
  await old.close()
})

test('T15: a body of "text\\n\\n" round-trips byte for byte and passes the T13 check (G25)', async () => {
  // codex-D.out #9. renderNote ends every body with one file newline, and
  // parseNote removes exactly that one. So the face, the stage and the
  // ingest all keep the two trailing newlines of the body.
  const old = await Bundle.init(await tmpDir('fid-nl-vault'))
  const { tag } = await old.createConcept('notes/blank', 'note')
  await old.setBody(tag, null, 'text\n\n')
  const base = await tmpDir('fid-nl')
  const res = await compact(old, { toDir: join(base, 'face'), vaultDir: join(base, 'out'), initBundle: Bundle.init })
  assert.equal(res.ok, true)
  assert.deepEqual(res.counts, { walked: 1, staged: 1, ingested: 1 })
  assert.deepEqual(res.warnings, [])
  assert.equal((await liveConcepts(res.vault)).get(tag).headText, 'text\n\n')
  const face = await readFile(join(base, 'face', 'notes', 'blank.md'), 'utf8')
  assert.ok(face.endsWith('\ntype: note\n---\n\ntext\n\n\n'), JSON.stringify(face))
  const staged = await readFile(join(base, 'out.compact-src', 'notes', 'blank.md'), 'utf8')
  assert.equal(staged, face.replace(/^_rev: .*\n/m, ''), 'the stage changed the bytes of the note')
  await old.close()
  await res.vault.close()
})

// ---------- T15: body bytes and limits survive compaction ----------

test('T15: parseNote inverts renderNote for every body, trailing newlines included (G25)', () => {
  const pairs = [['type', 'note']]
  const bodies = ['', 'text', 'text\n', 'text\n\n', 'text\n\n\n', '\n', '\n\n', '\ntext', '\n\ntext\n\n', 'a\n\nb\n', 'a\r\n']
  for (const body of bodies) {
    assert.deepEqual(parseNote(renderNote(pairs, body)), { fm: { type: 'note' }, body, warnings: [] }, JSON.stringify(body))
  }
  // The layout: the frontmatter block, one blank separator line, the body,
  // and one file newline. A body without a trailing newline keeps the bytes
  // it had before T15. An empty body writes the frontmatter block only.
  assert.equal(renderNote(pairs, 'text'), '---\ntype: note\n---\n\ntext\n')
  assert.equal(renderNote(pairs, 'text\n'), '---\ntype: note\n---\n\ntext\n\n')
  assert.equal(renderNote(pairs, 'text\n\n'), '---\ntype: note\n---\n\ntext\n\n\n')
  assert.equal(renderNote(pairs, ''), '---\ntype: note\n---\n')
})

test('T15: a hand-written note with one trailing newline parses and ingests as before', async () => {
  // parseNote does not change in T15. It removes the blank separator line
  // and one file newline, so the body of this note is 'body text'. The
  // ordinary ingest stores that body, and materialize writes the note back
  // with the same bytes, plus the _id and _rev lines.
  const text = '---\ntype: note\n---\n\nbody text\n'
  assert.deepEqual(parseNote(text), { fm: { type: 'note' }, body: 'body text', warnings: [] })
  const dir = await tmpDir('hand-one')
  await writeTree(dir, new Map([['notes/hand.md', text]]))
  const v = await Bundle.init(await tmpDir('hand-one-vault'))
  const w = await createIngestWatcher(v, dir, { watch: false })
  const ops = await w.ingestFile('notes/hand.md')
  await w.close()
  assert.deepEqual(
    ops.map((o) => [o.type, o.payload.text]),
    [['create-concept', undefined], ['set-body', 'body text']]
  )
  const [concept] = (await liveConcepts(v)).values()
  assert.equal(concept.headText, 'body text')
  const out = await tmpDir('hand-one-out')
  await materialize(v, out)
  const back = await readFile(join(out, 'notes', 'hand.md'), 'utf8')
  assert.equal(back.replace(/^_id: .*\n_rev: .*\n/m, ''), text)
  await v.close()
})

test('T15: a hand-written body that ends in a newline keeps it through ingest and materialize (G25)', async () => {
  // The file ends in two newlines: one is the file newline, and one is the
  // body's. The ingest stores 'body text\n'. materialize writes the file
  // newline after it, so the note comes back with the same bytes, and a
  // second ingest of those bytes changes nothing.
  const text = '---\ntype: note\n---\n\nbody text\n\n'
  assert.equal(parseNote(text).body, 'body text\n')
  const dir = await tmpDir('hand-two')
  await writeTree(dir, new Map([['notes/hand.md', text]]))
  const v = await Bundle.init(await tmpDir('hand-two-vault'))
  const w = await createIngestWatcher(v, dir, { watch: false })
  await w.ingestFile('notes/hand.md')
  await w.close()
  const [concept] = (await liveConcepts(v)).values()
  assert.equal(concept.headText, 'body text\n')
  const out = await tmpDir('hand-two-out')
  await materialize(v, out)
  const back = await readFile(join(out, 'notes', 'hand.md'), 'utf8')
  assert.equal(back.replace(/^_id: .*\n_rev: .*\n/m, ''), text)
  assert.equal(parseNote(back).body, concept.headText, 'the materialized note parses to another body')
  await v.close()
})

test("T15: the new vault takes the predecessor's pinned limits, so a path deeper than the default survives (G26)", async () => {
  // The predecessor pins maxPathDepth 100, and holds a concept at depth 70.
  // The default is 64. A new vault with the default limits rejects that
  // path (depth-exceeded), so the concept is lost and the T13 check fails.
  const limits = { maxOpBytes: 400000, maxPathBytes: 2048, maxPathDepth: 100 }
  const old = await Bundle.init(await tmpDir('fid-lim-vault'), { metadata: { limits } })
  assert.deepEqual(old.metadata.limits, limits)
  const deep = Array.from({ length: 70 }, (_, i) => `d${i}`).join('/')
  const { tag } = await old.createConcept(deep, 'note')
  await old.createConcept('notes/a', 'note')
  const before = await predecessorState(old)
  const base = await tmpDir('fid-lim')
  const res = await compact(old, { toDir: join(base, 'face'), vaultDir: join(base, 'out'), initBundle: Bundle.init })
  assert.equal(res.ok, true)
  assert.deepEqual(res.counts, { walked: 2, staged: 2, ingested: 2 })
  assert.deepEqual(res.warnings, [])
  assert.deepEqual(res.vault.metadata.limits, old.metadata.limits)
  assert.equal((await liveConcepts(res.vault)).get(tag).path, deep)
  assert.deepEqual(await predecessorState(old), before, 'compaction changed the predecessor')
  await old.close()
  await res.vault.close()
})

test('T13: a note with truncated frontmatter YAML fails compaction with COMPACT_FIDELITY, and the parse warning surfaces (G27)', async () => {
  // compact materializes its own face, and materialize never writes a
  // truncated note. So the fixture is a face directory that already holds
  // the materialized bundle, with one note's frontmatter truncated (an
  // unclosed flow list). The edit makes the target dirty, so compact
  // refuses it with COMPACT_DIRTY_TARGET, and only --force reaches the
  // stage. The stage parse then fails, and the stage drops the note.
  const old = await Bundle.init(await tmpDir('fid-yaml-vault'))
  const { tag } = await old.createConcept('notes/a', 'note')
  await old.addTag(tag, 'one')
  await old.addTag(tag, 'two')
  await old.setBody(tag, null, 'body a')
  await old.createConcept('notes/b', 'note')
  await old.update()
  const base = await tmpDir('fid-yaml')
  const face = join(base, 'face')
  assert.equal((await materialize(old, face)).ok, true)
  const notePath = join(face, 'notes', 'a.md')
  const text = await readFile(notePath, 'utf8')
  assert.match(text, /^tags: \[one, two\]$/m)
  await writeFile(notePath, text.replace('tags: [one, two]', 'tags: [one, two'))

  await assert.rejects(
    () => compact(old, { toDir: face, vaultDir: join(base, 'out'), initBundle: Bundle.init }),
    (err) => err.code === 'COMPACT_DIRTY_TARGET'
  )
  const err = await expectFidelityFailure(old, base, { force: true })
  assert.ok(err.differences.some((d) => d.kind === 'missing' && d.path === 'notes/a.md'), JSON.stringify(err.differences))
  assert.deepEqual(err.counts, { walked: 2, staged: 1, ingested: 1 })
  assert.ok(err.warnings.some((w) => w.kind === 'parse' && w.path === 'notes/a.md'), JSON.stringify(err.warnings))
  assert.ok(err.warnings.some((w) => w.kind === 'no-frontmatter' && w.path === 'notes/a.md'), JSON.stringify(err.warnings))
  await old.close()
})

test('T13: a failed compaction keeps an out-dir that it did not create, and removes what it wrote there', async () => {
  // The face holds a note that materialize did not emit. The stage takes
  // only what materialize emitted, so the check fails on that note. The
  // note makes the face dirty, so only --force reaches the stage.
  const old = await Bundle.init(await tmpDir('fid-own-vault'))
  await old.createConcept('notes/a', 'note')
  const base = await tmpDir('fid-own')
  await mkdir(join(base, 'out'))
  await writeTree(join(base, 'face'), new Map([['notes/hand.md', '---\ntype: note\n---\n\nby hand\n']]))
  await expectFidelityFailure(old, base, { leaves: ['face', 'out', 'out.compact-src'], force: true })
  assert.deepEqual(await entries(join(base, 'out')), [], 'the failed compaction left its files in the out-dir')
  await old.close()
})

const BIN = join(ROOT, 'okf', 'cli', 'bin', 'auto-okf.js')

/** Run the auto-okf CLI; resolves { code, stdout, stderr }. */
function cli(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { cwd: ROOT, timeout: 90000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr })
    })
  })
}

test('T13: auto-okf compact reports the counts and the fidelity check on success', async () => {
  const base = await tmpDir('fid-cli-ok')
  const v = await Bundle.init(join(base, 'vault'))
  const { tag } = await v.createConcept('notes/one', 'note')
  await v.setBody(tag, null, 'one')
  await v.createConcept('notes/two', 'note')
  await v.update()
  await v.close()

  const r = await cli(['compact', join(base, 'vault'), join(base, 'out')])
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /^notes: +2 walked, 2 staged, 2 ingested$/m)
  assert.match(r.stdout, /^fidelity: +the new vault matches the face/m)
  assert.equal(r.stderr, '', 'a clean compaction prints no warning')
  assert.deepEqual(await entries(base), ['out', 'out.compact-src', 'out.face', 'vault'])
})

test('T13: auto-okf compact prints every difference and every warning, and exits 1 on COMPACT_FIDELITY', async () => {
  const base = await tmpDir('fid-cli-fail')
  const v = await Bundle.init(join(base, 'vault'), { metadata: { limits: { maxOpBytes: 400000 } } })
  const a = await v.createConcept('big/report', 'note')
  await v.setBody(a.tag, null, 'x'.repeat(100000))
  await v.createConcept('.drafts/idea', 'note')
  await v.createConcept('small/note', 'note')
  await v.update()
  await v.close()

  // run.js maps an error that is not a usage error to exit 1.
  const r = await cli(['compact', join(base, 'vault'), join(base, 'out')])
  assert.equal(r.code, 1, r.stdout + r.stderr)
  assert.match(r.stderr, /COMPACT_FIDELITY/)
  for (const line of ['missing big/report.md', 'missing big/index.md', 'differs index.md']) {
    assert.ok(r.stderr.includes(line), `stderr must name '${line}':\n${r.stderr}`)
  }
  // The dot-path concept is walked, staged and ingested, so no difference names it (T14).
  assert.ok(!r.stderr.includes('.drafts'), r.stderr)
  assert.match(r.stderr, /^warning: big\/report\.md: body is 100000 bytes; maxOpBytes is 65536; not ingested$/m)
  assert.match(r.stderr, /^notes: +3 walked, 3 staged, 2 ingested$/m)
  // No new vault and no verification directory remain. The face and the stage stay.
  assert.deepEqual(await entries(base), ['out.compact-src', 'out.face', 'vault'])
})
