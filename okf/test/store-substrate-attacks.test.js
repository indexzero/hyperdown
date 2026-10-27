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
// - A1, G3: a stranger's approval that names itself (s1).
// - A4, G1: the livelock driven by strangers only (s5).
// - A5, G2: an outsider's approval at weight 1e9, in a child process.
// - A6, G43: an outsider's forged witness that cites a present length.
// - A7, G5: an outsider's backdated node that links one side of a
//   concurrent pair.
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
  deliveredTo,
  watchApply,
  runChild
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
// G3 (ab2-review/scratch-B/s1-stranger-self-admit.mjs): a stranger sends one
// optimistic node whose approvals name itself. With optimistic: true that
// node reached apply, its approval added the stranger to autobee's system,
// and the stranger became writable.
// ---------------------------------------------------------------------------
test('A1 G3: a stranger cannot admit itself with a forged approval (s1)', { timeout: TIMEOUT }, async (t) => {
  const a = quiet(await Bundle.init(await tmpDir('a1-a')))
  const s = quiet(await Bundle.join(await tmpDir('a1-s'), a.key)) // never admitted
  const applied = { a: watchApply(a), s: watchApply(s) }
  const unpair = pair(a, s)
  t.after(async () => {
    unpair()
    await closeAll(a, s)
  })
  const sHex = hex(s.localKey)
  const out = { trigger: 'outsider' }

  const { tag: seed } = await a.createConcept('seed', 'note')
  out.strangerSynced = await until(async () => (await s.update(), (await s.val(K.cMeta(seed))) !== undefined), 20000)
  const hash0 = await converged([a, s], 20000)

  // the attack: one optimistic node whose approvals name the stranger
  const forged = await timed(async () => {
    const length = await outsiderAppend(s, 'from-s', { approvals: [{ key: s.localKey, weight: TIER }] })
    return announce(s, [{ key: s.localKey, length }])
  }, 20000)
  out.forged = forged.status === 'ok' && forged.value === true ? 'ok' : forged.status
  out.delivered = await until(async () => (await a.update(), await holds(a, s.localKey, 1)), 20000)
  out.strangerWritable = await until(async () => (await s.update(), s.writable), 3000)
  // the stranger's next append, through its Bundle
  const plain = await timed(() => s.createConcept('from-s-plain', 'note'), 20000)
  out.plainAppend = plain.status
  out.plainError = plain.error ?? null
  out.peers = await outsiderRows(
    [
      ['a', a, applied.a],
      ['s', s, applied.s]
    ],
    [s.localKey],
    hash0
  )
  out.govWriterOnA = (await a.val(K.govWriter(sHex))) ?? null
  out.errors = { victim: errorsOf(a), stranger: errorsOf(s) }
  await record(t, 'A1-G3-self-admission', out)

  assert.equal(out.strangerSynced, true)
  assert.ok(hash0, 'the peers converge before the attack')
  assert.equal(out.forged, 'ok')
  assert.equal(out.delivered, true, 'the forged node reached the victim (positive control)')
  assert.equal(out.strangerWritable, false, 'the stranger never becomes writable')
  assert.equal(out.plainAppend, 'ERROR')
  assert.match(out.plainError, /^VAULT_NOT_WRITABLE/, 'its next append fails fast')
  assertOutsiderShut(out.peers)
  assert.equal(out.govWriterOnA, null, 'okf never records a gov/writer for the stranger')
  assert.deepEqual(out.errors, { victim: [], stranger: [] }, 'no autobee closes')
})

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
//
// A Bundle outsider can write j only. N and k never get to a core: no
// peer applies j, so N's witness link to j is in no system, and the
// carrier's autobee never gets past j to k (attack-helpers.js
// outsiderAppend). Thus the test sends j, proves that every peer holds it,
// and asserts no effect on every peer.
test('A4 G1: strangers put no node into apply, so they drive no livelock (s5)', { timeout: TIMEOUT }, async (t) => {
  const a = quiet(await Bundle.init(await tmpDir('a4-a'))) // genesis
  const c1 = quiet(await Bundle.join(await tmpDir('a4-c1'), a.key)) // the carrier, never admitted
  const c2 = quiet(await Bundle.join(await tmpDir('a4-c2'), a.key)) // the claimant, never admitted
  const applied = { a: watchApply(a), c1: watchApply(c1), c2: watchApply(c2) }
  const unpairAC = pair(a, c1)
  const unpairCC = pair(c1, c2)
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
  const peers = [
    ['a', a, applied.a],
    ['c1', c1, applied.c1],
    ['c2', c2, applied.c2]
  ]

  // j: the carrier's node, whose approvals name both keys
  const before = coreStats(a)
  let jLen = 0
  const j = await timed(async () => {
    jLen = await outsiderAppend(c1, 'carrier-j', {
      approvals: [
        { key: c1.localKey, weight: TIER },
        { key: c2.localKey, weight: TIER }
      ]
    })
    return announce(c1, [{ key: c1.localKey, length: jLen }])
  }, 20000)
  out.carrierAppend = j.status === 'ok' && j.value === true ? 'ok' : j.status
  out.delivered = await deliveredTo(peers, [{ key: c1.localKey, length: jLen }])
  out.claimantAdmitted = await until(async () => (await c2.update(), c2.writable), 3000)
  await sleep(1000)
  out.peers = await outsiderRows(peers, [c1.localKey, c2.localKey], hash0)
  out.undoDelta = coreStats(a).undos - before.undos
  out.errors = { victim: errorsOf(a), carrier: errorsOf(c1), claimant: errorsOf(c2) }
  await record(t, 'A4-G1-livelock-outsider', out)

  assert.ok(hash0, 'the peers converge before the attack')
  assert.equal(out.carrierAppend, 'ok')
  assert.deepEqual(out.delivered, { a: true, c1: true, c2: true }, 'every peer holds j (positive control)')
  assert.equal(out.claimantAdmitted, false, 'j admits nobody, not even on the claimant')
  assertOutsiderShut(out.peers)
  assert.equal(out.undoDelta, 0, 'genesis undoes nothing: no outsider node sorts into its order')
  assert.deepEqual(out.errors, { victim: [], carrier: [], claimant: [] }, 'no autobee closes')
})

