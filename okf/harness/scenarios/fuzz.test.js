// Seeded fuzz over 3 to 7 real writer processes with random
// partitions. After every heal, the convergence hash and a coherence check
// that never calls the code under test. A failure shrinks to a minimal
// repro in okf/harness/regressions/. HARNESS_FUZZ_ITERS sets the iterations,
// default 3, and HARNESS_SEED the base seed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveProfile } from '../lib/profiles.js'
import { resolveSeed } from '../lib/rng.js'
import { generateSchedule, runSchedule, shrinkSchedule, saveRegression } from '../lib/fuzz.js'

const ITERS = Number(process.env.HARNESS_FUZZ_ITERS || 3)

test(`seeded fuzz x${ITERS}: the peers converge and pass an independent I8 check after every heal`, async () => {
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
          `shrunk in ${runs} runs -> okf/harness/regressions/${name}`
      )
    }
  }
})
