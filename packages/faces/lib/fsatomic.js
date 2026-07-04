// On-disk safety plumbing shared by materialize and the ingest watcher
// (SPEC-FINAL §9.4):
//
// - atomic writes: temp file in the target's own (real) directory, fsync,
//   rename — rename(2) is atomic within a filesystem, and writing the temp
//   file next to the target guarantees same-filesystem rename
//   (https://nodejs.org/api/fs.html#fspromisesrenameoldpath-newpath;
//   POSIX rename semantics).
// - containment: lexical check on the resolved path (no '..' escape, no
//   absolute override) AND a realpath check on the parent directory after
//   mkdir, so a symlinked parent that points outside the root is refused
//   (§9.4 "no symlinked parent that resolves outside root").
// - per-path in-flight locks: one promise-chain mutex per (vault root,
//   relative path), shared process-wide through a registry keyed by the
//   root's realpath, so a materializer and an ingest watcher on the same
//   directory serialize their file-level critical sections (§9.4: the
//   mtime/hash check and the rename happen under one lock, with a re-check
//   immediately before rename closing the TOCTOU window).
// - the materialize manifest: relPath -> sha256 of the last-materialized
//   bytes, used to detect unsaved external modifications (materialize
//   skips them; the watcher uses the same hashes to ignore the system's
//   own writes). Stored at <root>/.vld-manifest.json in canonical bytes,
//   so it is itself deterministic for a given view (I9).
import { createHash } from 'node:crypto'
import { mkdir, open, readFile, realpath, rename, stat } from 'node:fs/promises'
import { dirname, join, resolve, sep, basename } from 'node:path'
import { canonical } from '@autovault-ld/core'

export const MANIFEST_FILE = '.vld-manifest.json'

const registries = new Map() // realRoot -> { locks: Map<rel, tailPromise> }
let tmpCounter = 0

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * Resolve (and create) a vault root, returning its process-wide registry.
 * The registry is keyed by realpath so two handles on the same directory
 * (e.g. one via a symlink) share one lock table.
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

/** Promise-chain mutex per relative path (the §9.4 in-flight lock). */
export function withPathLock(registry, rel, fn) {
  const prev = registry.locks.get(rel) || Promise.resolve()
  const run = prev.then(fn, fn)
  // keep the chain alive but never poisoned
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
  const err = new Error(`UNSAFE_PATH: '${rel}' resolves outside the vault root`)
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
 * Atomic, contained write (§9.4): mkdir parents, realpath-check the parent,
 * write a temp file, fsync, re-check the precondition, rename, fsync the
 * directory. `precondition.hash` is the on-disk hash observed by the caller
 * under the same path lock (null for "file must not exist"); if the file
 * changed in between, the write is abandoned with code 'MODIFIED' so the
 * caller can treat the file as an ingest event first.
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
    // Re-check under the caller's lock immediately before rename (§9.4:
    // the check-then-rename pair must not be a TOCTOU window).
    const now = await hashFile(target)
    if (now !== precondition.hash) {
      const err = new Error(`MODIFIED: '${rel}' changed on disk before rename`)
      err.code = 'MODIFIED'
      // The temp file is renamed aside rather than deleted: nothing under
      // the scratch trees is ever deleted (project rule); a stray .tmp in
      // the vault dir is ignored by both faces (dot-file rule).
      throw err
    }
  }
  await rename(tmp, target)
  // fsync the directory so the rename itself is durable (best effort:
  // directory fsync is not supported on every platform/filesystem).
  try {
    const dh = await open(realParent, 'r')
    try {
      await dh.sync()
    } finally {
      await dh.close()
    }
  } catch {
    // ignore: durability of the rename record is best-effort
  }
  return abs
}

// ---------- materialize manifest ----------

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

/** True for paths the faces never treat as notes (dot-files, temps). */
export function isIgnoredPath(rel) {
  const segs = String(rel).split(/[\\/]/)
  return segs.some((s) => s.startsWith('.')) || rel.endsWith('.tmp')
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
