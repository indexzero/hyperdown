// The governance helpers of the Bundle (okf SPEC §8, §13), on real autobee
// and corestore instances: the key check before an append (D-047 F18), the
// wait for open (D-047 N13), and the weight of the substrate grant (D-047
// F08).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Bundle, K, tmpDir, pair, until } from './store-helpers.js'

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

test('writers.setPolicy before open waits for open, and takes the default ceiling from the pinned metadata (D-047 N13)', async (t) => {
  // The default rateCeiling comes from this.metadata, which open loads.
  // Before the fix, setWriterPolicy read it before open, so a call before
  // ready() threw a TypeError. Every other append helper waits for open.
  const dir = await tmpDir('policy-before-open')
  const v = await Bundle.init(dir, { metadata: { rate: { defaultCeiling: 8 } } })
  const self = hex(v.localKey)
  await v.close()

  const a = new Bundle(dir)
  t.after(() => a.close())
  const res = await a.writers.setPolicy(self, { namespacePrefixes: ['team'] })
  assert.equal(res.seq, 0, 'the policy op is the first op of the vault')
  await a.update()
  assert.deepEqual(await a.val(K.govWriter(self)), { indexer: true, namespacePrefixes: ['team'], rateCeiling: 8 })
})

test('an AddWriter grant leaves no pending promotion on any peer: HostAdapter grants at weight 0, not at autobee\'s default (D-047 F08)', async (t) => {
  // autobee's host.addWriter defaults to isIndexer true and weight 2
  // (lib/apply-calls.js:33). The carrier of the grant stands at weight 0,
  // so autobee caps the effective weight and the ceiling at 0 at any asked
  // weight (lib/system.js:75), and every weight still reads 0. A grant at
  // the default weight still records a pending promotion to weight 2
  // (lib/system.js:78). With M2 (bootstrapWeight back at its default), that
  // brings back the G1 livelock (D-047 F08).
  //
  // No documented surface shows the promotion. autobee's README documents
  // the instance API key, discoveryKey, id, local, view, bee, writable,
  // isIndexer, append, update, updated, flush, replicate, wakeup, setLocal,
  // setAcking and views, and the host API addWriter with isIndexer only. It
  // documents no read of a weight, a ceiling or a pending promotion.
  // db.isIndexer reads a ceiling of 2 or more, and the cap keeps the
  // ceiling at 0. So the test reads autobee's system, and only reads it, as
  // the attack tests do (attack-helpers.js sys()).
  const a = await Bundle.init(await tmpDir('grant-a'))
  const b = await Bundle.join(await tmpDir('grant-b'), a.key)
  const c = await Bundle.join(await tmpDir('grant-c'), a.key)
  const unpairs = [pair(a, b), pair(a, c)]
  t.after(async () => {
    for (const un of unpairs) un()
    for (const v of [a, b, c]) await v.close()
  })
  await a.writers.add(b.localKey, { indexer: false })
  await a.writers.add(c.localKey, { indexer: true })
  assert.ok(await until(async () => (await b.update(), await c.update(), b.writable && c.writable)), 'b and c are granted')
  await b.createConcept('b/x', 'note')
  await c.createConcept('c/x', 'note')
  assert.ok(
    await until(async () => {
      for (const v of [a, b, c]) {
        await v.update()
        for (const w of [b, c]) if ((await v.val(K.seen(hex(w.localKey)))) !== 1) return false
      }
      return true
    }),
    'every peer folds the ops of b and c'
  )
  const grants = {}
  for (const [name, v] of [['a', a], ['b', b], ['c', c]]) {
    for (const [wname, w] of [['b', b], ['c', c]]) {
      const r = await v.db.system.get(w.localKey)
      grants[`${name}:${wname}`] = { weight: r.weight, maxWeight: r.maxWeight, pending: await v.db.system.pendingPromotion(w.localKey) }
    }
  }
  const zero = { weight: 0, maxWeight: 0, pending: 0 }
  assert.deepEqual(grants, { 'a:b': zero, 'a:c': zero, 'b:b': zero, 'b:c': zero, 'c:b': zero, 'c:c': zero })
})
