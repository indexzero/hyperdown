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
//      directory and byte-compare it with the face (verify.js). A difference
//      fails the cycle with COMPACT_FIDELITY, and compaction removes what it
//      wrote to the new out-dir;
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
import { mkdir, mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join, dirname, basename, resolve } from 'node:path'
import { keyspace as K } from '@auto-okf/core'
import { materialize } from './materialize.js'
import { createIngestWatcher } from './ingest.js'
import { parseNote, renderNote } from './yaml.js'
import { containedRealPath, loadManifest, isReservedDotFile, isReservedFile } from './fsatomic.js'
import { compareTrees } from './verify.js'

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
 *   vaultDir     (REQUIRED) storage directory for the fresh vault.
 *   stageDir     staging dir for the manifest-free, _rev-stripped bundle that
 *                is actually ingested (default `<vaultDir>.compact-src`).
 *   force        proceed even though `flag/conflict` or `flag/pathcollision`
 *                is non-empty (SPEC §10 guardrail). Without it, compact
 *                REFUSES (throws COMPACT_REFUSED) so live conflicts are never
 *                silently frozen into a new generation.
 *   encryptionKey  32-byte key for a private fresh vault (end to end).
 *                REQUIRED when the predecessor is encrypted (its pinned
 *                `metadata.encrypted`). Without it, compact refuses with
 *                COMPACT_ENCRYPTION_KEY_REQUIRED, before it reads, creates
 *                or writes anything. No option makes an unencrypted copy of an
 *                encrypted vault. The key is never carried over from the
 *                predecessor: the caller names the fresh vault's key.
 *   sign         async (checkpoint) => { signer, signature } (hex) — signs the
 *                predecessor checkpoint that anchors the generation chain (§10:
 *                operator-signed provenance, never verified here).
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
 *   bundleDir, stageDir, conflictCopies, logEntry, logPath, ingestOps,
 *   counts, warnings }.
 *
 *   counts    { walked, staged, ingested }: the concept notes that the face's
 *             emission manifest lists (index.md and log.md excluded), the
 *             notes written to the stage, and the staged notes the ingest
 *             turned into ops.
 *   warnings  [{ kind, path, message }], kind one of 'reserved' (a reserved
 *             `.okf-*` name the stage excludes), 'parse' and
 *             'no-frontmatter' (the stage parse), 'ingest', 'oversize' and
 *             'skip' (the ingest watcher's events).
 *   conflictCopies  [{ from, to, id }] (§10 --force), one per conflicted
 *             copy that the import took: its path in the face, the path at
 *             which the new vault holds the _id that the import gave it (null
 *             when it holds none), and that _id (null when the import took no
 *             concept). The generation log records the same list.
 *
 * After the ingest, compact materializes the fresh vault into a verification
 * directory (a uniquely named sibling of stageDir, removed on success and on
 * failure) and byte-compares it with the face (verify.js: `_rev` lines and
 * log.md excluded, §14). On any difference it throws COMPACT_FIDELITY. The
 * error carries `differences` ([{ path, kind }], every one also in the
 * message), `warnings`, `counts` and `conflictCopies`. A note that the face
 * holds and the stage or the ingest dropped is such a difference. On
 * COMPACT_FIDELITY, and on any other failure after it claims vaultDir,
 * compact closes the fresh vault and removes what it created there: vaultDir
 * itself when compact created it, else only the entries that it added.
 *
 * compact NEVER deletes the predecessor: it returns `predecessorPath` for the
 * operator to archive or destroy out-of-band (§10 step 5).
 */
export async function compact(vault, opts = {}) {
  const { toDir, vaultDir, force = false, encryptionKey, sign } = opts
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
  if (!toDir) throw compactError('COMPACT_NO_TODIR', 'opts.toDir is required')
  if (!vaultDir) throw compactError('COMPACT_NO_VAULTDIR', 'opts.vaultDir is required')
  // A key is never carried over, and no option makes an unencrypted copy of
  // an encrypted vault. materialize is the plaintext export.
  if (vault.metadata.encrypted === true && (encryptionKey === undefined || encryptionKey === null)) {
    throw compactError(
      'COMPACT_ENCRYPTION_KEY_REQUIRED',
      'the predecessor vault is encrypted, and compaction never makes an unencrypted copy: ' +
        'give the fresh vault an encryption key (opts.encryptionKey, auto-okf compact --encryption-key <hex64>). ' +
        'materialize is the plaintext export'
    )
  }
  // Staging MUST live OUTSIDE vaultDir: `new Corestore(vaultDir)` clears the
  // vault directory on init, so a nested staging dir would be wiped before
  // ingest ever reads it (proven under sslop/033).
  const stageDir = opts.stageDir || `${vaultDir}.compact-src`

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
  const report = await materialize(vault, toDir)
  if (!report.ok && !force) {
    throw compactError(
      'COMPACT_DIRTY_TARGET',
      `toDir is not clean (pending-ingest: ${report.pendingIngest.join(', ')}) — ` +
        `use a fresh directory or pass { force: true }`
    )
  }

  // ---- 3. stage a manifest-free, _rev-stripped copy for ingest ----
  // The stage walks the face's emission manifest, not the directory: a
  // directory walk (walkNotes) skips every dot name, and a concept at a
  // dot-segment path such as `.drafts/idea` is a note that materialize wrote.
  await rm(stageDir, { recursive: true, force: true })
  await mkdir(stageDir, { recursive: true })
  const emitted = Object.keys((await loadManifest(report.root)).files)
  const staged = []
  const claimOrd = new Map() // conflicted copy -> the predecessor's claim ord of its _id (§4 c/<id>/path)
  const counts = { walked: 0, staged: 0, ingested: 0 }
  const warnings = []
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
    const { differences, notes } = await verifyGeneration(newVault, report.root, stageDir, ids)
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

    return {
      ok: true,
      predecessorKey,
      predecessorPath: vault.dir, // §10 step 5: operator archives/destroys this
      predecessorCheckpoint,
      vault: newVault,
      vaultDir,
      generation: newVault.generation,
      bundleDir: report.root,
      stageDir,
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
 * compaction did not create.
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
 * with the face (§14: `_rev` lines and log.md excluded). The directory is a
 * sibling of the stage. mkdtemp creates it exclusively under a new unique
 * name, so no existing path is ever reused, and it is removed on every way
 * out. Returns { differences, notes }: `notes` maps each _id in `ids` to the
 * note that materialize wrote for it.
 */
async function verifyGeneration(newVault, faceDir, stageDir, ids) {
  const stage = resolve(stageDir)
  const verifyDir = await mkdtemp(join(dirname(stage), `${basename(stage)}.verify-`))
  try {
    const report = await materialize(newVault, verifyDir)
    const differences = await compareTrees(faceDir, verifyDir)
    return { differences, notes: await notesOf(report, ids) }
  } finally {
    await rm(verifyDir, { recursive: true, force: true })
  }
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
    `the new vault does not match the face ${faceDir} (_rev lines and log.md excluded, SPEC §14): ` +
      `${differences.length} difference(s). missing: only the face has the file. ` +
      `extra: only the new vault has the file. differs: the bytes differ.\n` +
      differences.map((d) => `  ${d.kind} ${d.path}`).join('\n')
  )
  err.differences = differences
  err.warnings = warnings
  err.counts = counts
  err.conflictCopies = conflictCopies
  return err
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
