// §9.4 race safety: materialize and ingest coordinate through per-path
// in-flight locks and the manifest hash check — a human edit is never
// clobbered by regeneration, a held lock serializes the check+rename
// critical section, and the real fs.watch pipeline (debounce +
// write-settle) turns disk edits into ops.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Vault, K, faces, tmpDir, seedVault, treeHash, readText, captureOps, until, sleep } from './faces-helpers.js'
import { rootRegistry, withPathLock } from '../vault-ld/faces/lib/fsatomic.js'

const { materialize, createIngestWatcher } = faces

test('materialize never clobbers an unsaved human edit (§9.4)', async (t) => {
  const v = await Vault.init(await tmpDir('race-clobber-vault'))
  t.after(() => v.close())
  await seedVault(v)
  const dir = await tmpDir('race-clobber-face')
  await materialize(v, dir)

  // a human edit lands between materializations (non-canonical spacing so
  // the bytes can never coincide with regenerated canonical bytes)
  const edited = (await readText(dir, 'Home.md')).replace(
    'title: Welcome home',
    'title:    precious human words'
  )
  await writeFile(join(dir, 'Home.md'), edited)

  // a concurrent view change to ANOTHER note, then materialize again:
  // the edited file is skipped, the other note regenerates
  await v.setField('Pinned', 'title', 'pinned v2')
  await v.update()
  const report = await materialize(v, dir)
  assert.ok(report.pendingIngest.includes('Home.md'), 'edited file reported for ingest, not overwritten')
  assert.equal(await readText(dir, 'Home.md'), edited, 'authored bytes untouched')
  assert.ok(report.written.includes('Notes/Deep/Pinned.md'), 'unedited files still regenerate')

  // the documented recovery: ingest first, then materialize
  const w = await createIngestWatcher(v, dir, { watch: false })
  t.after(() => w.close())
  await w.ingestFile('Home.md')
  await v.update()
  const r2 = await materialize(v, dir)
  assert.ok(r2.written.includes('Home.md'), 'after ingest the file regenerates canonically')
  const final = await readText(dir, 'Home.md')
  assert.match(final, /title: precious human words/, 'the human edit survived the full cycle')
  assert.match(await readText(dir, 'Notes/Deep/Pinned.md'), /pinned v2/)
})

test('the per-path in-flight lock serializes materialize against ingest (§9.4)', async (t) => {
  const v = await Vault.init(await tmpDir('race-lock-vault'))
  t.after(() => v.close())
  await seedVault(v)
  const dir = await tmpDir('race-lock-face')
  await materialize(v, dir)
  await v.setField('Home', 'title', 'lock test')
  await v.update()

  const { registry } = await rootRegistry(dir)
  let release
  const gate = new Promise((r) => (release = r))
  const order = []
  // hold Home.md's lock: materialize must queue behind it
  const holder = withPathLock(registry, 'Home.md', async () => {
    await gate
    order.push('lock-released')
  })
  const run = materialize(v, dir).then((rep) => {
    order.push('materialize-done')
    return rep
  })
  await sleep(150)
  assert.deepEqual(order, [], 'materialize blocked while the path lock is held')
  release()
  await holder
  const rep = await run
  assert.deepEqual(order, ['lock-released', 'materialize-done'], 'strict serialization')
  assert.ok(rep.written.includes('Home.md'))
})

test('concurrent materialize passes and ingest scans reach a consistent fixed point', async (t) => {
  const v = await Vault.init(await tmpDir('race-mix-vault'))
  t.after(() => v.close())
  await seedVault(v)
  const dir = await tmpDir('race-mix-face')
  await materialize(v, dir)
  const w = await createIngestWatcher(v, dir, { watch: false })
  t.after(() => w.close())

  // interleave: view writes, human edits, materialize and scans, all racing
  await Promise.all([
    materialize(v, dir),
    w.scan(),
    (async () => {
      await v.setField('Home', 'servings', 8)
      await v.update()
    })(),
    (async () => {
      await sleep(10)
      const cur = await readText(dir, 'Home.md')
      await writeFile(join(dir, 'Home.md'), cur.replace('Welcome home', 'racing edit'))
    })(),
    materialize(v, dir)
  ])

  // settle: ingest whatever is pending, then materialize to the fixed point
  await w.scan()
  await v.update()
  await materialize(v, dir)
  const quiescent = await w.scan()
  assert.equal(quiescent.length, 0, 'nothing left to ingest')
  const before = await treeHash(dir)
  const rep = await materialize(v, dir)
  assert.equal(rep.written.length, 0)
  assert.equal(rep.pendingIngest.length, 0)
  assert.equal(await treeHash(dir), before, 'stable bytes')
  const home = await readText(dir, 'Home.md')
  assert.match(home, /racing edit/, 'the human edit was ingested, not lost')
  // NOTE: no assertion on `servings` — the human edit carried the whole
  // frontmatter it observed, so whichever of {file's 4, concurrent 8} was
  // diffed LAST wins the LWW register (§5.4/§9.2: whole-field diff). Race
  // safety here means neither outcome loses bytes or diverges, not that a
  // particular interleaving wins.
  assert.match(home, /servings: [48]/, 'servings is one of the two racing values')
  // the file reflects exactly the view (fixed point == projection)
  const reg = await v.val(K.nField('Home', 'servings'))
  assert.match(home, new RegExp(`servings: ${reg.reg.values[0]}`), 'face matches the view register')
})

test('the real fs.watch pipeline ingests a disk edit (debounce + write-settle)', async (t) => {
  const v = await Vault.init(await tmpDir('race-watch-vault'))
  t.after(() => v.close())
  await seedVault(v)
  const dir = await tmpDir('race-watch-face')
  await materialize(v, dir)

  const w = await createIngestWatcher(v, dir, { debounce: 50, settle: 25 })
  t.after(() => w.close())
  const ops = captureOps(w)
  const events = []
  w.on('ops', (e) => events.push(e))
  w.on('error', (err) => events.push({ error: err }))

  const home = await readText(dir, 'Home.md')
  await writeFile(join(dir, 'Home.md'), home.replace('title: Welcome home', 'title: watched edit'))

  assert.ok(
    await until(() => ops.some((o) => o.type === 'set-field' && o.payload.o === 'watched edit'), 15000),
    'fs.watch delivered the edit as a SetField op'
  )
  await v.update()
  assert.deepEqual((await v.val(K.nField('Home', 'title'))).reg.values, ['watched edit'])

  // the system's own materialize writes are NOT echoed back as ops
  const opCount = ops.length
  await materialize(v, dir)
  await sleep(500) // give fs.watch time to deliver (and the watcher to skip)
  assert.equal(ops.length, opCount, 'self-writes suppressed (manifest hash), no echo ops')
})
