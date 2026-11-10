import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, rename, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import {
  Bundle,
  materialize,
  wanted,
  parseNote,
  renderNote,
  checkOkfConformance,
  tmpDir,
  readBundle,
  bundleDiff,
  listFiles,
  treeHash,
  entries,
  pair,
  converged
} from './helpers.js'

/** Seed three concepts that link to each other. Returns their ids. */
async function seed(v) {
  const { tag: sales } = await v.createConcept('datasets/sales', 'BigQuery Dataset')
  await v.setField(sales, 'title', 'Sales')
  await v.setField(sales, 'description', 'All sales tables for the retail business.')
  await v.setBody(sales, null, 'Contains [orders](/tables/orders.md) and [customers](/tables/customers.md).')

  const { tag: orders } = await v.createConcept('tables/orders', 'BigQuery Table')
  await v.setField(orders, 'title', 'Orders')
  await v.addTag(orders, 'sales')
  await v.addTag(orders, 'revenue')
  await v.setBody(orders, null, 'One row per completed order. Part of [sales](/datasets/sales.md).')

  const { tag: top } = await v.createConcept('overview', 'Reference')
  await v.setField(top, 'title', 'Overview')
  await v.setBody(top, null, 'Start here.')
  await v.update()
  return { sales, orders, top }
}

test('I9: materialize is byte-deterministic across two runs of the same view', async () => {
  const v = await Bundle.init(await tmpDir('vault'))
  await seed(v)
  const dir1 = await tmpDir('bundle')
  const dir2 = await tmpDir('bundle')
  const r1 = await materialize(v, dir1)
  const r2 = await materialize(v, dir2)
  assert.ok(r1.ok && r2.ok)
  const diff = bundleDiff(await readBundle(dir1), await readBundle(dir2))
  assert.equal(diff, null, `bundles differ: ${diff}`)
  await v.close()
})

test('I9: materialize is byte-identical on a replicated peer', async () => {
  const a = await Bundle.init(await tmpDir('vault-a'))
  await seed(a)
  const b = await Bundle.join(await tmpDir('vault-b'), a.key)
  const unpair = pair(a, b)
  const h = await converged([a, b])
  assert.ok(h, 'peers did not converge')

  const dirA = await tmpDir('bundle-a')
  const dirB = await tmpDir('bundle-b')
  await materialize(a, dirA)
  await materialize(b, dirB)
  const diff = bundleDiff(await readBundle(dirA), await readBundle(dirB))
  assert.equal(diff, null, `peer bundles differ: ${diff}`)

  unpair()
  await a.close()
  await b.close()
})

test('I3, I9: materialize is byte-identical on a view rebuilt from the log', async () => {
  const dir = await tmpDir('vault')
  const a = await Bundle.init(dir)
  const ids = await seed(a)
  const dir1 = await tmpDir('bundle')
  await materialize(a, dir1)
  const before = await readBundle(dir1)
  await a.close()

  // Reopen from disk, so the view is refolded from the persisted log.
  const b = await Bundle.open(dir)
  await b.update()
  const dir2 = await tmpDir('bundle')
  await materialize(b, dir2)
  const diff = bundleDiff(before, await readBundle(dir2))
  assert.equal(diff, null, `rebuilt bundle differs: ${diff}`)
  assert.ok(ids.sales)
  await b.close()
})

test('the bundle that materialize writes passes the independent OKF v0.1 conformance check', async () => {
  const v = await Bundle.init(await tmpDir('vault'))
  await seed(v)
  const dir = await tmpDir('bundle')
  await materialize(v, dir)
  const res = await checkOkfConformance(dir)
  assert.ok(res.ok, 'conformance violations: ' + JSON.stringify(res.violations, null, 2))
  // Make sure that the checker saw concept files, index.md and log.md, so the pass is not vacuous.
  assert.ok(res.files.includes('index.md'))
  assert.ok(res.files.includes('log.md'))
  assert.ok(res.files.includes('datasets/sales.md'))
  await v.close()
})

test('frontmatter emission order is _id, _rev, type, then sorted keys (§6)', async () => {
  const v = await Bundle.init(await tmpDir('vault'))
  const { orders } = await seed(v)
  const dir = await tmpDir('bundle')
  await materialize(v, dir)
  const bundle = await readBundle(dir)
  const text = bundle.get('tables/orders.md')
  const fmLines = text.split('\n---\n')[0].replace(/^---\n/, '').split('\n').filter(Boolean)
  const keys = fmLines.map((l) => l.split(':')[0])
  assert.equal(keys[0], '_id')
  assert.equal(keys[1], '_rev')
  assert.equal(keys[2], 'type')
  const rest = keys.slice(3)
  assert.deepEqual(rest, [...rest].sort())
  assert.match(text, /tags: \[revenue, sales\]/)
  assert.ok(orders)
  await v.close()
})

