// Store scope item 3: two-writer convergence over real autobee + corestore
// instances — view hash equality after cross-writer content ops (I2 at
// store level), plus the §8.2 optimistic onboarding flow (hold buffer on
// the writer's own peer, ack-anchored fold, cross-peer hash equality).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vault, K, tmpDir, pair, until, converged } from './store-helpers.js'

test('two writers converge to bit-identical views (hash equality)', async (t) => {
  const a = await Vault.init(await tmpDir('conv-a'))
  const b = await Vault.join(await tmpDir('conv-b'), a.key)
  const unpair = pair(a, b)
  t.after(async () => {
    unpair()
    await a.close()
    await b.close()
  })

  // onboarding: genesis indexer admits b (in-log governance op, §8.0)
  await a.addWriter(b.localKey, { indexer: false })
  assert.ok(
    await until(async () => {
      await b.update()
      return b.writable
    }),
    'b becomes writable after the AddWriter op linearizes'
  )

  // schema + concurrent-ish cross-writer content ops
  await a.defineTerm('core', 'title', { '@id': 'ex:title' })
  await a.defineTerm('core', 'topic', { '@id': 'ex:topic', '@container': '@set' })
  await a.setField('Home', 'title', 'Welcome')
  await b.addMember('Home', 'topic', 'p2p')
  await a.addMember('Home', 'topic', 'wiki')
  await b.setBody('Home', null, 'Hello from b')

  const hash = await converged([a, b])
  assert.ok(hash, 'views converge to one hash')

  // both members present in the or-set on both peers
  for (const v of [a, b]) {
    const rec = await v.val(K.nField('Home', 'topic'))
    const members = Object.values(rec.els).map((el) => el.v).sort()
    assert.deepEqual(members, ['p2p', 'wiki'])
    const title = await v.val(K.nField('Home', 'title'))
    assert.deepEqual(title.reg.values, ['Welcome'])
  }

  // §5.3 citation contract via the emission helper: remove one member
  await b.remMember('Home', 'topic', 'p2p')
  assert.ok(await converged([a, b]), 'views converge after the remove')
  const rec = await a.val(K.nField('Home', 'topic'))
  assert.deepEqual(Object.values(rec.els).map((el) => el.v), ['wiki'])
})

test('optimistic onboarding: held locally, folded at the ack position (§8.2)', async (t) => {
  const a = await Vault.init(await tmpDir('opt-a'))
  const c = await Vault.join(await tmpDir('opt-c'), a.key)
  const unpair = pair(a, c)
  t.after(async () => {
    unpair()
    await a.close()
    await c.close()
  })

  await a.defineTerm('core', 'title', { '@id': 'ex:title' })
  assert.ok(
    await until(async () => {
      await c.update()
      return (await c.val(K.ctxTerm('title'))) !== undefined
    }),
    'c replicates the schema'
  )

  // c is NOT an admitted writer: optimistic write (autobee append
  // {optimistic: true}; the apply wrapper acks the writer at the DAG level,
  // core holds the op's view effect in n/hold + flag/optimistic)
  assert.equal(c.writable, false)
  await c.setField('agents/c/Note', 'title', 'from c', { optimistic: true })
  await c.update()

  const cHex = c.localKey.toString('hex')
  const held = await c.view.dump('n/hold/')
  const flags = await c.view.dump('flag/optimistic/')
  assert.equal(Object.keys(held).length, 1, 'full decoded op held under n/hold/ (§8.2)')
  assert.ok(Object.keys(held)[0].startsWith(`n/hold/${cHex}/`))
  assert.equal(Object.keys(flags).length, 1, 'flag/optimistic written')
  assert.equal(
    await c.val(K.nField('agents/c/Note', 'title')),
    undefined,
    'no n/ mutation before the ack (I10)'
  )

  // an indexer AddWriter linearizes: core folds the held op at the ack
  // position, deletes the hold and the optimistic flag
  await a.addWriter(c.localKey, { indexer: false })
  assert.ok(
    await until(async () => {
      await a.update()
      await c.update()
      return (await c.val(K.nField('agents/c/Note', 'title'))) !== undefined
    }),
    'held op folds after the AddWriter'
  )
  const hash = await converged([a, c])
  assert.ok(hash, 'peers converge (raw linearizations may differ; effects are ack-anchored)')
  for (const v of [a, c]) {
    assert.equal(Object.keys(await v.view.dump('n/hold/')).length, 0, 'hold buffer cleared')
    assert.equal(Object.keys(await v.view.dump('flag/optimistic/')).length, 0, 'flags cleared')
    const rec = await v.val(K.nField('agents/c/Note', 'title'))
    assert.deepEqual(rec.reg.values, ['from c'])
  }
})
