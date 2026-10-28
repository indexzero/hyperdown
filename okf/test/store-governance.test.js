// The governance helpers of the Bundle (okf SPEC §8, §13), on real autobee
// and corestore instances: the key check before an append (D-047 F18).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Bundle, K, tmpDir } from './store-helpers.js'

const hex = (k) => k.toString('hex')

test('writers.add, writers.remove and writers.setPolicy refuse a key that is not 32 bytes or 64 hex characters, VAULT_BAD_WRITER_KEY, and append nothing (D-047 F18)', async (t) => {
  // Before the fix, toKeyBuffer took any string as hex. A z-base-32 id,
  // which is how hypercore names a core (db.local.id), decoded to no bytes,
  // and the indexer's AddWriter of it wrote a phantom gov/writer record.
  const a = await Bundle.init(await tmpDir('badkey-a'))
  const b = await Bundle.join(await tmpDir('badkey-b'), a.key)
  t.after(async () => {
    await a.close()
    await b.close()
  })
  const before = a.db.local.length
  const bad = [
    ['the z-base-32 id', b.db.local.id],
    ['63 hex characters', hex(b.localKey).slice(0, 63)],
    ['64 characters that are not hex', 'zz'.repeat(32)],
    ['31 bytes', Buffer.alloc(31, 1)],
    ['33 bytes', Buffer.alloc(33, 1)]
  ]
  for (const [name, key] of bad) {
    await assert.rejects(a.writers.add(key, { indexer: true }), { code: 'VAULT_BAD_WRITER_KEY' }, `writers.add: ${name}`)
    await assert.rejects(a.writers.remove(key), { code: 'VAULT_BAD_WRITER_KEY' }, `writers.remove: ${name}`)
    await assert.rejects(
      a.writers.setPolicy(key, { namespacePrefixes: ['x'] }),
      { code: 'VAULT_BAD_WRITER_KEY' },
      `writers.setPolicy: ${name}`
    )
  }
  assert.equal(a.db.local.length, before, 'no op reached the local core')

  // 32 bytes and 64 hex characters, in either case, name the same writer.
  await a.writers.add(hex(b.localKey).toUpperCase())
  await a.writers.setPolicy(b.localKey, { namespacePrefixes: ['b'] })
  await a.update()
  const govKeys = []
  for await (const { key } of a.scan(K.govWriterPrefix())) govKeys.push(key)
  assert.deepEqual(govKeys.sort(), [K.govWriter(hex(a.localKey)), K.govWriter(hex(b.localKey))].sort())
  assert.deepEqual((await a.val(K.govWriter(hex(b.localKey)))).namespacePrefixes, ['b'])
})
