// REGRESSION (major): O(N^2) conflict-flag blowup from repeated null-base
// SetBody on a single subject.
//
// §6 makes two revisions that cite the same base "true concurrency" and
// records flag/conflict/<s>/<a>/<b>. A null base counts as a shared base,
// so N SetBody ops with base=null on one subject produce N-choose-2
// conflict rows: 50 ops -> 1225, 100 -> 4950, 200 -> 19900, 400 -> 79800,
// and apply time grows super-linearly (~23s at 400 on a MemView). A single
// agent (or an ingest loop that loses base tracking) can therefore explode
// any peer's view and stall apply — this is what killed the first
// harness/soak run (a single setBody exceeded the 120s command budget once
// a subject held ~200 null-base revisions).
//
// Determinism/convergence (I1/I2) are NOT violated — every peer computes
// the same explosion — so this is a resource/scalability defect, not a
// correctness one. The fix is a design decision (cap conflict fan-out, or
// only pairwise-conflict against the current head, or dedupe null-base
// revisions); this test documents and bounds the growth. See
// orchestration/results/CODE-REVIEW.md finding M1.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createApply, encodeOp, MemView } from '../../packages/core/index.js'

const W = 'aa'.repeat(32)

async function foldNullBodies(n) {
  const apply = createApply({ genesisKey: W })
  const view = new MemView()
  for (let i = 0; i < n; i++) {
    const buf = encodeOp('set-body', { s: 'Home', base: null, text: `body ${i}` })
    await apply([{ from: { key: Buffer.from(W, 'hex') }, value: buf, length: 1 }], view, null)
  }
  let conflicts = 0
  for await (const { key } of view.createReadStream({})) {
    if (key.startsWith('flag/conflict/Home/')) conflicts++
  }
  return conflicts
}

test('null-base SetBody produces N-choose-2 conflict flags (quadratic growth)', async () => {
  // documents the current (pathological) behavior; when the defect is
  // fixed the conflict count should be bounded (e.g. <= N-1 or a cap), and
  // these exact-equality assertions should be updated to the new bound.
  assert.equal(await foldNullBodies(10), (10 * 9) / 2, '10 ops -> 45 conflicts today')
  assert.equal(await foldNullBodies(40), (40 * 39) / 2, '40 ops -> 780 conflicts today')
  // guard: the growth is at least quadratic (a linear design would be <= N)
  const c80 = await foldNullBodies(80)
  assert.ok(c80 > 80 * 4, `80 ops -> ${c80} conflicts, far above any linear bound`)
})