// ---------------------------------------------------------------------------
// G2 (ab2-review/codex-B.out #1): an approval's weight is unbounded. The
// peer that applies an approval at weight 1e9 walks one tier per unit of
// weight (lib/promotions.js:137, :144) until its heap runs out. With
// optimistic: true an outsider's optimistic node carried it into apply.
// Now autobee drops the node before _applyBatch, where approvals are read
// (index.js:1432-1441). It runs in a child process: a heap it exhausts
// must not take the test runner with it.
// ---------------------------------------------------------------------------
test('A5 G2: an outsider approval at weight 1e9 reaches no apply (child process)', { timeout: 2 * TIMEOUT }, async (t) => {
  const run = await runChild(['huge-approval', '1000000000'], 180000)
  const r = run.result
  await record(t, 'A5-G2-huge-approval-outsider', {
    trigger: 'outsider',
    childExit: run.code,
    childSignal: run.signal,
    childMs: run.ms,
    stderrTail: run.stderrTail || null,
    result: r
  })

  assert.equal(run.code, 0, `the child exits cleanly (${run.stderrTail})`)
  assert.ok(r, 'the child prints its result')
  assert.equal(r.error ?? null, null, 'the child throws nothing')
  assert.ok(r.hash0, 'the peers converge before the attack')
  assert.equal(r.forgedAppend, 'ok')
  assert.equal(r.delivered, true, 'the victim holds the forged node (positive control)')
  for (const name of ['a', 's']) {
    const p = r.peers[name]
    assert.equal(p.update, 'ok', `${name}: update() returns within the deadline`)
    assert.equal(p.hash, 'unchanged', `${name}: the view hash does not change`)
    assert.equal(p.applied, false, `${name}: no outsider node reaches apply`)
    assert.equal(p.seen, false, `${name}: no outsider op is counted in seen/`)
    assert.equal(p.namedInSystem, false, `${name}: the approval adds no writer`)
    assert.equal(p.outsiderInSystem, false, `${name}: autobee records no outsider key`)
  }
  assert.deepEqual(r.errors, { victim: [], outsider: [] }, 'no autobee closes')
})

