// G9b, the governance race, at store level (okf SPEC §8, AD7). Adopted
// from the T1b spike, which ported the D-001 probes
// probe-g9-vanish-config-c.mjs and probe-g9-vanish-config-c-phase2.mjs
// (themselves from ab2-review/scratch-A/s4-race.mjs).
//
// The race: a and b are indexers. b revokes a while a and b are
// partitioned. 100 ms later a admits c, and c appends Y, which links the
// AddWriter. The RemoveWriter carries the earlier timestamp, so once the
// partition heals it sorts first, and core rejects the AddWriter
// 'revoked' on every peer. On a and c, that reorder flips an AddWriter
// that core first accepted.
//
// Core grants c at weight 0 for every AddWriter op it folds, accepted or
// rejected (§8). So c is an autobee writer on every peer in every order.
// Y and c's next op Z reach apply on every peer, and core rejects them
// 'not-a-writer'. If core granted only an accepted AddWriter, autobee
// would keep Y in the systems of a and c (index.js:1430 records it before
// canApply at :1447), and b would never see it (index.js:1359). Y would
// vanish with no flag (I4). Z would then reach apply on a and c
// (lib/writers.js:526-533, lib/system.js:249-250) and not on b, and the
// views would split for good (I2, I3).
//
// Every wait has a deadline and fails the test when it passes. The test
// reads db.system only to report state. It changes no autobee behaviour.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Bundle, K, tmpDir, pair, sleep } from './store-helpers.js'

const DEADLINE = 30000
const GAP_MS = 100

/** Poll until fn() is truthy. Throws when the deadline passes. */
async function waitFor(label, fn, ms = DEADLINE, step = 25) {
  const t0 = Date.now()
  for (;;) {
    if (await fn()) return
    if (Date.now() - t0 >= ms) throw new Error(`deadline ${ms} ms passed: ${label}`)
    await sleep(step)
  }
}

const hex = (k) => k.toString('hex')

async function hashes(peers) {
  const hs = []
  for (const v of peers) {
    await v.update()
    hs.push(await v.snapshotHash())
  }
  return hs
}

const allEqual = (hs) => hs.every((h) => h === hs[0])

/** Wait for equal view hashes, then make sure they stay equal. */
async function converge(label, peers) {
  let hs = []
  await waitFor(`${label}: equal view hashes`, async () => allEqual((hs = await hashes(peers))))
  await sleep(300)
  hs = await hashes(peers)
  assert.ok(allEqual(hs), `${label}: the hashes stay equal: ${hs.map((h) => h.slice(0, 16))}`)
  return hs[0]
}

async function rejections(v) {
  await v.update()
  const out = []
  for await (const { key, value } of v.scan(K.flagPrefix('rejected'))) out.push([key, value.reason])
  return out
}

/** State of one peer for the diagnostics. db.system is read here only. */
async function report(name, v, cKey) {
  await v.update()
  const sys = await v.db.system.get(cKey)
  return {
    peer: name,
    hash: (await v.snapshotHash()).slice(0, 16),
    seenC: (await v.val(K.seen(hex(cKey)))) ?? null,
    govWriterC: (await v.val(K.govWriter(hex(cKey)))) !== undefined,
    rejected: (await rejections(v)).map(([k, r]) => [k.split('/').slice(2).join('/').slice(-24), r]),
    systemC: sys ? { length: sys.length, isRemoved: sys.isRemoved } : null
  }
}

/** Wait until every peer has folded c's ops up to and with `op`. */
async function everyPeerFolds(label, peers, cHex, op) {
  await waitFor(label, async () => {
    for (const v of peers) {
      await v.update()
      if (((await v.val(K.seen(cHex))) ?? 0) < op.seq + 1) return false
    }
    return true
  })
}

