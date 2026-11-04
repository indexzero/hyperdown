// File-system plumbing that materialize and the ingest watcher share: atomic
// writes, containment in the root, per-path locks and the emission manifest.
// See SPEC §9.
import { createHash } from 'node:crypto'
import { mkdir, open, readFile, readdir, readlink, realpath, rename, rmdir, stat, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { canonical, casefoldPath } from '@auto-okf/core'

export const MANIFEST_FILE = '.okf-manifest.json'

// materialize of an encrypted vault writes this file at the root before its
// first plaintext write. import refuses a marked bundle without a key.
// Nothing reads the bytes (ENCRYPTED_TEXT).
export const ENCRYPTED_FILE = '.okf-encrypted'
export const ENCRYPTED_TEXT =
  'This face holds the contents of an encrypted vault as plaintext.\n' +
  'auto-okf import of this face needs --encryption-key (decision 8).\n'

const registries = new Map() // realRoot -> { locks: Map<rel, tailPromise> }
let tmpCounter = 0

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * Create the root if needed and return its process-wide registry. The key
 * is the realpath, so two handles on one directory share one lock table.
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

/** Promise-chain mutex per relative path, so that a materializer and a watcher on one directory serialize. */
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

function containedError(rel, detail = '') {
  const err = new Error(`UNSAFE_PATH: '${rel}' resolves outside the bundle root${detail}`)
  err.code = 'UNSAFE_PATH'
  return err
}

/** Lexical containment of rel under realRoot. Returns the absolute path. */
export function containedPath(realRoot, rel) {
  const abs = resolve(realRoot, rel)
  if (abs !== realRoot && !abs.startsWith(realRoot + sep)) throw containedError(rel)
  return abs
}

/**
 * Containment of an existing file: lexical, then its real path, so that a
 * symlink cannot lead out of the root. Returns the absolute path. Throws
 * UNSAFE_PATH.
 */
export async function containedRealPath(realRoot, rel) {
  const abs = containedPath(realRoot, rel)
  const real = await realpath(abs)
  if (real !== realRoot && !real.startsWith(realRoot + sep)) throw containedError(rel)
  return abs
}

/**
 * Containment of the parent directory of `rel`: lexical, then the real
 * location of the parent (realLocation). The parent need not exist yet. A
 * symlink in the root that leads out of it, dangling or not, throws
 * UNSAFE_PATH. Returns the real parent.
 */
export async function containedParent(realRoot, rel) {
  const abs = containedPath(realRoot, rel)
  const parent = await realLocation(dirname(abs))
  if (parent !== realRoot && !parent.startsWith(realRoot + sep)) {
    throw containedError(rel, `: its parent directory is ${parent}, through a symlink`)
  }
  return parent
}

/**
 * Where a write to `path` lands: its real path when it exists, else the real
 * path of its nearest existing ancestor with the rest of `path` appended. A
 * dangling symlink resolves through its target.
 */
export async function realLocation(path) {
  let head = resolve(path)
  const rest = []
  for (let links = 0; ; ) {
    try {
      return join(await realpath(head), ...rest)
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err
    }
    const target = await readlink(head).catch(() => null)
    if (target !== null && links++ < 40) {
      head = resolve(dirname(head), target)
      continue
    }
    rest.unshift(basename(head))
    head = dirname(head)
  }
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
 * Atomic, contained write. `precondition.hash` is the hash that the caller
 * observed on disk under the same path lock, null for "the file must not
 * exist". If the file changed since, the write stops with code 'MODIFIED'.
 */
export async function atomicWrite(realRoot, rel, buf, { precondition } = {}) {
  const abs = containedPath(realRoot, rel)
  // Before the mkdir. A mkdir through a symlinked parent creates directories
  // outside the root.
  await containedParent(realRoot, rel)
  await mkdir(dirname(abs), { recursive: true })
  const realParent = await realpath(dirname(abs))
  if (realParent !== realRoot && !realParent.startsWith(realRoot + sep)) {
    throw containedError(rel)
  }
  const target = join(realParent, basename(abs))
  // Next to the target, so that the rename stays on one file system.
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
        // A stray temp file stays. It is a dot-file that both faces ignore.
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
    // Not every platform supports a directory fsync.
  }
  return abs
}

/**
 * Delete a contained file if present. The unlink goes through the real
 * parent (containedParent), so that a symlinked parent never leads it out
 * of the root. Throws UNSAFE_PATH.
 */
export async function atomicUnlink(realRoot, rel) {
  const abs = join(await containedParent(realRoot, rel), basename(rel))
  try {
    await unlink(abs)
    return true
  } catch (err) {
    if (err.code === 'ENOENT') return false
    throw err
  }
}

/** Remove the empty directories among relDirs. Skips the root. */
export async function pruneEmptyDirs(realRoot, relDirs) {
  // Deepest first, so that a parent can become empty after its child.
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

/** True for a path that is never a concept note: a dot-file or a temp file. */
export function isIgnoredPath(rel) {
  const segs = String(rel).split(/[\\/]/)
  return segs.some((s) => s.startsWith('.')) || rel.endsWith('.tmp')
}

/**
 * True when a casefolded segment of `rel` starts with `.okf-`, the names
 * of the state files of the faces. import takes dot-segment concept paths,
 * but refuses a note at or under such a name. See SPEC §10.
 */
export function hasReservedSegment(rel) {
  return String(rel)
    .split(/[\\/]/)
    .some((seg) => casefoldPath(seg).startsWith('.okf-'))
}

/** True when the last component is index.md or log.md. */
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

/** Collect the `.md` files under root into `out`, relative with forward slashes. */
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
