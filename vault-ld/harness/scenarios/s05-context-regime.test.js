// S5 (I1) context regime reorder. The indexer flips a term between scalar
// and @set concurrently with field writes to that term, healed such that
// linearization can differ from any writer's local perception. Convergence
// must hold regardless of the semantic surprise, and the two heal orders
// of the same universe must agree bit-for-bit (apply-time-policy rule,
// §5.7: merge policy is read from the in-log context at apply time).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupVaultCluster } from '../lib/setup.js'

test('S5: DefineTerm kind flip concurrent with field writes converges (I1)', async (t) => {
  const { ctl, writers } = await setupVaultCluster('s05', 3)
  t.after(() => ctl.stop())
  const [a, b, c] = writers

  // regime 0: 'tag' is a scalar
  await a.call('defineTerm', 'core', 'tag', { '@id': 'ex:tag' })
  await b.call('setField', 'Home', 'tag', 'epoch0')
  await ctl.quiesce(writers)

  // partition: A flips the term to @set while B and C write to it under
  // their local (scalar) perception
  await ctl.partition([a], [b, c])
  await ctl.partition([b], [c])
  await ctl.barrier([
    () => a.call('defineTerm', 'core', 'tag', { '@id': 'ex:tag', '@container': '@set' }),
    () => b.call('setField', 'Home', 'tag', 'from-b', { ctxKind: 'scalar' }),
    () => c.call('setField', 'Other', 'tag', 'from-c')
  ])
  await Promise.all(writers.map((w) => w.update()))

  const cloneL = await ctl.cloneUniverse(writers, 'L')
  const cloneR = await ctl.cloneUniverse(writers, 'R')

  // L: definer's flip reaches the mesh before the field writes
  await ctl.connect(cloneL[0], cloneL[1])
  await ctl.quiesce([cloneL[0], cloneL[1]])
  await ctl.connectAll(cloneL)
  const hashL = await ctl.quiesce(cloneL)

  // R: field writes first, then the flip
  await ctl.connect(cloneR[1], cloneR[2])
  await ctl.quiesce([cloneR[1], cloneR[2]])
  await ctl.connectAll(cloneR)
  const hashR = await ctl.quiesce(cloneR)

  assert.equal(hashL, hashR, `heal order changed the converged view (seed=${ctl.seed})`)

  // §5.7 semantics: identical term state everywhere; ctxKind-pinned writes
  // that crossed the flip are kindshift-flagged (auditable), never silent
  const states = new Set()
  for (const w of [...cloneL, ...cloneR]) {
    const term = await w.val('ctx/t/tag')
    const home = await w.val('n/Home/f/tag')
    const kindshiftFlags = Object.keys(await w.dump('flag/kindshift/'))
    states.add(JSON.stringify({ term, home, kindshiftFlags }))
  }
  assert.equal(states.size, 1, 'apply-time policy resolution identical everywhere')
  const st = JSON.parse([...states][0])
  assert.equal(st.term.kind, 'set', 'the flip itself linearized')
})
