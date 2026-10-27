// compact(vault, opts) — okf SPEC §10 generation-cycle compaction (the CouchDB
// homage, part two). Byte reclamation is an OPERATOR ACT VIA THE HYDRATED
// FACE, never an op (§8: the wire contract has no prune/compact/byte-
// destroying op at all). Compaction:
//
//   1. materialize the LIVE bundle (heads + _id/_rev; tombstoned concepts
//      suppressed; open conflicts as conflicted copies) into `toDir`;
//   2. init a FRESH vault whose writer keypairs cannot recur across generations
//      (@auto-okf/store derives writer cores under a per-generation corestore
//      namespace keyed by the predecessor fields — §10/N2, so adoption of
//      the predecessor's mint-shaped ids never deadlocks `mint-collision-
//      risk`). compact takes no keyPair, so nothing bypasses that
//      namespace. The fresh vault pins the predecessor's `limits` (§3);
//   3. ingest the bundle into the fresh vault with `_id` ADOPTION (§6/§9:
//      an incoming `_id` unknown to the fresh vault is authoritative on
//      create, so identity lineage survives the generation). Primary paths
//      import before conflicted copies, so each path keeps its owner (§7);
//   4. check its own output: materialize the fresh vault into a verification
//      directory and byte-compare it with the face, and compare the live
//      state of the fresh vault with the live state of the predecessor
//      (verify.js). A difference fails the cycle with COMPACT_FIDELITY, and
//      compaction removes what it wrote to the new out-dir;
//   5. record the generation chain in the fresh vault's metadata
//      ({ predecessorKey, predecessorCheckpoint }) and a generation entry in the
//      fresh vault's `log/`.
//
// Effect = CouchDB compaction (SPEC §10, I11): live STATE and IDENTITY
// survive byte-for-byte (every live concept's _id, type, fields, tags, path,
// head body), while HISTORY (old revisions, per-op attribution, clocks) is
// shed BY DESIGN. `_rev` and `log.md` necessarily re-derive in the new generation
// (SPEC §14): a head that was an EDIT (non-null base) re-roots at `base:null`
// in the fresh vault, so its revHash — the emitted `_rev` — changes even
// though the head TEXT is identical.
//
// Two mechanics are load-bearing and non-obvious (both proven under
// sslop/033 probes, recorded in DEVIATIONS.md):
//
//   - The predecessor's emission MANIFEST (.okf-manifest.json) is materialize
//     peer-local echo-suppression state, NOT part of the OKF bundle. Ingesting
//     `toDir` in place would make every file match that manifest and be
//     skipped as a self-echo, so compaction stages a MANIFEST-FREE copy of the
//     concept notes and ingests THAT — the fresh vault sees a plain, freshly
//     authored OKF bundle. The stage takes exactly the notes that the
//     manifest lists, dot-segment paths included, and each staged note goes
//     through the compaction import (`ingestFile(rel, { compaction: true })`),
//     which does not ignore a dot segment. Reserved `.okf-*` names stay out.
//   - Each staged note has its `_rev` line STRIPPED. A materialized `_rev` is
//     the base an ingest SetBody cites (§6); in the fresh vault that base does
//     not exist yet, which would flag `flag/conflict/<id>/-/<new>` and leave
//     the concept BODYLESS. Stripping `_rev` makes each head the concept's
//     first revision (`base:null`) — the only flag-free fresh start (§5) — so
//     the body survives and the new `_rev` re-derives (§14).
//
// This module imports NO substrate (consistent with the rest of @auto-okf/
// faces: "the substrate is injected"). The @auto-okf/store `Bundle.init` is
// passed in as `opts.initBundle`; the CLI (okf/cli) wires the two together.
import { lstat, mkdir, mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join, dirname, resolve, sep } from 'node:path'
import { keyspace as K } from '@auto-okf/core'
import { materialize } from './materialize.js'
import { createIngestWatcher } from './ingest.js'
import { parseNote, renderNote } from './yaml.js'
import { containedRealPath, loadManifest, isReservedDotFile, isReservedFile, realLocation } from './fsatomic.js'
import { compareTrees, compareStates, liveState } from './verify.js'

const CONFLICT_SUFFIX_RE = /\.conflict-[0-9a-f]{8,}\.md$/
const GENERATION_LOG_REL = 'log/generation.json'

