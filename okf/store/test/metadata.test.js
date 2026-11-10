// Vault metadata: the pinned document is byte-identical across peers,
// appendOnly cannot be false, the generation derives from predecessorKey
// alone, and limits, rate and swarm are closed groups. The rules live in
// okf/store/lib/metadata.js.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, writeFile, readFile } from 'node:fs/promises'
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
} from './helpers.js'
import { validateMetadata, applyConfig } from '../index.js'

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

  assert.equal(a.metadata.appendOnly, true)
  assert.equal(b.metadata.appendOnly, true)
  // The generation chain is predecessorKey alone (SPEC §10). The metadata
  // holds no record of the state of the predecessor.
  assert.equal(a.metadata.predecessorKey, null)
  assert.ok(!('predecessorCheckpoint' in a.metadata), 'the metadata holds no predecessorCheckpoint')
  assert.equal(a.metadata.generation, ROOT_GENERATION)
  assert.equal(a.generation, ROOT_GENERATION)

  assert.equal(metadataHash(a.metadata), metadataHash(b.metadata))
  assert.deepEqual(
    canonicalMetadataBytes(a.metadata),
    canonicalMetadataBytes(b.metadata),
    'byte-identical metadata'
  )
  const onDiskA = await loadMetadata(join(dirA, METADATA_FILE))
  const onDiskB = await loadMetadata(join(dirB, METADATA_FILE))
  assert.equal(metadataHash(onDiskA), metadataHash(onDiskB))

  assert.equal(b.metadata.genesisKey, a.keyHex)
  assert.ok(
    await until(async () => {
      await b.update()
      return b.keyHex === a.keyHex
    })
  )
})

test('appendOnly is immutable: createMetadata refuses false, and Bundle.open refuses a metadata file that sets it false', async (t) => {
  assert.throws(
    () => createMetadata({ genesisKey: 'a'.repeat(64), appendOnly: false }),
    /appendOnly/
  )

  const dir = await tmpDir('meta-tamper')
  const v = await Bundle.init(dir)
  let reopened = null
  t.after(async () => {
    await v.close() // a no-op once the test has closed it
    if (reopened) await reopened.close()
  })
  await v.close()
  const path = join(dir, METADATA_FILE)
  const doc = JSON.parse(await readFile(path, 'utf8'))
  doc.appendOnly = false
  await writeFile(path, JSON.stringify(doc))
  await assert.rejects(async () => {
    reopened = await Bundle.open(dir)
  }, /appendOnly/)
})

test('a vault of this release writes rate with defaultCeiling as its only key', async (t) => {
  const dir = await tmpDir('meta-rate')
  const v = await Bundle.init(dir)
  await v.close()

  const path = join(dir, METADATA_FILE)
  const onDisk = JSON.parse(await readFile(path, 'utf8'))
  assert.deepEqual(onDisk.rate, { defaultCeiling: 1024 })

  assert.deepEqual(await loadMetadata(path), onDisk)
  const reopened = await Bundle.open(dir)
  t.after(() => reopened.close())
  assert.deepEqual(reopened.metadata.rate, { defaultCeiling: 1024 })

  assert.deepEqual(applyConfig(reopened.metadata).rate, { defaultCeiling: 1024 })
})

test('validateMetadata accepts a version 2 document whose rate holds only defaultCeiling', () => {
  const doc = {
    version: 2,
    genesisKey: 'a'.repeat(64),
    appendOnly: true,
    generation: ROOT_GENERATION,
    predecessorKey: null,
    limits: { maxOpBytes: 65536, maxPathBytes: 1024, maxPathDepth: 64 },
    rate: { defaultCeiling: 1024 },
    schemaVersion: 1,
    encrypted: false,
    swarm: { allow: [], genesis: null }
  }
  assert.equal(validateMetadata(doc), doc)
})

