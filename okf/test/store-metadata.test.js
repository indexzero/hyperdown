// Store scope (okf SPEC §13, T4): vault-metadata determinism — the pinned
// document is byte-identical across peers (incl. the §8 appendOnly
// constant and the §10 generation-chain fields), the appendOnly constant is
// immutable (unrepresentable off and refused at open when tampered), and
// the per-generation writer namespace derives deterministically from the
// predecessor fields.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  Bundle,
  createMetadata,
  metadataHash,
  canonicalMetadataBytes,
  loadMetadata,
  generationId,
  METADATA_FILE,
  ROOT_GENERATION,
  tmpDir,
  pair,
  until
} from './store-helpers.js'

test('vault metadata is deterministic and identical across peers', async (t) => {
  const dirA = await tmpDir('meta-a')
  const a = await Bundle.init(dirA)
  const dirB = await tmpDir('meta-b')
  // the invite carries the full pinned document
  const b = await Bundle.join(dirB, a.key, { metadata: a.metadata })
  const unpair = pair(a, b)
  t.after(async () => {
    unpair()
    await a.close()
    await b.close()
  })

  // §8: the appendOnly constant, written at init, loaded at open
  assert.equal(a.metadata.appendOnly, true)
  assert.equal(b.metadata.appendOnly, true)
  // §10: generation-chain fields identical (root vault: both null)
  assert.equal(a.metadata.predecessorKey, null)
  assert.equal(a.metadata.predecessorCheckpoint, null)
  assert.equal(a.metadata.generation, ROOT_GENERATION)
  assert.equal(a.generation, ROOT_GENERATION)

  // cross-peer pin: same canonical bytes, same hash, on disk and in memory
  assert.equal(metadataHash(a.metadata), metadataHash(b.metadata))
  assert.deepEqual(
    canonicalMetadataBytes(a.metadata),
    canonicalMetadataBytes(b.metadata),
    'byte-identical metadata'
  )
  const onDiskA = await loadMetadata(join(dirA, METADATA_FILE))
  const onDiskB = await loadMetadata(join(dirB, METADATA_FILE))
  assert.equal(metadataHash(onDiskA), metadataHash(onDiskB))

  // a peer that replicated is pinned to the same genesis/vault key
  assert.equal(b.metadata.genesisKey, a.keyHex)
  assert.ok(
    await until(async () => {
      await b.update()
      return b.keyHex === a.keyHex
    })
  )
})

test('appendOnly is immutable: unrepresentable off, refused when tampered', async (t) => {
  // §8: no input can construct an appendOnly:false document
  assert.throws(
    () => createMetadata({ genesisKey: 'a'.repeat(64), appendOnly: false }),
    /appendOnly/
  )

  // a tampered on-disk document cannot open
  const dir = await tmpDir('meta-tamper')
  const v = await Bundle.init(dir)
  await v.close()
  const path = join(dir, METADATA_FILE)
  const doc = JSON.parse(await readFile(path, 'utf8'))
  doc.appendOnly = false
  await writeFile(path, JSON.stringify(doc))
  await assert.rejects(() => Bundle.open(dir), /appendOnly/)
})

test('a mismatched invite is refused (metadata is convergence-relevant)', async (t) => {
  const dir = await tmpDir('meta-invite')
  const v = await Bundle.init(dir)
  await v.close()
  await assert.rejects(
    () => Bundle.open(dir, { metadata: { limits: { maxPathBytes: 512 } } }),
    (err) => err.code === 'VAULT_METADATA_MISMATCH'
  )
})

test('generation chain: predecessor fields pin a deterministic writer namespace (§10)', async (t) => {
  const checkpoint = {
    viewHash: '1'.repeat(64),
    writerLengths: [['a'.repeat(64), 12]],
    signer: 'b'.repeat(64),
    signature: 'c'.repeat(128)
  }
  const predecessorKey = 'd'.repeat(64)

  // the generation id is a pure function of the predecessor fields
  const e1 = generationId(predecessorKey, checkpoint)
  const e2 = generationId(predecessorKey, checkpoint)
  assert.equal(e1, e2)
  assert.notEqual(e1, ROOT_GENERATION)
  assert.match(e1, /^[0-9a-f]{64}$/)

  // half a chain is invalid
  assert.throws(() => generationId(predecessorKey, null), /together/)
  assert.throws(
    () => createMetadata({ genesisKey: 'a'.repeat(64), predecessorKey }),
    /together/
  )

  // a fresh vault records the chain and derives its writer cores under the
  // per-generation namespace: same directory, different generation → different vault
  // (writer) key — the §10 keypair-freshness guarantee
  const dir = await tmpDir('meta-generation')
  const genesisVault = await Bundle.init(dir)
  const genesisKey = genesisVault.keyHex
  await genesisVault.close()

  const dir2 = await tmpDir('meta-generation') // fresh dir, generation-2 vault
  const next = await Bundle.init(dir2, {
    metadata: { predecessorKey, predecessorCheckpoint: checkpoint }
  })
  t.after(() => next.close())
  assert.equal(next.metadata.predecessorKey, predecessorKey)
  assert.deepEqual(next.metadata.predecessorCheckpoint, checkpoint)
  assert.equal(next.metadata.generation, e1)
  assert.equal(next.generation, e1)
  assert.notEqual(next.keyHex, genesisKey)

  // reopen from disk restores the same generation and key
  await next.close()
  const reopened = await Bundle.open(dir2)
  t.after(() => reopened.close())
  assert.equal(reopened.generation, e1)
  assert.equal(reopened.metadata.generation, e1)
})

test('same corestore directory, different generations → fresh writer keypairs (§10)', async (t) => {
  // the hazard §10 names: an operator re-inits in a REUSED directory; the
  // per-generation namespace must still yield a fresh local writer keypair
  const dir = await tmpDir('meta-reuse')
  const v1 = await Bundle.init(dir)
  const k1 = v1.keyHex
  await v1.close()

  // simulate the generation cycle re-using the directory: remove the pinned
  // metadata (operator archived the old vault), init with a predecessor
  const { rm } = await import('node:fs/promises')
  await rm(join(dir, METADATA_FILE))
  const v2 = await Bundle.init(dir, {
    metadata: {
      predecessorKey: k1,
      predecessorCheckpoint: { viewHash: '0'.repeat(64), writerLengths: [[k1, 1]] }
    }
  })
  t.after(() => v2.close())
  assert.notEqual(v2.keyHex, k1, 'writer keypair does not recur across generations')
  assert.equal(v2.metadata.predecessorKey, k1, 'chain recorded')
})