/**
 * Run one generation cycle. `vault` is the (open) predecessor @auto-okf/store
 * Bundle. Options:
 *
 *   initBundle   (REQUIRED) the @auto-okf/store `Bundle.init(dir, opts)` — the
 *                fresh-vault factory. Injected so faces stays substrate-free.
 *   toDir        (REQUIRED) directory to materialize the hydrated face into
 *                (the operator's archival OKF bundle — keeps _id/_rev).
 *   vaultDir     (REQUIRED) storage directory for the fresh vault: a new or
 *                an empty directory. A vaultDir that exists and is not an
 *                empty directory, a pinned one included, throws
 *                COMPACT_OUT_DIR_NOT_EMPTY before compact writes anything
 *                (G16).
 *   stageDir     staging dir for the manifest-free, _rev-stripped bundle that
 *                is actually ingested (default `<vaultDir>.compact-src`). It
 *                holds plaintext. compact creates it for this run only, and
 *                removes it on success and on failure. A stageDir that exists
 *                throws COMPACT_STAGE_EXISTS before compact writes anything:
 *                compact never writes into or removes a stage directory that
 *                it did not create.
 *   force        proceed even though `flag/conflict` or `flag/pathcollision`
 *                is non-empty (SPEC §10 guardrail). Without it, compact
 *                REFUSES (throws COMPACT_REFUSED) so live conflicts are never
 *                silently frozen into a new generation.
 *   encryptionKey  32-byte key for a private fresh vault (end to end): a
 *                Buffer or a Uint8Array of exactly 32 bytes. REQUIRED when
 *                the predecessor is encrypted (its pinned
 *                `metadata.encrypted`). Without it (undefined or null),
 *                compact refuses with COMPACT_ENCRYPTION_KEY_REQUIRED. Any
 *                other value that is not such a key (false, '', 0, a hex
 *                string, a key of another length) throws
 *                COMPACT_ENCRYPTION_KEY_INVALID: compact never reads a value
 *                as no key. Both refusals come before compact reads, creates
 *                or writes anything, and neither message holds the value.
 *                No option makes an unencrypted copy of an encrypted vault.
 *                The key is never carried over from the predecessor: the
 *                caller names the fresh vault's key. With a key, the fresh
 *                vault must be encrypted: compact reads its metadata after
 *                initBundle, before the import, and again before success,
 *                and throws COMPACT_SUCCESSOR_NOT_ENCRYPTED when it says
 *                otherwise.
 *   sign         async (checkpoint) => { signer, signature } (hex) — signs the
 *                predecessor checkpoint that anchors the generation chain (§10:
 *                operator-signed provenance, never verified here).
 *   onPlaintext  async (warning) => void. When the predecessor is encrypted,
 *                compact calls it once with the plaintext warning of the
 *                face, and awaits it, before the first write to the face
 *                (materialize opts.onPlaintext). The CLI prints the warning
 *                there, so a failure or a crash after a plaintext write
 *                finds it already printed.
 *
 * compact takes no `keyPair`. The fresh vault always takes the writer key
 * pair that the store derives under the generation namespace (§10 step 3).
 * A supplied key pair bypasses that namespace: the store gives it the same
 * writer key in every directory, so the predecessor's pair gives the new
 * vault the predecessor's vault key. compact refuses a supplied `keyPair`
 * with COMPACT_KEYPAIR_REFUSED, before it reads, creates or writes anything.
 *
 * Returns { ok, predecessorKey, predecessorPath, predecessorCheckpoint,
 *   vault (the fresh OPEN vault — the CALLER closes it), vaultDir, generation,
 *   bundleDir, conflictCopies, logEntry, logPath, ingestOps, counts,
 *   warnings }.
 *
 *   counts    { walked, staged, ingested }: the concept notes that the face's
 *             emission manifest lists (index.md and log.md excluded), the
 *             notes written to the stage, and the staged notes the ingest
 *             turned into ops.
 *   warnings  [{ kind, path, message }], kind one of 'plaintext' (the face
 *             directory, when the predecessor is encrypted: the face holds
 *             its contents as plaintext, and this warning comes first, made
 *             before the first write to the face),
 *             'reserved' (a reserved `.okf-*` name the stage excludes),
 *             'parse' and 'no-frontmatter' (the stage parse), 'ingest',
 *             'oversize' and 'skip' (the ingest watcher's events). Every
 *             error that compact throws after the face step carries the
 *             warnings too, as `err.warnings`.
 *   conflictCopies  [{ from, to, id }] (§10 --force), one per conflicted
 *             copy that the import took: its path in the face, the path at
 *             which the new vault holds the _id that the import gave it (null
 *             when it holds none), and that _id (null when the import took no
 *             concept). The generation log records the same list.
 *
 * After the ingest, compact materializes the fresh vault into a verification
 * directory (a uniquely named sibling of stageDir, removed on success and on
 * failure) and byte-compares it with the face (verify.js: `_rev` lines and
 * log.md excluded, §14). The face is a lossy projection: it omits a scalar
 * null, emits only the first `type` value, and writes a reference or an
 * object as a string. So compact also compares the live state of the fresh
 * vault with the live state that the predecessor had at the face step
 * (verify.js liveState: each live concept's _id, path, body, field values
 * and tag values, read through okf's view keys; revisions, attribution and
 * clocks excluded, §10). On any difference it throws COMPACT_FIDELITY. The
 * error carries `differences` (every one also in the message), `warnings`,
 * `counts` and `conflictCopies`. A difference is { path, kind } for a file
 * (kind 'missing', 'extra' or 'differs'), or { path, kind: 'state', id, key }
 * for the live state of a concept (key '_id', 'path', 'body' or
 * 'f/<field>'). A note that the face holds and the stage or the ingest
 * dropped is such a difference. A vault that holds a value that the face
 * cannot hold fails loudly: compaction never changes a value in silence. On
 * COMPACT_FIDELITY, and on any other failure after it claims vaultDir,
 * compact closes the fresh vault and removes what it created there: vaultDir
 * itself when compact created it, else only the entries that it added.
 *
 * Before it writes or removes anything, compact resolves its five areas: the
 * predecessor directory, vaultDir, toDir, stageDir and the verification
 * directory. It follows symlinks, and it resolves a path that does not exist
 * yet through its nearest existing ancestor. Two areas that are equal or
 * nested throw COMPACT_PATH_OVERLAP, with the two area names in `err.areas`
 * (G49).
 *
 * compact NEVER deletes the predecessor: it returns `predecessorPath` for the
 * operator to archive or destroy out-of-band (§10 step 5).
 */
