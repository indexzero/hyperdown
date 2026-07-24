// Store scope (okf SPEC §13, T4): encryptionKey end to end (§8) — writer
// cores, system and view encrypted at rest; reopen-from-disk needs no key
// (autobee@1.0.10 lib/boot.js persists it in the local core's userData);
// an invited peer holding the key replicates and reads.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { Vault, K, tmpDir, pair, until, converged } from './store-helpers.js'

test('encrypted vault: reopen from disk without the key, invited peer reads', async (t) => {
  const encryptionKey = randomBytes(32)
  const dir = await tmpDir('enc-a')
  const a = await Vault.init(dir, { encryptionKey })
  assert.equal(a.metadata.encrypted, true, 'metadata pins encryption at rest')

  const { tag: id } = await a.createConcept('secret/plan', 'plan')
  await a.setBody(id, null, 'meet at dawn')
  const before = await a.snapshotHash()
  await a.close()

  // reopen WITHOUT passing the key: restored from the local core userData
  const a2 = await Vault.open(dir)
  assert.equal(await a2.snapshotHash(), before, 'reopened encrypted view is intact')
  assert.equal(a2.metadata.encrypted, true)
  const head = await a2.val(K.cBody(id))
  const rev = await a2.val(K.cRev(id, head))
  assert.equal(rev.text, 'meet at dawn')

  // an invited peer holding the key converges and reads
  const b = await Vault.join(await tmpDir('enc-b'), a2.key, { encryptionKey })
  const unpair = pair(a2, b)
  t.after(async () => {
    unpair()
    await a2.close()
    await b.close()
  })
  assert.ok(
    await until(async () => {
      await b.update()
      return (await b.val(K.cBody(id))) !== undefined
    }),
    'invited peer folds encrypted ops'
  )
  assert.equal((await b.val(K.cRev(id, head))).text, 'meet at dawn')
  assert.ok(await converged([a2, b]), 'encrypted peers converge')
  assert.equal(b.metadata.encrypted, true)
})
