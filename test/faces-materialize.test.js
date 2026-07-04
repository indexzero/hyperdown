// Faces scope item 1: materialize(dir) — Obsidian-compatible vault from
// the view, byte-deterministic (I9), path-safe (§9.4), suppressing
// tombstoned subjects (§9.2), emitting host/unmapped/id keys (§9.1/§5.6/
// §5.8) and the composed context.jsonld.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  Vault,
  K,
  faces,
  tmpDir,
  seedVault,
  treeHash,
  treeHashes,
  readText,
  pair,
  converged
} from './faces-helpers.js'

const { materialize, exportTurtle } = faces

test('materialize is byte-deterministic: same view, two dirs, two passes (I9)', async (t) => {
  const v = await Vault.init(await tmpDir('mat-det-vault'))
  t.after(() => v.close())
  await seedVault(v)

  const d1 = await tmpDir('mat-det-face1')
  const d2 = await tmpDir('mat-det-face2')
  const r1 = await materialize(v, d1)
  const r2 = await materialize(v, d2)
  assert.deepEqual(r1.unsafe, [], 'fixture subjects are all safe')
  assert.equal(await treeHash(d1), await treeHash(d2), 'two dirs, identical bytes')

  // a second pass over the same dir is a no-op with identical bytes
  const before = await treeHash(d1)
  const r3 = await materialize(v, d1)
  assert.equal(r3.written.length, 0, 'second pass writes nothing')
  assert.equal(r3.pendingIngest.length, 0)
  assert.equal(await treeHash(d1), before, 'bytes unchanged after second pass')
})

test('materialize on a rebuilt store and a replicated peer yields identical bytes (I9)', async (t) => {
  const storage = await tmpDir('mat-rebuild-vault')
  let v = await Vault.init(storage)
  await seedVault(v)
  const d1 = await tmpDir('mat-rebuild-face1')
  await materialize(v, d1)
  const h1 = await treeHash(d1)

  // a fresh peer that replicates the whole log (rebuilt view)
  const peer = await Vault.join(await tmpDir('mat-rebuild-peer'), v.key)
  const unpair = pair(v, peer)
  assert.ok(await converged([v, peer]), 'peer converges to the same view hash')
  const d2 = await tmpDir('mat-rebuild-face2')
  await materialize(peer, d2)
  assert.equal(await treeHash(d2), h1, 'replicated peer materializes identical bytes')
  unpair()
  await peer.close()

  // reopen-from-disk (autobee relinearizes from the stored cores)
  await v.close()
  v = await Vault.open(storage)
  t.after(() => v.close())
  const d3 = await tmpDir('mat-rebuild-face3')
  await materialize(v, d3)
  assert.equal(await treeHash(d3), h1, 'reopened store materializes identical bytes')
})

test('materialized vault has the Obsidian/vault-ld shape (§9.1)', async (t) => {
  const v = await Vault.init(await tmpDir('mat-shape-vault'))
  t.after(() => v.close())
  await seedVault(v)
  const dir = await tmpDir('mat-shape-face')
  await materialize(v, dir)

  // context.jsonld: valid JSON, @context with @base, prefix, and terms
  const ctx = JSON.parse(await readText(dir, 'context.jsonld'))
  assert.equal(ctx['@context']['@base'], 'vault://data/')
  assert.equal(ctx['@context'].cul, 'https://example.org/culinary#')
  assert.deepEqual(ctx['@context'].type, { '@id': '@type' }, 'keyword alias declared')
  assert.equal(ctx['@context'].topic['@container'], '@set')

  // instance note at the context root, schema note at its vault-ld §5.1 path
  const home = await readText(dir, 'Home.md')
  assert.match(home, /^---\n/, 'frontmatter fence')
  assert.match(home, /\ntitle: Welcome home\n/, 'lww scalar')
  assert.match(home, /\nservings: 4\n/, 'canonical integer scalar')
  assert.match(home, /\ntopic: \["\[\[Recipe\]\]", p2p\]\n/, 'or-set flow array with wiki link')
  assert.match(home, /\ntags: \[demo, wiki\]\n/, 'host key round-trips (§5.6)')
  assert.match(home, /\nmood: blue\n/, 'unmapped key round-trips (§5.6/§10.3)')
  assert.match(home, /\n---\n\nHello \*\*world\*\*\n$/, 'body from head revision')
  // canonical ordering: keys sorted
  const keys = [...home.matchAll(/^([A-Za-z@][^:\n]*):/gm)].map((m) => m[1])
  assert.deepEqual(keys, [...keys].sort(), 'frontmatter keys canonically sorted')

  const recipe = await readText(dir, 'Ontologies/culinary/Classes/Recipe.md')
  assert.match(recipe, /\ntype: \["owl:Class"\]\n/, 'aliased @type spelling (vault-ld §4.3)')

  // pinned note at its authored path (§9.3)
  assert.ok(existsSync(join(dir, 'Notes/Deep/Pinned.md')), 'authored path honored')
})