test('root index.md carries okf_version and lists concepts then subdirs (OKF §6)', async () => {
  const v = await Bundle.init(await tmpDir('vault'))
  await seed(v)
  const dir = await tmpDir('bundle')
  await materialize(v, dir)
  const bundle = await readBundle(dir)
  const idx = bundle.get('index.md')
  assert.match(idx, /^---\nokf_version: "0.1"\n---\n\n# Contents\n/)
  const overviewPos = idx.indexOf('(overview.md)')
  const datasetsPos = idx.indexOf('(datasets/)')
  assert.ok(overviewPos > -1 && datasetsPos > -1 && overviewPos < datasetsPos)
  assert.ok(!bundle.get('datasets/index.md').startsWith('---'))
  await v.close()
})

test('log.md is # Update Log with ISO date headings newest-first (OKF §7)', async () => {
  const v = await Bundle.init(await tmpDir('vault'))
  await seed(v)
  const dir = await tmpDir('bundle')
  await materialize(v, dir)
  const log = (await readBundle(dir)).get('log.md')
  assert.match(log, /^# Update Log\n/)
  const dates = [...log.matchAll(/^## (.+)$/gm)].map((m) => m[1])
  for (const d of dates) assert.match(d, /^\d{4}-\d{2}-\d{2}$/)
  assert.deepEqual(dates, [...dates].sort().reverse())
  await v.close()
})

test('parseNote inverts renderNote for every body, trailing newlines included', () => {
  const pairs = [['type', 'note']]
  const bodies = ['', 'text', 'text\n', 'text\n\n', 'text\n\n\n', '\n', '\n\n', '\ntext', '\n\ntext\n\n', 'a\n\nb\n', 'a\r\n']
  for (const body of bodies) {
    assert.deepEqual(parseNote(renderNote(pairs, body)), { fm: { type: 'note' }, body, warnings: [] }, JSON.stringify(body))
  }
  // The layout: the frontmatter block, one blank line, the body, one file
  // newline. An empty body writes the frontmatter block only.
  assert.equal(renderNote(pairs, 'text'), '---\ntype: note\n---\n\ntext\n')
  assert.equal(renderNote(pairs, 'text\n'), '---\ntype: note\n---\n\ntext\n\n')
  assert.equal(renderNote(pairs, 'text\n\n'), '---\ntype: note\n---\n\ntext\n\n\n')
  assert.equal(renderNote(pairs, ''), '---\ntype: note\n---\n')
})

test('wanted() ranks unwritten concepts by referrer count (§4/§9)', async () => {
  const v = await Bundle.init(await tmpDir('vault'))
  const { tag: a } = await v.createConcept('a', 'Note')
  await v.setBody(a, null, 'See [hot](/hot.md) and [cold](/cold.md).')
  const { tag: b } = await v.createConcept('b', 'Note')
  await v.setBody(b, null, 'See [hot](/hot.md).')
  await v.update()
  const list = await wanted(v)
  assert.equal(list[0].path, 'hot')
  assert.equal(list[0].count, 2)
  assert.ok(list.some((w) => w.path === 'cold' && w.count === 1))
  assert.ok(list[0].count >= list[list.length - 1].count)
  await v.close()
})

// ---------- materialize writes inside the bundle directory only ----------

/** A vault's state: its full-view hash. */
async function vaultState(v) {
  await v.update()
  return v.snapshotHash()
}

test('a symlink in the face that leads out of it fails materialize by name before any change, and the files outside stay', async () => {
  // notes/ in the face is a symlink to a directory outside it, and the
  // concept moved. If materialize checks lexical containment only, it deletes
  // the files outside through the symlink.
  const base = await tmpDir('face-escape')
  const old = await Bundle.init(join(base, 'vault'))
  const { tag } = await old.createConcept('notes/a', 'note')
  await old.setBody(tag, null, 'outside victim content')
  await old.update()
  const face = join(base, 'face')
  assert.equal((await materialize(old, face)).ok, true)
  const outside = join(base, 'outside')
  await rename(join(face, 'notes'), outside)
  await symlink(outside, join(face, 'notes'))
  await old.setPath(tag, 'new/a')
  await old.update()
  const state = async () => ({
    outsideFiles: await listFiles(outside),
    outsideBytes: await treeHash(outside),
    faceEntries: await entries(face),
    faceBytes: await treeHash(face),
    vault: await vaultState(old)
  })
  const before = await state()
  assert.deepEqual(before.outsideFiles, ['a.md', 'index.md'])
  await assert.rejects(
    () => materialize(old, face),
    (err) => {
      assert.equal(err.code, 'UNSAFE_PATH', err.stack)
      assert.match(err.message, /'notes\/(a|index)\.md' resolves outside the bundle root/)
      return true
    }
  )
  assert.deepEqual(await state(), before, 'materialize changed the face, the files outside it or the vault')
  assert.deepEqual(await entries(base), ['face', 'outside', 'vault'])
  await old.close()

  // A write through a symlink: <face>/new leads outside the face. The mkdir
  // of a parent must not run before the real-path check.
  const base2 = await tmpDir('face-escape-write')
  const v = await Bundle.init(join(base2, 'vault'))
  await v.createConcept('new/sub/a', 'note')
  await v.update()
  const face2 = join(base2, 'face')
  const elsewhere = join(base2, 'elsewhere')
  await mkdir(elsewhere)
  await mkdir(face2)
  await symlink(elsewhere, join(face2, 'new'))
  await assert.rejects(
    () => materialize(v, face2),
    (err) => {
      assert.equal(err.code, 'UNSAFE_PATH', err.stack)
      assert.match(err.message, /'new\/(index|sub\/a|sub\/index)\.md' resolves outside the bundle root/)
      return true
    }
  )
  assert.deepEqual(await entries(elsewhere), [], 'materialize created something outside the face')
  assert.deepEqual(await entries(face2), ['new'], 'materialize wrote to the face')
  assert.deepEqual(await entries(base2), ['elsewhere', 'face', 'vault'])
  await v.close()
})