// ---------------------------------------------------------------------------
// G43, the reachable variant (D-003 A6): a forged witness whose link cites
// a writer length that is present in the system. An outsider sends it.
// autobee still resolves the node's weight before the drop
// (lib/writers.js:195), so update() returning also shows that this
// resolution ends.
// ---------------------------------------------------------------------------
test('A6 G43: an outsider forged witness reaches no apply', { timeout: TIMEOUT }, async (t) => {
  const a = quiet(await Bundle.init(await tmpDir('a6-a')))
  const b = quiet(await Bundle.join(await tmpDir('a6-b'), a.key)) // a member, the cited writer
  const s = quiet(await Bundle.join(await tmpDir('a6-s'), a.key)) // the outsider
  const applied = { a: watchApply(a), b: watchApply(b), s: watchApply(s) }
  const unpairAB = pair(a, b)
  const unpairAS = pair(a, s)
  // No peer relays the outsider's core (attack-helpers.js outsiderAppend),
  // so b gets the forged node only from s itself.
  const unpairBS = pair(b, s)
  t.after(async () => {
    unpairAB()
    unpairAS()
    unpairBS()
    await closeAll(a, b, s)
  })
  const out = { trigger: 'outsider' }

  await a.writers.add(b.localKey, { indexer: false })
  assert.ok(await until(async () => (await b.update(), b.writable), 20000), 'b becomes writable')
  await b.createConcept('b-op', 'note')
  const citedLen = b.db.local.length
  out.citedPresentOnA = await until(async () => {
    await a.update()
    const rec = await a.db.system.get(b.localKey)
    return !!rec && rec.length >= citedLen
  }, 20000)
  const hash0 = await converged([a, b, s], 20000)
  const peers = [
    ['a', a, applied.a],
    ['b', b, applied.b],
    ['s', s, applied.s]
  ]

  let attackLen = 0
  const forged = await timed(async () => {
    attackLen = await outsiderAppend(s, 'forged-witness', {
      witness: { weight: TIER, link: { key: b.localKey, length: citedLen } }
    })
    return announce(s, [{ key: s.localKey, length: attackLen }])
  }, 20000)
  out.forged = forged.status === 'ok' && forged.value === true ? 'ok' : forged.status
  out.delivered = await deliveredTo(peers, [{ key: s.localKey, length: attackLen }])
  await sleep(500)
  out.peers = await outsiderRows(peers, [s.localKey], hash0)
  out.citedSys = await sys(a, b.localKey)
  out.errors = { victim: errorsOf(a), member: errorsOf(b), outsider: errorsOf(s) }
  await record(t, 'A6-G43-forged-witness-outsider', out)

  assert.equal(out.citedPresentOnA, true, 'the cited length is present in the system')
  assert.ok(hash0, 'the peers converge before the attack')
  assert.equal(out.forged, 'ok')
  assert.deepEqual(out.delivered, { a: true, b: true, s: true }, 'every peer holds the forged node (positive control)')
  assertOutsiderShut(out.peers)
  assert.deepEqual(out.citedSys, W0, 'the cited member stays at weight 0')
  assert.deepEqual(out.errors, { victim: [], member: [], outsider: [] }, 'no autobee closes')
})

