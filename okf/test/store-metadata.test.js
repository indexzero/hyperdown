// Store scope (okf SPEC §13, T4): vault-metadata determinism — the pinned
// document is byte-identical across peers (incl. the §8 appendOnly
// constant and the §10 predecessorKey), the appendOnly constant is
// immutable (unrepresentable off and refused at open when tampered), and
// the per-generation writer namespace derives deterministically from
// predecessorKey alone (T24). The rate group holds defaultCeiling only
// (T6c), and limits and rate refuse a key that version 2 does not define.
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
} from './store-helpers.js'
import { validateMetadata, applyConfig } from '../store/index.js'

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
  // §10: the generation chain is predecessorKey alone (root vault: null).
  // The metadata holds no record of the predecessor's state (T24).
  assert.equal(a.metadata.predecessorKey, null)
  assert.ok(!('predecessorCheckpoint' in a.metadata), 'the metadata holds no predecessorCheckpoint')
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

  // the pinned document on disk
  const path = join(dir, METADATA_FILE)
  const onDisk = JSON.parse(await readFile(path, 'utf8'))
  assert.deepEqual(onDisk.rate, { defaultCeiling: 1024 })

  // it validates: loadMetadata and a reopen accept it as written
  assert.deepEqual(await loadMetadata(path), onDisk)
  const reopened = await Bundle.open(dir)
  t.after(() => reopened.close())
  assert.deepEqual(reopened.metadata.rate, { defaultCeiling: 1024 })

  // core gets the same rate slice
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

test('the swarm group is closed: allow is a sorted list of distinct 64-hex keys, and it is in the hash (T25)', () => {
  const k1 = '1'.repeat(64)
  const k2 = 'ab'.repeat(32)
  // the default is an empty allowlist and no bound creator key, when the
  // fields are absent
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

  // validateMetadata refuses every other shape
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
  // G3-P9 F04: a supplied list is never changed in silence. A value that is
  // not an array, a bad key and a key listed twice are refused by name.
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

test('swarm.genesis binds one key of the allowlist to genesisKey: null or a listed 64-hex key, and it is in the hash (D-060 F01)', async (t) => {
  const k1 = '1'.repeat(64)
  const k2 = 'ab'.repeat(32)
  // createMetadata takes 32 bytes or 64 hex in any case, as for allow
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

  // validateMetadata: version 2 always holds the key, null or a listed key
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

  // A creator refuses to bind any key but its own, by name, before it pins.
  const dirC = await tmpDir('genesis-bind-other')
  await assert.rejects(
    Bundle.init(dirC, { metadata: { swarm: { allow: [k1], genesis: k1 } } }),
    (err) => err.code === 'VAULT_BAD_SWARM_GENESIS' && /names 1{64}, not the swarm key of the creator/.test(err.message)
  )
  await assert.rejects(access(join(dirC, METADATA_FILE)), 'nothing is pinned')
})

test('Bundle.init refuses a malformed metadata.swarm.allow by name, before it adds the creator key (G3-P9 F04)', async (t) => {
  const k1 = 'ab'.repeat(32)
  const cases = [
    [{ allow: 'not-an-array' }, /metadata\.swarm\.allow must be an array of swarm keys/],
    [{ allow: null }, /metadata\.swarm\.allow must be an array of swarm keys/],
    [{ allow: [k1, 'xyz'] }, /metadata\.swarm\.allow\[1\] is not a swarm key/],
    [{ allow: [k1, k1.toUpperCase()] }, new RegExp(`metadata\\.swarm\\.allow lists the swarm key ${k1} twice`)]
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
  // no input can add a key to either group
  assert.throws(
    () => createMetadata({ genesisKey: 'a'.repeat(64), rate: { extra: 1 } }),
    /metadata\.rate\.extra is not a metadata version 2 field/
  )
  assert.throws(
    () => createMetadata({ genesisKey: 'a'.repeat(64), limits: { extra: 1 } }),
    /metadata\.limits\.extra is not a metadata version 2 field/
  )

  // a document on disk with an added rate key does not load or open
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

test('a mismatched invite is refused (metadata is convergence-relevant)', async (t) => {
  const dir = await tmpDir('meta-invite')
  const v = await Bundle.init(dir)
  await v.close()
  await assert.rejects(
    () => Bundle.open(dir, { metadata: { limits: { maxPathBytes: 512 } } }),
    (err) => err.code === 'VAULT_METADATA_MISMATCH'
  )
})

test('a directory that joined with the vault key alone refuses the invite later, by name, with the fix; any other difference stays VAULT_METADATA_MISMATCH (D-060 F11)', async (t) => {
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

  // the generation id is sha256 over the predecessor key bytes, and over
  // nothing else (T24: the metadata holds no record of the predecessor's state)
  const e1 = generationId(predecessorKey)
  assert.equal(e1, createHash('sha256').update(Buffer.from(predecessorKey, 'hex')).digest('hex'))
  assert.equal(generationId(Buffer.from(predecessorKey, 'hex')), e1, 'a key given as bytes derives the same id')
  assert.equal(generationId(predecessorKey.toUpperCase()), e1, 'a key given in upper case derives the same id')
  assert.notEqual(e1, ROOT_GENERATION)
  assert.equal(generationId(null), ROOT_GENERATION)

  // a predecessorKey that is not a 64-hex key is refused
  assert.throws(
    () => createMetadata({ genesisKey: 'a'.repeat(64), predecessorKey: 'not-a-key' }),
    /metadata\.predecessorKey must be a 64-char lowercase-hex key/
  )

  // a fresh vault records the key and derives its writer cores under the
  // per-generation namespace: same directory, different generation → different vault
  // (writer) key — the §10 keypair-freshness guarantee
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

  // reopen from disk restores the same generation and key
  await next.close()
  const reopened = await Bundle.open(dir2)
  t.after(() => reopened.close())
  assert.equal(reopened.generation, e1)
  assert.equal(reopened.metadata.generation, e1)

  // a pinned document whose generation does not derive from its
  // predecessorKey does not load
  const path = join(dir2, METADATA_FILE)
  const doc = JSON.parse(await readFile(path, 'utf8'))
  doc.generation = generationId('e'.repeat(64))
  await writeFile(path, JSON.stringify(doc))
  await assert.rejects(() => loadMetadata(path), /metadata\.generation does not match its predecessorKey/)
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
  const v2 = await Bundle.init(dir, { metadata: { predecessorKey: k1 } })
  t.after(() => v2.close())
  assert.notEqual(v2.keyHex, k1, 'writer keypair does not recur across generations')
  assert.equal(v2.metadata.predecessorKey, k1, 'chain recorded')
})