test('the swarm group is closed: allow is a sorted list of distinct 64-hex keys, and it is in the hash', () => {
  const k1 = '1'.repeat(64)
  const k2 = 'ab'.repeat(32)
  assert.deepEqual(createMetadata({ genesisKey: 'a'.repeat(64) }).swarm, { allow: [], genesis: null })
  assert.deepEqual(createMetadata({ genesisKey: 'a'.repeat(64), swarm: {} }).swarm, { allow: [], genesis: null })
  // createMetadata lowercases and sorts, so peers pin the same bytes
  const meta = createMetadata({
    genesisKey: 'a'.repeat(64),
    swarm: { allow: [k2.toUpperCase(), Buffer.from(k1, 'hex')] }
  })
  assert.deepEqual(meta.swarm, { allow: [k1, k2], genesis: null })
  assert.notEqual(
    metadataHash(meta),
    metadataHash(createMetadata({ genesisKey: 'a'.repeat(64) })),
    'the allowlist is part of the pinned hash'
  )

  const good = createMetadata({ genesisKey: 'a'.repeat(64) })
  const refused = [
    [{ ...good, swarm: undefined }, /metadata\.swarm must be an object/],
    [{ ...good, swarm: [] }, /metadata\.swarm must be an object/],
    [{ ...good, swarm: {} }, /metadata\.swarm\.allow must be an array of 64-char lowercase-hex keys/],
    [{ ...good, swarm: { allow: ['xyz'] } }, /metadata\.swarm\.allow must be an array of 64-char lowercase-hex keys/],
    [{ ...good, swarm: { allow: [k2.toUpperCase()] } }, /metadata\.swarm\.allow must be an array of 64-char lowercase-hex keys/],
    [{ ...good, swarm: { allow: [k2, k1] } }, /metadata\.swarm\.allow must be sorted and hold each key once/],
    [{ ...good, swarm: { allow: [k1, k1] } }, /metadata\.swarm\.allow must be sorted and hold each key once/],
    [{ ...good, swarm: { allow: [], genesis: null, extra: 1 } }, /metadata\.swarm\.extra is not a metadata version 2 field/]
  ]
  for (const [doc, re] of refused) assert.throws(() => validateMetadata(doc), re)
  assert.throws(
    () => createMetadata({ genesisKey: 'a'.repeat(64), swarm: { allow: [], extra: 1 } }),
    /metadata\.swarm\.extra is not a metadata version 2 field/,
    'no input can add a key to the group'
  )
  // A supplied list is never changed in silence.
  for (const [allow, re] of [
    ['not-an-array', /metadata\.swarm\.allow must be an array of swarm keys/],
    [null, /metadata\.swarm\.allow must be an array of swarm keys/],
    [{ 0: k1 }, /metadata\.swarm\.allow must be an array of swarm keys/],
    [['not-a-key'], /metadata\.swarm\.allow\[0\] is not a swarm key/],
    [[k1, Buffer.alloc(31)], /metadata\.swarm\.allow\[1\] is not a swarm key/],
    [[k2.toUpperCase(), k1, Buffer.from(k2, 'hex')], new RegExp(`metadata\\.swarm\\.allow lists the swarm key ${k2} twice`)]
  ]) {
    assert.throws(
      () => createMetadata({ genesisKey: 'a'.repeat(64), swarm: { allow } }),
      (err) => err.code === 'VAULT_BAD_SWARM_ALLOW' && re.test(err.message),
      `refused: ${JSON.stringify(allow)}`
    )
  }
  for (const swarm of [null, 'x', []]) {
    assert.throws(
      () => createMetadata({ genesisKey: 'a'.repeat(64), swarm }),
      /metadata\.swarm must be an object with an allow list/,
      `refused: swarm ${JSON.stringify(swarm)}`
    )
  }
})