// ---------------------------------------------------------------------------
// G5 (ab2-review/codex-B.out #3, D-003 A7): one node, backdated below a
// concurrent pair of member writes, linking only one side, with no system
// hash, so a receiver sorts it into the middle (index.js:1377-1384). With
// optimistic: true an outsider's node did this, and it flipped the LWW
// winner on every peer. The member variant stays a residual (T11).
// ---------------------------------------------------------------------------
test('A7 G5: an outsider backdated node flips no winner', { timeout: TIMEOUT }, async (t) => {
  const a = quiet(await Bundle.init(await tmpDir('a7-a')))
  const b = quiet(await Bundle.join(await tmpDir('a7-b'), a.key)) // a member
  const s = quiet(await Bundle.join(await tmpDir('a7-s'), a.key)) // the outsider
  const applied = { a: watchApply(a), b: watchApply(b), s: watchApply(s) }
  let unpairAB = pair(a, b)
  const unpairAS = pair(a, s)
  let unpairBS = pair(b, s) // full mesh
  t.after(async () => {
    unpairAB()
    unpairAS()
    unpairBS()
    await closeAll(a, b, s)
  })
  const out = { trigger: 'outsider' }

  await a.writers.add(b.localKey, { indexer: false })
  assert.ok(await until(async () => (await b.update(), b.writable), 20000), 'b becomes writable')
  const { tag: id } = await a.createConcept('conflict/target', 'note')
  assert.ok(await until(async () => (await b.update(), (await b.val(K.cMeta(id))) !== undefined), 20000))

  // the concurrent pair: b is cut off from every peer while both writes
  // happen, so neither write links the other
  unpairAB()
  unpairBS()
  await a.setField(id, 'status', ['from-a'])
  await sleep(150)
  await b.setField(id, 'status', ['from-b'])
  const bLen = b.db.local.length
  unpairAB = pair(a, b)
  unpairBS = pair(b, s)
  const hash0 = await converged([a, b, s], 25000)
  const w0 = hash0 ? await a.val(K.cField(id, 'status')) : null
  out.winnerBefore = w0 ? w0.values : null

  // the attack: backdated below both writes, linking only b's write
  const forged = await timed(async () => {
    const length = await outsiderAppend(s, 'attacker-node', {
      timestamp: Date.now() - 3600 * 1000,
      links: [{ key: b.localKey, length: bLen }],
      hash: null
    })
    return announce(s, [{ key: s.localKey, length }])
  }, 20000)
  out.forged = forged.status === 'ok' && forged.value === true ? 'ok' : forged.status
  out.delivered = await until(
    async () => (await a.update(), await b.update(), (await holds(a, s.localKey, 1)) && (await holds(b, s.localKey, 1))),
    20000
  )
  await sleep(1000)
  const before = coreStats(a)
  out.peers = await outsiderRows(
    [
      ['a', a, applied.a],
      ['b', b, applied.b],
      ['s', s, applied.s]
    ],
    [s.localKey],
    hash0
  )
  out.undoDelta = coreStats(a).undos - before.undos
  out.winnerAfter = {}
  for (const [name, v] of [['a', a], ['b', b], ['s', s]]) {
    const w = await v.val(K.cField(id, 'status'))
    out.winnerAfter[name] = w ? w.values : null
  }
  out.errors = { victim: errorsOf(a), member: errorsOf(b), outsider: errorsOf(s) }
  await record(t, 'A7-G5-backdated-outsider', out)

  assert.ok(hash0, 'the peers converge before the attack')
  assert.ok(out.winnerBefore, 'the concurrent pair has a winner')
  assert.equal(out.forged, 'ok')
  assert.equal(out.delivered, true, 'a and b hold the backdated node (positive control)')
  assertOutsiderShut(out.peers)
  for (const name of ['a', 'b', 's']) {
    assert.deepEqual(out.winnerAfter[name], out.winnerBefore, `${name}: the winner does not flip`)
  }
  assert.equal(out.undoDelta, 0, 'no reorder')
  assert.deepEqual(out.errors, { victim: [], member: [], outsider: [] }, 'no autobee closes')
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
