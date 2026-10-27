// Store scope (T5, T7): the substrate attacks that the product
// configuration closes, adopted from the T1 spike (D-003) as assertions.
// The one product configuration: optimistic: false, bootstrapWeight: 0,
// and every okf grant at weight 0.
//
// Weight 0 (T5). With nobody at a weight above 0, nobody has standing. No
// peer collects an approval (autobee index.js:1254-1255), no claim above 0
// verifies (lib/witness.js:33-51), and so no resolved weight can depend on
// a node's own position, which is the livelock's mechanism.
// - A2, G4: a key that a member names in a forged approval stays at 0.
// - A3, G1: a forged approval plus a forged witness, driven by a member
//   (s4). Every peer folds within its deadline.
// - G35: no peer collects an approval, with more than 32 promotions
//   pending.
// - G50: no writer climbs, also when a member forges a higher-tier
//   approval for another member.
//
// optimistic: false (T7). autobee drops every node of a writer it has not
// added before _applyBatch (index.js:1357-1364), so an outsider puts no op
// and no approval into apply. Each outsider test sends its forged node,
// announces the outsider's core so that the victim fetches it (the
// positive control: the victim holds the block), and then asserts three
// things on every peer: no outsider node reaches okf's apply, update()
// returns within its deadline, and the view hash does not change. Every
// honest op runs before the attack, so the hash before the attack is the
// hash that must stay.
// - A4, G1: the livelock driven by strangers only (s5).
//
// Not here: the member residuals and G44 (A5 member, A6 member, A7b, A8,
// A9: T11 adopts them).
//
// Every wait has a deadline. Each test has a timeout. Each poll runs under
// until(), each close under timed(), and every fold after the livelock
// heal, where a livelock stalls, runs under timed(). A stall therefore
// fails an assertion and never hangs the run. At weight 2 the A3 fold gave
// TIMEOUT.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import {
  Bundle,
  K,
  tmpDir,
  pair,
  until,
  sleep,
  converged,
  hex,
  forgeNext,
  quiet,
  errorsOf,
  sys,
  linearized,
  carriers,
  timed,
  coreStats,
  record,
  reopenCheck,
  outsiderAppend,
  announce,
  holds,
  watchApply
} from './attack-helpers.js'

// The tier an attacker asks for: indexer standing.
const TIER = 2
const W0 = { weight: 0, maxWeight: 0, isRemoved: false }
const TIMEOUT = 120000

/** Close each vault, each close under its own deadline. */
async function closeAll(...vaults) {
  for (const v of vaults) await timed(() => v.close(), 20000, 'close')
}

/** `[writer, approvals, witness]` of each carrier node, sorted. */
async function carrierRows(v) {
  return (await carriers(v)).map((n) => [n.writer, n.approvals, n.witness]).sort()
}

/**
 * Read the outsider claims on each peer `[name, vault, appliedSet]`, each
 * step under a deadline: does update() return, is the view hash still
 * `hash0`, which outsider keys reached okf's apply (watchApply), which
 * have a seen/ entry, and which does autobee's system record.
 */
async function outsiderRows(peers, outsiders, hash0) {
  const rows = {}
  for (const [name, v, applied] of peers) {
    const upd = await timed(() => v.update(), 20000)
    const hash = await timed(() => v.snapshotHash(), 20000)
    const row = {
      update: upd.status,
      hash: hash.status !== 'ok' ? hash.status : hash.value === hash0 ? 'unchanged' : 'CHANGED',
      applied: [],
      seen: [],
      system: []
    }
    for (const key of outsiders) {
      if (applied.has(hex(key))) row.applied.push(hex(key))
      if ((await v.val(K.seen(hex(key)))) !== undefined) row.seen.push(hex(key))
      if ((await v.db.system.get(key)) !== null) row.system.push(hex(key))
    }
    rows[name] = row
  }
  return rows
}

