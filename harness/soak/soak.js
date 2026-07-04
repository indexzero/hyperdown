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
console.log(`[soak] ${MINUTES} minutes, ${N} writers, lossy profile, seed=${ctl.seed}`)
console.log(`[soak] csv: ${csv}`)

await writers[0].call('defineTerm', 'core', 'title', { '@id': 'ex:title' })
await writers[0].call('defineTerm', 'core', 'topic', { '@id': 'ex:topic', '@container': '@set' })
await ctl.quiesce(writers)

const t0 = Date.now()
const deadline = t0 + MINUTES * 60000
const opCounts = writers.map(() => 0)
let running = true
let fatal = null

// sustained writes: each writer loops its own op stream (~12 ops/s/writer)
const loads = writers.map(async (w, wi) => {
  const rot = ['Home', 'Notes/A', 'Notes/B', `agents/w${wi}/Log`, 'Topic']
  while (running && Date.now() < deadline) {
    const i = opCounts[wi]
    const s = rot[i % rot.length]
    try {
      if (i % 3 === 0) await w.call('setField', s, 'title', `t${wi}-${i}`)
      else if (i % 3 === 1) await w.call('addMember', s, 'topic', `m${i % 50}`)
      else {
        // chain body revisions off the current head (realistic editing);
        // null-base every time would hit the O(N^2) conflict path (see
        // CODE-REVIEW.md finding), which is exercised by its own repro.
        const head = await w.val(`n/${s.replace(/\//g, '%2F')}/body`)
        await w.call('setBody', s, head || null, `body ${wi}-${i}`)
      }
      opCounts[wi]++
    } catch (err) {
      fatal = `[soak] writer w${wi} op failed: ${err.message}`
      running = false
    }
    await sleep(80)
  }
})

// periodic partitions/heals (every 3 min: isolate one writer for 30s)
const churn = (async () => {
  const rng = ctl.rng.child('soak-churn')
  while (running && Date.now() < deadline - 60000) {
    await sleep(180000)
    if (!running) break
    const iso = writers[rng.int(N)]
    console.log(`[soak] ${((Date.now() - t0) / 1000) | 0}s partitioning ${iso.name} for 30s`)
    await ctl.partition([iso], writers.filter((w) => w !== iso))
    await sleep(30000)
    await ctl.connectAll(writers)
  }
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
