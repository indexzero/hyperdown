// Store scope items 1/3: encryptionKey end to end — encrypted at-rest vault
// opens and reads back after restart (autobee persists the key in the local
// core's userData; the metadata pin carries only the `encrypted` bit, never
// the key), and a second peer given the key via the invite replicates and
// converges.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { Vault, K, tmpDir, pair, until, converged } from './store-helpers.js'

test('encrypted vault: init, write, reopen from disk, read', async () => {
  const dir = await tmpDir('enc')
  const key = randomBytes(32)

  const a = await Vault.init(dir, { encryptionKey: key })
  assert.equal(a.metadata.encrypted, true, 'encrypted bit pinned in metadata')
  assert.ok(a.encryptionKey, 'autobee holds the encryption key')
  await a.defineTerm('core', 'secret', { '@id': 'ex:secret' })
  await a.setField('Vault', 'secret', 'hunter2')
  const h1 = await a.hash()
  await a.close()

  // reopen WITHOUT re-supplying the key: the pinned `encrypted` bit turns
  // encryption on and autobee recovers the key from local userData
  const a2 = await Vault.open(dir)
  await a2.update()
  assert.equal(a2.metadata.encrypted, true)
  assert.deepEqual((await a2.val(K.nField('Vault', 'secret'))).reg.values, ['hunter2'])
  assert.equal(await a2.hash(), h1, 'reopened encrypted view is bit-identical')
  await a2.close()
})

test('encrypted vault: a second peer with the invite key converges', async (t) => {
  const key = randomBytes(32)
  const a = await Vault.init(await tmpDir('enc-a'), { encryptionKey: key })
  const b = await Vault.join(await tmpDir('enc-b'), a.key, { encryptionKey: key })
  const unpair = pair(a, b)
  t.after(async () => {
    unpair()
    await a.close()
    await b.close()
  })

  assert.equal(b.metadata.encrypted, true)
  await a.defineTerm('core', 'secret', { '@id': 'ex:secret' })
  await a.setField('Vault', 'secret', 'swordfish')
  assert.ok(
    await until(async () => {
      await b.update()
      return (await b.val(K.nField('Vault', 'secret'))) !== undefined
    }),
    'b reads the encrypted replicated field'
  )
  assert.deepEqual((await b.val(K.nField('Vault', 'secret'))).reg.values, ['swordfish'])

  await a.addWriter(b.localKey, { indexer: false })
  assert.ok(await until(async () => {
    await b.update()
    return b.writable
  }))
  await b.setField('Vault', 'secret', 'both ways')
  assert.ok(await converged([a, b]), 'encrypted peers converge')
  assert.deepEqual((await a.val(K.nField('Vault', 'secret'))).reg.values, ['both ways'])
})
