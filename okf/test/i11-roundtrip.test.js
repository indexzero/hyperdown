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
import assert from 'node:assert/strict'
import { mkdir, readdir, readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Bundle } from '../store/index.js'
import { materialize, compact, readView, readLog } from '../faces/index.js'
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

test('I11: --force carries a path-collision conflict copy across the generation (old path -> new path)', async () => {
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

  // ...and with force enumerates the carried-across conflict copy old -> new.
  const res = await compact(a, {
    toDir: await tmpDir('cc-face'),
    vaultDir: await tmpDir('cc-vault'),
    initBundle: Bundle.init,
    force: true
  })
  const nu = res.vault
  assert.equal(res.conflictCopies.length, 1, 'exactly one conflicted copy should be enumerated')
  const cc = res.conflictCopies[0]
  assert.match(cc.from, /^shared\/note\.conflict-[0-9a-f]{8,}\.md$/)
  assert.equal(cc.to, cc.from, 'identity + path preserved => conflict copy re-manifests at the same path')

  // The collision re-manifests in the new vault: one holder + one conflict copy.
  const newDir = await tmpDir('cc-new-bundle')
  await materialize(nu, newDir)
  const bundle = await readBundle(newDir)
  assert.ok(bundle.has('shared/note.md'), 'winner missing in new vault')
  assert.ok(
    [...bundle.keys()].some((k) => /shared\/note\.conflict-[0-9a-f]{8,}\.md$/.test(k)),
    'conflict copy did not re-manifest in the new vault'
  )

  unpair()
  await a.close()
  await b.close()
  await nu.close()
})
