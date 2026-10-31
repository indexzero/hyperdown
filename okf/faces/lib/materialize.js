// materialize(vault, dir, opts) — okf SPEC §9: walk the view and emit a
// byte-deterministic OKF v0.1 bundle (concept files + per-directory
// index.md + root log.md). Every emitted byte is a pure function of the
// converged view (I9): converged peers emit identical bundles.
//
// N3 (load-bearing — "deletion is dangerous"): materialize reconciles the
// directory to the view THROUGH AN EMISSION MANIFEST, never by blind
// mirroring. A concept `.md` file whose current bytes differ from its
// manifest entry — or that has no entry at all (human-authored, not yet
// ingested) — is NEVER deleted or overwritten. It is left in place and
// surfaced as pending-ingest; the run reports not-ok unless ingest is run
// first (opts.forceMirror restores unconditional mirroring for operator
// use). The only removal candidates are manifest-tracked files this run did
// not produce whose current bytes still match their manifest entry (prior
// conflict copies, prior paths of renamed concepts, index.md of vanished
// directories).
import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import { keyspace as K, canonical, dirOf, casefoldPath } from '@auto-okf/core'
import { readView, readLog, collisionKey } from './view.js'
import { renderNote, emitFrontmatter, parseNote, yamlToValues } from './yaml.js'
import {
  rootRegistry,
  withPathLock,
  containedPath,
  containedParent,
  atomicWrite,
  atomicUnlink,
  hashFile,
  sha256,
  loadManifest,
  saveManifest,
  pruneEmptyDirs,
  isReservedFile,
  walkNotes,
  MANIFEST_FILE,
  ENCRYPTED_FILE,
  ENCRYPTED_TEXT
} from './fsatomic.js'

const { sortValues, byteForm, canonicalArray, nfc } = canonical

