// S10 fuzz engine (okf harness): seeded random op schedules across N writers
// with random partition schedules — including malformed ops, oversized
// paths, unknown op types, garbage bases, and adversarial _id mint attempts.
// After every heal: the convergence hash (across peers) AND an INDEPENDENT
// index-coherence check (path/, link/, bl/, wanted/, wantedrank/, revbybase/
// derivable from c/ — coherence.js reimplements the checker, it never calls
// the code under test). On failure the schedule is greedily shrunk to a
// minimal repro and written to okf/test/regressions/ as a committed fixture.
import { writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setupVaultCluster } from './setup.js'
import { checkCoherence } from './coherence.js'
import { Rng } from './rng.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

// Symbolic subjects: a fixed pool the generator references; each maps at
// runtime to whatever _id gets minted (writer keys are random per run, so a
// schedule must be id-agnostic to replay). Every subject's canonical path is
// `notes/<subject>`, so body links (`/notes/<subject>`) resolve deterministically.
const SUBJECTS = ['alpha', 'beta', 'gamma', 'delta', 'home', 'a/b/c', 'wiki/x']

const pathOf = (s) => `notes/${s}`

/** Generate a deterministic schedule from a seed. */
export function generateSchedule(seed, { writers = 3, rounds = 3, opsPerRound = 10 } = {}) {
  const rng = new Rng(seed)
  const schedule = { seed, writers, rounds: [] }
  for (let r = 0; r < rounds; r++) {
    const round = { partition: null, ops: [] }
    if (rng.chance(0.75) && writers > 1) {
      const cut = 1 + rng.int(writers - 1)
      const ids = rng.shuffle([...Array(writers).keys()])
      round.partition = [ids.slice(0, cut), ids.slice(cut)]
    }
    for (let i = 0; i < opsPerRound; i++) {
      const w = rng.int(writers)
      const s = rng.pick(SUBJECTS)
      const roll = rng.next()
      let op
      if (roll < 0.16) op = { w, kind: 'create', s }
      else if (roll < 0.3) op = { w, kind: 'set-field', s, key: `k${rng.int(3)}`, value: `v${r}-${i}` }
      else if (roll < 0.42) op = { w, kind: 'add-tag', s, value: `t${rng.int(4)}` }
      else if (roll < 0.5) op = { w, kind: 'rem-tag', s, value: `t${rng.int(4)}` }
      else if (roll < 0.6) op = { w, kind: 'set-body', s, text: `body ${r}-${i} [l](/${pathOf(rng.pick(SUBJECTS))})` }
      else if (roll < 0.68) op = { w, kind: 'set-path', s, to: pathOf(rng.pick(SUBJECTS)) }
      else if (roll < 0.74) op = { w, kind: 'delete', s }
      else if (roll < 0.78) op = { w, kind: 'undelete', s }
      else if (roll < 0.84) op = { w, kind: 'garbage-base', s }
      else if (roll < 0.88) op = { w, kind: 'oversized-path' }
      else if (roll < 0.92) op = { w, kind: 'malformed-raw', hex: randomHex(rng, 4 + rng.int(40)) }
      else if (roll < 0.95) op = { w, kind: 'unknown-msgid' }
      else if (roll < 0.98) op = { w, kind: 'adversarial-id', s, mode: rng.chance(0.5) ? 'dup' : 'mint-shaped' }
      else op = { w, kind: 'weird-path', to: rng.pick(['/abs', '../escape', 'a//b', 'x/index', 'y/log', 'p.conflict-deadbeef']) }
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

/** Resolve (creating if needed) the id a subject maps to this run. */
async function ensure(state, writers, w, s) {
  if (state.ids.has(s)) return state.ids.get(s)
  const res = await writers[w].call('createConcept', pathOf(s), 'note')
  if (res && res.tag) state.ids.set(s, res.tag)
  return state.ids.get(s)
}

async function execOp(state, writers, op) {
  const w = writers[op.w]
  try {
    switch (op.kind) {
      case 'create': {
        // first create registers the subject; a repeat mints a colliding
        // concept on the same path (exercises pathcollision)
        if (!state.ids.has(op.s)) return await ensure(state, writers, op.w, op.s)
        return await w.call('createConcept', pathOf(op.s), 'note')
      }
      case 'set-field':
        return await w.call('setField', await ensure(state, writers, op.w, op.s), op.key, op.value)
      case 'add-tag':
        return await w.call('addTag', await ensure(state, writers, op.w, op.s), op.value)
      case 'rem-tag':
        return await w.call('remTag', await ensure(state, writers, op.w, op.s), op.value)
      case 'set-body':
        return await w.append('set-body', { id: await ensure(state, writers, op.w, op.s), base: null, text: op.text })
      case 'set-path':
        return await w.call('setPath', await ensure(state, writers, op.w, op.s), op.to)
      case 'delete':
        return await w.call('deleteConcept', await ensure(state, writers, op.w, op.s))
      case 'undelete':
        return await w.call('undeleteConcept', await ensure(state, writers, op.w, op.s))
      case 'garbage-base':
        return await w.append('set-body', { id: await ensure(state, writers, op.w, op.s), base: 'ff'.repeat(32), text: 'garbage-base' })
      case 'oversized-path':
        return await w.call('createConcept', 'S'.repeat(1025 + (op.w % 3)), 'note')
      case 'malformed-raw':
        return await w.cmd('appendRaw', { hexBytes: op.hex })
      case 'unknown-msgid':
        return await w.cmd('appendRaw', { hexBytes: 'fd4041' })
      case 'adversarial-id': {
        const id = op.mode === 'dup'
          ? (state.ids.get(op.s) || 'abcdef0123456789')
          : (w.info.localKey + '5') // writerKey||seqHex shape → mint-collision-risk
        return await w.call('createConcept', pathOf(`${op.s}-adv`), 'note', { id })
      }
      case 'weird-path':
        return await w.call('createConcept', op.to, 'note')
    }
  } catch (err) {
    return { emitError: String(err.message).slice(0, 120) }
  }
}

/**
 * Run one schedule against real writer processes.
 * @returns {null | { round, reason, detail }} first failure, or null
 */
export async function runSchedule(schedule, { profile } = {}) {
  const { ctl, writers } = await setupVaultCluster(`fuzz-${schedule.seed}`, schedule.writers, {
    seed: schedule.seed,
    profile
  })
  const state = { ids: new Map() }
  try {
    await ctl.quiesce(writers)
    for (let r = 0; r < schedule.rounds.length; r++) {
      const round = schedule.rounds[r]
      if (round.partition) {
        const [g1, g2] = round.partition
        await ctl.partition(g1.map((i) => writers[i]), g2.map((i) => writers[i]))
      }
      for (const op of round.ops) await execOp(state, writers, op)
      await ctl.connectAll(writers)
      let hash
      try {
        hash = await ctl.quiesce(writers)
      } catch (err) {
        return { round: r, reason: 'divergence', detail: err.message }
      }
      for (const wr of writers) {
        const dump = await wr.dump('')
        const violations = checkCoherence(dump)
        if (violations.length) {
          return { round: r, reason: 'coherence', detail: `${wr.name}: ${violations.slice(0, 10).join('; ')}` }
        }
      }
      void hash
    }
    return null
  } finally {
    await ctl.stop()
  }
}

/**
 * Greedy shrink: drop rounds, then ops, then partitions, while the failure
 * still reproduces. `predicate(schedule) -> bool` defaults to running the
 * schedule against real processes; inject a synthetic predicate to unit-test
 * the shrink machinery without spawning anything.
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
  for (let r = best.rounds.length - 1; r >= 0; r--) {
    if (best.rounds.length <= 1) break
    const cand = { ...best, rounds: best.rounds.filter((_, i) => i !== r) }
    if (await fails(cand)) best = cand
  }
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
  const dir = join(ROOT, 'okf', 'test', 'regressions')
  await mkdir(dir, { recursive: true })
  const name = `fuzz-seed-${schedule.seed}.json`
  await writeFile(join(dir, name), JSON.stringify({ failure, schedule }, null, 2) + '\n')
  return name
}
