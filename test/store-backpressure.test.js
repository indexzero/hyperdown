// CODE-REVIEW.md M2: store-level append admission control. Unthrottled,
// vault.append is fire-at-caller-rate, so a fast writer can outrun every
// peer's fold (the M2 concurrency feedback loop the 3-writer lossy soak
// reproduces). The opt-in `backpressure` option gates every append on two
// maxInflight watermarks: the writer's OWN last awaited fold, and the best
// peer acknowledgment (the §3.2 clock a folded remote op carries, citing
// this writer's core length — proof of that peer's fold progress). This is
// the short in-process version of the fix check: bounded in-flight
// watermark, all writers make progress under concurrent load, the ack gate
// degrades to timeout admission instead of deadlocking, and — critically —
// the default append path never awaits a fold (behavior unchanged for the
// invariant layer).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vault, K, tmpDir, pair, until, converged } from './store-helpers.js'

/** Count how often a vault awaits its own fold via vault.update(). */
function spyUpdate(v) {
  const counter = { n: 0 }
  const orig = v.update.bind(v)
  v.update = () => {
    counter.n++
    return orig()
  }
  return counter
}

test('backpressure bounds in-flight ops and every writer progresses under concurrent load (M2)', async (t) => {
  const a = await Vault.init(await tmpDir('bp-a'))
  const b = await Vault.join(await tmpDir('bp-b'), a.key)
  const c = await Vault.join(await tmpDir('bp-c'), a.key)
  const unpairs = [pair(a, b), pair(a, c), pair(b, c)]
  t.after(async () => {
    for (const un of unpairs) un()
    await a.close()
    await b.close()
    await c.close()
  })

  await a.defineTerm('core', 'title', { '@id': 'ex:title' })
  await a.defineTerm('core', 'topic', { '@id': 'ex:topic', '@container': '@set' })
  await a.addWriter(b.localKey, { indexer: false })
  await a.addWriter(c.localKey, { indexer: false })
  for (const v of [b, c]) {
    assert.ok(
      await until(async () => {
        await v.update()
        return v.writable
      }),
      'joined peer becomes writable'
    )
  }

  // The M2 shape in miniature: three writers, each firing its op stream as
  // fast as the store admits it (no sleeps), all replicating concurrently.
  const MAX_INFLIGHT = 4
  const OPS = 30
  const vaults = [a, b, c]
  const done = [0, 0, 0]
  await Promise.all(
    vaults.map(async (v, wi) => {
      const rot = ['Home', `agents/w${wi}/Log`, 'Topic']
      for (let i = 0; i < OPS; i++) {
        const s = rot[i % rot.length]
        const opts = { backpressure: { maxInflight: MAX_INFLIGHT } }
        if (i % 2 === 0) await v.setField(s, 'title', `t${wi}-${i}`, opts)
        else await v.addMember(s, 'topic', `m${i}`, opts)
        // bounded in-flight watermark: this writer never has more than
        // maxInflight of its own ops outstanding beyond its last awaited
        // fold (private counters ARE the watermark being asserted)
        assert.ok(
          v._nextSeq - v._foldedSeq <= MAX_INFLIGHT,
          `w${wi} in-flight ${v._nextSeq - v._foldedSeq} <= ${MAX_INFLIGHT} after op ${i}`
        )
        done[wi]++
      }
    })
  )

  // every writer made full progress — nobody was starved into a stall
  assert.deepEqual(done, [OPS, OPS, OPS], 'all writers complete their op streams')

  // the peer-ack gate was live: every writer folded remote clocks citing it
  for (const [wi, v] of vaults.entries()) {
    assert.ok(v._ackSeen, `w${wi} saw remote writers`)
    assert.ok(v._bestAck > 0, `w${wi} harvested peer acks of its core (got ${v._bestAck})`)
  }

  const hash = await converged([a, b, c])
  assert.ok(hash, 'views converge after the concurrent throttled load')
})