export async function compact(vault, opts = {}) {
  const { force = false, sign } = opts
  if (opts.keyPair !== undefined) {
    throw compactError(
      'COMPACT_KEYPAIR_REFUSED',
      'compact takes no keyPair: the fresh vault takes the writer key pair that the store derives ' +
        'under the generation namespace (SPEC §10 step 3), and a supplied key pair bypasses it'
    )
  }
  const initBundle = opts.initBundle
  if (typeof initBundle !== 'function') {
    throw compactError('COMPACT_NO_INITBUNDLE', 'opts.initBundle (@auto-okf/store Bundle.init) is required')
  }
  if (!opts.toDir) throw compactError('COMPACT_NO_TODIR', 'opts.toDir is required')
  if (!opts.vaultDir) throw compactError('COMPACT_NO_VAULTDIR', 'opts.vaultDir is required')
  // A key is never carried over, and no option makes an unencrypted copy of
  // an encrypted vault. materialize is the plaintext export.
  const encryptionKey = freshVaultKey(opts.encryptionKey, vault.metadata.encrypted === true)
  // The path guard, before compact writes or removes anything. From here on,
  // compact uses the normalized paths that it returns.
  const { toDir, vaultDir, stageDir } = await guardCompactPaths({
    predecessorDir: vault.dir,
    toDir: opts.toDir,
    vaultDir: opts.vaultDir,
    stageDir: opts.stageDir
  })

  if (typeof vault.update === 'function') await vault.update()

  // ---- 1. guardrail (§10): refuse on a live conflict/pathcollision ----
  const conflictKeys = await sampleKeys(vault, K.flagPrefix('conflict'))
  const collisionKeys = await sampleKeys(vault, K.flagPrefix('pathcollision'))
  if (!force && (conflictKeys.total > 0 || collisionKeys.total > 0)) {
    throw compactError(
      'COMPACT_REFUSED',
      `refusing to compact with open conflicts (SPEC §10): ` +
        `${conflictKeys.total} flag/conflict, ${collisionKeys.total} flag/pathcollision — ` +
        `resolve them or pass { force: true }. e.g. ` +
        [...conflictKeys.sample, ...collisionKeys.sample].slice(0, 4).join(', ')
    )
  }

  // ---- 2. materialize the hydrated face (§10 step 1) ----
  // The face is the plaintext artifact of compaction. When the predecessor
  // is encrypted, materialize announces the face before its first write:
  // the warning goes first into `warnings`, and to opts.onPlaintext. Every
  // way out from here on carries the warnings, a failure inside
  // materialize included.
  const warnings = []
  const onPlaintext = async (warning) => {
    warnings.push(warning)
    if (typeof opts.onPlaintext === 'function') await opts.onPlaintext(warning)
  }
  let ownStage = false
  try {
    const report = await materialize(vault, toDir, { onPlaintext })
    if (!report.ok && !force) {
      throw compactError(
        'COMPACT_DIRTY_TARGET',
        `toDir is not clean (pending-ingest: ${report.pendingIngest.join(', ')}) — ` +
          `use a fresh directory or pass { force: true }`
      )
    }
    // The live state that the fresh vault must hold (step 6): the
    // predecessor's, read just after the face step.
    const expected = await liveState(vault)

    // ---- 3. stage a manifest-free, _rev-stripped copy for ingest ----
    // The stage holds plaintext. compact creates it for this run, and the
    // finally below removes it on success and on failure. The mkdir of the
    // stage is exclusive: when the stage appeared after the check above, it
    // throws, and compact neither writes into nor removes a directory that
    // it did not create. (It removes stageDir only, never a parent that
    // mkdir created, because the out-dir can be in that parent.)
    await mkdir(dirname(stageDir), { recursive: true })
    await mkdir(stageDir).catch((err) => {
      throw err.code === 'EEXIST' ? stageExistsError(stageDir) : err
    })
    ownStage = true
    return await generateSuccessor(vault, report, warnings, { expected, stageDir, vaultDir, encryptionKey, sign, initBundle })
  } catch (err) {
    if (err !== null && typeof err === 'object' && err.warnings === undefined) err.warnings = warnings
    throw err
  } finally {
    if (ownStage) await rm(stageDir, { recursive: true, force: true })
  }
}