function byteCmp(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

function lastComponent(p) {
  return String(p).split('/').pop()
}

/** OR-set element map -> emitted value list (dedup, canonical §5 byte order). */
function orSetValues(rec) {
  const els = (rec && rec.els) || {}
  const seen = new Set()
  const out = []
  for (const v of sortValues(Object.values(els))) {
    const bf = byteForm(v)
    if (seen.has(bf)) continue
    seen.add(bf)
    out.push(v)
  }
  return out
}

/** Emitted frontmatter value for one field key (null => omit the key). */
function fieldEmitValue(key, rec) {
  if (key === 'tags') {
    const vals = orSetValues(rec)
    return vals.length === 0 ? null : vals // OKF §4.1: tags is a list
  }
  const values = rec && Array.isArray(rec.values) ? rec.values : []
  if (values.length === 0) return null // §5 empty LWW state => key omitted
  return values.length === 1 ? values[0] : values
}

/** §6 frontmatter pairs for one concept, in emission order. */
function frontmatterPairs(concept) {
  const pairs = [['_id', concept.id]]
  if (concept.headHash !== undefined) pairs.push(['_rev', concept.headHash])
  // §5: `type: unknown` is a materialize-only defensive fallback for corrupt
  // state (empty type is unreachable through accepted ops).
  pairs.push(['type', typeof concept.type === 'string' && concept.type !== '' ? concept.type : 'unknown'])
  const rest = []
  for (const [key, rec] of concept.fields) {
    if (key === 'type') continue // emitted in the fixed position above
    const v = fieldEmitValue(key, rec)
    if (v !== null) rest.push([key, v])
  }
  rest.sort((a, b) => byteCmp(a[0], b[0]))
  return pairs.concat(rest)
}

/** Scalar frontmatter field value (title/description), or undefined. */
function scalarField(concept, key) {
  const rec = concept.fields.get(key)
  if (!rec || !Array.isArray(rec.values) || rec.values.length === 0) return undefined
  const v = rec.values[0]
  return typeof v === 'string' ? v : undefined
}

/**
 * §7 materialized path for a live concept: its path, unless it is a
 * pathcollision loser, in which case a deterministic conflicted copy
 * `<path>.conflict-<first-8-hex-of-SHA-256(_id)>`. Two losers of one path
 * that hash-collide on 8 hex both extend to the full 64-hex hash.
 */
function conflictHash(id) {
  return createHash('sha256').update(Buffer.from(id, 'utf8')).digest('hex')
}

/**
 * §10: the field values of `concept` that its rendered note cannot hold.
 * Parse the note back, read each field the way ingest reads it (yamlToValues,
 * then the canonical array that apply stores), and compare it with the view.
 * Returns [{ id, path, key, before, after }]: `before` the view's values,
 * `after` the values that the note gives back ([] when the note omits the
 * key), for each key that differs.
 */
function lossyFields(concept, rel, text) {
  const { fm } = parseNote(text)
  const parsed = new Map()
  for (const [k, v] of Object.entries(fm || {})) {
    const key = nfc(k)
    if (key !== '_id' && key !== '_rev') parsed.set(key, v)
  }
  const out = []
  for (const key of [...new Set([...concept.fields.keys(), ...parsed.keys()])].sort(byteCmp)) {
    const rec = concept.fields.get(key)
    const before = key === 'tags' ? orSetValues(rec) : rec && Array.isArray(rec.values) ? rec.values : []
    let after = parsed.has(key) ? yamlToValues(parsed.get(key)).values : []
    // ingest takes only string tags (§5: a tag value is a string)
    if (key === 'tags') after = after.filter((v) => typeof v === 'string')
    after = canonicalArray(after)
    if (!sameValues(canonicalArray(before), after)) out.push({ id: concept.id, path: rel, key, before, after })
  }
  return out
}

/**
 * §10, D-060 F03: the concept paths that a case-insensitive file system
 * cannot hold. Two spellings that fold together (casefoldPath: NFC, then
 * lowercase) are one directory or one file there, such as the directories
 * of `Notes/a` and `notes/b`. The file system keeps the spelling that was
 * written first, and the import gives the concept that spelling. reconcile
 * writes in byte order, so in an empty directory the first spelling in byte
 * order is the one that stays. Returns [{ id, path, key: 'path', before,
 * after }] for each placed note whose path changes under those spellings:
 * `before` the concept's path in the view, `after` the path that its note
 * gives back. It reads no disk, so the report is the same on every file
 * system, a case-sensitive one too (I9).
 */
function lossyPaths(placed) {
  const prefixes = (rel) => rel.split('/').map((_, i, segs) => segs.slice(0, i + 1).join('/'))
  const first = new Map() // fold -> its first spelling in byte order, of a directory or a note path
  for (const p of placed) {
    for (const s of prefixes(p.rel)) {
      const fold = casefoldPath(s)
      if (!first.has(fold) || byteCmp(s, first.get(fold)) < 0) first.set(fold, s)
    }
  }
  const out = []
  for (const p of placed) {
    // The spelling that each segment gets: the name of the first spelling of its prefix.
    const held = prefixes(p.rel).map((s) => lastComponent(first.get(casefoldPath(s)))).join('/')
    if (held === p.rel) continue
    const loser = p.rel !== `${p.concept.path}.md`
    const after = loser ? held.slice(0, -3).replace(/\.conflict-[0-9a-f]{8,}$/, '') : held.slice(0, -3)
    out.push({ id: p.concept.id, path: p.rel, key: 'path', before: [p.concept.path], after: [after] })
  }
  return out
}

function sameValues(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (byteForm(a[i]) !== byteForm(b[i])) return false
  return true
}

/**
 * The full byte plan for a converged view (materialize steps 1–4: concept
 * files, per-directory index.md, root log.md) WITHOUT touching disk.
 * Returns Map<rel, Buffer>. Shared with status() (ADR-002) so the
 * porcelain's states are judged against the exact bytes materialize would
 * write. With `opts.lossy` (an array), it parses each rendered note back
 * and pushes each field value that the note cannot hold (lossyFields), and
 * each path that a case-insensitive file system cannot hold (lossyPaths).
 */
export async function planBundle(vault, opts = {}) {
  if (typeof vault.update === 'function') await vault.update()

  const { concepts, collisions } = await readView(vault)

  // ---- 1. resolve each live concept's materialized path ----
  const live = []
  for (const c of concepts.values()) {
    if (c.deleted || c.path === undefined) continue
    live.push(c)
  }
  // Pre-compute conflict-hash collisions per path (§7 8-hex extension).
  const h8CountByPath = new Map() // path -> Map<h8, count>
  for (const c of live) {
    if (!collisions.has(collisionKey(c.path, c.id))) continue
    const h8 = conflictHash(c.id).slice(0, 8)
    let m = h8CountByPath.get(c.path)
    if (!m) {
      m = new Map()
      h8CountByPath.set(c.path, m)
    }
    m.set(h8, (m.get(h8) || 0) + 1)
  }

  const placed = [] // { concept, rel, dir, name, title, description }
  const takenRel = new Set()
  for (const c of live) {
    let matPath = c.path
    if (collisions.has(collisionKey(c.path, c.id))) {
      const full = conflictHash(c.id)
      const h8 = full.slice(0, 8)
      const suffix = (h8CountByPath.get(c.path).get(h8) || 0) > 1 ? full : h8
      matPath = `${c.path}.conflict-${suffix}`
    }
    const rel = matPath + '.md'
    if (takenRel.has(rel)) {
      // Unreachable given §7's reservations; guard so we never emit two
      // concepts to one file under any input.
      continue
    }
    takenRel.add(rel)
    placed.push({
      concept: c,
      rel,
      dir: dirOf(matPath),
      name: lastComponent(matPath),
      title: scalarField(c, 'title'),
      description: scalarField(c, 'description')
    })
  }

  // ---- 2. planned bytes: concept files ----
  const planned = new Map() // rel -> Buffer
  for (const p of placed) {
    const text = renderNote(frontmatterPairs(p.concept), p.concept.headText)
    planned.set(p.rel, Buffer.from(text, 'utf8'))
    if (Array.isArray(opts.lossy)) opts.lossy.push(...lossyFields(p.concept, p.rel, text))
  }
  if (Array.isArray(opts.lossy)) {
    opts.lossy.push(...lossyPaths(placed))
    opts.lossy.sort((a, b) => byteCmp(a.path, b.path) || byteCmp(a.key, b.key))
  }

  // ---- 3. per-directory index.md (OKF §6) ----
  const dirs = new Set([''])
  for (const p of placed) {
    let d = p.dir
    dirs.add(d)
    while (d !== '') {
      d = dirOf(d)
      dirs.add(d)
    }
  }
  for (const d of dirs) {
    const rel = d === '' ? 'index.md' : `${d}/index.md`
    planned.set(rel, Buffer.from(renderIndex(d === '', d, placed, dirs), 'utf8'))
  }

  // ---- 4. root log.md (OKF §7) ----
  planned.set('log.md', Buffer.from(await renderLog(vault, concepts), 'utf8'))

  return planned
}

/**
 * Walk the view and emit the bundle. Options:
 *
 *   forceMirror  restore unconditional mirroring (overwrite/delete
 *                regardless of manifest).
 *   onPlaintext  async (warning) => void. materialize is the plaintext
 *                export (decision 8). When the vault is encrypted (its
 *                pinned `metadata.encrypted`), materialize calls it once with
 *                the plaintext warning, and awaits it, before its first write
 *                to the directory. So a caller can announce the directory
 *                before any plaintext lands in it.
 *
 * The face of an encrypted vault is marked (D-060 F02): after the warning
 * and before its first plaintext write, materialize writes ENCRYPTED_FILE
 * (`.okf-encrypted`) at the root of the directory. import refuses a marked
 * face without a key (decision 8), so a generation never drops encryption,
 * with or without the predecessor's metadata. materialize never removes the
 * mark: a directory that once held an encrypted vault's plaintext stays
 * marked.
 *
 * Returns a report:
 *   { root, ok, written, unchanged, pendingIngest, removed, stale, unsafe,
 *     warnings, lossy }
 *
 * `lossy` is [{ id, path, key, before, after }]: each field value that its
 * note cannot hold (§10). materialize parses each rendered note back and
 * compares each field with the view: a scalar null that the note omits, a
 * second `type` value, a reference or an object written as a string. An
 * entry with the key `path` is a note path whose spelling folds together
 * with another one, such as `notes/b` beside `Notes/a` (lossyPaths): a
 * case-insensitive file system holds both in one directory. A generation
 * (materialize, then import) would lose such a value, so an operator fixes
 * it in the vault before the import. `ok` does not read it: the caller
 * decides (`auto-okf materialize` exits 1).
 *
 * `warnings` is [] for an unencrypted vault. For an encrypted vault it is
 * [{ kind: 'plaintext', path: root, message }]: the directory now holds the
 * vault's contents as plaintext. An error that materialize throws after that
 * announcement carries the same list as `err.warnings`.
 *
 * Before it changes anything in the directory, materialize checks the real
 * path of the parent of each path that it can create, overwrite or delete:
 * each planned file and each manifest entry. A parent outside the root, by
 * a symlink in the root, throws UNSAFE_PATH, and nothing in the directory
 * or outside it changes (§9 realpath containment).
 */
export async function materialize(vault, dir, opts = {}) {
  const { realRoot, registry } = await rootRegistry(dir)
  const forceMirror = opts.forceMirror === true

  const lossy = []
  const planned = await planBundle(vault, { lossy })

  // ---- 5. reconcile to disk through the manifest (§9) ----
  const report = {
    root: realRoot,
    ok: true,
    written: [],
    unchanged: [],
    pendingIngest: [],
    removed: [],
    stale: [],
    unsafe: [],
    warnings: [],
    lossy
  }
  const manifest = await withPathLock(registry, MANIFEST_FILE, () => loadManifest(realRoot))
  await refuseEscapes(realRoot, [...planned.keys(), ...Object.keys(manifest.files)])

  // Decision 8: announce the plaintext directory, then mark it, before the
  // first plaintext write. So a failure or a crash after a plaintext write
  // finds the warning out, and an import of the face finds the mark.
  if (vault.metadata && vault.metadata.encrypted === true) {
    const warning = plaintextWarning(realRoot)
    report.warnings.push(warning)
    if (typeof opts.onPlaintext === 'function') await opts.onPlaintext(warning)
  }
  try {
    if (report.warnings.length > 0) await markEncrypted(realRoot, registry)
    await reconcile(realRoot, registry, planned, manifest, report, forceMirror)
  } catch (err) {
    if (report.warnings.length > 0 && err !== null && typeof err === 'object' && err.warnings === undefined) {
      err.warnings = report.warnings
    }
    throw err
  }
  report.ok = report.pendingIngest.length === 0
  return report
}

/**
 * §9 realpath containment, before reconciliation changes anything: the real
 * parent of each path in `rels` must be in realRoot (containedParent). A
 * symlink in the root that leads out of it throws UNSAFE_PATH, which names
 * the path. A path that escapes lexically is skipped here: reconcile never
 * touches it, and reports a planned one as unsafe. One check per parent
 * directory.
 */
async function refuseEscapes(realRoot, rels) {
  const checked = new Set()
  for (const rel of rels) {
    let abs
    try {
      abs = containedPath(realRoot, rel)
    } catch {
      continue
    }
    const parent = dirname(abs)
    if (checked.has(parent)) continue
    await containedParent(realRoot, rel)
    checked.add(parent)
  }
}

/** Write the mark of an encrypted vault's face (ENCRYPTED_FILE) at the root, unless it already holds those bytes. */
async function markEncrypted(realRoot, registry) {
  const bytes = Buffer.from(ENCRYPTED_TEXT, 'utf8')
  await withPathLock(registry, ENCRYPTED_FILE, async () => {
    if ((await hashFile(containedPath(realRoot, ENCRYPTED_FILE))) !== sha256(bytes)) {
      await atomicWrite(realRoot, ENCRYPTED_FILE, bytes)
    }
  })
}

/** The warning that names a directory that now holds an encrypted vault's contents as plaintext. */
export function plaintextWarning(dir) {
  return { kind: 'plaintext', path: dir, message: 'now holds the contents of an encrypted vault as plaintext' }
}

/**
 * Materialize steps 5 to 7 for `planned` (Map<rel, Buffer>): write each
 * planned file, remove this run's own prior outputs, and merge-save the
 * manifest. Fills `report`.
 */
async function reconcile(realRoot, registry, planned, manifest, report, forceMirror) {
  const next = { files: {} }

  for (const rel of [...planned.keys()].sort(byteCmp)) {
    const buf = planned.get(rel)
    const target = sha256(buf)
    await withPathLock(registry, rel, async () => {
      let abs
      try {
        abs = containedPath(realRoot, rel)
      } catch {
        report.unsafe.push({ rel, reason: 'escapes-root' })
        return
      }
      const onDisk = await hashFile(abs)
      const last = manifest.files[rel]
      if (onDisk === target) {
        report.unchanged.push(rel)
        next.files[rel] = target
        return
      }
      const reserved = isReservedFile(rel)
      if (!reserved && !forceMirror && onDisk !== null && onDisk !== last) {
        // N3: human-authored (no entry) or human-modified (bytes != manifest)
        // concept file — never overwrite; surface as an ingest candidate.
        report.pendingIngest.push(rel)
        if (last !== undefined) next.files[rel] = last
        return
      }
      try {
        await atomicWrite(realRoot, rel, buf, { precondition: { hash: onDisk } })
      } catch (err) {
        if (err.code === 'MODIFIED') {
          if (!reserved) report.pendingIngest.push(rel)
          if (last !== undefined) next.files[rel] = last
          return
        }
        if (err.code === 'UNSAFE_PATH') {
          report.unsafe.push({ rel, reason: 'escapes-root' })
          return
        }
        throw err
      }
      report.written.push(rel)
      next.files[rel] = target
    })
  }

  // ---- 6. removal of this run's own prior outputs (§9) ----
  const prunableDirs = new Set()
  // Manifest entries this run retired: a file we unlinked, or one already gone
  // from disk. They MUST be dropped from the saved manifest — a stale entry
  // pointing at a vanished file lets a LATER run delete a human file that
  // happens to recreate those exact bytes at that path (N3).
  const droppedFromManifest = new Set()
  for (const rel of Object.keys(manifest.files)) {
    if (planned.has(rel)) continue
    await withPathLock(registry, rel, async () => {
      let abs
      try {
        abs = containedPath(realRoot, rel)
      } catch {
        return
      }
      const onDisk = await hashFile(abs)
      if (onDisk === null) {
        droppedFromManifest.add(rel) // already gone; drop from manifest
        return
      }
      if (forceMirror || onDisk === manifest.files[rel]) {
        await atomicUnlink(realRoot, rel)
        report.removed.push(rel)
        droppedFromManifest.add(rel)
        const d = dirOf(rel)
        if (d) prunableDirs.add(d)
      } else if (isReservedFile(rel)) {
        // A derived face a human edited: leave it, report as stale (it is not
        // an ingestable concept), keep tracking so a later run can reconcile.
        report.stale.push(rel)
        next.files[rel] = manifest.files[rel]
      } else {
        // N3: our old output the human has since edited — never delete.
        report.pendingIngest.push(rel)
        next.files[rel] = manifest.files[rel]
      }
    })
  }
  // add ancestors of pruned dirs so nested empties collapse
  for (const d of [...prunableDirs]) {
    let a = d
    while (a !== '') {
      prunableDirs.add(a)
      a = dirOf(a)
    }
  }
  await pruneEmptyDirs(realRoot, [...prunableDirs])

  // ---- 6b. surface untracked human-authored files (N3) ----
  // A `.md` on disk that this run did not plan and the manifest has never
  // tracked is human-authored and not yet ingested: it is LEFT untouched and
  // reported as pending-ingest (never deleted — deletion is dangerous).
  if (!forceMirror) {
    const disk = []
    await walkNotes(realRoot, '', disk)
    for (const rel of disk.sort(byteCmp)) {
      if (planned.has(rel) || manifest.files[rel] !== undefined || isReservedFile(rel)) continue
      report.pendingIngest.push(rel)
    }
  }

  // ---- 7. merge-save the manifest under its lock (§9 watcher coordination) ----
  await withPathLock(registry, MANIFEST_FILE, async () => {
    const current = await loadManifest(realRoot)
    const merged = { ...current.files, ...next.files }
    // Drop retired entries LAST so they win over any stale value re-merged from
    // `current` (this run's own reconciliation is authoritative for them).
    for (const rel of droppedFromManifest) delete merged[rel]
    await saveManifest(realRoot, { files: merged })
  })
}

// ---------- index.md (OKF §6) ----------

/**
 * One directory's index.md. Root gets the single permitted frontmatter
 * block (`okf_version: "0.1"`); every index has a single `# Contents`
 * heading, then concept bullets (byte order of `<name>.md`) followed by
 * subdirectory bullets (byte order of `<name>/`).
 */
export function renderIndex(isRoot, d, placed, dirs) {
  const conceptBullets = []
  for (const p of placed) {
    if (p.dir !== d) continue
    const entry = lastComponent(p.rel)
    const title = p.title !== undefined && p.title !== '' ? p.title : p.name
    conceptBullets.push({ entry, line: bullet(title, entry, p.description) })
  }
  conceptBullets.sort((a, b) => byteCmp(a.entry, b.entry))

  const subBullets = []
  for (const child of dirs) {
    if (child === '' || child === d) continue
    if (dirOf(child) !== d) continue
    const name = lastComponent(child)
    const entry = name + '/'
    subBullets.push({ entry, line: bullet(name, entry, undefined) })
  }
  subBullets.sort((a, b) => byteCmp(a.entry, b.entry))

  const bullets = [...conceptBullets, ...subBullets].map((b) => b.line)
  let out = ''
  if (isRoot) out += '---\n' + emitFrontmatter([['okf_version', '0.1']]) + '---\n\n'
  out += '# Contents\n'
  if (bullets.length > 0) out += '\n' + bullets.join('\n') + '\n'
  return out
}

function bullet(title, entry, description) {
  let line = `* [${title}](${entry})`
  if (description !== undefined && description !== '') line += ` - ${description}`
  return line
}

// ---------- log.md (OKF §7) ----------

/**
 * Root log.md projected from the log/ family (§9): `# Update Log`, then
 * `## YYYY-MM-DD` UTC headings newest-first, entries within a heading in
 * descending ordinal. Dates come from each op's informational `at`. Entries
 * are deterministic given a converged view (I9).
 */
export async function renderLog(reader, concepts) {
  const records = await readLog(reader)
  const entries = [] // { date, ord, line }
  for (const rec of records) {
    const date = utcDate(rec.at)
    for (const ev of rec.events) {
      const line = logLine(ev, concepts)
      if (line) entries.push({ date, ord: rec.ord, line })
    }
  }
  const byDate = new Map()
  for (const e of entries) {
    if (!byDate.has(e.date)) byDate.set(e.date, [])
    byDate.get(e.date).push(e)
  }
  let out = '# Update Log\n'
  for (const date of [...byDate.keys()].sort().reverse()) {
    const es = byDate.get(date)
    // ord is a fixed-width zero-padded string, so string-descending == newest.
    es.sort((a, b) => (a.ord < b.ord ? 1 : a.ord > b.ord ? -1 : 0))
    out += '\n## ' + date + '\n' + es.map((e) => e.line).join('\n') + '\n'
  }
  return out
}

function utcDate(ms) {
  const d = new Date(typeof ms === 'number' && Number.isFinite(ms) ? ms : 0)
  return d.toISOString().slice(0, 10)
}

function pathOf(concepts, id) {
  const c = concepts.get(id)
  return c && c.path !== undefined ? c.path : null
}

function link(path) {
  return `/${path}.md`
}

function logLine(ev, concepts) {
  switch (ev.kind) {
    case 'create': {
      const name = lastComponent(ev.path)
      return `* **Creation**: Established [${name}](${link(ev.path)}).`
    }
    case 'rename': {
      const name = lastComponent(ev.to)
      return `* **Update**: Renamed \`${ev.from}\` to [${name}](${link(ev.to)}).`
    }
    case 'delete': {
      const path = pathOf(concepts, ev.id)
      return path
        ? `* **Deprecation**: Deleted [${lastComponent(path)}](${link(path)}).`
        : `* **Deprecation**: Deleted concept \`${ev.id}\`.`
    }
    case 'undelete': {
      const path = pathOf(concepts, ev.id)
      return path
        ? `* **Update**: Restored [${lastComponent(path)}](${link(path)}).`
        : `* **Update**: Restored concept \`${ev.id}\`.`
    }
    case 'resolve': {
      const path = pathOf(concepts, ev.id)
      return path
        ? `* **Update**: Resolved a conflict on [${lastComponent(path)}](${link(path)}).`
        : `* **Update**: Resolved a conflict on \`${ev.id}\`.`
    }
    case 'pathcollision': {
      const name = lastComponent(ev.path)
      return `* **Update**: [${name}](${link(ev.path)}) collided on \`${ev.path}\` and was written as a conflicted copy.`
    }
    default:
      return null
  }
}
