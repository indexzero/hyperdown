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

const BODY = 'meet at dawn'

/** A vault with one concept whose body is BODY, folded. */
async function withSecret(v) {
  const { tag: id } = await v.createConcept('secret/plan', 'plan')
  await v.setBody(id, null, BODY)
  await v.update()
  return id
}

/**
 * The blocks of `core` that hold `needle`: as stored (get({ raw: true })
 * returns the stored bytes, undecrypted), and decrypted.
 */
async function hits(core, needle) {
  const out = { raw: 0, decrypted: 0 }
  for (let i = 0; i < core.length; i++) {
    if ((await core.get(i, { raw: true })).includes(needle)) out.raw++
    if ((await core.get(i)).includes(needle)) out.decrypted++
  }
  return out
}

/**
 * The at-rest scan. Each core gets a needle that its plaintext blocks
 * hold. The system core never holds an op body: it holds writer records
 * keyed by the writer key, and system info that lists the heads
 * (autobee lib/system.js:417-460). So its needle is the writer key.
 */
async function atRest(v) {
  const body = Buffer.from(BODY)
  return {
    system: await hits(v.db.system.bee.core, v.localKey),
    writer: await hits(v.db.local, body),
    view: await hits(v.db.bee.core, body)
  }
}

test('at rest: no stored block of the system, writer or view core holds plaintext, and the same scan finds it in an unencrypted vault', async (t) => {
  const open = []
  t.after(async () => {
    for (const v of open) await v.close()
  })
  const enc = await Bundle.init(await tmpDir('enc-rest'), { encryptionKey: randomBytes(32) })
  open.push(enc)
  const plain = await Bundle.init(await tmpDir('plain-rest'))
  open.push(plain)
  await withSecret(enc)
  await withSecret(plain)
  assert.equal(enc.metadata.encrypted, true)
  assert.equal(plain.metadata.encrypted, false)

  const e = await atRest(enc)
  // controls: decrypted, each core holds its needle, so the raw scan below
  // looks for bytes that are there
  for (const name of ['system', 'writer', 'view']) {
    assert.ok(e[name].decrypted > 0, `control: the decrypted ${name} core holds its needle`)
  }
  assert.equal(e.system.raw, 0, 'no stored block of the system core holds the writer key')
  assert.equal(e.writer.raw, 0, 'no stored block of the writer core holds the body')
  assert.equal(e.view.raw, 0, 'no stored block of the view core holds the body')
  assert.equal(enc.db.bee.core.manifest.version, 3, 'view core at manifest v3 (autobee@2 view encryption)')

  // the scan can fail: the stored blocks of an unencrypted vault hold each
  // needle, the system core included
  const p = await atRest(plain)
  assert.ok(p.system.raw > 0, 'an unencrypted system core holds the writer key in its stored blocks')
  assert.ok(p.writer.raw > 0, 'an unencrypted writer core holds the body in its stored blocks')
  assert.ok(p.view.raw > 0, 'an unencrypted view core holds the body in its stored blocks')
})

test('encrypted vault: reopen from disk without the key, invited peer reads', async (t) => {
  const open = new Set()
  let unpair = () => {}
  t.after(async () => {
    unpair()
    for (const v of open) await v.close()
  })
  const encryptionKey = randomBytes(32)
  const dir = await tmpDir('enc-a')
  const a = await Bundle.init(dir, { encryptionKey })
  open.add(a)
  assert.equal(a.metadata.encrypted, true, 'metadata pins encryption at rest')
  const id = await withSecret(a)
  const before = await a.snapshotHash()
  await a.close()
  open.delete(a)

  // reopen WITHOUT passing the key: restored from the local core userData
  const a2 = await Bundle.open(dir)
  open.add(a2)
  assert.equal(await a2.snapshotHash(), before, 'reopened encrypted view is intact')
  assert.equal(a2.metadata.encrypted, true)
  const head = await a2.val(K.cBody(id))
  const rev = await a2.val(K.cRev(id, head))
  assert.equal(rev.text, BODY)

  // an invited peer holding the key converges and reads
  const b = await Bundle.join(await tmpDir('enc-b'), a2.key, { encryptionKey })
  open.add(b)
  unpair = pair(a2, b)
  assert.ok(
    await until(async () => {
      await b.update()
      return (await b.val(K.cBody(id))) !== undefined
    }),
    'invited peer folds encrypted ops'
  )
  assert.equal((await b.val(K.cRev(id, head))).text, BODY)
  assert.ok(await converged([a2, b]), 'encrypted peers converge')
  assert.equal(b.metadata.encrypted, true)
})
