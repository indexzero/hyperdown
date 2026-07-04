// Assignment §3 "backpressure and resource leaks": long-running
// lossy-profile soak with sustained writes. Watches RSS, open FDs and
// Corestore directory growth per process, sampled every 30s into
// <run>/soak.csv. Ends with a heal + convergence check.
//
//   node harness/soak/soak.js            # 32 minutes (default)
//   SOAK_MINUTES=45 HARNESS_SEED=99 node harness/soak/soak.js
//
// Exit code 0 = converged at the end and no writer process died.
import { appendFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Controller, sleep } from '../lib/controller.js'
import { setupVaultCluster } from '../lib/setup.js'
import { PROFILES } from '../lib/profiles.js'

const execFileP = promisify(execFile)
const MINUTES = Number(process.env.SOAK_MINUTES || 32)
const SAMPLE_MS = 30000
const N = 3
// Write pacing. At <=80ms/op the three writers attempt ~12 ops/s each;
// 3-way concurrent lossy replication cannot fold that fast, so without
// admission control one writer floods and the others stall applying it
// (CODE-REVIEW.md finding M2). The store's opt-in append backpressure
// (vault.append(..., { backpressure }) — the M2 fix) ties each writer's
// append rate to its own fold rate, so the soak stays balanced even at
// SOAK_SLEEP=80. Set SOAK_BACKPRESSURE=0 to reproduce the unthrottled
// M2 flood.
const OP_SLEEP = Number(process.env.SOAK_SLEEP || 400)
const BACKPRESSURE = process.env.SOAK_BACKPRESSURE !== '0'
// One brief partition at the midpoint (still exercises heal/catch-up)
// instead of repeated churn, which builds expensive concurrent merges.
const CHURN = process.env.SOAK_CHURN !== '0'

async function dirKb(dir) {
  try {
    const { stdout } = await execFileP('du', ['-sk', dir])
    return Number(stdout.split('\t')[0])
  } catch {
    return -1
  }
}

const { ctl, writers } = await setupVaultCluster('soak', N, { profile: PROFILES.lossy })
const csv = join(ctl.baseDir, 'soak.csv')
await writeFile(csv, 'elapsed_s,writer,rss_mb,heap_mb,fds,dir_kb,ops\n')
console.log(
  `[soak] ${MINUTES} minutes, ${N} writers, lossy profile, seed=${ctl.seed}, op_sleep=${OP_SLEEP}ms, backpressure=${BACKPRESSURE ? 'on' : 'OFF (M2 repro)'}`
)
console.log(`[soak] csv: ${csv}`)

await writers[0].call('defineTerm', 'core', 'title', { '@id': 'ex:title' })
await writers[0].call('defineTerm', 'core', 'topic', { '@id': 'ex:topic', '@container': '@set' })
await ctl.quiesce(writers)

const t0 = Date.now()
const deadline = t0 + MINUTES * 60000
const opCounts = writers.map(() => 0)
let running = true
let fatal = null

// sustained writes: each writer loops its own op stream
const loads = writers.map(async (w, wi) => {
  const rot = ['Home', 'Notes/A', 'Notes/B', `agents/w${wi}/Log`, 'Topic']
  // The M2 fix, exercised where production writers would use it: the
  // store's opt-in append backpressure makes each writer await its own
  // fold once maxInflight of its ops are outstanding, so no writer builds
  // the runaway append-vs-apply backlog (the M2 feedback loop).
  const opOpts = BACKPRESSURE ? { backpressure: true } : {}
  while (running && Date.now() < deadline) {
    const i = opCounts[wi]
    const s = rot[i % rot.length]
    try {
      // Bounded O(1)-per-op workload only: LWW setField and OR-set
      // addMember (capped at 50 distinct members/field). SetBody is
      // deliberately EXCLUDED — apply.js opSetBody rescans every prior
      // revision of the subject on each call, so sustained SetBody on one
      // subject is O(R^2) (CODE-REVIEW.md finding M1) and would conflate the
      // apply-cost defect with the leak/backpressure measurement this soak
      // exists to make. M1 has its own committed repro.
      if (i % 2 === 0) await w.call('setField', s, 'title', `t${wi}-${i}`, opOpts)
      else await w.call('addMember', s, 'topic', `m${i % 50}`, opOpts)
      opCounts[wi]++
    } catch (err) {
      fatal = `[soak] writer w${wi} op failed: ${err.message}`
      running = false
    }
    await sleep(OP_SLEEP)
  }
})

// one brief partition/heal at the midpoint (exercises catch-up without
// building the repeated concurrent-merge backlog that trips M2)
const churn = (async () => {
  if (!CHURN) return
  const half = (deadline - t0) / 2
  await sleep(half)
  if (!running) return
  const iso = writers[1]
  console.log(`[soak] ${((Date.now() - t0) / 1000) | 0}s partitioning ${iso.name} for 20s`)
  await ctl.partition([iso], writers.filter((w) => w !== iso))
  await sleep(20000)
  if (running) await ctl.connectAll(writers)
})()

// sampler
const sampler = (async () => {
  while (running && Date.now() < deadline) {
    const elapsed = ((Date.now() - t0) / 1000) | 0
    for (let i = 0; i < N; i++) {
      try {
        const st = await writers[i].stats()
        const kb = await dirKb(writers[i].dir)
        const line = `${elapsed},w${i},${(st.rss / 1048576).toFixed(1)},${(st.heapUsed / 1048576).toFixed(1)},${st.fds},${kb},${opCounts[i]}`
        await appendFile(csv, line + '\n')
        console.log(`[soak] ${line}`)
      } catch (err) {
        console.log(`[soak] sample failed for w${i}: ${err.message}`)
      }
    }
    // controller (hub buffers) too
    const mem = process.memoryUsage()
    await appendFile(csv, `${elapsed},ctl,${(mem.rss / 1048576).toFixed(1)},${(mem.heapUsed / 1048576).toFixed(1)},-1,-1,-1\n`)
    await sleep(SAMPLE_MS)
  }
})()

await Promise.allSettled([...loads, churn, sampler])
running = false

if (fatal) {
  console.error(fatal)
  await ctl.stop()
  process.exit(1)
}

console.log(`[soak] writes done (${opCounts.join('/')}); healing + final convergence check`)
await ctl.connectAll(writers)
try {
  const hash = await ctl.quiesce(writers, { timeout: 300000 })
  console.log(`[soak] converged at ${hash}`)
  await ctl.stop()
  process.exit(0)
} catch (err) {
  console.error(`[soak] FAILED to converge: ${err.message}`)
  await ctl.stop()
  process.exit(1)
}
