// S10 fuzz. Seeded generator producing random op schedules (malformed
// ops, oversized subjects, unknown op types, garbage base hashes, hostile
// subject names) across 3-5 writer processes with random partition
// schedules. After every heal: convergence hash check + the independent
// I8 coherence check. On failure the schedule is shrunk to a minimal
// repro and written to test/regressions/ as a named regression fixture.
//
// Iterations via HARNESS_FUZZ_ITERS (default 3); base seed via
// HARNESS_SEED (default clock).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveProfile } from '../lib/profiles.js'
import { resolveSeed } from '../lib/rng.js'
import { generateSchedule, runSchedule, shrinkSchedule, saveRegression } from '../lib/fuzz.js'

const ITERS = Number(process.env.HARNESS_FUZZ_ITERS || 3)

test(`S10: seeded fuzz x${ITERS} (convergence + I8 after every heal)`, async () => {
  const profile = resolveProfile()
  const baseSeed = resolveSeed()
  console.log(`[fuzz] baseSeed=${baseSeed} iters=${ITERS} profile=${profile.name}`)
  for (let i = 0; i < ITERS; i++) {
    const seed = (baseSeed + i * 0x9e3779b9) >>> 0
    const writers = 3 + ((seed >>> 8) % 3) // 3..5 real processes
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
          `shrunk in ${runs} runs -> test/regressions/${name}`
      )
    }
  }
})
