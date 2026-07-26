// S10 fuzz engine: seeded generation of random op schedules (including
// malformed ops, oversized subjects, unknown op types, garbage base
// hashes) across N writers with random partition schedules. After every
// heal: convergence hash check plus the independent I8 coherence check.
// On failure the schedule is greedily shrunk to a minimal repro; the
// minimal schedule is written to disk and replayable via runSchedule.
import { writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Controller } from './controller.js'
import { setupVaultCluster } from './setup.js'
import { checkCoherence } from './coherence.js'
import { Rng } from './rng.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

const SUBJECTS = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Home', 'agents/x/Note', 'a/b/c']

/** Generate a deterministic schedule from a seed. */
export function generateSchedule(seed, { writers = 3, rounds = 3, opsPerRound = 10 } = {}) {
  const rng = new Rng(seed)
  const schedule = { seed, writers, rounds: [] }
  for (let r = 0; r < rounds; r++) {
    const round = { partition: null, ops: [] }
    if (rng.chance(0.75) && writers > 1) {
      // random 2-way split
      const cut = 1 + rng.int(writers - 1)
      const ids = rng.shuffle([...Array(writers).keys()])
      round.partition = [ids.slice(0, cut), ids.slice(cut)]
    }
    for (let i = 0; i < opsPerRound; i++) {
      const w = rng.int(writers)
      const s = rng.pick(SUBJECTS)
      const roll = rng.next()
      let op
      if (roll < 0.14) op = { w, kind: 'set-field', s, o: `v${r}-${i}` }
      else if (roll < 0.28) op = { w, kind: 'add-member', s, o: rng.chance(0.5) ? `m${rng.int(4)}` : { ref: rng.pick(SUBJECTS) } }
      else if (roll < 0.38) op = { w, kind: 'rem-member', s, o: `m${rng.int(4)}` }
      else if (roll < 0.5) op = { w, kind: 'set-body', s, text: `body ${r}-${i}` }
      else if (roll < 0.56) op = { w, kind: 'garbage-base', s, base: 'ff'.repeat(32) }
      else if (roll < 0.62) op = { w, kind: 'delete-subject', s }
      else if (roll < 0.68) op = { w, kind: 'define-term', term: `t${rng.int(3)}`, set: rng.chance(0.5) }
      else if (roll < 0.76) op = { w, kind: 'oversized-subject', bytes: 1025 + rng.int(2000) }
      else if (roll < 0.84) op = { w, kind: 'malformed-raw', hex: randomHex(rng, 4 + rng.int(60)) }
      else if (roll < 0.9) op = { w, kind: 'unknown-msgid' }
      else if (roll < 0.96) op = { w, kind: 'set-path', s, path: rng.chance(0.5) ? `Notes/${s}.md` : '../escape.md' }
      else op = { w, kind: 'weird-subject', s: rng.pick(['hold', '', 'flag/x', 'ctx/gov/writer/00', 'n/../..', '%2F%25', 'seen/ff']) }
      round.ops.push(op)
    }
    schedule.rounds.push(round)
  }
  return schedule
}

function randomHex(rng, n) {
  let s = ''
  for (let i = 0; i < n; i++) s += rng.int(256).toString(16).padStart(2, '0')
  return s
}

async function execOp(writers, op) {
  const w = writers[op.w]
  try {
    switch (op.kind) {
      case 'set-field':
        return await w.call('setField', op.s, 'title', op.o)
      case 'add-member':
        return await w.call('addMember', op.s, 'topic', op.o)
      case 'rem-member':
        return await w.call('remMember', op.s, 'topic', op.o)
      case 'set-body':
        return await w.append('set-body', { s: op.s, base: null, text: op.text })
      case 'garbage-base':
        return await w.append('set-body', { s: op.s, base: op.base, text: 'garbage-base body' })
      case 'delete-subject':
        return await w.append('delete-subject', { s: op.s })
      case 'define-term':
        return await w.call(
          'defineTerm',
          'core',
          op.term,
          op.set ? { '@id': `ex:${op.term}`, '@container': '@set' } : { '@id': `ex:${op.term}` }
        )
      case 'oversized-subject':
        return await w.call('setField', 'S'.repeat(op.bytes), 'title', 'oversize')
      case 'malformed-raw':
        return await w.cmd('appendRaw', { hexBytes: op.hex })
      case 'unknown-msgid':
        // hyperdispatch id-space: a huge varint id that no decoder claims
        return await w.cmd('appendRaw', { hexBytes: 'fd4041' })
      case 'set-path':
        return await w.append('set-path', { s: op.s, path: op.path })
      case 'weird-subject':
        return await w.call('setField', op.s, 'title', 'weird')
    }
  } catch (err) {
    // op emission may legitimately throw (e.g. encoder rejects); the fuzz
    // cares about apply/view behavior, not client-side validation
    return { emitError: String(err.message).slice(0, 120) }
  }
}