/** The three outsider claims, on every peer. */
function assertOutsiderShut(rows) {
  for (const [name, r] of Object.entries(rows)) {
    assert.equal(r.update, 'ok', `${name}: update() returns within the deadline`)
    assert.equal(r.hash, 'unchanged', `${name}: the view hash does not change`)
    assert.deepEqual(r.applied, [], `${name}: no outsider node reaches apply`)
    assert.deepEqual(r.seen, [], `${name}: no outsider op is counted in seen/`)
    assert.deepEqual(r.system, [], `${name}: autobee records no outsider key`)
  }
}

// ---------------------------------------------------------------------------
// G4 (ab2-review/scratch-B/s2-weight0-approval-climbs.mjs): a member's
// forged approval names a key nobody admitted. At weight 2 genesis's next
// honest append approved that key, and the key climbed to 2.
// ---------------------------------------------------------------------------
test('A2 G4: a key that a member names in a forged approval stays at weight 0', { timeout: TIMEOUT }, async (t) => {
  const aDir = await tmpDir('a2-a')
  const a = quiet(await Bundle.init(aDir))
  const b = quiet(await Bundle.join(await tmpDir('a2-b'), a.key)) // an okf member
  const s = quiet(await Bundle.join(await tmpDir('a2-s'), a.key)) // never admitted
  const unpairAB = pair(a, b)
  const unpairBS = pair(b, s)
  let closed = false
  t.after(async () => {
    unpairAB()
    unpairBS()
    await closeAll(b, s)
    if (!closed) await closeAll(a)
  })
  const bHex = hex(b.localKey)
  const sHex = hex(s.localKey)
  const out = { trigger: 'member' }

  await a.writers.add(b.localKey, { indexer: false })
  assert.ok(await until(async () => (await b.update(), b.writable), 20000), 'b becomes writable')

  // the attack: b's next node approves s at the indexer tier
  forgeNext(b, { approvals: [{ key: s.localKey, weight: TIER }] })
  out.carrierAppend = (await timed(() => b.createConcept('carrier', 'note'), 20000)).status
  out.admittedOnA = await until(async () => {
    await a.update()
    return (await a.db.system.get(s.localKey)) !== null
  }, 20000)
  out.pendingOnA = await a.db.system.pendingPromotion(s.localKey)
  out.strangerWritable = await until(async () => (await s.update(), s.writable), 20000)

  // genesis's honest next append (at weight 2 it approved s), then s's
  // plain append (at weight 2 it cited that approval as a witness)
  await a.createConcept('a-next', 'note')
  out.plainAppend = (await timed(() => s.createConcept('s-plain', 'note'), 20000)).status
  out.converged = (await converged([a, b, s], 25000)) !== null
  out.sys = {}
  out.carriers = {}
  for (const [name, v] of [['a', a], ['b', b], ['s', s]]) {
    out.sys[name] = await sys(v, s.localKey)
    out.carriers[name] = await carrierRows(v)
  }
  out.govWriterOnA = (await a.val(K.govWriter(sHex))) ?? null

  unpairAB()
  unpairBS()
  out.reopen = await reopenCheck(a, aDir, 20000)
  closed = true
  out.errors = { victim: errorsOf(a), member: errorsOf(b), stranger: errorsOf(s) }
  await record(t, 'A2-G4-member-approval', out)

  assert.equal(out.carrierAppend, 'ok')
  assert.equal(out.admittedOnA, true, 'a member can add any key to the autobee system (AD2)')
  assert.equal(out.strangerWritable, true)
  assert.equal(out.plainAppend, 'ok')
  assert.equal(out.converged, true, 'the peers converge')
  for (const name of ['a', 'b', 's']) {
    assert.deepEqual(out.sys[name], W0, `${name}: the named key stays at weight 0`)
    assert.deepEqual(out.carriers[name], [[bHex, true, false]], `${name}: only the forged node carries approvals`)
  }
  assert.equal(out.govWriterOnA, null, 'okf never records a gov/writer for the named key')
  assert.equal(out.reopen.update, 'ok', 'the victim reopens and folds (no brick)')
})

