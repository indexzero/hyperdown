// The shared harness of the store tests: real autobee and corestore
// instances on disk. Test directories are unique per run under
// sslop/030/tmp/. Nothing deletes them, so a failed run leaves its files
// for inspection.
import { mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export {
  Bundle,
  createMetadata,
  metadataHash,
  canonicalMetadataBytes,
  loadMetadata,
  generationId,
  viewHash,
  METADATA_FILE,
  ROOT_GENERATION
} from '../store/index.js'
export { keyspace as K, canonical, makeTag } from '../core/index.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const RUN = `run-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let seq = 0

/** A unique scratch directory on disk for one vault. */
export async function tmpDir(name) {
  const dir = join(ROOT, 'sslop', '030', 'tmp', RUN, `${name}-${seq++}`)
  await mkdir(dir, { recursive: true })
  return dir
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Polls until fn() is truthy. Returns false at the deadline, and never throws. */
export async function until(fn, ms = 20000, step = 50) {
  const t0 = Date.now()
  for (;;) {
    if (await fn()) return true
    if (Date.now() - t0 >= ms) return false
    await sleep(step)
  }
}

/**
 * A direct replication stream pair between two vaults. Returns a function
 * that destroys both streams.
 */
export function pair(a, b) {
  const s1 = a.replicate(true)
  const s2 = b.replicate(false)
  s1.on('error', () => {})
  s2.on('error', () => {})
  s1.pipe(s2).pipe(s1)
  return () => {
    s1.destroy()
    s2.destroy()
  }
}

/** Waits until every vault reports one view hash. Returns the hash, or null at the deadline. */
export async function converged(vaults, ms = 30000) {
  let hashes = []
  const ok = await until(async () => {
    hashes = []
    for (const v of vaults) {
      await v.update()
      hashes.push(await v.snapshotHash())
    }
    return hashes.every((h) => h === hashes[0])
  }, ms)
  return ok ? hashes[0] : null
}
