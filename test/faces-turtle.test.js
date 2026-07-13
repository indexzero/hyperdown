// Faces scope item 3: exportTurtle(dir) — §10.1 layer partition from
// idx/spo range scans, §10.2 byte-determinism, §10.3 unmapped terms never
// exported, §10.4 vld:path roundtrip flag. Parsed with N3.js
// (https://github.com/rdfjs/N3.js), the standard maintained Turtle parser
// on npm (devDependency only).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Parser } from 'n3'
import { Vault, faces, tmpDir, seedVault, treeHash, readText, pair, converged } from './faces-helpers.js'

const { exportTurtle } = faces

async function parseLayer(dir, layer) {
  const text = await readFile(join(dir, layer + '.ttl'), 'utf8')
  return { text, quads: new Parser().parse(text) }
}

test('exportTurtle output parses with a standard Turtle parser (N3.js)', async (t) => {
  const v = await Vault.init(await tmpDir('ttl-parse-vault'))
  t.after(() => v.close())
  await seedVault(v)
  await v.setField('Home', 'servings', 4) // idempotent re-set
  await v.setBody('Pinned', null, 'a body with "quotes", a \\ backslash\nand a newline')
  await v.setField('Quoted', 'title', 'she said "hi" — with \t tabs')
  await v.update()

  const dir = await tmpDir('ttl-parse-out')
  const report = await exportTurtle(v, dir, { roundtrip: true })
  const schema = await parseLayer(dir, 'schema')
  const data = await parseLayer(dir, 'data')
  assert.equal(schema.quads.length, report.schema.triples, 'schema.ttl parses completely')
  assert.equal(data.quads.length, report.data.triples, 'data.ttl parses completely')
  assert.ok(schema.quads.length > 0 && data.quads.length > 0)

  // escaped literal round-trips through the parser
  const title = data.quads.find(
    (q) => q.subject.value === 'vault://data/Quoted' && q.predicate.value.endsWith('title')
  )
  assert.equal(title.object.value, 'she said "hi" — with \t tabs')
})

test('export is byte-deterministic across passes, rebuilds, and peers (I9)', async (t) => {
  const storage = await tmpDir('ttl-det-vault')
  let v = await Vault.init(storage)
  await seedVault(v)

  const d1 = await tmpDir('ttl-det-1')
  const d2 = await tmpDir('ttl-det-2')
  await exportTurtle(v, d1, { roundtrip: true })
  await exportTurtle(v, d2, { roundtrip: true })
  const h1 = await treeHash(d1)
  assert.equal(await treeHash(d2), h1, 'same view, identical bytes')

  const peer = await Vault.join(await tmpDir('ttl-det-peer'), v.key)
  const unpair = pair(v, peer)
  assert.ok(await converged([v, peer]))
  const d3 = await tmpDir('ttl-det-3')
  await exportTurtle(peer, d3, { roundtrip: true })
  assert.equal(await treeHash(d3), h1, 'converged peer exports identical bytes')
  unpair()
  await peer.close()

  await v.close()
  v = await Vault.open(storage)
  t.after(() => v.close())
  const d4 = await tmpDir('ttl-det-4')
  await exportTurtle(v, d4, { roundtrip: true })
  assert.equal(await treeHash(d4), h1, 'reopened store exports identical bytes')
})

