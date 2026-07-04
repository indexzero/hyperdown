// Store scope item 3, I3 at store level: a vault reopened from disk holds a
// view bit-identical to the pre-restart view, and a fresh peer that rebuilds
// from the replicated log converges to the same hash (rebuild equivalence).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vault, K, tmpDir, pair, until, converged } from './store-helpers.js'

test('restart from disk: reopened view equals the pre-close view (I3)', async (t) => {
  const dir = await tmpDir('restart')
  const a = await Vault.init(dir)
  await a.defineTerm('core', 'title', { '@id': 'ex:title' })
  await a.defineTerm('core', 'topic', { '@id': 'ex:topic', '@container': '@set' })
  await a.defineScope('onto', 'vault://onto/', 'onto')
  await a.setField('Home', 'title', 'Welcome')
  await a.addMember('Home', 'topic', 'p2p')
  await a.addMember('Home', 'topic', 'wiki')
  await a.setBody('Home', null, 'First body')
  await a.setField('Home', 'title', 'Welcome!') // supersede own write
  const before = await a.hash()
  const beforeKeys = Object.keys(await a.view.dump(''))
  await a.close()

  const a2 = await Vault.open(dir)
  t.after(() => a2.close())
  await a2.update()
  assert.equal(await a2.hash(), before, 'hash equality across restart')
  assert.deepEqual(Object.keys(await a2.view.dump('')), beforeKeys, 'same key set')

  // still writable and deterministic after restart
  await a2.setField('Home', 'title', 'Back again')
  const rec = await a2.val(K.nField('Home', 'title'))
  assert.deepEqual(rec.reg.values, ['Back again'])
})

test('fresh peer rebuild from the log equals the restarted view', async (t) => {
  const dir = await tmpDir('rebuild-a')
  const a = await Vault.init(dir)
  await a.defineTerm('core', 'title', { '@id': 'ex:title' })
  await a.setField('Home', 'title', 'Rebuild me')
  await a.setBody('Home', null, 'body text')
  await a.close()

  const a2 = await Vault.open(dir)
  const fresh = await Vault.join(await tmpDir('rebuild-b'), a2.key)
  const unpair = pair(a2, fresh)
  t.after(async () => {
    unpair()
    await a2.close()
    await fresh.close()
  })

  assert.ok(
    await until(async () => {
      await fresh.update()
      return (await fresh.val(K.nField('Home', 'title'))) !== undefined
    }),
    'fresh peer folds the replicated log'
  )
  const hash = await converged([a2, fresh])
  assert.ok(hash, 'restarted view and fresh rebuild agree')
  assert.deepEqual((await fresh.val(K.nField('Home', 'title'))).reg.values, ['Rebuild me'])
})
