// On-disk safety plumbing shared by materialize and the ingest watcher
// (okf SPEC §9). Pattern ancestor: vault-ld/faces/lib/fsatomic.js
// (copy-don't-depend, SPEC §0); rewritten for the auto-okf manifest name
// and OKF reserved-file rules.
//
// - Atomic writes: temp file in the target's own (real) directory, fsync,
//   rename — rename(2) is atomic within a filesystem, and writing the temp
//   file next to the target guarantees a same-filesystem rename
//   (https://nodejs.org/api/fs.html#fspromisesrenameoldpath-newpath).
// - Containment (§9 "lexical + realpath containment"): a lexical check on
//   the resolved path (no '..' escape, no absolute override) AND a realpath
//   check on the parent directory after mkdir, so a symlinked parent that
//   resolves outside the root is refused.
// - Per-path in-flight locks: one promise-chain mutex per (vault root,
//   relative path), shared process-wide through a registry keyed by the
//   root's realpath, so a materializer and an ingest watcher on the same
//   directory serialize their file-level critical sections (§9).
// - The emission manifest (§9 "reconciles through an emission manifest,
//   never blind mirroring"): relPath -> sha256 of the last-materialized
//   bytes. Materialize uses it to (a) detect human-authored/modified files
//   it must never overwrite or delete (N3), and (b) know which of its own
//   prior outputs are safe to remove. The watcher uses the same hashes to
//   ignore the system's own writes. Stored at <root>/.okf-manifest.json in
//   canonical bytes, so it is itself deterministic for a given view.
import { createHash } from 'node:crypto'
import { mkdir, open, readFile, readdir, realpath, rename, rmdir, stat, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { canonical } from '@auto-okf/core'

export const MANIFEST_FILE = '.okf-manifest.json'

const registries = new Map() // realRoot -> { locks: Map<rel, tailPromise> }
let tmpCounter = 0

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * Resolve (and create) a vault/bundle root, returning its process-wide
 * registry. Keyed by realpath so two handles on the same directory (e.g.
 * one via a symlink) share one lock table.
 */
export async function rootRegistry(dir) {
  await mkdir(dir, { recursive: true })
  const realRoot = await realpath(dir)
  let reg = registries.get(realRoot)
  if (!reg) {
    reg = { locks: new Map() }
    registries.set(realRoot, reg)
  }
  return { realRoot, registry: reg }
}

/** Promise-chain mutex per relative path (the §9 in-flight lock). */
export function withPathLock(registry, rel, fn) {
  const prev = registry.locks.get(rel) || Promise.resolve()
  const run = prev.then(fn, fn)
  registry.locks.set(
    rel,
    run.then(
      () => undefined,
      () => undefined
    )
  )
  return run
}

function containedError(rel) {
  const err = new Error(`UNSAFE_PATH: '${rel}' resolves outside the bundle root`)
  err.code = 'UNSAFE_PATH'
  return err
}

/** Lexical containment of rel under realRoot; returns the absolute path. */
export function containedPath(realRoot, rel) {
  const abs = resolve(realRoot, rel)
  if (abs !== realRoot && !abs.startsWith(realRoot + sep)) throw containedError(rel)
  return abs
}

/** sha256 of a file, or null when it does not exist. */
export async function hashFile(abs) {
  try {
    return sha256(await readFile(abs))
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

/**
 * Atomic, contained write (§9): mkdir parents, realpath-check the parent,
 * write a temp file, fsync, optionally re-check the precondition, rename,
 * fsync the directory. `precondition.hash` is the on-disk hash observed by
 * the caller under the same path lock (null for "file must not exist"); if
 * the file changed in between, the write is abandoned with code 'MODIFIED'.
 */
export async function atomicWrite(realRoot, rel, buf, { precondition } = {}) {
  const abs = containedPath(realRoot, rel)
  await mkdir(dirname(abs), { recursive: true })
  const realParent = await realpath(dirname(abs))
  if (realParent !== realRoot && !realParent.startsWith(realRoot + sep)) {
    throw containedError(rel)
  }
  const target = join(realParent, basename(abs))
  const tmp = join(realParent, `.${basename(abs)}.${process.pid}.${tmpCounter++}.tmp`)
  const fh = await open(tmp, 'w')
  try {
    await fh.writeFile(buf)
    await fh.sync()
  } finally {
    await fh.close()
  }
  if (precondition !== undefined) {
    const now = await hashFile(target)
    if (now !== precondition.hash) {
      try {
        await unlink(tmp)
      } catch {
        // leave the stray temp; it is a dot-file both faces ignore
      }
      const err = new Error(`MODIFIED: '${rel}' changed on disk before rename`)
      err.code = 'MODIFIED'
      throw err
    }
  }
  await rename(tmp, target)
  try {
    const dh = await open(realParent, 'r')
    try {
      await dh.sync()
    } finally {
      await dh.close()
    }
  } catch {
    // directory fsync is best-effort (not supported on every platform)
  }
  return abs
}

/** Delete a contained file if present (materialize reconciliation, §9). */
export async function atomicUnlink(realRoot, rel) {
  const abs = containedPath(realRoot, rel)
  try {
    await unlink(abs)
    return true
  } catch (err) {
    if (err.code === 'ENOENT') return false
    throw err
  }
}

/** Remove now-empty directories bottom-up (skips the root). */
export async function pruneEmptyDirs(realRoot, relDirs) {
  // Deepest first so a parent can become empty after its child is removed.
  for (const rel of [...new Set(relDirs)].filter(Boolean).sort((a, b) => b.length - a.length)) {
    const abs = containedPath(realRoot, rel)
    try {
      const entries = await readdir(abs)
      if (entries.length === 0) await rmdir(abs)
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTEMPTY') throw err
    }
  }
}

// ---------- emission manifest ----------

export async function loadManifest(realRoot) {
  try {
    const raw = await readFile(join(realRoot, MANIFEST_FILE), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && parsed.files && typeof parsed.files === 'object') {
      return { files: { ...parsed.files } }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
  return { files: {} }
}

export async function saveManifest(realRoot, manifest) {
  const sorted = { files: {} }
  for (const k of Object.keys(manifest.files).sort()) sorted.files[k] = manifest.files[k]
  const bytes = Buffer.from(canonical.stableStringify(sorted) + '\n', 'utf8')
  await atomicWrite(realRoot, MANIFEST_FILE, bytes)
  return manifest
}

/** True for paths the faces never treat as concept notes (dot-files, temps). */
export function isIgnoredPath(rel) {
  const segs = String(rel).split(/[\\/]/)
  return segs.some((s) => s.startsWith('.')) || rel.endsWith('.tmp')
}

/** True when the terminal component is a reserved OKF face (index.md/log.md). */
export function isReservedFile(rel) {
  const name = String(rel).split('/').pop().toLowerCase()
  return name === 'index.md' || name === 'log.md'
}

/** stat() that maps ENOENT to null. */
export async function statOrNull(abs) {
  try {
    return await stat(abs)
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

/** Recursively collect concept `.md` files (relative, forward-slash). */
export async function walkNotes(root, rel, out) {
  const abs = rel === '' ? root : join(root, rel)
  let entries
  try {
    entries = await readdir(abs, { withFileTypes: true })
  } catch (err) {
    if (err.code === 'ENOENT') return
    throw err
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const childRel = rel === '' ? e.name : `${rel}/${e.name}`
    if (e.isDirectory()) await walkNotes(root, childRel, out)
    else if (e.isFile() && childRel.endsWith('.md')) out.push(childRel)
  }
}