/**
 * The path guard of compaction (T18). compact() runs it before it writes or
 * removes anything. A caller that must refuse before it opens the
 * predecessor runs it first too: the CLI does, because an open and a close
 * of a vault rewrite files in its storage. It writes nothing.
 *
 * First it normalizes toDir, vaultDir and stageDir with path.resolve (G19):
 * a path names the same directory with or without a trailing slash, so the
 * default stage `<vaultDir>.compact-src` is a sibling of vaultDir, never in
 * it. Then, in order:
 *
 *   - the five areas (predecessorDir, vaultDir, toDir, the stage and the
 *     verification directory) must be separate: COMPACT_PATH_OVERLAP (G49);
 *   - vaultDir must be new or an empty directory: COMPACT_OUT_DIR_NOT_EMPTY
 *     (G16);
 *   - the stage must not exist: COMPACT_STAGE_EXISTS.
 *
 * Returns the normalized { toDir, vaultDir, stageDir } that compact uses.
 */
export async function guardCompactPaths({ predecessorDir = null, toDir, vaultDir, stageDir }) {
  // Staging MUST live OUTSIDE vaultDir: `new Corestore(vaultDir)` clears the
  // vault directory on init, so a nested staging dir would be wiped before
  // ingest ever reads it (proven under sslop/033).
  const paths = { toDir: resolve(toDir), vaultDir: resolve(vaultDir) }
  paths.stageDir = stageDir ? resolve(stageDir) : `${paths.vaultDir}.compact-src`
  await refuseOverlap([
    ['predecessor', predecessorDir],
    ['out-dir', paths.vaultDir],
    ['face', paths.toDir],
    ['stage', paths.stageDir],
    ['verification', `${verifyPrefix(paths.stageDir)}XXXXXX`]
  ])
  await refuseUsedOutDir(paths.vaultDir)
  // compact creates its stage for this run only, and step 3 creates it
  // exclusively.
  if (await lstat(paths.stageDir).catch(() => null)) throw stageExistsError(paths.stageDir)
  return paths
}