test('G9b: the governance race converges, and every op of the race writer leaves a flag (I2, I3, I4)', { timeout: 240000 }, async (t) => {
  const outcome = { steps: {} }
  const peers = []
  let cKey = null
  const links = []
  t.after(async () => {
    for (const unlink of links) unlink()
    for (const v of peers) await v.close().catch(() => {})
  })
  const link = (x, y) => {
    const unlink = pair(x, y)
    links.push(unlink)
    return unlink
  }

  try {
    // a and b are indexers. c joins and folds the seed, but cannot write.
    const a = await Bundle.init(await tmpDir('race-a'))
    peers.push(a)
    const b = await Bundle.join(await tmpDir('race-b'), a.key)
    peers.push(b)
    const unAB = link(a, b)
    await a.writers.add(b.localKey, { indexer: true })
    await waitFor('b becomes writable', async () => (await b.update(), b.writable))
    const seed = await a.createConcept('seed/a1', 'note')
    await waitFor('b folds the seed', async () => {
      await b.update()
      return (await b.val(K.cMeta(seed.tag))) !== undefined
    })
    const c = await Bundle.join(await tmpDir('race-c'), a.key)
    peers.push(c)
    link(a, c)
    await waitFor('c folds the seed', async () => {
      await c.update()
      return (await c.val(K.cMeta(seed.tag))) !== undefined
    })
    assert.equal(c.writable, false, 'c cannot write before its admission')
    cKey = c.localKey
    const aHex = hex(a.localKey)
    const cHex = hex(cKey)

    // The partition: b revokes a first, then a admits c, and c appends Y.
    unAB()
    await sleep(50)
    await b.removeWriter(a.localKey)
    await b.update()
    await sleep(GAP_MS)
    const add = await a.writers.add(c.localKey, { indexer: false })
    await waitFor('c becomes writable', async () => (await c.update(), c.writable))
    const Y = await c.createConcept('c/y', 'note')
    await c.update()
    await waitFor('a accepts Y before the heal', async () => {
      await a.update()
      return (await a.val(K.cMeta(Y.tag))) !== undefined
    })

    // The heal. Every peer folds the revocation, and a's AddWriter(c) in
    // its final disposition.
    link(a, b)
    link(b, c)
    await waitFor('every peer folds the revocation and the AddWriter', async () => {
      for (const v of peers) {
        await v.update()
        if ((await v.val(K.govRemoved(aHex))) === undefined) return false
        if (((await v.val(K.seen(aHex))) ?? 0) < add.seq + 1) return false
      }
      return true
    })
    for (const v of peers) {
      assert.deepEqual(
        await v.val(K.flagRejected(aHex, add.seq)),
        { reason: 'revoked' },
        'the RemoveWriter sorts first, so every peer rejects the AddWriter revoked'
      )
    }

    // Every op of c before its re-admission leaves a flag on every peer
    // (I4), and takes no effect.
    const flagged = async (op) => {
      for (const v of peers) {
        assert.deepEqual(
          await v.val(K.flagRejected(cHex, op.seq)),
          { reason: 'not-a-writer' },
          `c's op at seq ${op.seq} leaves a flag on every peer (I4)`
        )
        assert.equal(await v.val(K.cMeta(op.tag)), undefined, `c's op at seq ${op.seq} takes no effect`)
      }
    }

    // After Y.
    await everyPeerFolds('every peer folds Y', peers, cHex, Y)
    outcome.steps.afterY = { hash: (await converge('after Y', peers)).slice(0, 16) }
    await flagged(Y)

    // After c's next op Z.
    const Z = await c.createConcept('c/z', 'note')
    await c.update()
    await everyPeerFolds('every peer folds Z', peers, cHex, Z)
    const hz = await converge('after Z', peers)
    outcome.steps.afterZ = {
      hash: hz.slice(0, 16),
      peers: await Promise.all(peers.map((v, i) => report('abc'[i], v, c.localKey)))
    }
    await flagged(Y)
    await flagged(Z)

    // An indexer admits c again, and c appends R. R takes effect.
    await b.writers.add(c.localKey, { indexer: false })
    await waitFor('c folds its re-admission', async () => {
      await c.update()
      return (await c.val(K.govWriter(cHex))) !== undefined
    })
    const R = await c.createConcept('c/r', 'note')
    await waitFor('R takes effect on every peer', async () => {
      for (const v of peers) {
        await v.update()
        if ((await v.val(K.cMeta(R.tag))) === undefined) return false
      }
      return true
    })
    const hr = await converge('after R', peers)
    for (const v of peers) {
      assert.equal(await v.val(K.flagRejected(cHex, R.seq)), undefined, 'R is not rejected')
      assert.equal((await v.val(K.cPath(R.tag))).path, 'c/r', 'R takes effect')
    }

    // A fresh peer syncs from nothing (store-level I3, as in
    // store-restart.test.js 'fresh peer rebuild from the log').
    const d = await Bundle.join(await tmpDir('race-d'), a.key)
    peers.push(d)
    link(b, d)
    await waitFor('the fresh peer folds R', async () => {
      await d.update()
      return (await d.val(K.cMeta(R.tag))) !== undefined
    })
    const hd = await converge('fresh peer', peers)
    assert.equal(hd, hr, 'the fresh peer gives the same view hash as the three peers')
    const want = await rejections(a)
    for (const v of peers) {
      assert.deepEqual(await rejections(v), want, 'the same rejection records on every peer')
    }
    assert.deepEqual(
      want.filter(([k]) => k.startsWith(`flag/rejected/${cHex}/`)).map(([, reason]) => reason),
      ['not-a-writer', 'not-a-writer'],
      'the rejected ops of c are Y and Z'
    )
    assert.equal((await d.val(K.cPath(R.tag))).path, 'c/r', 'R takes effect on the fresh peer')
    outcome.steps.fresh = {
      hash: hd.slice(0, 16),
      peers: await Promise.all(peers.map((v, i) => report('abcd'[i], v, c.localKey)))
    }
  } finally {
    // On a failure, the state of every peer at that moment.
    if (cKey && !outcome.steps.fresh) {
      outcome.atFailure = await Promise.all(peers.map((v, i) => report('abcd'[i], v, cKey))).catch(String)
    }
    t.diagnostic(`outcome ${JSON.stringify(outcome)}`)
  }
})