test('swarm.genesis binds one key of the allowlist to genesisKey: null or a listed 64-hex key, and it is in the hash', async (t) => {
  const k1 = '1'.repeat(64)
  const k2 = 'ab'.repeat(32)
  const bound = createMetadata({ genesisKey: 'a'.repeat(64), swarm: { allow: [k1, k2], genesis: k2.toUpperCase() } })
  assert.deepEqual(bound.swarm, { allow: [k1, k2], genesis: k2 })
  assert.deepEqual(
    createMetadata({ genesisKey: 'a'.repeat(64), swarm: { allow: [k1], genesis: Buffer.from(k1, 'hex') } }).swarm,
    { allow: [k1], genesis: k1 }
  )
  assert.notEqual(
    metadataHash(bound),
    metadataHash(createMetadata({ genesisKey: 'a'.repeat(64), swarm: { allow: [k1, k2] } })),
    'the binding is part of the pinned hash'
  )
  for (const [genesis, re] of [
    ['xyz', /metadata\.swarm\.genesis is not a swarm key/],
    [Buffer.alloc(31), /metadata\.swarm\.genesis is not a swarm key/],
    [k2, /metadata\.swarm\.genesis must be one of metadata\.swarm\.allow/]
  ]) {
    assert.throws(
      () => createMetadata({ genesisKey: 'a'.repeat(64), swarm: { allow: [k1], genesis } }),
      re,
      `refused: genesis ${JSON.stringify(genesis)}`
    )
  }

  // validateMetadata requires the key: null or a listed key.
  const good = createMetadata({ genesisKey: 'a'.repeat(64), swarm: { allow: [k1] } })
  for (const [swarm, re] of [
    [{ allow: [k1] }, /metadata\.swarm\.genesis must be null or a 64-char lowercase-hex key/],
    [{ allow: [k1], genesis: 'xyz' }, /metadata\.swarm\.genesis must be null or a 64-char lowercase-hex key/],
    [{ allow: [k2], genesis: k2.toUpperCase() }, /metadata\.swarm\.genesis must be null or a 64-char lowercase-hex key/],
    [{ allow: [k1], genesis: k2 }, /metadata\.swarm\.genesis must be one of metadata\.swarm\.allow/]
  ]) {
    assert.throws(() => validateMetadata({ ...good, swarm }), re, `refused: ${JSON.stringify(swarm)}`)
  }

  // A creator binds its own swarm key, and the invite carries the binding.
  const dirA = await tmpDir('genesis-bind-a')
  const a = await Bundle.init(dirA, { metadata: { swarm: { allow: [k1] } } })
  t.after(() => a.close())
  const own = a.swarmKey.toString('hex')
  assert.deepEqual(a.metadata.swarm, { allow: [k1, own].sort(), genesis: own })
  assert.deepEqual((await loadMetadata(join(dirA, METADATA_FILE))).swarm.genesis, own)
  const b = await Bundle.join(await tmpDir('genesis-bind-b'), a.key, { metadata: a.metadata })
  t.after(() => b.close())
  assert.equal(b.metadata.swarm.genesis, own, 'a joiner pins the binding of the invite')
  // A joiner without the invite pins no binding.
  const keyOnly = await Bundle.join(await tmpDir('genesis-bind-key-only'), a.key)
  t.after(() => keyOnly.close())
  assert.equal(keyOnly.metadata.swarm.genesis, null)

  const dirC = await tmpDir('genesis-bind-other')
  await assert.rejects(
    Bundle.init(dirC, { metadata: { swarm: { allow: [k1], genesis: k1 } } }),
    (err) => err.code === 'VAULT_BAD_SWARM_GENESIS' && /names 1{64}, not the swarm key of the creator/.test(err.message)
  )
  await assert.rejects(access(join(dirC, METADATA_FILE)), 'nothing is pinned')
})

