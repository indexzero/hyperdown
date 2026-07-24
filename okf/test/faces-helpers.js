// Shared harness for the @auto-okf/faces tests: REAL @auto-okf/store vaults
// (autobee + corestore on disk) driving materialize/ingest against REAL
// bundle directories. All scratch lives under sslop/031/tmp/, unique per
// run; handles are closed but files are NEVER deleted (post-mortem), and
// nothing under sslop/ (or /tmp) is touched.
import { mkdir, readdir, readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export { initVault, joinVault, openVault } from '../store/index.js'
export { keyspace as K, canonical, makeTag } from '../core/index.js'
export { materialize, createIngestWatcher, wanted, readView } from '../faces/index.js'
export { checkOkfConformance } from './okf-conformance.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const RUN = `run-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let seq = 0

/** Unique on-disk scratch dir under sslop/031/tmp/ (never cleaned up). */
export async function tmpDir(name) {
  const dir = join(ROOT, 'sslop', '031', 'tmp', RUN, `${name}-${seq++}`)
  await mkdir(dir, { recursive: true })
  return dir
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function until(fn, ms = 20000, step = 50) {
  const t0 = Date.now()
  for (;;) {
    if (await fn()) return true
    if (Date.now() - t0 >= ms) return false
    await sleep(step)
  }
}

/** Direct replication stream pair between two vaults; returns unpair(). */
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

/** Wait until every vault reports the same non-null view hash; returns it. */
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

/** Read a bundle directory into a Map<relPath, string> of every .md file. */
export async function readBundle(root, rel = '', out = new Map()) {
  const abs = rel === '' ? root : join(root, rel)
  for (const e of (await readdir(abs, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (e.name.startsWith('.')) continue
    const childRel = rel === '' ? e.name : `${rel}/${e.name}`
    if (e.isDirectory()) await readBundle(root, childRel, out)
    else if (e.isFile() && childRel.endsWith('.md')) out.set(childRel, await readFile(join(root, childRel), 'utf8'))
  }
  return out
}

/** Compare two bundle maps for byte-identity; returns a diff description or null. */
export function bundleDiff(a, b) {
  const keys = new Set([...a.keys(), ...b.keys()])
  for (const k of [...keys].sort()) {
    if (!a.has(k)) return `only in B: ${k}`
    if (!b.has(k)) return `only in A: ${k}`
    if (a.get(k) !== b.get(k)) return `differ: ${k}`
  }
  return null
}
