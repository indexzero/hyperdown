// REGRESSION (major, FIXED): O(N^2) conflict-flag blowup + O(R) per-op
// revision rescan from repeated SetBody on a single subject.
//
// Before the fix, §6's "two revisions citing the same base are true
// concurrency" treated a null base as a shared base, so N SetBody ops with
// base=null on one subject produced N-choose-2 flag/conflict rows
// (50 -> 1225, 100 -> 4950, 400 -> 79800) and every SetBody — null base or
// not — rescanned the subject's entire n/<s>/rev/* set, making apply time
// quadratic per subject (~23s at 400 null-base ops on a MemView; a single
// setBody exceeded the harness's 120s command budget once a subject held
// ~200 revisions, killing two soak runs). See CODE-REVIEW.md finding M1.
//
// The fix (vault-ld/core/lib/apply.js opSetBody):
//   1. same-base concurrency is found via the base-keyed bookkeeping index
//      revbybase/<s>/<base>/<rev> in O(matches), not a full-revision scan;
//   2. a null base is "no base cited": independent null-base creations are
//      LWW on the head pointer and raise NO mutual flag/conflict (their
//      cross-writer supersession is still surfaced via §5.4 flag/clobber);
//      flag/conflict is reserved for same-NON-null-base concurrency.
// I4 holds throughout: every revision is retained and observable, the head
// is deterministic, and a true same-base pair yields exactly one flag.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createApply, encodeOp, revHash, MemView } from '../../vault-ld/core/index.js'
import { run, n, addWriters, K, GEN, W1, W2 } from '../helpers.js'

const W = 'aa'.repeat(32) // genesis writer of the manual folds below

/** Fold n SetBody ops (one apply() per op, like the original repro). */
async function foldBodies(n, baseFor) {
  const apply = createApply({ genesisKey: W })
  const view = new MemView()
  const t0 = process.hrtime.bigint()
  let prev = null
  for (let i = 0; i < n; i++) {
    const base = baseFor(prev, i)
    const text = `body ${i}`
    const buf = encodeOp('set-body', { s: 'Home', base, text })
    await apply([{ from: { key: Buffer.from(W, 'hex') }, value: buf, length: 1 }], view, null)
    prev = revHash(base, text)
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  let conflicts = 0
  let revs = 0
  for await (const { key } of view.createReadStream({})) {
    if (key.startsWith('flag/conflict/Home/')) conflicts++
    if (key.startsWith('n/Home/rev/')) revs++
  }
  const head = (await view.get('n/Home/body')).value
  return { conflicts, revs, head, ms }
}

test('null-base SetBody raises no mutual conflicts and applies in ~linear time', async () => {
  // null base = "no base cited": LWW on the head pointer, zero flag/conflict
  // rows regardless of N (was N-choose-2 before the fix).
  for (const nOps of [10, 40, 80]) {
    const { conflicts, revs } = await foldBodies(nOps, () => null)
    assert.equal(conflicts, 0, `${nOps} null-base ops -> 0 conflict flags`)
    assert.equal(revs, nOps, `${nOps} ops -> all ${nOps} revisions retained (I4)`)
  }
  // the 400-op case took ~23.5s before the fix; well under 1s after it.
  const big = await foldBodies(400, () => null)
  assert.equal(big.conflicts, 0, '400 null-base ops -> 0 conflict flags')
  assert.equal(big.revs, 400, 'all 400 revisions retained (I4)')
  assert.equal(big.head, revHash(null, 'body 399'), 'head is the last revision (LWW)')
  assert.ok(big.ms < 1000, `400 null-base ops applied in ${big.ms.toFixed(1)}ms (< 1000ms)`)
})

test('chained SetBody (base = head) no longer pays an O(R) scan per op', async () => {
  // clean succession: each revision cites the previous head, so each base
  // has exactly one citing revision -> no conflicts, O(1) index lookups.
  const { conflicts, revs, ms } = await foldBodies(400, (prev) => prev)
  assert.equal(conflicts, 0, 'chained succession raises no conflicts')
  assert.equal(revs, 400, 'all 400 revisions retained (I4)')
  assert.ok(ms < 1000, `400 chained ops applied in ${ms.toFixed(1)}ms (< 1000ms)`)
})

test('cross-writer null-base supersession is surfaced via §5.4 clobber, not §6 conflict', async () => {
  const r1 = revHash(null, 'from w1')
  const r2 = revHash(null, 'from w2')
  const { view } = await run([
    ...addWriters([W1, false], [W2, false]),
    n(W1, 'set-body', { s: 'A', base: null, text: 'from w1' }),
    n(W2, 'set-body', { s: 'A', base: null, text: 'from w2' })
  ])
  assert.equal(Object.keys(view.dump('flag/conflict/')).length, 0, 'no conflict for null-base pair')
  assert.equal(Object.keys(view.dump('flag/clobber/')).length, 1, 'supersession is not silent (I4)')
  assert.ok(await view.get(K.nRev('A', r1)), 'superseded revision retained (I4)')
  assert.ok(await view.get(K.nRev('A', r2)))
  assert.equal((await view.get(K.nBody('A'))).value, r2, 'head LWW under linearization')
})

test('true same-non-null-base concurrency still yields exactly one conflict flag (§6)', async () => {
  const r0 = revHash(null, 'seed')
  const r1 = revHash(r0, 'branch one')
  const r2 = revHash(r0, 'branch two')
  const [a, b] = [r1, r2].sort()
  const { view } = await run([
    ...addWriters([W1, false], [W2, false]),
    n(GEN, 'set-body', { s: 'A', base: null, text: 'seed' }),
    n(W1, 'set-body', { s: 'A', base: r0, text: 'branch one' }),
    n(W2, 'set-body', { s: 'A', base: r0, text: 'branch two' })
  ])
  const conflicts = Object.keys(view.dump('flag/conflict/'))
  assert.deepEqual(conflicts, [K.flag('conflict', 'A', a, b)], 'exactly one flag for the pair')
  assert.ok(await view.get(K.nRev('A', r1)), 'both revisions retained (I4)')
  assert.ok(await view.get(K.nRev('A', r2)))
})
