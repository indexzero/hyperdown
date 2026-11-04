// Two-writer convergence on real autobee and corestore (I2 at store
// level), and admission before the first write: the store refuses the
// append of a joiner until an indexer admits it, and the refusal uses no
// seq.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Autobee from '../store/node_modules/autobee/index.js'
import Corestore from '../store/node_modules/corestore/index.js'
import { createApply } from '../core/index.js'
import { applyConfig, ViewAdapter } from '../store/index.js'
import { Bundle, K, tmpDir, pair, until, converged } from './store-helpers.js'

test('two writers converge to bit-identical views (hash equality)', async (t) => {
  const a = await Bundle.init(await tmpDir('conv-a'))
  const b = await Bundle.join(await tmpDir('conv-b'), a.key)
  const unpair = pair(a, b)
  t.after(async () => {
    unpair()
    await a.close()
    await b.close()
  })

  await a.writers.add(b.localKey, { indexer: false })
  assert.ok(
    await until(async () => {
      await b.update()
      return b.writable
    }),
    'b becomes writable after the AddWriter op linearizes'
  )

  const { tag: id } = await a.createConcept('guides/home', 'guide')
  assert.ok(
    await until(async () => {
      await b.update()
      return (await b.val(K.cMeta(id))) !== undefined
    }),
    'b folds the create'
  )
  await a.setField(id, 'title', ['Welcome'])
  await b.addTag(id, 'p2p')
  await a.addTag(id, 'wiki')
  await b.setBody(id, null, 'Hello from b — see [arch](/guides/architecture).')

  const hash = await converged([a, b])
  assert.ok(hash, 'views converge to one hash')

  for (const v of [a, b]) {
    const rec = await v.val(K.cField(id, 'tags'))
    assert.deepEqual(Object.values(rec.els).sort(), ['p2p', 'wiki'])
    const title = await v.val(K.cField(id, 'title'))
    assert.deepEqual(title.values, ['Welcome'])
    assert.equal(await v.val(K.wanted('guides/architecture', id)), true, 'wanted/ demand row')
  }

  // a remove cites the observed tags (SPEC §5)
  await b.remTag(id, 'p2p')
  assert.ok(await converged([a, b]), 'views converge after the remove')
  const rec = await a.val(K.cField(id, 'tags'))
  assert.deepEqual(Object.values(rec.els), ['wiki'])
})

test('a refused append does not burn a seq (§8 forged-clock)', async (t) => {
  const a = await Bundle.init(await tmpDir('burn-a'))
  const c = await Bundle.join(await tmpDir('burn-c'), a.key)
  const unpair = pair(a, c)
  t.after(async () => {
    unpair()
    await a.close()
    await c.close()
  })
  const { tag: id } = await a.createConcept('notes/burn', 'note')
  assert.ok(
    await until(async () => {
      await c.update()
      return (await c.val(K.cMeta(id))) !== undefined
    })
  )

  // No indexer admitted c, so the store refuses each append with
  // VAULT_NOT_WRITABLE before it uses a seq or touches the local core.
  for (const value of ['early', 'early-again']) {
    await assert.rejects(
      () => c.setField(id, 'status', [value]),
      (err) => err.code === 'VAULT_NOT_WRITABLE'
    )
  }

  await a.writers.add(c.localKey, { indexer: false })
  assert.ok(
    await until(async () => {
      await c.update()
      return c.writable
    }),
    'c becomes writable after the AddWriter op linearizes'
  )
  const first = await c.setField(id, 'status', ['one'])
  assert.equal(first.seq, 0, 'the refused appends consumed no seq')
  const second = await c.setField(id, 'status', ['two'])
  assert.equal(second.seq, 1)
  assert.ok(await converged([a, c]), 'peers converge')
  const cHex = c.localKey.toString('hex')
  for (const v of [a, c]) {
    assert.equal(await v.val(K.flagRejected(cHex, 0)), undefined, 'seq 0 is not rejected forged-clock')
    assert.equal(await v.val(K.flagRejected(cHex, 1)), undefined, 'seq 1 is not rejected forged-clock')
    assert.equal(await v.val(K.seen(cHex)), 2, 'both ops reached apply')
    assert.deepEqual((await v.val(K.cField(id, 'status'))).values, ['two'])
  }
})

