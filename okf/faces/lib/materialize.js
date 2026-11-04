// materialize(vault, dir, opts) projects the view to a bundle: one file per
// live concept, index.md per directory, log.md at the root. Every byte is a
// function of the converged view (I9). See SPEC §9.
//
// A `.md` file whose bytes differ from its emission manifest entry, or that
// has no entry, is never deleted or overwritten. `opts.forceMirror` removes
// that guard.
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

/** The elements of an OR-set record, deduplicated, in canonical byte order. */
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

/** The frontmatter value of one field. null means that the note omits the key. */
function fieldEmitValue(key, rec) {
  if (key === 'tags') {
    const vals = orSetValues(rec)
    return vals.length === 0 ? null : vals // OKF §4.1: tags is always a list
  }
  const values = rec && Array.isArray(rec.values) ? rec.values : []
  if (values.length === 0) return null
  return values.length === 1 ? values[0] : values
}

/** The frontmatter pairs of one concept, in the order of SPEC §6. */
function frontmatterPairs(concept) {
  const pairs = [['_id', concept.id]]
  if (concept.headHash !== undefined) pairs.push(['_rev', concept.headHash])
  // An empty type is unreachable through accepted ops. 'unknown' covers
  // corrupt state.
  pairs.push(['type', typeof concept.type === 'string' && concept.type !== '' ? concept.type : 'unknown'])
  const rest = []
  for (const [key, rec] of concept.fields) {
    if (key === 'type') continue
    const v = fieldEmitValue(key, rec)
    if (v !== null) rest.push([key, v])
  }
  rest.sort((a, b) => byteCmp(a[0], b[0]))
  return pairs.concat(rest)
}

/** The first value of a field when it is a string, else undefined. */
function scalarField(concept, key) {
  const rec = concept.fields.get(key)
  if (!rec || !Array.isArray(rec.values) || rec.values.length === 0) return undefined
  const v = rec.values[0]
  return typeof v === 'string' ? v : undefined
}

/**
 * A pathcollision loser materializes at
 * `<path>.conflict-<first 8 hex of SHA-256(_id)>`. Two losers of one path
 * whose 8 hex collide both take the full 64 hex. See SPEC §7.
 */
function conflictHash(id) {
  return createHash('sha256').update(Buffer.from(id, 'utf8')).digest('hex')
}

/**
 * The field values of `concept` that its rendered note cannot hold. `text`
 * is the note as its bytes decode, so a lone surrogate reads as U+FFFD.
 * Each field is read the way ingest reads it and compared with the view.
 * Returns [{ id, path, key, before, after }]: `before` from the view,
 * `after` from the note, [] when the note omits the key.
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
    // ingest keeps only string tags (SPEC §5).
    if (key === 'tags') after = after.filter((v) => typeof v === 'string')
    after = canonicalArray(after)
    if (!sameValues(canonicalArray(before), after)) out.push({ id: concept.id, path: rel, key, before, after })
  }
  return out
}

/**
 * The concept paths that a case-insensitive file system cannot hold. Two
 * spellings that casefold together are one entry there. The first spelling
 * in byte order stays, because reconcile writes in byte order. Reads no
 * disk, so the report is the same on every file system (I9). Returns
 * [{ id, path, key: 'path', before, after }] per note whose path changes.
 */