test('Bundle.init refuses a malformed metadata.swarm.allow by name, before it adds the creator key', async (t) => {
  // The test above holds the rules of the list. These two lists are the
  // ones that the creator key can hide: init cannot add a key to a list
  // that is not an array.
  const k1 = 'ab'.repeat(32)
  const cases = [
    [{ allow: 'not-an-array' }, /metadata\.swarm\.allow must be an array of swarm keys/],
    [{ allow: null }, /metadata\.swarm\.allow must be an array of swarm keys/]
  ]
  for (const [swarm, re] of cases) {
    const dir = await tmpDir('init-bad-allow')
    await assert.rejects(
      Bundle.init(dir, { metadata: { swarm } }),
      (err) => err.code === 'VAULT_BAD_SWARM_ALLOW' && re.test(err.message),
      `refused: ${JSON.stringify(swarm)}`
    )
    await assert.rejects(access(join(dir, METADATA_FILE)), `nothing is pinned for ${JSON.stringify(swarm)}`)
  }
  for (const swarm of [null, 'x']) {
    const dir = await tmpDir('init-bad-swarm')
    await assert.rejects(Bundle.init(dir, { metadata: { swarm } }), /metadata\.swarm must be an object with an allow list/)
    await assert.rejects(access(join(dir, METADATA_FILE)), `nothing is pinned for swarm ${JSON.stringify(swarm)}`)
  }

  // The empty default applies only when the field is absent.
  const bare = await Bundle.init(await tmpDir('init-no-allow'), { metadata: { swarm: {} } })
  t.after(() => bare.close())
  assert.deepEqual(bare.metadata.swarm.allow, [bare.swarmKey.toString('hex')], 'the creator key alone')

  // A fleet list can name the creator: its own key is no duplicate.
  const dir = await tmpDir('init-own-listed')
  const own = (await Bundle.readSwarmKey(dir)).toString('hex')
  const listed = await Bundle.init(dir, { metadata: { swarm: { allow: [k1, own] } } })
  t.after(() => listed.close())
  assert.deepEqual(listed.metadata.swarm.allow, [k1, own].sort())
})

test('limits and rate are closed: a key that metadata version 2 does not define is refused', async (t) => {
  assert.throws(
    () => createMetadata({ genesisKey: 'a'.repeat(64), rate: { extra: 1 } }),
    /metadata\.rate\.extra is not a metadata version 2 field/
  )
  assert.throws(
    () => createMetadata({ genesisKey: 'a'.repeat(64), limits: { extra: 1 } }),
    /metadata\.limits\.extra is not a metadata version 2 field/
  )

  const dir = await tmpDir('meta-closed')
  const v = await Bundle.init(dir)
  await v.close()
  const path = join(dir, METADATA_FILE)
  const doc = JSON.parse(await readFile(path, 'utf8'))
  doc.rate.extra = 1
  await writeFile(path, JSON.stringify(doc))
  await assert.rejects(() => loadMetadata(path), /metadata\.rate\.extra is not a metadata version 2 field/)
  await assert.rejects(() => Bundle.open(dir), /metadata\.rate\.extra is not a metadata version 2 field/)
})