/** Everything after the stage is created: the staged copy, the fresh vault, its ingest, its check and its generation entry. */
async function generateSuccessor(vault, report, warnings, { expected, stageDir, vaultDir, encryptionKey, sign, initBundle }) {
  // The stage walks the face's emission manifest, not the directory: a
  // directory walk (walkNotes) skips every dot name, and a concept at a
  // dot-segment path such as `.drafts/idea` is a note that materialize wrote.
  const emitted = Object.keys((await loadManifest(report.root)).files)
  const staged = []
  const claimOrd = new Map() // conflicted copy -> the predecessor's claim ord of its _id (§4 c/<id>/path)
  const counts = { walked: 0, staged: 0, ingested: 0 }
  for (const rel of emitted.sort(byteCmp)) {
    if (!rel.endsWith('.md') || isReservedFile(rel)) continue // index.md / log.md are regenerated faces
    counts.walked++
    if (isReservedDotFile(rel)) {
      // The faces reserve the `.okf-*` names for their own state. The face
      // still holds the note, so the fidelity check (step 6) fails on it.
      warnings.push({ kind: 'reserved', path: rel, message: 'a reserved .okf- dot-file name; not staged' })
      continue
    }
    // The manifest is peer-local state in the face. A path that it lists and
    // that leads out of the face, by '..' or by a symlink, throws
    // UNSAFE_PATH, so the stage never reads or writes outside its two roots.
    const raw = await readFile(await containedRealPath(report.root, rel), 'utf8')
    const { fm, body, warnings: parseWarnings } = parseNote(raw)
    for (const message of parseWarnings) warnings.push({ kind: 'parse', path: rel, message })
    if (!fm) {
      // Not a concept note to the stage. The face still holds it, so the
      // fidelity check (step 6) fails on it: a drop is never only a warning.
      warnings.push({ kind: 'no-frontmatter', path: rel, message: 'no parseable frontmatter; not staged' })
      continue
    }
    const pairs = []
    for (const [k, v] of Object.entries(fm)) {
      if (k === '_rev') continue // §6/§14: re-derives in the new generation (see header)
      pairs.push([k, v])
    }
    await writeStaged(stageDir, rel, renderNote(pairs, body))
    staged.push(rel)
    counts.staged++
    if (isConflictCopy(rel)) {
      // The import order of the copies (step 5) is their claim order in the
      // predecessor.
      const pathRec = typeof fm._id === 'string' ? await vault.val(K.cPath(fm._id)) : undefined
      claimOrd.set(rel, pathRec && typeof pathRec.ord === 'number' ? pathRec.ord : Infinity)
    }
  }

  // ---- 4. checkpoint the predecessor and open the fresh vault (§10 step 3/4) ----
  const predecessorKey = vault.keyHex
  const predecessorCheckpoint = await vault.checkpoint() // { viewHash, writerLengths }
  if (typeof sign === 'function') {
    const sig = await sign(predecessorCheckpoint)
    if (sig && sig.signer !== undefined) predecessorCheckpoint.signer = sig.signer
    if (sig && sig.signature !== undefined) predecessorCheckpoint.signature = sig.signature
  }

  // From here on, a failure closes the fresh vault and removes what this
  // compaction created in vaultDir, so no partial out-dir remains.
  const outDir = await claimDir(vaultDir)
  let newVault = null
  try {
    // The fresh vault pins the predecessor's limits (§3). Every note in the
    // face fitted them, and the fresh vault's apply and the ingest preflight
    // check each op against them.
    newVault = await initBundle(vaultDir, {
      metadata: { predecessorKey, predecessorCheckpoint, limits: { ...vault.metadata.limits } },
      ...(encryptionKey !== undefined ? { encryptionKey } : {})
    })
    // With a key, the fresh vault is encrypted before the import writes any
    // content to it. initBundle is injected, so compact reads the metadata
    // of the vault that it got.
    if (encryptionKey !== undefined) requireEncrypted(newVault, vaultDir)

    // ---- 5. ingest the staged bundle with _id adoption (§6/§9/§10) ----
    // Each staged path goes through the explicit compaction import. scan()
    // would walk the stage with walkNotes again, and ingestFile without the
    // option ignores every dot path.
    //
    // The import order keeps each path with its owner in the predecessor
    // (G28). §7 gives a path to the earliest claim, and a conflicted copy
    // claims its suffix-stripped path (§9). Byte order puts
    // `note.conflict-<h8>.md` before `note.md`, so in byte order the copy
    // claims the path first, and the owner and the loser swap. So:
    //   - Every primary path comes first, in byte order. No two primary
    //     notes claim one casefold path (§7 flags every later claimant), so
    //     their order changes no holder.
    //   - Then every `.conflict-` copy, in the order of its claim in the
    //     predecessor (the ord of c/<id>/path), then in byte order. Two
    //     copies can claim one exact path: when the casefold winner is at
    //     another exact path, each later claimant is a copy, and the earliest
    //     of them holds the exact path (path/<p>, where links resolve).
    const copies = staged.filter(isConflictCopy).sort((p, q) => claimOrd.get(p) - claimOrd.get(q) || byteCmp(p, q))
    const importOrder = [...staged.filter((rel) => !isConflictCopy(rel)), ...copies]
    const watcher = await createIngestWatcher(newVault, stageDir, { watch: false })
    watcher.on('warning', ({ path, message }) => warnings.push({ kind: 'ingest', path, message }))
    watcher.on('oversize', ({ path, bytes, limit }) =>
      warnings.push({ kind: 'oversize', path, message: `body is ${bytes} bytes; maxOpBytes is ${limit}; not ingested` })
    )
    watcher.on('skip', ({ path, reason }) => warnings.push({ kind: 'skip', path, message: `skipped by the ingest (${reason})` }))
    watcher.on('ops', ({ ops }) => {
      if (ops.length > 0) counts.ingested++
    })
    const ops = []
    const imported = [] // { rel, id }: each conflicted copy, and the _id that the import gave it
    try {
      for (const rel of importOrder) {
        const fileOps = await watcher.ingestFile(rel, { compaction: true })
        ops.push(...fileOps)
        // Every op of one file names the concept of that file, and the
        // create names the adopted _id. No op: the import took no concept.
        if (isConflictCopy(rel)) imported.push({ rel, id: fileOps.length > 0 ? fileOps[0].payload.id : null })
      }
      if (typeof newVault.update === 'function') await newVault.update()
    } finally {
      await watcher.close()
    }

    // ---- 6. check its own output (§10, §14) ----
    const ids = new Set(imported.map(({ id }) => id).filter((id) => id !== null))
    const { differences, notes } = await verifyGeneration(newVault, report.root, stageDir, ids, expected)
    // §10 --force: the carry-across mapping comes from what the import did.
    // For each conflicted copy: its path in the face, the _id that the
    // import gave it, and the path at which the new vault holds that _id
    // (null when it holds none). When the check passes, to === from (§9
    // conflict-copy awareness: the _id and the path both survive, and the
    // copy name is a function of the _id, §7).
    const conflictCopies = imported.map(({ rel, id }) => ({ from: rel, to: (id !== null && notes.get(id)) || null, id }))
    if (differences.length > 0) throw fidelityError(report.root, differences, warnings, counts, conflictCopies)

    // ---- 7. record the generation entry in the fresh vault's log/ (§10) ----
    // The §3 append-only wire contract has NO generation op and the view's log/
    // family is apply-only, so the §10 generation entry is a durable filesystem
    // artifact under the fresh vault's log/ (DEVIATIONS.md). It carries the
    // generation chain and, under --force, the conflicted-copy carry-across map.
    const logEntry = {
      kind: 'generation',
      generation: newVault.generation,
      at: Date.now(),
      predecessorKey,
      predecessorCheckpoint,
      conflictCopies,
      note:
        'generation cycle (SPEC §10): live state + identity preserved byte-for-byte; ' +
        'history (old revisions, per-op attribution, clocks) shed by design.'
    }
    const logPath = join(vaultDir, GENERATION_LOG_REL)
    await mkdir(dirname(logPath), { recursive: true })
    await writeFile(logPath, JSON.stringify(logEntry, null, 2) + '\n')

    // With a key, the fresh vault is still encrypted at success.
    if (encryptionKey !== undefined) requireEncrypted(newVault, vaultDir)

    return {
      ok: true,
      predecessorKey,
      predecessorPath: vault.dir, // §10 step 5: operator archives/destroys this
      predecessorCheckpoint,
      vault: newVault,
      vaultDir,
      generation: newVault.generation,
      bundleDir: report.root,
      conflictCopies,
      logEntry,
      logPath,
      ingestOps: ops.length,
      counts,
      warnings
    }
  } catch (err) {
    try {
      if (newVault) await newVault.close()
    } finally {
      await outDir.release()
    }
    throw err
  }
}

