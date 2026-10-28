// importFace(initBundle, faceDir, dir, opts) — okf SPEC §10 generations: a
// new vault in a new directory, filled from a face on disk. A generation is
// two commands: `materialize` writes the face of the live vault, and
// `import` reads that face into a fresh vault. The face is inert source.
// import reads it once, writes nothing to it and opens no predecessor
// vault, so no stage, no verification copy and no live predecessor exist.
//
// Each note of the face goes through import-mode ingest
// (IngestWatcher.importNote): the emission manifest of the face is ignored,
// `_rev` is absent, a dot segment is part of a concept path, each op is
// checked against maxOpBytes as encoded before it is appended, and an op
// that core rejects fails the import by name.
//
// The fidelity check: after the import, the byte plan of a materialize of
// the new vault (planBundle, in memory) must equal the notes read from the
// face, byte for byte, without each `_rev` frontmatter line (§14). index.md
// and log.md are regenerated faces, which import never reads (§9), so the
// check leaves them out. A difference throws IMPORT_FIDELITY, and import
// removes the new directory. No verification copy is written to disk.
//
// This module imports no substrate (the rest of @auto-okf/faces does not
// either). The @auto-okf/store `Bundle.init` is passed in as `initBundle`;
// the CLI (okf/cli) wires the two together.
import { mkdir, readdir, readFile, readlink, realpath, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { planBundle } from './materialize.js'
import { createIngestWatcher } from './ingest.js'
import { isReservedDotFile, isReservedFile } from './fsatomic.js'
import { compareNotes } from './verify.js'

// §7: a conflicted copy is a note whose terminal name ends `.conflict-<hex>.md`.
const CONFLICT_COPY_RE = /\.conflict-[0-9a-f]{8,}\.md$/
// The store pins a vault in this file (@auto-okf/store METADATA_FILE). faces
// imports no substrate, so it names the file here.
const PINNED_FILE = 'okf-vault.json'
// The fields of the predecessor's metadata that the new vault carries.
const CARRIED = ['limits', 'rate', 'schemaVersion']

/**
 * Create a vault at `dir` from the notes of the face at `faceDir`.
 *
 *   initBundle  (required) the @auto-okf/store `Bundle.init(dir, opts)`.
 *   faceDir     the face: a directory of notes, such as one that
 *               `materialize` wrote. import reads every regular `.md` file
 *               in it, at any depth and dot segments included, except the
 *               regenerated faces index.md and log.md. A file that is not
 *               `.md`, such as the emission manifest, is not a note. import
 *               never writes to the face.
 *   dir         storage directory for the new vault: new, or an empty
 *               directory. A trailing slash names the same directory.
 *   opts.encryptionKey   a Buffer or a Uint8Array of 32 bytes: the new
 *               vault is encrypted with it. undefined or null: the new
 *               vault is not encrypted.
 *   opts.metadata        the predecessor's pinned metadata (the document in
 *               its okf-vault.json). The new vault carries its `limits`,
 *               `rate` and `schemaVersion`, and no other field. Without it,
 *               the new vault takes the defaults. When it says `encrypted:
 *               true`, opts.encryptionKey is required (decision 8: a
 *               generation of an encrypted vault is never unencrypted).
 *   opts.predecessorKey  the predecessor's vault key (64 hex characters, or
 *               32 bytes). The new vault records it as `predecessorKey`, and
 *               its generation id derives from it (§10). Without it, the
 *               new vault is a root vault.
 *
 * Refusals, by name, before import writes anything:
 *   IMPORT_NO_INITBUNDLE           initBundle is not a function
 *   IMPORT_ENCRYPTION_KEY_INVALID  a key that is not 32 bytes (the message
 *                                  never holds it); no value is read as no key
 *   IMPORT_ENCRYPTION_KEY_REQUIRED opts.metadata says encrypted, and no key
 *                                  was given
 *   IMPORT_PREDECESSOR_INVALID     a predecessorKey that is not a vault key
 *   IMPORT_DIR_NOT_EMPTY           `dir` is pinned (it holds okf-vault.json),
 *                                  is not empty, or is not a directory
 *   IMPORT_FACE_ENTRY              the face holds an entry that is not a
 *                                  regular file or a directory, such as a
 *                                  symlink
 *   IMPORT_CONFLICT_COPY           the face holds a `.conflict-<hex>` note: a
 *                                  collision is still open. Resolve it in
 *                                  the face first
 *   IMPORT_RESERVED_NAME           the face holds a note at a reserved `.okf-`
 *                                  name
 * Each of the last three carries `err.paths`.
 *
 * Failures after the new vault exists: IMPORT_NOT_ENCRYPTED (a key was
 * given and the new vault's metadata does not say encrypted),
 * IMPORT_OVERSIZE and IMPORT_REJECTED (import-mode ingest: `err.path`,
 * `err.op`, and `err.bytes` and `err.limit` or `err.reason`), and
 * IMPORT_FIDELITY (`err.differences`: [{ path, kind }], kind 'missing',
 * 'extra' or 'differs'). On each, import closes the new vault and removes
 * what it created in `dir`: `dir` itself when import created it, else only
 * the entries that it added. Every error after the refusals carries
 * `err.warnings` and `err.counts`.
 *
 * Returns { vault (the new vault, OPEN: the caller closes it), dir,
 *   generation, counts: { notes, imported }, warnings }. `notes` counts the
 * notes read from the face, and `imported` the notes that established a
 * concept. `warnings` is [{ kind, path, message }]: kind 'ingest' (a note
 * that does not parse, or that establishes no concept) or 'copy' (a note
 * whose `_id` another note holds: import minted a new `_id`).
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
    throw importError(
      'IMPORT_ENCRYPTION_KEY_REQUIRED',
      "the predecessor's metadata says encrypted, and a generation never makes an unencrypted copy of an " +
        'encrypted vault (decision 8): give the new vault a key (opts.encryptionKey, auto-okf import ' +
        '--encryption-key <hex64>). The face is the plaintext export'
    )
  }
  const metadata = carriedMetadata(opts.metadata, predecessorOption(opts.predecessorKey))
  const vaultDir = resolve(dir)
  await refuseUsedDir(vaultDir)
  const face = await readFace(resolve(faceDir))

  const counts = { notes: face.notes.size, imported: 0 }
  const warnings = []
  const outDir = await claimDir(vaultDir)
  let vault = null
  try {
    vault = await initBundle(vaultDir, { metadata, ...(encryptionKey !== undefined ? { encryptionKey } : {}) })
    // initBundle is injected, so import reads the metadata of the vault that
    // it got before it writes any content to it.
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
    return { vault, dir: vaultDir, generation: vault.generation, counts, warnings }
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
 * `root` the real path of the face and each `rel` a forward-slash path as it
 * is on disk. Then refuse, by name and in this order: an entry that is not a
 * regular file or a directory (IMPORT_FACE_ENTRY: import reads only what is
 * in the face, so a symlink never leads it out), a conflicted copy
 * (IMPORT_CONFLICT_COPY) and a note at a reserved `.okf-` name
 * (IMPORT_RESERVED_NAME: core takes such a path, but the faces reserve the
 * name for their own state).
 */
async function readFace(faceDir) {
  const root = await realpath(faceDir)
  const notes = new Map()
  const refused = { entry: [], conflict: [], reserved: [] }
  const walk = async (rel) => {
    for (const e of await readdir(rel === '' ? root : join(root, rel), { withFileTypes: true })) {
      const child = rel === '' ? e.name : `${rel}/${e.name}`
      if (e.isDirectory()) await walk(child)
      else if (!e.isFile()) refused.entry.push(child)
      else if (!child.endsWith('.md') || isReservedFile(child)) continue
      else if (CONFLICT_COPY_RE.test(child)) refused.conflict.push(child)
      else if (isReservedDotFile(child)) refused.reserved.push(child)
      else notes.set(child, await readFile(join(root, child)))
    }
  }
  await walk('')
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
  return { root, notes }
}

/** The notes of a materialize of `vault`, in memory: index.md and log.md left out. */
async function renderedNotes(vault) {
  const planned = await planBundle(vault)
  for (const rel of [...planned.keys()]) if (isReservedFile(rel)) planned.delete(rel)
  return planned
}

/**
 * G16: a `dir` that exists and is not an empty directory throws
 * IMPORT_DIR_NOT_EMPTY. A store in `dir` would take the import of the face,
 * which reverts the edits made there, or the encryption key, which makes it
 * unreadable. A pinned `dir` holds its metadata file, so this refuses it too.
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
  if (names !== null && names.length === 0) return
  const what =
    names === null
      ? 'is not a directory'
      : names.includes(PINNED_FILE)
        ? `is already a vault (${PINNED_FILE} exists)`
        : `is not empty (${names.sort().slice(0, 4).join(', ')}${names.length > 4 ? ', ...' : ''})`
  throw importError(
    'IMPORT_DIR_NOT_EMPTY',
    `${dir} ${what}. import makes the new vault only in a new or empty directory, so it never writes into an ` +
      'existing store: the import would revert the edits made there, and an encryption key would make it ' +
      'unreadable. Give a new <dir>'
  )
}

/**
 * Claim `dir` before the new vault writes to it. release() removes only
 * what this import created: the directory (with any parent that mkdir
 * created for it) when it did not exist, else only the entries that were not
 * in it at claim time. importFace admits an existing `dir` only when it is
 * empty, so release() leaves such a directory as it was.
 */
async function claimDir(dir) {
  const created = await mkdir(dir, { recursive: true }) // undefined when dir existed
  const before = created === undefined ? new Set(await readdir(dir)) : null
  return {
    async release() {
      if (created !== undefined) return rm(created, { recursive: true, force: true })
      for (const name of await readdir(dir)) {
        if (!before.has(name)) await rm(join(dir, name), { recursive: true, force: true })
      }
    }
  }
}

/** The new vault's key: undefined for no key (undefined or null), else a 32-byte Buffer or Uint8Array. */
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

/** The predecessor's vault key as 64 lowercase hex characters, or null for none. */
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

/** IMPORT_NOT_ENCRYPTED: import got a key, and the new vault's metadata does not say encrypted. */
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

function byteCmp(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

function importError(code, message) {
  const err = new Error(`${code}: ${message}`)
  err.code = code
  return err
}
