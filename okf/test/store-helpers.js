// Shared harness for the @auto-okf/store integration tests: REAL autobee +
// corestore instances on disk (no MemView, no stubs). Test dirs are unique
// per run under sslop/030/tmp/ (never /tmp, never cleaned up — handles are
// closed, files are left for post-mortem).
import { mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export {
  Vault,
  initVault,
  openVault,
  joinVault,
  createMetadata,
  metadataHash,
  canonicalMetadataBytes,
  loadMetadata,
  epochId,
  viewHash,
  METADATA_FILE,
  GENESIS_EPOCH
} from '../store/index.js'
export { keyspace as K, canonical, makeTag } from '../core/index.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const RUN = `run-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let seq = 0

/** Unique on-disk scratch dir for one vault. */
export async function tmpDir(name) {
  const dir = join(ROOT, 'sslop', '030', 'tmp', RUN, `${name}-${seq++}`)
  await mkdir(dir, { recursive: true })
  return dir
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Poll until fn() is truthy (returns false on timeout, never throws up). */
export async function until(fn, ms = 20000, step = 50) {
  const t0 = Date.now()
  for (;;) {
    if (await fn()) return true
    if (Date.now() - t0 >= ms) return false
    await sleep(step)
  }
}

/**
 * Direct replication stream pair between two vaults (autobee README:
 * `db1.replicate(true)` / `db2.replicate(false)`, pipe both ways).
 * Returns an unpair() that destroys both streams.
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

/** Wait for every vault to report the same non-null view hash; returns it. */
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