/**
 * Run one schedule against real writer processes.
 * @returns {null | { round, reason, detail }} first failure, or null
 */
export async function runSchedule(schedule, { profile, keepController = null } = {}) {
  const { ctl, writers } = await setupVaultCluster(`fuzz-${schedule.seed}`, schedule.writers, {
    seed: schedule.seed,
    profile
  })
  try {
    // shared schema so or-set/scalar terms exist
    await writers[0].call('defineTerm', 'core', 'title', { '@id': 'ex:title' })
    await writers[0].call('defineTerm', 'core', 'topic', { '@id': 'ex:topic', '@container': '@set' })
    await ctl.quiesce(writers)

    for (let r = 0; r < schedule.rounds.length; r++) {
      const round = schedule.rounds[r]
      if (round.partition) {
        const [g1, g2] = round.partition
        await ctl.partition(
          g1.map((i) => writers[i]),
          g2.map((i) => writers[i])
        )
      }
      for (const op of round.ops) await execOp(writers, op)
      await ctl.connectAll(writers)
      let hash
      try {
        hash = await ctl.quiesce(writers)
      } catch (err) {
        return { round: r, reason: 'divergence', detail: err.message }
      }
      for (const w of writers) {
        const dump = await w.dump('')
        const violations = checkCoherence(dump, { rootBase: 'vault://data/' })
        if (violations.length) {
          return { round: r, reason: 'coherence', detail: `${w.name}: ${violations.slice(0, 10).join('; ')}` }
        }
      }
      void hash
    }
    return null
  } finally {
    if (keepController) keepController.push(ctl)
    else await ctl.stop()
  }
}

/**
 * Greedy shrink: drop rounds, then ops, then partitions, while the failure
 * still reproduces. `predicate(schedule) -> bool` defaults to running the
 * schedule against real processes; inject a synthetic predicate to unit-
 * test the shrink machinery without spawning anything.
 */
export async function shrinkSchedule(schedule, { profile, maxRuns = 40, predicate = null } = {}) {
  let best = schedule
  let runs = 0
  const fails = async (s) => {
    if (runs >= maxRuns) return false
    runs++
    if (predicate) return predicate(s)
    return (await runSchedule(s, { profile })) !== null
  }
  // 1. drop whole rounds
  for (let r = best.rounds.length - 1; r >= 0; r--) {
    if (best.rounds.length <= 1) break
    const cand = { ...best, rounds: best.rounds.filter((_, i) => i !== r) }
    if (await fails(cand)) best = cand
  }
  // 2. drop individual ops
  for (let r = 0; r < best.rounds.length; r++) {
    for (let i = best.rounds[r].ops.length - 1; i >= 0; i--) {
      const cand = {
        ...best,
        rounds: best.rounds.map((round, ri) =>
          ri === r ? { ...round, ops: round.ops.filter((_, oi) => oi !== i) } : round
        )
      }
      if (await fails(cand)) best = cand
    }
  }
  // 3. drop the partition if it is not needed
  for (let r = 0; r < best.rounds.length; r++) {
    if (!best.rounds[r].partition) continue
    const cand = {
      ...best,
      rounds: best.rounds.map((round, ri) => (ri === r ? { ...round, partition: null } : round))
    }
    if (await fails(cand)) best = cand
  }
  return { schedule: best, runs }
}

/** Persist a shrunk failing schedule as a committed regression fixture. */
export async function saveRegression(schedule, failure) {
  const dir = join(ROOT, 'test', 'regressions')
  await mkdir(dir, { recursive: true })
  const name = `fuzz-seed-${schedule.seed}.json`
  await writeFile(
    join(dir, name),
    JSON.stringify({ failure, schedule }, null, 2) + '\n'
  )
  return name
}
