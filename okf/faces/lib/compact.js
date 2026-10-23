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
//      risk`);
//   3. ingest the bundle into the fresh vault with `_id` ADOPTION (§6/§9:
//      an incoming `_id` unknown to the fresh vault is authoritative on
//      create, so identity lineage survives the generation);
//   4. record the generation chain in the fresh vault's metadata
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
//     authored OKF bundle.
//   - Each staged note has its `_rev` line STRIPPED. A materialized `_rev` is
//     the base an ingest SetBody cites (§6); in the fresh vault that base does
//     not exist yet, which would flag `flag/conflict/<id>/-/<new>` and leave
//     the concept BODYLESS. Stripping `_rev` makes each head the concept's
//     first revision (`base:null`) — the only flag-free fresh start (§5) — so
//     the body survives and the new `_rev` re-derives (§14).
//
// The two halves split at the seam after the materialize step, so they can
// run in different processes, and on different substrate releases:
//
//   - materializeForCompact(vault, opts): the guardrail, the materialize, and
//     the predecessor checkpoint. It needs the predecessor vault open, and it
//     records the provenance in the face as `.okf-predecessor.json`.
//   - compactFromFace(faceDir, opts): staging, the fresh vault, the ingest
//     and the generation entry. It needs only the face directory and the
//     provenance (from opts, or the face's `.okf-predecessor.json`), never the
//     predecessor vault. This is the half that carries a vault across a
//     substrate flag day (autobee@1 to autobee@2): the old release writes the
//     face, the new release compacts it.
//
// compact(vault, opts) runs both halves in one process, as before.
//
// This module imports NO substrate (consistent with the rest of @auto-okf/
// faces: "the substrate is injected"). The @auto-okf/store `Bundle.init` is
// passed in as `opts.initBundle`; the CLI (okf/cli) wires the two together.
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { keyspace as K } from '@auto-okf/core'
import { materialize } from './materialize.js'
import { createIngestWatcher } from './ingest.js'
import { parseNote, renderNote } from './yaml.js'
import { walkNotes, isReservedFile, atomicWrite } from './fsatomic.js'

const CONFLICT_SUFFIX_RE = /\.conflict-[0-9a-f]{8,}\.md$/
const GENERATION_LOG_REL = 'log/generation.json'

/**
 * The provenance materializeForCompact leaves in the face: `{ predecessorKey,
 * predecessorCheckpoint }`. A dot-file, so every face reader (walkNotes,
 * status, ingest) skips it.
 */
export const PREDECESSOR_FILE = '.okf-predecessor.json'

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
 *   keyPair      custom signing keypair for the fresh vault's local writer
 *                (else the store generates a fresh one under the generation ns).
 *   encryptionKey  32-byte key for a private fresh vault (end to end).
 *   sign         async (checkpoint) => { signer, signature } (hex) — signs the
 *                predecessor checkpoint that anchors the generation chain (§10:
 *                operator-signed provenance, never verified here).
 *
 * Returns { ok, predecessorKey, predecessorPath, predecessorCheckpoint,
 *   vault (the fresh OPEN vault — the CALLER closes it), vaultDir, generation,
 *   bundleDir, stageDir, conflictCopies, logEntry, logPath, ingestOps }.
 *
 * compact NEVER deletes the predecessor: it returns `predecessorPath` for the
 * operator to archive or destroy out-of-band (§10 step 5).
 */
export async function compact(vault, opts = {}) {
  const { toDir, vaultDir, force = false, sign } = opts
  checkInitBundle(opts.initBundle)
  if (!toDir) throw compactError('COMPACT_NO_TODIR', 'opts.toDir is required')
  if (!vaultDir) throw compactError('COMPACT_NO_VAULTDIR', 'opts.vaultDir is required')

  const face = await materializeForCompact(vault, { toDir, force, sign })
  const res = await compactFromFace(toDir, {
    ...opts,
    predecessorKey: face.predecessorKey,
    predecessorCheckpoint: face.predecessorCheckpoint
  })
  return { ...res, predecessorPath: vault.dir, bundleDir: face.bundleDir }
}

/**
 * The first half of compact: everything that needs the predecessor vault.
 * Options: toDir (REQUIRED), force, sign (as for compact). Refuses on a live
 * conflict or pathcollision without force (COMPACT_REFUSED) and on a dirty
 * toDir without force (COMPACT_DIRTY_TARGET).
 *
 * Writes the face into toDir plus `<toDir>/.okf-predecessor.json`, and
 * returns { predecessorKey, predecessorCheckpoint, bundleDir, report }.
 */
export async function materializeForCompact(vault, opts = {}) {
  const { toDir, force = false, sign } = opts
  if (!toDir) throw compactError('COMPACT_NO_TODIR', 'opts.toDir is required')

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

  // ---- 3. checkpoint the predecessor (§10 step 4), recorded in the face ----
  const predecessorKey = vault.keyHex
  const predecessorCheckpoint = await vault.checkpoint() // { viewHash, writerLengths }
  if (typeof sign === 'function') {
    const sig = await sign(predecessorCheckpoint)
    if (sig && sig.signer !== undefined) predecessorCheckpoint.signer = sig.signer
    if (sig && sig.signature !== undefined) predecessorCheckpoint.signature = sig.signature
  }
  const provenance = { predecessorKey, predecessorCheckpoint }
  await atomicWrite(report.root, PREDECESSOR_FILE, Buffer.from(JSON.stringify(provenance, null, 2) + '\n'))

  return { predecessorKey, predecessorCheckpoint, bundleDir: report.root, report }
}