// ---------------------------------------------------------------------------
// G1, the livelock (ab2-review/scratch-B/s4-witness-oscillation.mjs and
// s5-stranger-livelock.mjs). A forged approval plus a forged witness gives
// the claimant's node N a weight that depends on its own position: at
// weight 2, N resolved to 2 only if the carrier's climb k sorted before it,
// and N at 2 sorted before k. No fixpoint, so apply never returned.
// ---------------------------------------------------------------------------
async function livelock(t) {
  const driver = 'member'
  const aDir = await tmpDir(`ll-${driver}-a`)
  const a = quiet(await Bundle.init(aDir)) // genesis
  const c1 = quiet(await Bundle.join(await tmpDir(`ll-${driver}-c1`), a.key)) // the carrier
  const c2 = quiet(await Bundle.join(await tmpDir(`ll-${driver}-c2`), a.key)) // the claimant
  const unpairAC = pair(a, c1)
  let unpairCC = pair(c1, c2)
  let closed = false
  t.after(async () => {
    unpairAC()
    unpairCC()
    await closeAll(c1, c2)
    if (!closed) await closeAll(a)
  })
  const c1Hex = hex(c1.localKey)
  const c2Hex = hex(c2.localKey)
  const out = { trigger: driver, driver }

  const { tag: seed } = await a.createConcept('seed', 'note')
  out.carrierSynced = await until(async () => (await c1.update(), (await c1.val(K.cMeta(seed))) !== undefined), 20000)
  await a.writers.add(c1.localKey, { indexer: false })
  out.carrierWritable = await until(async () => (await c1.update(), c1.writable), 20000)

  // j: the carrier's node whose approvals name the claimant
  forgeNext(c1, { approvals: [{ key: c2.localKey, weight: TIER }] })
  out.carrierAppend = (await timed(() => c1.createConcept('carrier-j', 'note'), 20000)).status
  const jLen = c1.db.local.length
  out.claimantAdmitted = await until(async () => (await c2.update(), c2.writable), 20000)

  unpairCC() // cut the claimant off, so it never sees g or k
  out.genesisSawClaimant = await until(async () => {
    await a.update()
    return (await a.db.system.get(c2.localKey)) !== null
  }, 20000)

  // g: genesis's honest append. At weight 2 it approved the carrier and
  // the claimant.
  const g = await a.createConcept('g', 'note')
  out.carrierSawG = await until(async () => (await c1.update(), (await c1.val(K.seen(hex(a.localKey)))) > g.seq), 20000)

  // N: the claimant's node, with a forged witness citing (carrier, j)
  forgeNext(c2, { witness: { weight: TIER, link: { key: c1.localKey, length: jLen } } })
  out.claimantAppend = (await timed(() => c2.createConcept('N', 'note'), 20000)).status
  await sleep(150) // tN < tk
  // k: the carrier's plain append. At weight 2 it cited g's approval and
  // climbed.
  out.carrierSecondAppend = (await timed(() => c1.createConcept('k', 'note'), 20000)).status

  // heal: one peer now holds both N and k. Every fold runs under a deadline.
  const before = coreStats(a)
  unpairCC = pair(c1, c2)
  const fold = await timed(
    () =>
      until(async () => {
        await a.update()
        return (await a.val(K.seen(c2Hex))) === 1 && (await a.val(K.seen(c1Hex))) === 2
      }, 20000),
    25000
  )
  out.foldGenesis = fold.status === 'ok' && fold.value === true ? 'ok' : fold.status === 'ok' ? 'NOT-FOLDED' : fold.status
  out.foldGenesisMs = fold.ms
  out.updateGenesis = (await timed(() => a.update(), 8000)).status
  out.updateCarrier = (await timed(() => c1.update(), 8000)).status
  await sleep(1000)
  out.updateGenesisAgain = (await timed(() => a.update(), 8000)).status
  out.undoDelta = coreStats(a).undos - before.undos

  // These reads fold first (sys and linearized call update), so they also
  // run under a deadline: a stalled peer gives TIMEOUT, not a hung test.
  const state = await timed(async () => {
    const carrier = await sys(a, c1.localKey)
    const claimant = await sys(a, c2.localKey)
    const heavier = (await linearized(a)).filter((n) => n.weight !== 0)
    return { sys: { carrier, claimant }, heavier, carriers: await carrierRows(a) }
  }, 20000)
  out.state = state.status
  Object.assign(out, state.value || {})
  out.expectedCarriers = [
    [c1Hex, true, false],
    [c2Hex, false, true]
  ].sort()

  unpairCC()
  unpairAC()
  await closeAll(c1, c2)
  out.errors = { victim: errorsOf(a), carrier: errorsOf(c1), claimant: errorsOf(c2) }
  out.reopen = await reopenCheck(a, aDir, 25000)
  closed = true
  return out
}