test('layer partition: schema notes in schema.ttl, instances in data.ttl (§10.1)', async (t) => {
  const v = await Vault.init(await tmpDir('ttl-layer-vault'))
  t.after(() => v.close())
  await seedVault(v)
  const dir = await tmpDir('ttl-layer-out')
  await exportTurtle(v, dir)
  const schema = await parseLayer(dir, 'schema')
  const data = await parseLayer(dir, 'data')

  const schemaSubjects = new Set(schema.quads.map((q) => q.subject.value))
  const dataSubjects = new Set(data.quads.map((q) => q.subject.value))
  assert.ok(schemaSubjects.has('https://example.org/culinary#Recipe'), 'Recipe (Ontologies/ path) is schema')
  assert.ok(!dataSubjects.has('https://example.org/culinary#Recipe'), 'Recipe absent from data.ttl')
  assert.ok(dataSubjects.has('vault://data/Home'), 'Home is data')
  assert.ok(!schemaSubjects.has('vault://data/Home'), 'Home absent from schema.ttl')

  // rdf:type of the schema class, via the 'a' shorthand
  const typeQuad = schema.quads.find(
    (q) =>
      q.subject.value === 'https://example.org/culinary#Recipe' &&
      q.predicate.value === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
  )
  assert.equal(typeQuad.object.value, 'http://www.w3.org/2002/07/owl#Class')
  // '@type': '@id' term (subClassOf): string object exported as an IRI
  const sub = schema.quads.find((q) => q.predicate.value.endsWith('subClassOf'))
  assert.equal(sub.object.termType, 'NamedNode', "'@type': '@id' coerces strings to IRIs")
  assert.equal(sub.object.value, 'https://example.org/culinary#Food')
})

test('unmapped terms are never exported as triples but stay on the Markdown face (§10.3)', async (t) => {
  const v = await Vault.init(await tmpDir('ttl-unmapped-vault'))
  t.after(() => v.close())
  await seedVault(v)
  const ttlDir = await tmpDir('ttl-unmapped-out')
  await exportTurtle(v, ttlDir, { roundtrip: true })
  const data = await readText(ttlDir, 'data.ttl')
  assert.ok(!data.includes('mood'), 'unmapped term absent from Turtle (§10.3)')
  assert.ok(!data.includes('tags'), 'host key absent from Turtle (vault-ld §4.3)')

  const face = await tmpDir('ttl-unmapped-face')
  await faces.materialize(v, face)
  assert.match(await readText(face, 'Home.md'), /\nmood: blue\n/, 'still on the Markdown face')
})

test('wiki-link refs export as object IRIs; dangling targets use their minted IRI (§7)', async (t) => {
  const v = await Vault.init(await tmpDir('ttl-ref-vault'))
  t.after(() => v.close())
  await seedVault(v)
  await v.addMember('Home', 'topic', { ref: 'Nowhere Yet' })
  await v.update()
  const dir = await tmpDir('ttl-ref-out')
  await exportTurtle(v, dir)
  const data = await parseLayer(dir, 'data')
  const topics = data.quads.filter(
    (q) => q.subject.value === 'vault://data/Home' && q.predicate.value === 'https://example.org/culinary#topic'
  )
  const objects = topics.map((q) => [q.object.termType, q.object.value])
  assert.ok(
    objects.some(([t2, v2]) => t2 === 'NamedNode' && v2 === 'https://example.org/culinary#Recipe'),
    'existing ref -> subject IRI'
  )
  assert.ok(
    objects.some(([t2, v2]) => t2 === 'NamedNode' && v2 === 'vault://data/Nowhere%20Yet'),
    'dangling ref -> IRI minted in the data namespace (§7)'
  )
  assert.ok(
    objects.some(([t2, v2]) => t2 === 'Literal' && v2 === 'p2p'),
    'plain member stays a literal'
  )
})

test('roundtrip flag gates vld:path emission (§10.4)', async (t) => {
  const v = await Vault.init(await tmpDir('ttl-vld-vault'))
  t.after(() => v.close())
  await seedVault(v)
  const rt = await tmpDir('ttl-vld-rt')
  const q = await tmpDir('ttl-vld-q')
  await exportTurtle(v, rt, { roundtrip: true })
  await exportTurtle(v, q, { roundtrip: false })
  const rtData = await readText(rt, 'data.ttl')
  const qData = await readText(q, 'data.ttl')
  assert.ok(rtData.includes('vld:path "Notes/Deep/Pinned.md"'), 'roundtrip face carries vld:path')
  assert.ok(!qData.includes('vld:path'), 'query-only export omits vld:path')
  // Recipe sits at its reconstructable default -> no vld:path even in roundtrip
  const rtSchema = await readText(rt, 'schema.ttl')
  assert.ok(!rtSchema.includes('vld:path'), 'defaults omitted (§10.4)')
})