test('explicit @id is emitted verbatim and deleted subjects are suppressed (§5.8/§9.2)', async (t) => {
  const v = await Vault.init(await tmpDir('mat-id-vault'))
  t.after(() => v.close())
  await seedVault(v)
  await v.setField('Alias', 'id', 'https://elsewhere.example/thing/42')
  await v.setField('Alias', 'title', 'explicitly identified')
  await v.setField('Doomed', 'title', 'to be deleted')
  await v.append('delete-subject', { s: 'Doomed' })
  await v.update()

  const dir = await tmpDir('mat-id-face')
  await materialize(v, dir)
  const alias = await readText(dir, 'Alias.md')
  assert.match(alias, /\nid: "https:\/\/elsewhere\.example\/thing\/42"\n/, 'id: emitted verbatim under its alias')
  assert.ok(!existsSync(join(dir, 'Doomed.md')), 'tombstoned subject not materialized')
})

test('adversarial containment: ../escape and unsafe SetPath never write outside root (§9.4)', async (t) => {
  const v = await Vault.init(await tmpDir('mat-adv-vault'))
  t.after(() => v.close())
  await v.defineTerm('core', 'title', { '@id': 'ex:title' })
  await v.setField('../escape', 'title', 'evil subject')
  await v.setField('..', 'title', 'evil subject 2')
  await v.setField('a\\b', 'title', 'backslash subject')
  await v.append('set-path', { s: 'Sneaky', path: '../outside', scope: null })
  await v.setField('Sneaky', 'title', 'op-level escape rejected by apply')
  await v.update()

  // apply-side: unsafe SetPath rejected under §8.4 reason 'unsafe-path'
  const rejections = []
  for await (const { value } of v.scan('flag/rejected/')) rejections.push(value)
  assert.ok(
    rejections.some((r) => r.reason === 'unsafe-path'),
    'unsafe SetPath left a flag/rejected record (reason unsafe-path)'
  )

  const parent = await tmpDir('mat-adv-parent')
  const dir = join(parent, 'face')
  const report = await materialize(v, dir)
  const reasons = Object.fromEntries(report.unsafe.map((u) => [u.subject, u.reason]))
  assert.ok(reasons['../escape'], '../escape skipped')
  assert.ok(reasons['..'], '.. skipped')
  assert.ok(reasons['a\\b'], 'backslash subject skipped')
  assert.ok(!existsSync(join(parent, 'escape.md')), 'nothing written outside the face root')
  assert.ok(!existsSync(join(parent, 'outside.md')), 'rejected SetPath never materialized')
  // Sneaky itself (no accepted path) is a plain root note
  assert.ok(existsSync(join(dir, 'Sneaky.md')))
})

test('case-insensitive collisions keep one deterministic winner (§9.4 (d))', async (t) => {
  const v = await Vault.init(await tmpDir('mat-case-vault'))
  t.after(() => v.close())
  await v.defineTerm('core', 'title', { '@id': 'ex:title' })
  await v.setField('Note', 'title', 'upper')
  await v.setField('note', 'title', 'lower')
  await v.update()

  const d1 = await tmpDir('mat-case-face1')
  const r1 = await materialize(v, d1)
  assert.equal(r1.unsafe.length, 1, 'exactly one collision loser skipped')
  assert.match(r1.unsafe[0].reason, /^case-collision:/)
  const d2 = await tmpDir('mat-case-face2')
  const r2 = await materialize(v, d2)
  assert.deepEqual(r1.unsafe, r2.unsafe, 'deterministic loser')
  assert.equal(await treeHash(d1), await treeHash(d2))
})

test('turtle files and manifest are part of no note walk (bookkeeping stays out of the face)', async (t) => {
  const v = await Vault.init(await tmpDir('mat-clean-vault'))
  t.after(() => v.close())
  await seedVault(v)
  const dir = await tmpDir('mat-clean-face')
  await materialize(v, dir)
  const rels = [...(await treeHashes(dir)).keys()]
  assert.ok(rels.every((r) => r.endsWith('.md') || r === 'context.jsonld' || r === '.vld-manifest.json'))
  // no seen/, rate/, hold, flag rows leak into file names
  assert.ok(!rels.some((r) => r.startsWith('seen') || r.startsWith('rate') || r.includes('hold')))
})
