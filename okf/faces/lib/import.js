// import (SPEC §10): a new vault in a new directory, filled from a face on
// disk. import reads the face once, writes nothing to it and opens no
// predecessor vault. Each note goes through import-mode ingest: see
// IngestWatcher.importNote in ./ingest.js.
//
// This module imports no substrate: the CLI passes the @auto-okf/store
// `Bundle.init` in as `initBundle`.
import { lstat, mkdir, open, readdir, readFile, readlink, realpath, rm, rmdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { planBundle } from './materialize.js'
import { parseNote } from './yaml.js'
import { createIngestWatcher } from './ingest.js'
import { ENCRYPTED_FILE, hasReservedSegment, isReservedFile } from './fsatomic.js'
import { compareNotes } from './verify.js'

// A conflicted copy (SPEC §7).
const CONFLICT_COPY_RE = /\.conflict-[0-9a-f]{8,}\.md$/
// The metadata file of a vault, @auto-okf/store METADATA_FILE. faces imports
// no substrate, so it repeats the name.
const PINNED_FILE = 'okf-vault.json'
// An import holds its `dir` with this file while it runs (claimDir).
const CLAIM_FILE = 'okf-import-claim'
// The fields of the predecessor's metadata that the new vault carries.
const CARRIED = ['limits', 'rate', 'schemaVersion']

/**
 * Create a vault at `dir` from the notes of the face at `faceDir`.
 *
 *   initBundle  (required) the @auto-okf/store `Bundle.init(dir, opts)`.
 *   faceDir     a directory of notes, such as one that `materialize` wrote.
 *               import reads every regular `.md` file in it, at any depth,
 *               dot segments included, except index.md and log.md. It never
 *               writes to the face.
 *   dir         the storage directory of the new vault: new, or empty. A
 *               trailing slash names the same directory.
 *   opts.encryptionKey   a Buffer or a Uint8Array of 32 bytes. The new vault
 *               is encrypted with it. undefined or null: not encrypted.
 *   opts.metadata        the pinned metadata of the predecessor. The new
 *               vault carries its `limits`, `rate` and `schemaVersion`, and
 *               no other field. Without it, the new vault takes the
 *               defaults. When it says `encrypted: true`,
 *               opts.encryptionKey is required: a generation of an encrypted
 *               vault is never unencrypted.
 *   opts.predecessorKey  the vault key of the predecessor (64 hex characters,
 *               or 32 bytes). The new vault records it as `predecessorKey`,
 *               and its generation id derives from it. Without it, the new
 *               vault is a root vault.
 *
 * Refusals, by name, before import writes anything:
 *   IMPORT_NO_INITBUNDLE           initBundle is not a function
 *   IMPORT_ENCRYPTION_KEY_INVALID  a key that is not 32 bytes. The message
 *                                  never holds the key. No value is read as
 *                                  no key.
 *   IMPORT_ENCRYPTION_KEY_REQUIRED no key, and opts.metadata says encrypted,
 *                                  or the face holds ENCRYPTED_FILE
 *   IMPORT_PREDECESSOR_INVALID     a predecessorKey that is not a vault key
 *   IMPORT_DIR_NOT_EMPTY           `dir` holds okf-vault.json, is not empty,
 *                                  or is not a directory
 *   IMPORT_FACE_ENTRY              an entry that is not a regular file or a
 *                                  directory, such as a symlink
 *   IMPORT_CONFLICT_COPY           a `.conflict-<hex>` note: a collision is
 *                                  still open
 *   IMPORT_RESERVED_NAME           a note at or under a reserved `.okf-` name
 *   IMPORT_MISSING_ID              a note whose frontmatter holds no `_id`
 * Each of the last four carries `err.paths`.
 *   IMPORT_DIR_CLAIMED             another import holds `dir`: its
 *                                  okf-import-claim exists. This import
 *                                  writes and removes nothing.
 *
 * Failures after the new vault exists: IMPORT_NOT_ENCRYPTED (a key was
 * given, and the metadata of the new vault does not say encrypted),
 * IMPORT_OVERSIZE and IMPORT_REJECTED (from importNote: `err.path`,
 * `err.op`, and `err.bytes` and `err.limit` or `err.reason`), and
 * IMPORT_FIDELITY (`err.differences`: [{ path, kind }], kind 'missing',
 * 'extra' or 'differs'). On each, import closes the new vault, removes each
 * entry that it wrote in `dir`, and then removes each directory that it
 * made, when empty. An existing `dir` stays. Every such error carries
 * `err.warnings` and `err.counts`. `err.warnings` is [{ kind, path,
 * message }]: kind 'ingest' (a note that does not parse, or that
 * establishes no concept) or 'copy' (a note whose `_id` another note holds:
 * import minted a new `_id`). Such a note does not round-trip, so each
 * warning comes with a difference.
 *
 * Returns { vault, dir, generation, counts: { notes, imported } }. `vault`
 * is open: the caller closes it. `notes` counts the notes read from the
 * face, and `imported` the notes that established a concept. A successful
 * import has no warning.
 */
export async function importFace(initBundle, faceDir, dir, opts = {}) {
  if (typeof initBundle !== 'function') {
    throw importError('IMPORT_NO_INITBUNDLE', 'initBundle (@auto-okf/store Bundle.init) is required')
  }
  if (typeof faceDir !== 'string' || typeof dir !== 'string') {
    throw new TypeError('importFace(initBundle, faceDir, dir, opts): faceDir and dir must be paths')
  }
  const encryptionKey = keyOption(opts.encryptionKey)
  if (encryptionKey === undefined && opts.metadata != null && opts.metadata.encrypted === true) {
    throw keyRequiredError("the predecessor's metadata says encrypted")
  }
  const metadata = carriedMetadata(opts.metadata, predecessorOption(opts.predecessorKey))
  const faceRoot = await realpath(resolve(faceDir))
  if (encryptionKey === undefined && (await isMarkedEncrypted(faceRoot))) {
    throw keyRequiredError(`the face ${faceRoot} holds ${ENCRYPTED_FILE}: materialize wrote it from an encrypted vault`)
  }
  const vaultDir = resolve(dir)
  await refuseUsedDir(vaultDir)
  const face = await readFace(faceRoot)

  const counts = { notes: face.notes.size, imported: 0 }
  const warnings = []
  const outDir = await claimDir(vaultDir)
  let vault = null
  try {
    vault = await initBundle(vaultDir, { metadata, ...(encryptionKey !== undefined ? { encryptionKey } : {}) })
    // initBundle is injected, so make sure that the vault is encrypted
    // before any content is written to it.
    if (encryptionKey !== undefined) requireEncrypted(vault, vaultDir)

    const watcher = await createIngestWatcher(vault, face.root, { watch: false })
    watcher.on('warning', ({ path, message }) => warnings.push({ kind: 'ingest', path, message }))
    watcher.on('copy', ({ path, of }) =>
      warnings.push({ kind: 'copy', path, message: `another note holds the _id ${of}; a new _id was minted` })
    )
    try {
      for (const rel of [...face.notes.keys()].sort(byteCmp)) {
        if ((await watcher.importNote(rel, face.notes.get(rel))).length > 0) counts.imported++
      }
    } finally {
      await watcher.close()
    }

    const differences = compareNotes(face.notes, await renderedNotes(vault))
    if (differences.length > 0) throw fidelityError(face.root, differences)
    await outDir.done()
    return { vault, dir: vaultDir, generation: vault.generation, counts }
  } catch (err) {
    if (err !== null && typeof err === 'object') {
      if (err.warnings === undefined) err.warnings = warnings
      if (err.counts === undefined) err.counts = counts
    }
    try {
      if (vault) await vault.close()
    } finally {
      await outDir.release()
    }
    throw err
  }
}

/**
 * Read the notes of the face into memory: { root, notes: Map<rel, Buffer> },
 * `rel` a forward-slash path as on disk. A symlink is refused
 * (IMPORT_FACE_ENTRY), so import never reads outside the face. A note with
 * no frontmatter block goes on. It establishes no concept and fails the
 * fidelity check with a warning.
 */
async function readFace(faceDir) {
  const root = await realpath(faceDir)
  const notes = new Map()
  const refused = { entry: [], conflict: [], reserved: [], id: [] }
  const walk = async (rel) => {
    for (const e of await readdir(rel === '' ? root : join(root, rel), { withFileTypes: true })) {
      const child = rel === '' ? e.name : `${rel}/${e.name}`
      if (e.isDirectory()) await walk(child)
      else if (!e.isFile()) refused.entry.push(child)
      else if (!child.endsWith('.md') || isReservedFile(child)) continue
      else if (CONFLICT_COPY_RE.test(child)) refused.conflict.push(child)
      else if (hasReservedSegment(child)) refused.reserved.push(child)
      else notes.set(child, await readFile(join(root, child)))
    }
  }
  await walk('')
  for (const [rel, raw] of notes) {
    const { fm } = parseNote(raw.toString('utf8'))
    if (fm !== null && !(typeof fm._id === 'string' && fm._id !== '')) refused.id.push(rel)
  }
  const refuse = (code, paths, what) => {
    paths.sort(byteCmp)
    const err = importError(code, `the face ${root} holds ${what}: ${paths.join(', ')}`)
    err.paths = paths
    return err
  }
  if (refused.entry.length > 0) {
    throw refuse(
      'IMPORT_FACE_ENTRY',
      refused.entry,
      'an entry that is not a regular file or a directory, such as a symlink. import reads only regular files and directories'
    )
  }
  if (refused.conflict.length > 0) {
    throw refuse(
      'IMPORT_CONFLICT_COPY',
      refused.conflict,
      'a conflicted copy, so a path collision is still open. Resolve it in the face first: give the copy a path of its own, or merge it and remove it'
    )
  }
  if (refused.reserved.length > 0) {
    throw refuse(
      'IMPORT_RESERVED_NAME',
      refused.reserved,
      'a note at a reserved .okf- name. The faces reserve these names for their own state: give the note another name'
    )
  }
  if (refused.id.length > 0) {
    throw refuse(
      'IMPORT_MISSING_ID',
      refused.id,
      "a note whose frontmatter holds no _id. A generation keeps each concept's _id, and import cannot keep " +
        'one that the note does not hold: give the note its _id (lowercase hex, SPEC §6), or remove it'
    )
  }
  return { root, notes }
}

/**
 * Refuse a `dir` that is not new or empty (IMPORT_DIR_NOT_EMPTY). A `dir`
 * that holds only CLAIM_FILE goes on to claimDir, which refuses it by name.
 */
async function refuseUsedDir(dir) {
  let names
  try {
    names = await readdir(dir)
  } catch (err) {
    if (err.code === 'ENOENT') {
      // A dangling symlink is no new directory: mkdir cannot create it.
      if ((await readlink(dir).catch(() => null)) === null) return
      names = null
    } else if (err.code === 'ENOTDIR') {
      names = null
    } else {
      throw err
    }
  }
  if (names !== null && names.every((name) => name === CLAIM_FILE)) return
  throw usedDirError(dir, names)
}

/** IMPORT_DIR_NOT_EMPTY for `dir`: `names` are its entries, or null when it is not a directory. */
function usedDirError(dir, names) {
  const what =
    names === null
      ? 'is not a directory'
      : names.includes(PINNED_FILE)
        ? `is already a vault (${PINNED_FILE} exists)`
        : `is not empty (${names.sort().slice(0, 4).join(', ')}${names.length > 4 ? ', ...' : ''})`
  return importError(
    'IMPORT_DIR_NOT_EMPTY',
    `${dir} ${what}. import makes the new vault only in a new or empty directory, so it never writes into an ` +
      'existing store: the import would revert the edits made there, and an encryption key would make it ' +
      'unreadable. Give a new <dir>'
  )
}

/**
 * Claim `dir` before the new vault writes to it. mkdir makes `dir` when it
 * is absent. Then an exclusive open ('wx') creates CLAIM_FILE. Only one
 * open can create the file, so one import at a time holds `dir`. Another
 * import refuses by name (IMPORT_DIR_CLAIMED) before its initBundle, and
 * deletes nothing.
 */
async function claimDir(dir) {
  const claim = join(dir, CLAIM_FILE)
  let created // the first directory that mkdir created: `dir` or a parent
  for (let attempt = 1; ; attempt++) {
    created = (await mkdir(dir, { recursive: true })) ?? created
    try {
      await (await open(claim, 'wx')).close()
      break
    } catch (err) {
      // ENOENT: the release of another import removed `dir` after the mkdir.
      if (err.code === 'ENOENT' && attempt < 3) continue
      await removeDirs(dir, created)
      if (err.code !== 'EEXIST') throw err
      throw importError(
        'IMPORT_DIR_CLAIMED',
        `${dir} is held by another import (${CLAIM_FILE} exists). An import holds <dir> until it ends. If no ` +
          'import runs, a signal stopped an import before its cleanup: remove <dir> and run import again'
      )
    }
  }
  const others = (await readdir(dir)).filter((name) => name !== CLAIM_FILE)
  if (others.length > 0) {
    // `dir` got entries after refuseUsedDir, for example from an import
    // that ended before this claim. They are not this import's: remove
    // only the claim.
    await rm(claim, { force: true })
    await removeDirs(dir, created)
    throw usedDirError(dir, others)
  }
  return {
    // Every entry in `dir` is one that this import created, so remove them
    // all. rmdir removes only an empty directory, so no entry of another
    // import goes.
    async release() {
      for (const name of await readdir(dir)) {
        if (name !== CLAIM_FILE) await rm(join(dir, name), { recursive: true, force: true })
      }
      await rm(claim, { force: true })
      await removeDirs(dir, created)
    },
    // The first open of the store moves the claim into `<dir>/db/`:
    // hypercore-storage moves each unknown top-level file of a new storage
    // directory there. So remove the claim at both places.
    async done() {
      await rm(claim, { force: true })
      await rm(join(dir, 'db', CLAIM_FILE), { force: true })
    }
  }
}

/** The key of the new vault: undefined for no key (undefined or null), else a 32-byte Buffer or Uint8Array. */
function keyOption(key) {
  if (key === undefined || key === null) return undefined
  if (key instanceof Uint8Array && key.byteLength === 32) return key
  const what = key instanceof Uint8Array ? `${key.byteLength} bytes` : Array.isArray(key) ? 'an array' : `a value of type ${typeof key}`
  throw importError(
    'IMPORT_ENCRYPTION_KEY_INVALID',
    `opts.encryptionKey is ${what}, and it must be a Buffer or a Uint8Array of 32 bytes. ` +
      'import never reads another value as no key, so it never makes an unencrypted vault by mistake. ' +
      'Give a 32-byte key (auto-okf import --encryption-key <hex64>), or leave the option out'
  )
}

/** The vault key of the predecessor as 64 lowercase hex characters, or null for none. */
function predecessorOption(key) {
  if (key === undefined || key === null) return null
  if (typeof key === 'string' && /^[0-9a-fA-F]{64}$/.test(key)) return key.toLowerCase()
  if (key instanceof Uint8Array && key.byteLength === 32) return Buffer.from(key).toString('hex')
  throw importError(
    'IMPORT_PREDECESSOR_INVALID',
    'opts.predecessorKey must be the vault key of the predecessor: 64 hex characters, or its 32 bytes'
  )
}

/** The metadata overrides of the new vault: the carried fields, and predecessorKey. */
function carriedMetadata(metadata, predecessorKey) {
  const out = {}
  if (metadata !== undefined && metadata !== null) {
    for (const key of CARRIED) {
      const v = metadata[key]
      if (v !== undefined) out[key] = v !== null && typeof v === 'object' ? { ...v } : v
    }
  }
  if (predecessorKey !== null) out.predecessorKey = predecessorKey
  return out
}

/**
 * rmdir `dir`, then each parent of it up to `created`, the first directory
 * that the mkdir of this import made. It stops at the first rmdir that
 * fails, such as on a directory that is not empty. No-op when `created` is
 * undefined.
 */
async function removeDirs(dir, created) {
  if (created === undefined) return
  for (let d = dir; ; d = dirname(d)) {
    try {
      await rmdir(d)
    } catch {
      return
    }
    if (d === created || dirname(d) === d) return
  }
}

/** The notes of a materialize of `vault`, in memory, without index.md and log.md. */
async function renderedNotes(vault) {
  const planned = await planBundle(vault)
  for (const rel of [...planned.keys()]) if (isReservedFile(rel)) planned.delete(rel)
  return planned
}

/** IMPORT_NOT_ENCRYPTED: import got a key, and the metadata of the new vault does not say encrypted. */
function requireEncrypted(vault, dir) {
  if (vault.metadata && vault.metadata.encrypted === true) return
  throw importError(
    'IMPORT_NOT_ENCRYPTED',
    `the new vault at ${dir} is not encrypted (its metadata does not say encrypted: true), ` +
      'but import got an encryption key for it: initBundle must pass opts.encryptionKey to the store'
  )
}

/** IMPORT_FIDELITY: every difference is in the message and in `differences`. */
function fidelityError(faceRoot, differences) {
  const err = importError(
    'IMPORT_FIDELITY',
    `the new vault does not match the face ${faceRoot} (_rev lines excluded, SPEC §14; index.md and log.md ` +
      `are regenerated faces, not compared): ${differences.length} difference(s). ` +
      'missing: only the face holds the note. extra: only the new vault holds it. differs: the bytes differ.\n' +
      differences.map(({ kind, path }) => `  ${kind} ${path}`).join('\n')
  )
  err.differences = differences
  return err
}

/**
 * Does the face at `root` hold ENCRYPTED_FILE? Any entry at that name
 * marks it, a directory or a symlink too (lstat), so import fails closed.
 */
async function isMarkedEncrypted(root) {
  try {
    await lstat(join(root, ENCRYPTED_FILE))
    return true
  } catch (err) {
    if (err.code === 'ENOENT') return false
    throw err
  }
}

/** IMPORT_ENCRYPTION_KEY_REQUIRED: `why` says how import knows that the face holds an encrypted vault. */
function keyRequiredError(why) {
  return importError(
    'IMPORT_ENCRYPTION_KEY_REQUIRED',
    `${why}, and a generation never makes an unencrypted copy of an encrypted vault (decision 8): give the ` +
      'new vault a key (opts.encryptionKey, auto-okf import --encryption-key <hex64>). The face is the plaintext export'
  )
}

function byteCmp(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

function importError(code, message) {
  const err = new Error(`${code}: ${message}`)
  err.code = code
  return err
}
