// T10 adversarial review — resource-leak soak for the @auto-okf stack.
// Sustained multi-writer load under the lossy fault profile; samples RSS,
// heap, open FDs and corestore directory growth per writer process every
// 30s into <run>/soak.csv, with one partition/heal at the midpoint. Ends
// with a heal + convergence check.
//
//   node okf/harness/soak/soak.js               # 22 minutes (default)
//   SOAK_MINUTES=30 HARNESS_SEED=99 node okf/harness/soak/soak.js
//
// Unbounded revision RETENTION is a documented design choice (append-only,
// §8); unbounded MEMORY under bounded-per-op workload is a bug. This soak
// runs only O(1)-per-op workload (LWW setField + OR-set addTag capped at 50
// distinct members) so RSS growth cannot be blamed on the known O(R^2)
// SetBody rescan — it isolates the leak/backpressure question.
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
const MINUTES = Number(process.env.SOAK_MINUTES || 22)
const SAMPLE_MS = 30000
const N = 3
const OP_SLEEP = Number(process.env.SOAK_SLEEP || 400)
const BACKPRESSURE = process.env.SOAK_BACKPRESSURE !== '0'
const CHURN = process.env.SOAK_CHURN !== '0'

// Flat subjects (no '/' so path/<p> needs no escaping when resolving ids).
const SUBJECTS = ['Home', 'NotesA', 'NotesB', 'Log', 'Topic']

async function dirKb(dir) {
  try {
    const { stdout } = await execFileP('du', ['-sk', dir])
    return Number(stdout.split('\t')[0])
  } catch {
    return -1
  }
}

async function fdCount(pid) {
  try {
    const { stdout } = await execFileP('lsof', ['-p', String(pid)])
    return stdout.trim().split('\n').length - 1 // minus header
  } catch {
    return -1
  }
}

const { ctl, writers } = await setupVaultCluster('soak', N, { profile: PROFILES.lossy })
const csv = join(ctl.baseDir, 'soak.csv')
await writeFile(csv, 'elapsed_s,writer,rss_mb,heap_mb,fds,dir_kb,ops\n')
console.log(
  `[soak] ${MINUTES} minutes, ${N} writers, lossy, seed=${ctl.seed}, op_sleep=${OP_SLEEP}ms, backpressure=${BACKPRESSURE ? 'on' : 'OFF'}`
)
console.log(`[soak] csv: ${csv}`)

// w0 seeds the shared subjects; every writer then mutates them concurrently.
// w0 mints them (no squat), so the op tag IS the concept id, and after
// quiesce every peer's apply has folded the same ids.
const ids = new Map()
for (const s of SUBJECTS) {
  const res = await writers[0].call('createConcept', s, 'note')
  ids.set(s, res.tag)
}
await ctl.quiesce(writers)

const t0 = Date.now()
const deadline = t0 + MINUTES * 60000
const opCounts = writers.map(() => 0)
let running = true
let fatal = null

const loads = writers.map(async (w, wi) => {
  const opOpts = BACKPRESSURE ? { backpressure: true } : {}
  while (running && Date.now() < deadline) {
    const i = opCounts[wi]
    const s = SUBJECTS[i % SUBJECTS.length]
    const id = ids.get(s)
    try {
      if (i % 2 === 0) await w.call('setField', id, 'title', `t${wi}-${i}`, opOpts)
      else await w.call('addTag', id, `m${i % 50}`, opOpts)
      opCounts[wi]++
    } catch (err) {
      fatal = `[soak] writer w${wi} op failed: ${err.message}`
      running = false
    }
    await sleep(OP_SLEEP)
  }
})

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

const sampler = (async () => {
  while (running && Date.now() < deadline) {
    const elapsed = ((Date.now() - t0) / 1000) | 0
    for (let i = 0; i < N; i++) {
      try {
        const st = await writers[i].stats()
        const kb = await dirKb(writers[i].dir)
        const fds = await fdCount(writers[i].proc.pid)
        const line = `${elapsed},w${i},${(st.rss / 1048576).toFixed(1)},${(st.heapUsed / 1048576).toFixed(1)},${fds},${kb},${opCounts[i]}`
        await appendFile(csv, line + '\n')
        console.log(`[soak] ${line}`)
      } catch (err) {
        console.log(`[soak] sample failed for w${i}: ${err.message}`)
      }
    }
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

console.log(`[soak] writes done (${opCounts.join('/')}); healing + final convergence`)
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