function assertNoLivelock(out) {
  assert.equal(out.carrierAppend, 'ok')
  assert.equal(out.claimantAdmitted, true, 'the forged approval adds the claimant at weight 0')
  assert.equal(out.claimantAppend, 'ok')
  assert.equal(out.carrierSecondAppend, 'ok')
  assert.equal(out.foldGenesis, 'ok', 'no livelock: genesis folds N and k within the deadline')
  assert.equal(out.updateGenesis, 'ok', 'no livelock: genesis update returns within the deadline')
  assert.equal(out.updateGenesisAgain, 'ok', 'no livelock: a later update also returns')
  assert.ok(out.undoDelta < 100, `undos stay bounded (${out.undoDelta})`)
  assert.equal(out.state, 'ok', 'genesis answers reads within the deadline')
  assert.deepEqual(out.sys.carrier, W0, 'the carrier stays at weight 0')
  assert.deepEqual(out.sys.claimant, W0, 'the claimant stays at weight 0: its witness claim never verifies')
  assert.deepEqual(out.heavier, [], 'every node resolves at weight 0')
  assert.deepEqual(out.carriers, out.expectedCarriers, 'the forged nodes are the only nodes with approvals or a witness')
  assert.equal(out.reopen.update, 'ok', 'genesis reopens and folds (no brick)')
}

test('A3 G1: no livelock driven by a member (s4)', { timeout: 2 * TIMEOUT }, async (t) => {
  const out = await livelock(t)
  await record(t, 'A3-G1-livelock-member', out)
  assertNoLivelock(out)
  assert.equal(out.updateCarrier, 'ok', 'no livelock: the carrier update returns within the deadline')
})