/**
 * The second half of compact: everything after the materialize step, from a
 * face directory alone. Options: initBundle and vaultDir (REQUIRED);
 * stageDir, keyPair, encryptionKey (as for compact); predecessorKey and
 * predecessorCheckpoint, which default to the face's `.okf-predecessor.json`.
 * Without either, it throws COMPACT_NO_PREDECESSOR: §10 requires the
 * generation chain in the new metadata.
 *
 * Returns what compact returns, with predecessorPath null (the predecessor
 * vault is not known here).
 */
export async function compactFromFace(faceDir, opts = {}) {
  const { vaultDir, keyPair, encryptionKey } = opts
  const initBundle = checkInitBundle(opts.initBundle)
  if (!faceDir) throw compactError('COMPACT_NO_TODIR', 'a face directory is required')
  if (!vaultDir) throw compactError('COMPACT_NO_VAULTDIR', 'opts.vaultDir is required')
  // Staging MUST live OUTSIDE vaultDir: `new Corestore(vaultDir)` clears the
  // vault directory on init, so a nested staging dir would be wiped before
  // ingest ever reads it (proven under sslop/033).
  const stageDir = opts.stageDir || `${vaultDir}.compact-src`

  let { predecessorKey = null, predecessorCheckpoint = null } = opts
  if (predecessorKey == null && predecessorCheckpoint == null) {
    const prov = await readProvenance(join(faceDir, PREDECESSOR_FILE))
    if (prov === null) {
      throw compactError(
        'COMPACT_NO_PREDECESSOR',
        `${faceDir} records no predecessor (${PREDECESSOR_FILE}); pass predecessorKey and ` +
          `predecessorCheckpoint — SPEC §10 requires the generation chain`
      )
    }
    predecessorKey = prov.predecessorKey
    predecessorCheckpoint = prov.predecessorCheckpoint
  }

  // ---- 1. stage a manifest-free, _rev-stripped copy for ingest ----
  await rm(stageDir, { recursive: true, force: true })
  await mkdir(stageDir, { recursive: true })
  const notes = []
  await walkNotes(faceDir, '', notes)
  const conflictCopies = []
  for (const rel of notes.sort(byteCmp)) {
    if (isReservedFile(rel)) continue // index.md / log.md are regenerated faces
    const raw = await readFile(join(faceDir, rel), 'utf8')
    const { fm, body } = parseNote(raw)
    if (!fm) continue // no frontmatter => not a concept note
    const pairs = []
    for (const [k, v] of Object.entries(fm)) {
      if (k === '_rev') continue // §6/§14: re-derives in the new generation (see header)
      pairs.push([k, v])
    }
    await writeStaged(stageDir, rel, renderNote(pairs, body))
    if (CONFLICT_SUFFIX_RE.test(rel)) {
      // §10 --force: enumerate every conflicted copy carried across. Identity
      // (_id) and path both survive the cycle, and the conflict suffix is
      // first-8-hex of SHA-256(_id) (§7) — so the collision re-manifests at the
      // SAME path in the new vault (deterministic carry-across, §9 conflict-
      // copy awareness). old conflict path === new conflict path.
      conflictCopies.push({ from: rel, to: rel, id: typeof fm._id === 'string' ? fm._id : null })
    }
  }

  // ---- 2. open the fresh vault with the generation chain (§10 step 3/4) ----
  const newVault = await initBundle(vaultDir, {
    metadata: { predecessorKey, predecessorCheckpoint },
    ...(keyPair !== undefined ? { keyPair } : {}),
    ...(encryptionKey !== undefined ? { encryptionKey } : {})
  })

  // ---- 3. ingest the staged bundle with _id adoption (§6/§9/§10) ----
  const watcher = await createIngestWatcher(newVault, stageDir, { watch: false })
  const ops = await watcher.scan()
  if (typeof newVault.update === 'function') await newVault.update()
  await watcher.close()

  // ---- 4. record the generation entry in the fresh vault's log/ (§10) ----
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
    predecessorPath: null,
    predecessorCheckpoint,
    vault: newVault,
    vaultDir,
    generation: newVault.generation,
    bundleDir: faceDir,
    stageDir,
    conflictCopies,
    logEntry,
    logPath,
    ingestOps: ops.length
  }
}

/** `{ predecessorKey, predecessorCheckpoint }` from a JSON file, or null if absent. */
async function readProvenance(path) {
  let raw
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
  const { predecessorKey = null, predecessorCheckpoint = null } = JSON.parse(raw)
  if (predecessorKey == null || predecessorCheckpoint == null) return null
  return { predecessorKey, predecessorCheckpoint }
}

function checkInitBundle(initBundle) {
  if (typeof initBundle !== 'function') {
    throw compactError('COMPACT_NO_INITBUNDLE', 'opts.initBundle (@auto-okf/store Bundle.init) is required')
  }
  return initBundle
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

function byteCmp(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

function compactError(code, message) {
  const err = new Error(`${code}: ${message}`)
  err.code = code
  return err
}