function lossyPaths(placed) {
  const prefixes = (rel) => rel.split('/').map((_, i, segs) => segs.slice(0, i + 1).join('/'))
  const first = new Map() // fold -> first spelling in byte order
  for (const p of placed) {
    for (const s of prefixes(p.rel)) {
      const fold = casefoldPath(s)
      if (!first.has(fold) || byteCmp(s, first.get(fold)) < 0) first.set(fold, s)
    }
  }
  const out = []
  for (const p of placed) {
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
 * The bytes of the bundle for a converged view, without a disk write.
 * Returns Map<rel, Buffer>. status() uses the same plan, so its states are
 * judged against the exact bytes that materialize writes. With `opts.lossy`
 * (an array), pushes each field value that a note cannot hold (lossyFields)
 * and each path that a case-insensitive file system cannot hold
 * (lossyPaths).
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
      // Unreachable under the SPEC §7 reservations. The guard keeps two
      // concepts out of one file.
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
    const buf = Buffer.from(renderNote(frontmatterPairs(p.concept), p.concept.headText), 'utf8')
    planned.set(p.rel, buf)
    // Parse the bytes, not the string. UTF-8 cannot hold a lone surrogate,
    // so the file holds U+FFFD in its place.
    if (Array.isArray(opts.lossy)) opts.lossy.push(...lossyFields(p.concept, p.rel, buf.toString('utf8')))
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
 * Project the view to the bundle at `dir`. Options:
 *
 *   forceMirror  overwrite and delete without regard to the manifest.
 *   onPlaintext  async (warning) => void. For an encrypted vault
 *                (`metadata.encrypted`), materialize calls it once and
 *                awaits it before its first write, so that a caller can
 *                announce the directory before plaintext lands in it.
 *
 * For an encrypted vault, materialize writes ENCRYPTED_FILE at the root
 * before its first plaintext write and never removes it. import refuses a
 * marked bundle without a key, so a generation never drops encryption.
 *
 * Returns { root, ok, written, unchanged, pendingIngest, removed, stale,
 * unsafe, warnings, lossy }.
 *
 * `lossy` is [{ id, path, key, before, after }]: each field value that its
 * note cannot hold, and each path (key `path`) that folds together with
 * another one. A generation loses such a value. `ok` does not read
 * `lossy`. The caller decides (`auto-okf materialize` exits 1). See SPEC §10.
 *
 * `warnings` is [] for an unencrypted vault, else
 * [{ kind: 'plaintext', path: root, message }]. An error thrown after that
 * announcement carries the same list as `err.warnings`.
 *
 * Before any change, materialize resolves the real parent of each planned
 * file and each manifest entry. A parent outside the root throws
 * UNSAFE_PATH, and nothing changes.
 */
export async function materialize(vault, dir, opts = {}) {
  const { realRoot, registry } = await rootRegistry(dir)
  const forceMirror = opts.forceMirror === true

  const lossy = []
  const planned = await planBundle(vault, { lossy })

  // ---- 5. reconcile to disk through the manifest ----
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

  // Announce, then mark, then write. A crash after a plaintext write then
  // leaves the warning out and the mark in place.
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
 * Make sure that the real parent of each path in `rels` is inside realRoot
 * (containedParent), before reconcile changes anything. A symlink that leads
 * out throws UNSAFE_PATH. A path that escapes lexically is skipped here:
 * reconcile never touches it, and reports a planned one as unsafe. One
 * check per parent directory.
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

/** Write ENCRYPTED_FILE at the root, unless it already holds those bytes. */
async function markEncrypted(realRoot, registry) {
  const bytes = Buffer.from(ENCRYPTED_TEXT, 'utf8')
  await withPathLock(registry, ENCRYPTED_FILE, async () => {
    if ((await hashFile(containedPath(realRoot, ENCRYPTED_FILE))) !== sha256(bytes)) {
      await atomicWrite(realRoot, ENCRYPTED_FILE, bytes)
    }
  })
}

export function plaintextWarning(dir) {
  return { kind: 'plaintext', path: dir, message: 'now holds the contents of an encrypted vault as plaintext' }
}

/** Reconcile the directory to `planned` (Map<rel, Buffer>) and fill `report`. */
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
        // A file with no entry, or with bytes that differ from its entry, is
        // a human file. Never overwrite it.
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

  // ---- 6. removal of the prior outputs of this run ----
  const prunableDirs = new Set()
  // Drop a retired entry from the saved manifest. A stale entry at a vanished
  // file lets a later run delete a human file that recreates those exact
  // bytes there.
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
        droppedFromManifest.add(rel)
        return
      }
      if (forceMirror || onDisk === manifest.files[rel]) {
        await atomicUnlink(realRoot, rel)
        report.removed.push(rel)
        droppedFromManifest.add(rel)
        const d = dirOf(rel)
        if (d) prunableDirs.add(d)
      } else if (isReservedFile(rel)) {
        // An edited index.md or log.md is not a concept. Report it stale and
        // keep its entry.
        report.stale.push(rel)
        next.files[rel] = manifest.files[rel]
      } else {
        // Our old output that a human edited. Never delete it.
        report.pendingIngest.push(rel)
        next.files[rel] = manifest.files[rel]
      }
    })
  }
  // Add the ancestors, so that nested empty directories collapse.
  for (const d of [...prunableDirs]) {
    let a = d
    while (a !== '') {
      prunableDirs.add(a)
      a = dirOf(a)
    }
  }
  await pruneEmptyDirs(realRoot, [...prunableDirs])

  // ---- 6b. untracked human files ----
  // A `.md` that this run did not plan and the manifest never tracked is a
  // human file. Report it, never delete it.
  if (!forceMirror) {
    const disk = []
    await walkNotes(realRoot, '', disk)
    for (const rel of disk.sort(byteCmp)) {
      if (planned.has(rel) || manifest.files[rel] !== undefined || isReservedFile(rel)) continue
      report.pendingIngest.push(rel)
    }
  }

  // ---- 7. merge-save the manifest under its lock ----
  await withPathLock(registry, MANIFEST_FILE, async () => {
    const current = await loadManifest(realRoot)
    const merged = { ...current.files, ...next.files }
    // Delete after the merge, so that a stale value in `current` cannot bring
    // an entry back.
    for (const rel of droppedFromManifest) delete merged[rel]
    await saveManifest(realRoot, { files: merged })
  })
}

// ---------- index.md (OKF §6) ----------

/**
 * The index.md of one directory. The root index gets the only frontmatter
 * block, `okf_version: "0.1"`. Then `# Contents`, the concept bullets in
 * byte order of `<name>.md`, then the subdirectory bullets in byte order of
 * `<name>/`.
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
 * The root log.md from the `log/` family: `# Update Log`, then one
 * `## YYYY-MM-DD` UTC heading per day, newest first, with the entries in
 * descending ordinal. The date comes from the `at` of each op.
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
    // ord is a zero-padded string of fixed width, so a string compare orders it.
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