// G1 driven by strangers only (ab2-review/scratch-B/s5-stranger-livelock.mjs).
// Two keys of one outsider: the carrier's node j approves both keys, the
// claimant's node N cites j as a witness, and the carrier's node k follows.
// With optimistic: true, j reached apply and admitted both keys, which set
// up the livelock. Now no node of either key reaches apply.
test('A4 G1: strangers put no node into apply, so they drive no livelock (s5)', { timeout: TIMEOUT }, async (t) => {
  const a = quiet(await Bundle.init(await tmpDir('a4-a'))) // genesis
  const c1 = quiet(await Bundle.join(await tmpDir('a4-c1'), a.key)) // the carrier, never admitted
  const c2 = quiet(await Bundle.join(await tmpDir('a4-c2'), a.key)) // the claimant, never admitted
  const applied = { a: watchApply(a), c1: watchApply(c1), c2: watchApply(c2) }
  const unpairAC = pair(a, c1)
  let unpairCC = pair(c1, c2)
  t.after(async () => {
    unpairAC()
    unpairCC()
    await closeAll(a, c1, c2)
  })
  const out = { trigger: 'outsider' }

  // The honest ops come first: the seed, and g, the genesis append that
  // approved both keys at weight 2. At weight 0 no honest append carries
  // an approval (G35), so the place of g changes nothing.
  await a.createConcept('seed', 'note')
  await a.createConcept('g', 'note')
  const hash0 = await converged([a, c1, c2], 20000)

  // j: the carrier's node, whose approvals name both keys
  const j = await timed(async () => {
    const length = await outsiderAppend(c1, 'carrier-j', {
      approvals: [
        { key: c1.localKey, weight: TIER },
        { key: c2.localKey, weight: TIER }
      ]
    })
    await announce(c1, [{ key: c1.localKey, length }])
    return length
  }, 20000)
  out.carrierAppend = j.status
  const jLen = j.value
  out.claimantAdmitted = await until(async () => (await c2.update(), c2.writable), 3000)

  unpairCC() // cut the claimant off, as s5 does
  // N: the claimant's node, with a forged witness citing (carrier, j)
  const n = await timed(
    () => outsiderAppend(c2, 'N', { witness: { weight: TIER, link: { key: c1.localKey, length: jLen } } }),
    20000
  )
  out.claimantAppend = n.status
  await sleep(150) // tN < tk
  // k: the carrier's next node
  const k = await timed(() => outsiderAppend(c1, 'k'), 20000)
  out.carrierSecondAppend = k.status

  // heal: the claimant announces N to the carrier, and the carrier, a
  // modified client, relays both cores to genesis
  unpairCC = pair(c1, c2)
  const before = coreStats(a)
  out.relayed = await timed(async () => {
    await announce(c2, [{ key: c2.localKey, length: n.value }])
    await until(async () => (await c1.update(), await holds(c1, c2.localKey, n.value)), 20000)
    return announce(c1, [
      { key: c1.localKey, length: k.value },
      { key: c2.localKey, length: n.value }
    ])
  }, 30000)
  out.delivered = await until(
    async () => (await a.update(), (await holds(a, c1.localKey, k.value)) && (await holds(a, c2.localKey, n.value))),
    20000
  )
  await sleep(1000)
  out.peers = await outsiderRows(
    [
      ['a', a, applied.a],
      ['c1', c1, applied.c1],
      ['c2', c2, applied.c2]
    ],
    [c1.localKey, c2.localKey],
    hash0
  )
  out.undoDelta = coreStats(a).undos - before.undos
  out.errors = { victim: errorsOf(a), carrier: errorsOf(c1), claimant: errorsOf(c2) }
  await record(t, 'A4-G1-livelock-outsider', out)

  assert.ok(hash0, 'the peers converge before the attack')
  assert.equal(out.carrierAppend, 'ok')
  assert.equal(out.claimantAdmitted, false, 'j admits nobody, not even on the claimant')
  assert.equal(out.claimantAppend, 'ok')
  assert.equal(out.carrierSecondAppend, 'ok')
  assert.equal(out.delivered, true, 'genesis holds j, k and N (positive control)')
  assertOutsiderShut(out.peers)
  assert.equal(out.undoDelta, 0, 'genesis undoes nothing: no outsider node sorts into its order')
  assert.deepEqual(out.errors, { victim: [], carrier: [], claimant: [] }, 'no autobee closes')
})

// ---------------------------------------------------------------------------
// G35 (ab2-review/codex-B.out #5): autobee collects at most 32 approvals per
// append (index.js:1265-1268), so promotions stalled with more than 32
// pending. At weight 0 no peer collects an approval at all.
// ---------------------------------------------------------------------------
test('G35: no peer collects an approval, with more than 32 promotions pending', { timeout: TIMEOUT }, async (t) => {
  const a = quiet(await Bundle.init(await tmpDir('g35-a')))
  const b = quiet(await Bundle.join(await tmpDir('g35-b'), a.key))
  const unpair = pair(a, b)
  t.after(async () => {
    unpair()
    await closeAll(a, b)
  })
  const bHex = hex(b.localKey)
  const out = { trigger: 'member' }

  await a.writers.add(b.localKey, { indexer: true })
  assert.ok(await until(async () => (await b.update(), b.writable), 20000), 'b becomes writable')

  // one node of b names 40 keys nobody admitted: 40 pending promotions
  const named = Array.from({ length: 40 }, () => ({ key: randomBytes(32), weight: TIER }))
  forgeNext(b, { approvals: named })
  out.carrierAppend = (await timed(() => b.createConcept('g35/carrier', 'note'), 20000)).status
  out.carrierFolded = await until(async () => (await a.update(), (await a.val(K.seen(bHex))) === 1), 20000)
  const pending = async (v) => {
    let n = 0
    for (const { key } of named) if ((await v.db.system.pendingPromotion(key)) > 0) n++
    return n
  }
  out.pendingBefore = await pending(a)

  // three honest appends from each peer: at weight 2 each of genesis's
  // appends carried up to 32 approvals
  for (let i = 0; i < 3; i++) {
    await a.createConcept(`g35/a${i}`, 'note')
    await b.createConcept(`g35/b${i}`, 'note')
  }
  out.converged = (await converged([a, b], 25000)) !== null
  out.peers = {}
  for (const [name, v] of [['a', a], ['b', b]]) {
    const heavier = []
    for (const { key } of named) {
      const rec = await sys(v, key)
      if (!rec || rec.weight !== 0 || rec.maxWeight !== 0) heavier.push(hex(key))
    }
    out.peers[name] = { pending: await pending(v), carriers: await carrierRows(v), heavier }
  }
  out.errors = { a: errorsOf(a), b: errorsOf(b) }
  await record(t, 'G35-no-approval-collected', out)

  assert.equal(out.carrierAppend, 'ok')
  assert.equal(out.carrierFolded, true)
  assert.equal(out.pendingBefore, 40, 'every named key is a pending promotion')
  assert.equal(out.converged, true, 'the peers converge')
  for (const name of ['a', 'b']) {
    const p = out.peers[name]
    assert.deepEqual(p.carriers, [[bHex, true, false]], `${name}: no honest append carries approvals`)
    assert.equal(p.pending, 40, `${name}: no approval served a pending promotion`)
    assert.deepEqual(p.heavier, [], `${name}: every named key stays at weight 0`)
  }
})