/**
 * Claim the out-dir before the fresh vault writes to it. release() removes
 * only what this compaction created: the directory (with any parent that
 * mkdir created for it) when it did not exist, else only the entries that
 * were not in it at claim time. It never removes a directory that this
 * compaction did not create. compact admits an out-dir that exists only
 * when it is empty (refuseUsedOutDir), so release() leaves such an out-dir
 * as it was before the run.
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

/**
 * Materialize the fresh vault into a verification directory and compare it
 * with the face (§14: `_rev` lines and log.md excluded). Then compare the
 * live state of the fresh vault with `expected`, the predecessor's (§10).
 * The directory is a sibling of the stage. mkdtemp creates it exclusively
 * under a new unique name, so no existing path is ever reused, and it is
 * removed on every way out. Returns { differences, notes }: the file
 * differences, then the state differences, and `notes` maps each _id in
 * `ids` to the note that materialize wrote for it.
 */
async function verifyGeneration(newVault, faceDir, stageDir, ids, expected) {
  const verifyDir = await mkdtemp(verifyPrefix(stageDir))
  try {
    const report = await materialize(newVault, verifyDir)
    const differences = [...(await compareTrees(faceDir, verifyDir)), ...compareStates(expected, await liveState(newVault))]
    return { differences, notes: await notesOf(report, ids) }
  } finally {
    await rm(verifyDir, { recursive: true, force: true })
  }
}

