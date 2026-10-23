// Store scope (okf SPEC §13, T4): encryptionKey end to end (§8) — writer
// cores, system and view encrypted at rest; reopen-from-disk needs no key
// (autobee lib/boot.js persists it in the local core's userData as
// `autobee/encryption`); an invited peer holding the key replicates and
// reads. autobee@2 moved encryption into autobee itself (lib/encryption.js,
// per-view keys); its view encryption needs manifest-v3 cores, which okf
// gets only with corestore >= 7.12 honouring the per-core manifestVersion.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { Bundle, K, tmpDir, pair, until, converged } from './store-helpers.js'

test('encrypted vault: reopen from disk without the key, invited peer reads', async (t) => {
  const encryptionKey = randomBytes(32)
  const dir = await tmpDir('enc-a')
  const a = await Bundle.init(dir, { encryptionKey })
  assert.equal(a.metadata.encrypted, true, 'metadata pins encryption at rest')

  const { tag: id } = await a.createConcept('secret/plan', 'plan')
  await a.setBody(id, null, 'meet at dawn')
  const before = await a.snapshotHash()

  // at rest: no stored block of the writer, system or view core holds the
  // plaintext (get({ raw: true }) returns the stored bytes, undecrypted),
  // while the decrypted writer core does
  const plain = Buffer.from('meet at dawn')
  const cores = { writer: a.db.local, system: a.db.system.bee.core, view: a.db.bee.core }
  let decryptedHits = 0
  for (let i = 0; i < a.db.local.length; i++) {
    if ((await a.db.local.get(i)).includes(plain)) decryptedHits++
  }
  assert.equal(decryptedHits, 1, 'control: the decrypted writer core holds the body')
  for (const [name, core] of Object.entries(cores)) {
    for (let i = 0; i < core.length; i++) {
      const raw = await core.get(i, { raw: true })
      assert.ok(!raw.includes(plain), `${name} block ${i} is encrypted at rest`)
    }
  }
  assert.equal(a.db.bee.core.manifest.version, 3, 'view core at manifest v3 (autobee@2 view encryption)')
  await a.close()

  // reopen WITHOUT passing the key: restored from the local core userData
  const a2 = await Bundle.open(dir)
  assert.equal(await a2.snapshotHash(), before, 'reopened encrypted view is intact')
  assert.equal(a2.metadata.encrypted, true)
  const head = await a2.val(K.cBody(id))
  const rev = await a2.val(K.cRev(id, head))
  assert.equal(rev.text, 'meet at dawn')

  // an invited peer holding the key converges and reads
  const b = await Bundle.join(await tmpDir('enc-b'), a2.key, { encryptionKey })
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