// ---------------------------------------------------------------------------
// G50 (ab2-review/codex-B.out #4): a forged higher-tier approval suppressed
// a member's climb. At weight 0 no writer climbs, with or without it.
// ---------------------------------------------------------------------------
test('G50: no writer climbs, also when a member forges a higher-tier approval', { timeout: TIMEOUT }, async (t) => {
  const a = quiet(await Bundle.init(await tmpDir('g50-a')))
  const b = quiet(await Bundle.join(await tmpDir('g50-b'), a.key)) // an okf indexer
  const c = quiet(await Bundle.join(await tmpDir('g50-c'), a.key)) // a plain okf writer
  const unpairAB = pair(a, b)
  const unpairAC = pair(a, c)
  t.after(async () => {
    unpairAB()
    unpairAC()
    await closeAll(a, b, c)
  })
  const cHex = hex(c.localKey)
  const out = { trigger: 'member' }

  await a.writers.add(b.localKey, { indexer: true })
  await a.writers.add(c.localKey, { indexer: false })
  assert.ok(await until(async () => (await b.update(), await c.update(), b.writable && c.writable), 20000))

  // c names b at a tier above any standing
  forgeNext(c, { approvals: [{ key: b.localKey, weight: TIER + 1 }] })
  out.forgedAppend = (await timed(() => c.createConcept('g50/forged', 'note'), 20000)).status

  // honest rounds: at weight 2 genesis approved b and c, and each climbed
  // on its next append
  for (let i = 0; i < 3; i++) {
    for (const [name, v] of [['a', a], ['b', b], ['c', c]]) await v.createConcept(`g50/${name}${i}`, 'note')
  }
  out.converged = (await converged([a, b, c], 25000)) !== null
  out.peers = {}
  for (const [name, v] of [['a', a], ['b', b], ['c', c]]) {
    out.peers[name] = {
      sys: [await sys(v, a.localKey), await sys(v, b.localKey), await sys(v, c.localKey)],
      heavier: (await linearized(v)).filter((n) => n.weight !== 0),
      carriers: await carrierRows(v)
    }
  }
  out.errors = { a: errorsOf(a), b: errorsOf(b), c: errorsOf(c) }
  await record(t, 'G50-no-climb', out)

  assert.equal(out.forgedAppend, 'ok')
  assert.equal(out.converged, true, 'the peers converge')
  for (const name of ['a', 'b', 'c']) {
    const p = out.peers[name]
    assert.deepEqual(p.sys, [W0, W0, W0], `${name}: genesis, b and c stay at weight 0`)
    assert.deepEqual(p.heavier, [], `${name}: every node resolves at weight 0`)
    assert.deepEqual(p.carriers, [[cHex, true, false]], `${name}: only the forged node carries approvals`)
  }
})
