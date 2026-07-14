// S10 — seeded fuzz. A seeded generator produces random op schedules
// (including malformed ops, oversized paths, unknown op types, garbage bases,
// and adversarial _id mint attempts) across 3-7 real writer processes with
// random partition schedules. After EVERY heal: the convergence hash across
// peers, plus an INDEPENDENT index-coherence check (path/, link/, bl/,
// wanted/, wantedrank/, revbybase/ derivable from c/ — the checker never
// calls the code under test). On failure the schedule is shrunk to a minimal
// repro and committed to okf/test/regressions/.
//
// Iterations via HARNESS_FUZZ_ITERS (default 3); base seed via HARNESS_SEED.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveProfile } from '../lib/profiles.js'
import { resolveSeed } from '../lib/rng.js'
import { generateSchedule, runSchedule, shrinkSchedule, saveRegression } from '../lib/fuzz.js'

const ITERS = Number(process.env.HARNESS_FUZZ_ITERS || 3)

test(`S10: seeded fuzz x${ITERS} (convergence + independent I8 after every heal)`, async () => {
  const profile = resolveProfile()
  const baseSeed = resolveSeed()
  console.log(`[fuzz] baseSeed=${baseSeed} iters=${ITERS} profile=${profile.name}`)
  for (let i = 0; i < ITERS; i++) {
    const seed = (baseSeed + i * 0x9e3779b9) >>> 0
    const writers = 3 + ((seed >>> 8) % 5) // 3..7 real processes
    const schedule = generateSchedule(seed, { writers, rounds: 3, opsPerRound: 10 })
    console.log(`[fuzz] iter=${i} seed=${seed} writers=${writers}`)
    const failure = await runSchedule(schedule, { profile })
    if (failure) {
      console.log(`[fuzz] FAILURE seed=${seed}: ${failure.reason} @round ${failure.round}`)
      const { schedule: minimal, runs } = await shrinkSchedule(schedule, { profile })
      const refail = await runSchedule(minimal, { profile })
      const name = await saveRegression(minimal, refail || failure)
      assert.fail(
        `fuzz seed=${seed} failed (${failure.reason}: ${failure.detail}); ` +
          `shrunk in ${runs} runs -> okf/test/regressions/${name}`
      )
    }
  }
})
