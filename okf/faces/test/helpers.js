// Shared harness for the faces tests, on real store vaults and real bundle
// directories. Scratch stays on disk after a run, for a post-mortem.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Bundle } from '../../store/index.js'
import { materialize, importFace, readView } from '../index.js'

export { Bundle } from '../../store/index.js'
export { keyspace as K, canonical, makeTag } from '../../core/index.js'
export { materialize, createIngestWatcher, importFace, status, wanted, readView, readLog, parseNote, renderNote } from '../index.js'
export { checkOkfConformance } from './okf-conformance.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const RUN = `run-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let seq = 0

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

/** A direct replication stream pair between two vaults. Returns the function that destroys it. */
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

/** Wait until every vault reports the same view hash. Returns it, or null after `ms`. */
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

/** Compare two bundle maps byte for byte. Returns the first difference, or null. */
export function bundleDiff(a, b) {
  const keys = new Set([...a.keys(), ...b.keys()])
  for (const k of [...keys].sort()) {
    if (!a.has(k)) return `only in B: ${k}`
    if (!b.has(k)) return `only in A: ${k}`
    if (a.get(k) !== b.get(k)) return `differ: ${k}`
  }
  return null
}

/** Every file under a directory, dot-files included, as sorted relative paths. */
export async function listFiles(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  return entries
    .filter((e) => e.isFile())
    .map((e) => relative(root, join(e.parentPath, e.name)))
    .sort()
}

/** The entries of a directory, sorted. */
export async function entries(dir) {
  return (await readdir(dir)).sort()
}

/** A sha256 over every file under `root`, dot-files included: each path and its bytes. */
export async function treeHash(root) {
  const h = createHash('sha256')
  for (const rel of await listFiles(root)) {
    h.update(`${rel}\0`)
    h.update(await readFile(join(root, rel)))
    h.update('\0')
  }
  return h.digest('hex')
}

/** Write `files` (Map<rel, string>) under `root`, creating directories. */
export async function writeTree(root, files) {
  for (const [rel, text] of files) {
    await mkdir(dirname(join(root, rel)), { recursive: true })
    await writeFile(join(root, rel), text)
  }
}

/** Live (non-tombstoned, path-bearing) concepts of a vault, by _id. */
export async function liveConcepts(vault) {
  const { concepts } = await readView(vault)
  const live = new Map()
  for (const c of concepts.values()) if (!c.deleted && c.path !== undefined) live.set(c.id, c)
  return live
}

/**
 * One generation of `old`: materialize it into `<base>/face`, then import
 * that face into `<base>/vault`, carrying the metadata and the vault key.
 */
export async function generation(old, base, opts = {}) {
  const face = join(base, 'face')
  assert.equal((await materialize(old, face)).ok, true, 'setup: the face must be clean')
  return importFace(Bundle.init, face, join(base, 'vault'), { metadata: old.metadata, predecessorKey: old.keyHex, ...opts })
}
