// Vault metadata pinning (store scope item 2): written at init, loaded at
// open, canonical bytes identical across peers and input orderings (I2:
// metadata values are convergence-relevant apply inputs).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import {
  Vault,
  createMetadata,
  canonicalMetadataBytes,
  metadataHash,
  loadMetadata,
  METADATA_FILE,
  tmpDir,
  pair,
  until
} from './store-helpers.js'

const GEN = 'ab'.repeat(32)

test('metadata canonical bytes are independent of input key order', () => {
  const m1 = createMetadata({
    genesisKey: GEN,
    rootBase: 'vault://data/',
    rate: { capacity: 512, holdMax: 8, tokensPerIndexerOp: 2 },
    limits: { maxDepth: 32, maxOpBytes: 1024, maxSubjectBytes: 128 }
  })
  const m2 = createMetadata({
    limits: { maxSubjectBytes: 128, maxOpBytes: 1024, maxDepth: 32 },
    rate: { tokensPerIndexerOp: 2, holdMax: 8, capacity: 512 },
    rootBase: 'vault://data/',
    genesisKey: GEN
  })
  assert.equal(canonicalMetadataBytes(m1).toString(), canonicalMetadataBytes(m2).toString())
  assert.equal(metadataHash(m1), metadataHash(m2))
  // and sensitive to actual value changes
  const m3 = createMetadata({ genesisKey: GEN, rate: { capacity: 513 } })
  assert.notEqual(metadataHash(m1), metadataHash(m3))
})

test('metadata defaults mirror the core vault-metadata table', () => {
  const m = createMetadata({ genesisKey: GEN })
  assert.equal(m.rootBase, 'vault://data/')
  assert.deepEqual(m.hostAllowlist, ['tags', 'aliases', 'cssclasses'])
  assert.deepEqual(m.rate, { tokensPerIndexerOp: 1, capacity: 1024, holdMax: 64 })
  assert.deepEqual(m.limits, { maxSubjectBytes: 1024, maxOpBytes: 65536, maxDepth: 64 })
  assert.equal(m.schemaVersion, 1)
  assert.equal(m.encrypted, false)
})

test('metadata is written at init, loaded at open, and pinned to the vault key', async () => {
  const dir = await tmpDir('meta-init')
  const a = await Vault.init(dir, { metadata: { rate: { capacity: 256 } } })
  const onDisk = await loadMetadata(join(dir, METADATA_FILE))
  assert.ok(onDisk, 'metadata file written at init')
  assert.equal(onDisk.genesisKey, a.keyHex, 'genesisKey === vault key')
  assert.equal(onDisk.rate.capacity, 256, 'override pinned')
  assert.equal(metadataHash(onDisk), metadataHash(a.metadata))
  await a.close()

  const a2 = await Vault.open(dir)
  assert.equal(metadataHash(a2.metadata), metadataHash(onDisk), 'open loads identical metadata')
  await a2.close()
})

test('metadata is identical across peers of the same vault', async (t) => {
  const a = await Vault.init(await tmpDir('meta-a'), { metadata: { rate: { holdMax: 16 } } })
  const b = await Vault.join(await tmpDir('meta-b'), a.key, { metadata: { rate: { holdMax: 16 } } })
  t.after(async () => {
    unpair()
    await a.close()
    await b.close()
  })
  const unpair = pair(a, b)
  assert.equal(metadataHash(b.metadata), metadataHash(a.metadata))
  assert.equal(b.metadata.genesisKey, a.keyHex)
  await a.defineTerm('core', 'title', { '@id': 'ex:title' })
  assert.ok(await until(async () => {
    await b.update()
    return (await b.val('ctx/t/title')) !== undefined
  }), 'peers replicate under the shared pin')
})

test('a divergent invite or mismatched key is refused', async () => {
  const dir = await tmpDir('meta-refuse')
  const a = await Vault.init(dir)
  await a.close()

  // reopen with an invite that disagrees with the pinned document
  await assert.rejects(
    Vault.open(dir, { metadata: { rate: { capacity: 7 } } }),
    /VAULT_METADATA_MISMATCH/
  )
  // reopen against a different vault key than the pin
  await assert.rejects(
    Vault.open(dir, { key: 'cd'.repeat(32) }),
    /VAULT_KEY_MISMATCH/
  )
  // a re-supplied identical invite is fine
  const again = await Vault.open(dir, { metadata: {} })
  assert.equal(again.metadata.genesisKey, again.keyHex)
  await again.close()
})