test('a joiner folds every op through its own apply, never a stamped view (I2/I3)', async (t) => {
  // autobee fast-forwards a peer onto a system and view head that another
  // writer stamped, once that head is 16 or more flushes ahead, and by
  // default it trusts every stamp (lib/trusted.js). The genesis peer here
  // runs a different apply, which writes a key that okf's apply never
  // writes. A joiner that adopts the stamp holds that key.
  const open = []
  const unpairs = []
  t.after(async () => {
    for (const unpair of unpairs) unpair()
    for (const v of open) await v.close()
  })
  const a = await Bundle.init(await tmpDir('ff-a'))
  open.push(a)
  const pinned = a._coreApply
  a._coreApply = async (nodes, view, host) => {
    await pinned(nodes, view, host)
    const w = view.write()
    w.tryPut('zz/foreign-config', '"stamped"')
    await w.flush()
  }
  const ids = []
  for (let i = 0; i < 40; i++) {
    const { tag } = await a.createConcept(`ff/n${i}`, 'note')
    ids.push(tag)
    await a.update() // one flush (one stamped view head) per op
  }
  assert.equal(await a.val('zz/foreign-config'), 'stamped')
  const aHex = a.localKey.toString('hex')

  // Positive control: a raw Autobee built as the Bundle builds one, but
  // with fastForward at autobee's default, on. It must hold the stamped key.
  const controlStore = new Corestore(await tmpDir('ff-control'))
  let control = null
  open.push({
    async close() {
      if (control) await control.close()
      await controlStore.close()
    }
  })
  control = new Autobee(controlStore.namespace('okf/generation/' + a.generation), a.key, {
    apply: createApply(applyConfig(a.metadata)),
    open: (bee) => new ViewAdapter(bee),
    optimistic: false,
    bootstrapWeight: 0
  })
  await control.ready()
  await control.update() // as Bundle.join does before it resolves, with no peer yet
  unpairs.push(pair(a, control))
  const controlVal = async (key) => {
    const node = await control.view.get(key)
    return node ? JSON.parse(node.value) : undefined
  }
  assert.ok(
    await until(async () => {
      await control.update()
      return (await controlVal(K.seen(aHex))) === 40
    }),
    'the control reaches all 40 ops of a'
  )
  assert.ok(control.stats.fastForwards >= 1, 'control: with fast-forward on, the joiner fast-forwards')
  assert.equal(await controlVal('zz/foreign-config'), 'stamped', 'control: the joiner holds the key that only the apply of a writes')

  const b = await Bundle.join(await tmpDir('ff-b'), a.key)
  open.push(b)
  unpairs.push(pair(a, b))
  assert.ok(
    await until(async () => {
      await b.update()
      return (await b.val(K.seen(aHex))) === 40
    }),
    'b folds all 40 of a ops'
  )
  assert.equal(b.db.stats.fastForwards, 0, 'b never fast-forwards')
  assert.equal(await b.val('zz/foreign-config'), undefined, 'b holds only what its own apply wrote')
  assert.ok((await b.val(K.cMeta(ids[39]))) !== undefined)
})

test('opt-in append backpressure throttles without deadlocking', async (t) => {
  const a = await Bundle.init(await tmpDir('bp-a'))
  const b = await Bundle.join(await tmpDir('bp-b'), a.key, {
    backpressure: { maxInflight: 2, ackTimeout: 250 }
  })
  const unpair = pair(a, b)
  t.after(async () => {
    unpair()
    await a.close()
    await b.close()
  })

  await a.writers.add(b.localKey, { indexer: false })
  assert.ok(
    await until(async () => {
      await b.update()
      return b.writable
    }),
    'b writable'
  )

  const { tag: id } = await a.createConcept('bp/target', 'note')
  assert.ok(
    await until(async () => {
      await b.update()
      return (await b.val(K.cMeta(id))) !== undefined
    })
  )

  // The burst completes because ackTimeout releases each wait, and it
  // converges.
  for (let i = 0; i < 8; i++) {
    await b.setField(id, 'n', [String(i)])
  }
  assert.ok(await converged([a, b]), 'burst converges under backpressure')
  assert.deepEqual((await a.val(K.cField(id, 'n'))).values, ['7'])
})