test('ack gate degrades to timeout admission when peers go silent (no deadlock)', async (t) => {
  const a = await Vault.init(await tmpDir('bp-silent-a'))
  const b = await Vault.join(await tmpDir('bp-silent-b'), a.key)
  const unpair = pair(a, b)
  let unpaired = false
  t.after(async () => {
    if (!unpaired) unpair()
    await a.close()
    await b.close()
  })

  await a.defineTerm('core', 'title', { '@id': 'ex:title' })
  await a.addWriter(b.localKey, { indexer: false })
  assert.ok(
    await until(async () => {
      await b.update()
      return b.writable
    }),
    'b becomes writable'
  )

  // arm a's ack tracking, then have b demonstrate fold progress once
  await a.setField('Home', 'title', 'armed', { backpressure: true })
  await until(async () => {
    await b.update()
    return (await b.val(K.nField('Home', 'title'))) !== undefined
  })
  await b.setField('Home', 'title', 'from-b')
  assert.ok(
    await until(async () => {
      await a.update()
      return a._ackSeen && a._bestAck > 0
    }),
    'a folded a remote op whose clock cites its core'
  )

  // silence b entirely: no more acks will ever arrive
  unpair()
  unpaired = true

  const t0 = Date.now()
  for (let i = 0; i < 3; i++) {
    await a.setField('Home', 'title', `solo${i}`, { backpressure: { maxInflight: 1, ackTimeout: 50 } })
  }
  const elapsed = Date.now() - t0
  assert.ok(elapsed < 5000, `silent peers degrade to timeout admission, no deadlock (${elapsed}ms)`)
})

test('backpressure is opt-in: default append never awaits the fold; vault config + per-call override', async (t) => {
  // default behavior unchanged: append is fire-at-caller-rate, no folds
  const a = await Vault.init(await tmpDir('bp-def-a'))
  t.after(async () => {
    await a.close()
  })
  await a.defineTerm('core', 'title', { '@id': 'ex:title' })
  const aFolds = spyUpdate(a)
  for (let i = 0; i < 10; i++) await a.setField('Home', 'title', `v${i}`)
  assert.equal(aFolds.n, 0, 'default append path never awaits update()')

  // per-call option on an unconfigured vault throttles that op stream
  const aOptFolds = spyUpdate(a)
  for (let i = 0; i < 6; i++) {
    await a.setField('Home', 'title', `opt${i}`, { backpressure: { maxInflight: 1 } })
    assert.ok(a._nextSeq - a._foldedSeq <= 1, 'maxInflight: 1 watermark holds')
  }
  assert.ok(aOptFolds.n >= 5, `per-call backpressure awaits the fold (${aOptFolds.n} folds)`)

  // vault-level config applies to every append; per-call false disables it
  const d = await Vault.init(await tmpDir('bp-cfg-d'), { backpressure: { maxInflight: 2 } })
  t.after(async () => {
    await d.close()
  })
  await d.defineTerm('core', 'title', { '@id': 'ex:title' })
  const dFolds = spyUpdate(d)
  for (let i = 0; i < 8; i++) {
    await d.setField('Home', 'title', `v${i}`)
    assert.ok(d._nextSeq - d._foldedSeq <= 2, 'vault-level maxInflight: 2 watermark holds')
  }
  assert.ok(dFolds.n > 0, `vault-level config throttles plain appends (${dFolds.n} folds)`)
  const before = dFolds.n
  for (let i = 0; i < 6; i++) {
    await d.setField('Home', 'title', `raw${i}`, { backpressure: false })
  }
  assert.equal(dFolds.n, before, 'per-call backpressure: false overrides the vault config')

  // the throttled writes all landed (LWW: last value wins)
  await d.update()
  const rec = await d.val(K.nField('Home', 'title'))
  assert.deepEqual(rec.reg.values, ['raw5'])
})
