// Tests the fuzz shrinker with no processes. A synthetic predicate replaces
// a real failure, so the result does not depend on machine timing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateSchedule, shrinkSchedule, saveRegression } from '../lib/fuzz.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

function countOps(s) {
  return s.rounds.reduce((n, r) => n + r.ops.length, 0)
}

test('fuzz shrinker reduces a schedule to the minimal failing core', async () => {
  const schedule = generateSchedule(1, { writers: 3, rounds: 3, opsPerRound: 10 })
  const before = countOps(schedule)
  assert.ok(before >= 20)

  // The predicate fails on any delete op, so one delete is the true
  // minimal cause.
  const hasDelete = (s) => s.rounds.some((r) => r.ops.some((o) => o.kind === 'delete'))
  assert.ok(hasDelete(schedule), 'seed 1 contains a delete to shrink toward')

  const { schedule: minimal, runs } = await shrinkSchedule(schedule, { predicate: hasDelete })
  assert.ok(hasDelete(minimal), 'minimal schedule still reproduces the predicate')
  assert.ok(countOps(minimal) < before, `shrunk ${before} -> ${countOps(minimal)} ops`)
  assert.equal(countOps(minimal), 1, 'shrunk to the single causal op')
  assert.ok(runs > 0)

  const name = await saveRegression(minimal, { reason: 'synthetic', detail: 'shrinker self-test' })
  const path = join(ROOT, 'okf', 'test', 'regressions', name)
  const saved = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(saved.schedule.seed, 1)
  assert.ok(hasDelete(saved.schedule))
  await rm(path) // a self-test fixture, not a real repro
})