test('version 2 metadata is a closed document: an unknown top-level key, the deleted predecessorCheckpoint too, is refused by name', async (t) => {
  const good = createMetadata({ genesisKey: 'a'.repeat(64) })
  for (const key of ['predecessorCheckpoint', 'extra']) {
    const re = new RegExp(`metadata\\.${key} is not a metadata version 2 field`)
    assert.throws(() => validateMetadata({ ...good, [key]: { seq: 0 } }), re, `validateMetadata: ${key}`)
    assert.throws(() => createMetadata({ genesisKey: 'a'.repeat(64), [key]: { seq: 0 } }), re, `createMetadata: ${key}`)
  }

  const re = /metadata\.predecessorCheckpoint is not a metadata version 2 field/
  const dir = await tmpDir('meta-top-closed')
  const v = await Bundle.init(dir)
  await v.close()
  const path = join(dir, METADATA_FILE)
  const doc = JSON.parse(await readFile(path, 'utf8'))
  await writeFile(path, JSON.stringify({ ...doc, predecessorCheckpoint: { seq: 0 } }))
  await assert.rejects(() => loadMetadata(path), re)
  await assert.rejects(() => Bundle.open(dir), re)

  const a = await Bundle.init(await tmpDir('meta-top-a'))
  t.after(() => a.close())
  const dirB = await tmpDir('meta-top-b')
  await assert.rejects(Bundle.join(dirB, a.key, { metadata: { ...a.metadata, predecessorCheckpoint: { seq: 0 } } }), re)
  await assert.rejects(access(join(dirB, METADATA_FILE)), 'nothing is pinned')
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

test('a directory that joined with the vault key alone refuses the invite later, by name, with the fix; any other difference stays VAULT_METADATA_MISMATCH', async (t) => {
  const a = await Bundle.init(await tmpDir('late-invite-a'))
  t.after(() => a.close())
  const dir = await tmpDir('late-invite-b')
  const b = await Bundle.join(dir, a.key) // the vault key alone
  assert.equal(b.metadata.swarm.genesis, null, 'it pins no binding of the creator')
  assert.deepEqual(b.metadata.swarm.allow, [], 'and no key of the invite')
  await b.close()

  const named = (err) =>
    err.code === 'VAULT_JOINED_WITHOUT_INVITE' &&
    /pinned metadata never changes; join again in a new directory with the invite/.test(err.message)
  await assert.rejects(Bundle.open(dir, { metadata: a.metadata }), named, 'Bundle.open with the invite')
  await assert.rejects(Bundle.join(dir, a.key, { metadata: a.metadata }), named, 'Bundle.join with the invite')
  await assert.rejects(
    Bundle.open(dir, { metadata: { limits: { maxPathBytes: 512 } } }),
    (err) => err.code === 'VAULT_METADATA_MISMATCH',
    'another difference'
  )
})

test('generation chain: predecessorKey alone pins a deterministic writer namespace (§10)', async (t) => {
  const predecessorKey = 'd'.repeat(64)

  const e1 = generationId(predecessorKey)
  assert.equal(e1, createHash('sha256').update(Buffer.from(predecessorKey, 'hex')).digest('hex'))
  assert.equal(generationId(Buffer.from(predecessorKey, 'hex')), e1, 'a key given as bytes derives the same id')
  assert.equal(generationId(predecessorKey.toUpperCase()), e1, 'a key given in upper case derives the same id')
  assert.notEqual(e1, ROOT_GENERATION)
  assert.equal(generationId(null), ROOT_GENERATION)

  assert.throws(
    () => createMetadata({ genesisKey: 'a'.repeat(64), predecessorKey: 'not-a-key' }),
    /metadata\.predecessorKey must be a 64-char lowercase-hex key/
  )

  // A new generation derives its writer cores under its own namespace, so
  // the vault key differs (SPEC §10).
  const dir = await tmpDir('meta-generation')
  const genesisVault = await Bundle.init(dir)
  const genesisKey = genesisVault.keyHex
  await genesisVault.close()

  const dir2 = await tmpDir('meta-generation') // fresh dir, generation-2 vault
  const next = await Bundle.init(dir2, { metadata: { predecessorKey } })
  t.after(() => next.close())
  assert.equal(next.metadata.predecessorKey, predecessorKey)
  assert.ok(!('predecessorCheckpoint' in next.metadata), 'the metadata holds no predecessorCheckpoint')
  assert.equal(next.metadata.generation, e1)
  assert.equal(next.generation, e1)
  assert.notEqual(next.keyHex, genesisKey)

  await next.close()
  const reopened = await Bundle.open(dir2)
  t.after(() => reopened.close())
  assert.equal(reopened.generation, e1)
  assert.equal(reopened.metadata.generation, e1)

  const path = join(dir2, METADATA_FILE)
  const doc = JSON.parse(await readFile(path, 'utf8'))
  doc.generation = generationId('e'.repeat(64))
  await writeFile(path, JSON.stringify(doc))
  await assert.rejects(() => loadMetadata(path), /metadata\.generation does not match its predecessorKey/)
})

test('a second generation in the same corestore directory gets a fresh writer key pair (§10)', async (t) => {
  // An operator re-inits in a reused directory. The per-generation
  // namespace must still give a fresh writer key pair (SPEC §10).
  const dir = await tmpDir('meta-reuse')
  const v1 = await Bundle.init(dir)
  const k1 = v1.keyHex
  await v1.close()

  // The operator archived the old vault and removed the pinned metadata.
  const { rm } = await import('node:fs/promises')
  await rm(join(dir, METADATA_FILE))
  const v2 = await Bundle.init(dir, { metadata: { predecessorKey: k1 } })
  t.after(() => v2.close())
  assert.notEqual(v2.keyHex, k1, 'writer keypair does not recur across generations')
  assert.equal(v2.metadata.predecessorKey, k1, 'chain recorded')
})
