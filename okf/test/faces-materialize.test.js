// @auto-okf/faces materialize on REAL @auto-okf/store vaults (autobee):
// byte-determinism (I9), OKF v0.1 conformance, frontmatter/index/log
// structure, and wanted/ ranking.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  Bundle,
  materialize,
  wanted,
  checkOkfConformance,
  tmpDir,
  readBundle,
  bundleDiff,
  pair,
  converged
} from './faces-helpers.js'

/** Seed a small, non-trivial bundle into a fresh vault. Returns ids. */
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

test('materialize is byte-deterministic across two runs of the same view (I9)', async () => {
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

test('materialize is byte-identical on a replicated peer (I9 convergence)', async () => {
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

test('materialize is byte-identical on a from-scratch rebuilt view (I3/I9)', async () => {
  const dir = await tmpDir('vault')
  const a = await Bundle.init(dir)
  const ids = await seed(a)
  const dir1 = await tmpDir('bundle')
  await materialize(a, dir1)
  const before = await readBundle(dir1)
  await a.close()

  // Reopen from disk (a full incremental re-fold from the persisted log).
  const b = await Bundle.open(dir)
  await b.update()
  const dir2 = await tmpDir('bundle')
  await materialize(b, dir2)
  const diff = bundleDiff(before, await readBundle(dir2))
  assert.equal(diff, null, `rebuilt bundle differs: ${diff}`)
  assert.ok(ids.sales)
  await b.close()
})

test('emitted bundle passes the independent OKF v0.1 conformance check', async () => {
  const v = await Bundle.init(await tmpDir('vault'))
  await seed(v)
  const dir = await tmpDir('bundle')
  await materialize(v, dir)
  const res = await checkOkfConformance(dir)
  assert.ok(res.ok, 'conformance violations: ' + JSON.stringify(res.violations, null, 2))
  // Sanity: the checker actually saw concept files, index.md and log.md.
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
  // remaining keys canonically (byte) sorted
  const rest = keys.slice(3)
  assert.deepEqual(rest, [...rest].sort())
  // tags OR-set emitted as a sorted flow list
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
  // 'overview.md' concept bullet appears before subdirectory bullets
  const overviewPos = idx.indexOf('(overview.md)')
  const datasetsPos = idx.indexOf('(datasets/)')
  assert.ok(overviewPos > -1 && datasetsPos > -1 && overviewPos < datasetsPos)
  // non-root index has NO frontmatter
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
  // newest-first: descending
  assert.deepEqual(dates, [...dates].sort().reverse())
  await v.close()
})

test('wanted() ranks unwritten concepts by referrer count (§4/§9)', async () => {
  const v = await Bundle.init(await tmpDir('vault'))
  // two concepts both link to the same unwritten target; one also links a
  // less-referenced target.
  const { tag: a } = await v.createConcept('a', 'Note')
  await v.setBody(a, null, 'See [hot](/hot.md) and [cold](/cold.md).')
  const { tag: b } = await v.createConcept('b', 'Note')
  await v.setBody(b, null, 'See [hot](/hot.md).')
  await v.update()
  const list = await wanted(v)
  assert.equal(list[0].path, 'hot')
  assert.equal(list[0].count, 2)
  assert.ok(list.some((w) => w.path === 'cold' && w.count === 1))
  // most-wanted first
  assert.ok(list[0].count >= list[list.length - 1].count)
  await v.close()
})
