// Validates the S10 fuzz machinery itself (no processes): a schedule that
// fails a synthetic predicate is shrunk to (near-)minimal and persisted as
// a named regression fixture. This exercises generateSchedule /
// shrinkSchedule / saveRegression end-to-end so the "shrunk fuzz repro
// committed as a regression" pipeline is proven, decoupled from machine
// timing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateSchedule, shrinkSchedule, saveRegression } from '../lib/fuzz.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function countOps(s) {
  return s.rounds.reduce((n, r) => n + r.ops.length, 0)
}

test('fuzz shrinker reduces a schedule to the minimal failing core', async () => {
  const schedule = generateSchedule(12345, { writers: 3, rounds: 3, opsPerRound: 10 })
  const before = countOps(schedule)
  assert.ok(before >= 20)

  // synthetic failure predicate: "fails" iff a delete-subject op is present
  // (a single op is the true minimal cause). The shrinker must strip
  // everything else while keeping at least one delete-subject.
  const hasDelete = (s) => s.rounds.some((r) => r.ops.some((o) => o.kind === 'delete-subject'))
  assert.ok(hasDelete(schedule), 'seed 12345 contains a delete-subject to shrink toward')

  const { schedule: minimal, runs } = await shrinkSchedule(schedule, { predicate: hasDelete })
  assert.ok(hasDelete(minimal), 'minimal schedule still reproduces the predicate')
  assert.ok(countOps(minimal) < before, `shrunk ${before} -> ${countOps(minimal)} ops`)
  assert.equal(countOps(minimal), 1, 'shrunk to the single causal op')
  assert.ok(runs > 0)

  // persist + read back the fixture (proves saveRegression round-trips)
  const name = await saveRegression(minimal, { reason: 'synthetic', detail: 'shrinker self-test' })
  const path = join(ROOT, 'test', 'regressions', name)
  const saved = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(saved.schedule.seed, 12345)
  assert.ok(hasDelete(saved.schedule))
  await rm(path) // self-test fixture is not a real repro; do not keep it
})