/**
 * G16: an out-dir that exists and is not an empty directory throws
 * COMPACT_OUT_DIR_NOT_EMPTY. A store in the out-dir would take the ingest of
 * the face, which reverts the edits made in it, or the encryption key, which
 * makes it unreadable. A pinned out-dir holds its metadata file, so this
 * refuses it too.
 */
async function refuseUsedOutDir(vaultDir) {
  let names
  try {
    names = await readdir(vaultDir)
  } catch (err) {
    if (err.code === 'ENOENT') return
    if (err.code !== 'ENOTDIR') throw err
    names = null
  }
  if (names !== null && names.length === 0) return
  const what = names === null ? 'is not a directory' : `is not empty (${names.sort().slice(0, 4).join(', ')}${names.length > 4 ? ', ...' : ''})`
  throw compactError(
    'COMPACT_OUT_DIR_NOT_EMPTY',
    `the out-dir ${vaultDir} ${what}. Compaction makes the fresh vault only in a new or empty directory, so it ` +
      'never writes into an existing store: the ingest would revert the edits made there, and an encryption key ' +
      'would make it unreadable. Give a new out-dir'
  )
}

/**
 * The fresh vault's encryption key: undefined when the caller gave none
 * (undefined or null), else the 32-byte Buffer or Uint8Array that the caller
 * gave. No key for an encrypted predecessor throws
 * COMPACT_ENCRYPTION_KEY_REQUIRED. Any other value throws
 * COMPACT_ENCRYPTION_KEY_INVALID: the store reads a false value as no key,
 * so a value that is not a key would give an unencrypted fresh vault. The
 * messages never hold the value.
 */
function freshVaultKey(key, predecessorEncrypted) {
  if (key === undefined || key === null) {
    if (!predecessorEncrypted) return undefined
    throw compactError(
      'COMPACT_ENCRYPTION_KEY_REQUIRED',
      'the predecessor vault is encrypted, and compaction never makes an unencrypted copy: ' +
        'give the fresh vault an encryption key (opts.encryptionKey, auto-okf compact --encryption-key <hex64>). ' +
        'materialize is the plaintext export'
    )
  }
  if (key instanceof Uint8Array && key.byteLength === 32) return key
  const what = key instanceof Uint8Array ? `${key.byteLength} bytes` : Array.isArray(key) ? 'an array' : `a value of type ${typeof key}`
  throw compactError(
    'COMPACT_ENCRYPTION_KEY_INVALID',
    `opts.encryptionKey is ${what}, and it must be a Buffer or a Uint8Array of 32 bytes. ` +
      'Compaction never reads another value as no key, so it never makes an unencrypted vault by mistake. ' +
      'Give a 32-byte key (auto-okf compact --encryption-key <hex64>), or leave the option out'
  )
}

/** COMPACT_SUCCESSOR_NOT_ENCRYPTED: compact got a key, and the fresh vault's metadata does not say encrypted. */
function requireEncrypted(newVault, vaultDir) {
  if (newVault.metadata && newVault.metadata.encrypted === true) return
  throw compactError(
    'COMPACT_SUCCESSOR_NOT_ENCRYPTED',
    `the fresh vault at ${vaultDir} is not encrypted (its metadata does not say encrypted: true), ` +
      'but compact got an encryption key for it. Compaction never makes an unencrypted copy of an encrypted ' +
      'vault: initBundle must pass opts.encryptionKey to the store'
  )
}

/** COMPACT_STAGE_EXISTS: compact creates its stage for this run only. */
function stageExistsError(stageDir) {
  return compactError(
    'COMPACT_STAGE_EXISTS',
    `the stage ${stageDir} exists. Compaction creates its stage for this run only, and it never writes into ` +
      'or removes a directory that it did not create. A run that stopped can leave its stage, which holds ' +
      'plaintext: examine it and remove it, or give another out-dir or stageDir'
  )
}

/** The verification directory is this prefix plus the six characters that mkdtemp picks: a sibling of the stage. */
function verifyPrefix(stageDir) {
  return `${resolve(stageDir)}.verify-`
}

const AREA_LABEL = { verification: 'verification directory' }

