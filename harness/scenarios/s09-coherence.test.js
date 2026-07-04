// S9 (I8) index coherence under churn. Seeded random rename/relink
// workload across three writers with random partitions; at every quiescent
// point, verify by full scan that idx/*, bl/* (and the bookkeeping reverse
// indexes) are exactly derivable from n/* — using the independent checker
// in ../lib/coherence.js, not the code under test.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupVaultCluster } from '../lib/setup.js'
import { checkCoherence } from '../lib/coherence.js'

test('S9: idx/* and bl/* exactly derivable from n/* under churn (I8)', async (t) => {
  const { ctl, writers } = await setupVaultCluster('s09', 3)
  t.after(() => ctl.stop())
  const [a] = writers
  const rng = ctl.rng.child('s09-workload')

  await a.call('defineTerm', 'core', 'title', { '@id': 'ex:title' })
  await a.call('defineTerm', 'core', 'link', { '@id': 'ex:link', '@container': '@set' })
  await ctl.quiesce(writers)

  const subjects = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta']
  const ROUNDS = 4
  for (let round = 0; round < ROUNDS; round++) {
    // random partition for this round
    const cut = rng.chance(0.7)
    if (cut) {
      const isolated = writers[rng.int(writers.length)]
      await ctl.partition(
        [isolated],
        writers.filter((w) => w !== isolated)
      )
    }

    const opsThisRound = 12
    for (let i = 0; i < opsThisRound; i++) {
      const w = writers[rng.int(writers.length)]
      const s = rng.pick(subjects)
      const kind = rng.int(6)
      try {
        if (kind === 0) await w.call('setField', s, 'title', `t${round}-${i}`)
        else if (kind === 1) await w.call('addMember', s, 'link', { ref: rng.pick(subjects) })
        else if (kind === 2) await w.call('remMember', s, 'link', { ref: rng.pick(subjects) })
        else if (kind === 3) await w.append('set-path', { s, path: `Notes/${s}-${round}.md` })
        else if (kind === 4) await w.append('delete-subject', { s })
        else await w.call('setField', s, 'title', `re-${round}-${i}`)
      } catch (err) {
        // a partitioned writer may reject helper calls that need the view;
        // the workload itself must never crash the harness
        ctl.log(`workload op error: ${err.message}`)
      }
    }

    await ctl.connectAll(writers)
    const hash = await ctl.quiesce(writers)
    assert.ok(hash, `round ${round} converges`)

    // quiescent-point coherence check on EVERY peer, independently
    for (const w of writers) {
      const dump = await w.dump('')
      const violations = checkCoherence(dump, { rootBase: 'vault://data/' })
      assert.deepEqual(
        violations,
        [],
        `round ${round} ${w.name}: ${violations.length} coherence violations (seed=${ctl.seed})`
      )
    }
  }
})
