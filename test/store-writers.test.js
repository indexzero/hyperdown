// Store scope item 3: writer add/remove round trip over real autobee
// instances — admission via in-log AddWriter (§8.0), revocation via in-log
// RemoveWriter (§8.3 causal revocation record), and containment of
// post-revocation writes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vault, K, tmpDir, pair, until, converged, sleep } from './store-helpers.js'

test('writer add/remove round trip', async (t) => {
  const a = await Vault.init(await tmpDir('wr-a'))
  const b = await Vault.join(await tmpDir('wr-b'), a.key)
  const unpair = pair(a, b)
  t.after(async () => {
    unpair()
    await a.close()
    await b.close()
  })
  const bHex = b.localKey.toString('hex')

  // --- add ---
  await a.defineTerm('core', 'title', { '@id': 'ex:title' })
  await a.addWriter(b.localKey, { indexer: false })
  assert.ok(
    await until(async () => {
      await b.update()
      return b.writable
    }),
    'b writable after admission'
  )
  const gov = await a.val(K.govWriter(bHex))
  assert.ok(gov && gov.indexer === false, 'ctx/gov records the non-indexer writer')

  // b's write lands on both peers
  await b.setField('agents/b/Note', 'title', 'hello from b')
  assert.ok(await converged([a, b]))
  assert.deepEqual((await a.val(K.nField('agents/b/Note', 'title'))).reg.values, [
    'hello from b'
  ])

  // --- remove ---
  await a.removeWriter(b.localKey)
  assert.ok(
    await until(async () => {
      await a.update()
      await b.update()
      return (
        (await a.val(K.govRemoved(bHex))) !== undefined &&
        (await b.val(K.govRemoved(bHex))) !== undefined
      )
    }),
    'ctx/gov/removed/<b> recorded on both peers (§8.3)'
  )
  assert.ok(
    await until(async () => {
      await b.update()
      return !b.writable
    }),
    'b unwritable at the autobee level (host.removeWriter went through)'
  )

  // --- containment after revocation ---
  const before = await converged([a, b])
  assert.ok(before, 'peers converged post-removal')

  // b appends after having SEEN its own removal: autobee refuses to
  // linearize a non-optimistic node from an unwritable local writer
  // (lib/writers.js "Not writable", surfaced as an 'error' event that tears
  // the revoked instance down) — the op never reaches any peer's view (I10).
  const bErrors = []
  b.on('error', (err) => bErrors.push(err))
  await b.setField('agents/b/Note', 'title', 'zombie write').catch(() => {})
  await sleep(500)
  await a.update()
  assert.deepEqual(
    (await a.val(K.nField('agents/b/Note', 'title'))).reg.values,
    ['hello from b'],
    "b's post-revocation write never lands on a"
  )
  assert.equal(await a.hash(), before, "a's view is unchanged by the contained write")
})