/**
 * The path guard of compaction (G49). compact uses five areas: the
 * predecessor directory, the out-dir (vaultDir), the face (toDir), the stage
 * and the verification directory. `areas` is [[name, path]] in that order. A
 * null path (a predecessor that has no directory) is no area. The guard
 * resolves each path to its real location: it follows symlinks, and it
 * resolves a path that does not exist yet through its nearest existing
 * ancestor. The verification directory does not exist until step 6, so it
 * resolves through the parent of the stage. Two areas that are equal, or of
 * which one contains the other, throw COMPACT_PATH_OVERLAP. `err.areas`
 * names the two. The guard writes nothing.
 */
async function refuseOverlap(areas) {
  const resolved = []
  for (const [name, path] of areas) {
    if (path !== null && path !== undefined) resolved.push({ name, path, real: await realLocation(path) })
  }
  for (let i = 0; i < resolved.length; i++) {
    for (let j = i + 1; j < resolved.length; j++) {
      const how = overlap(resolved[i].real, resolved[j].real)
      if (how === null) continue
      const show = ({ name, path, real }) => `the ${AREA_LABEL[name] || name} ${path}${real === resolve(path) ? '' : ` (real path ${real})`}`
      const err = compactError(
        'COMPACT_PATH_OVERLAP',
        `${show(resolved[i])} ${how} ${show(resolved[j])}. Compaction needs five separate areas: ` +
          'the predecessor, the out-dir, the face, the stage and the verification directory. No area may equal or contain another'
      )
      err.areas = [resolved[i].name, resolved[j].name]
      throw err
    }
  }
}

/**
 * 'is', 'contains' or 'is inside' when real paths `a` and `b` overlap, else
 * null. The comparison ignores case and Unicode normalization: a path that
 * does not exist yet keeps the case that the caller gave, and the default
 * macOS file system treats two such spellings as one directory.
 */
function overlap(a, b) {
  const x = a.normalize('NFC').toLowerCase()
  const y = b.normalize('NFC').toLowerCase()
  if (x === y) return 'is'
  if (y.startsWith(x.endsWith(sep) ? x : x + sep)) return 'contains'
  if (x.startsWith(y.endsWith(sep) ? y : y + sep)) return 'is inside'
  return null
}

/** The note that a materialize report wrote for each _id in `ids`: Map<_id, path>. */
async function notesOf(report, ids) {
  const notes = new Map()
  if (ids.size === 0) return notes
  for (const rel of [...report.written, ...report.unchanged]) {
    if (!rel.endsWith('.md') || isReservedFile(rel)) continue
    const { fm } = parseNote(await readFile(join(report.root, rel), 'utf8'))
    if (fm && ids.has(fm._id)) notes.set(fm._id, rel)
  }
  return notes
}

/** COMPACT_FIDELITY: every difference is in the message and in `differences`. */
function fidelityError(faceDir, differences, warnings, counts, conflictCopies) {
  const err = compactError(
    'COMPACT_FIDELITY',
    `the new vault does not match the face ${faceDir} (_rev lines and log.md excluded, SPEC §14), ` +
      `or the live state of the predecessor (revisions, attribution and clocks excluded, SPEC §10): ` +
      `${differences.length} difference(s). missing: only the face has the file. ` +
      `extra: only the new vault has the file. differs: the bytes differ. ` +
      `state: the live state of the concept differs at the key named ` +
      `(_id: the concept is live in one vault only, path, body, or f/<field>).\n` +
      differences.map(differenceLine).join('\n')
  )
  err.differences = differences
  err.warnings = warnings
  err.counts = counts
  err.conflictCopies = conflictCopies
  return err
}

/** One line of the COMPACT_FIDELITY message: `  differs index.md`, `  state notes/a (_id <id>): f/type`. */
function differenceLine(d) {
  return d.kind === 'state' ? `  state ${d.path} (_id ${d.id}): ${d.key}` : `  ${d.kind} ${d.path}`
}

/** Count (and sample up to 4) keys under a view prefix. */
async function sampleKeys(vault, prefix) {
  let total = 0
  const sample = []
  for await (const { key } of vault.scan(prefix)) {
    total++
    if (sample.length < 4) sample.push(key)
  }
  return { total, sample }
}

/** Write one staged note, creating parent directories as needed. */
async function writeStaged(stageDir, rel, text) {
  const abs = join(stageDir, rel)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, text)
}

/** §7: a conflicted copy is a note whose terminal name ends `.conflict-<hex>.md`. */
function isConflictCopy(rel) {
  return CONFLICT_SUFFIX_RE.test(rel)
}

function byteCmp(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

function compactError(code, message) {
  const err = new Error(`${code}: ${message}`)
  err.code = code
  return err
}
