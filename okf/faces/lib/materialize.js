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
import { keyspace as K, canonical, dirOf } from '@auto-okf/core'
import { readView, readLog, collisionKey } from './view.js'
import { renderNote, emitFrontmatter } from './yaml.js'
import {
  rootRegistry,
  withPathLock,
  containedPath,
  atomicWrite,
  atomicUnlink,
  hashFile,
  sha256,
  loadManifest,
  saveManifest,
  pruneEmptyDirs,
  isReservedFile,
  walkNotes,
  MANIFEST_FILE
} from './fsatomic.js'

const { sortValues, byteForm } = canonical

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
 * The full byte plan for a converged view (materialize steps 1–4: concept
 * files, per-directory index.md, root log.md) WITHOUT touching disk.
 * Returns Map<rel, Buffer>. Shared with status() (ADR-002) so the
 * porcelain's states are judged against the exact bytes materialize would
 * write.
 */
export async function planBundle(vault) {
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
    planned.set(p.rel, Buffer.from(renderNote(frontmatterPairs(p.concept), p.concept.headText), 'utf8'))
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
 * Walk the view and emit the bundle. `opts.forceMirror` restores
 * unconditional mirroring (overwrite/delete regardless of manifest).
 * Returns a report:
 *   { root, ok, written, unchanged, pendingIngest, removed, stale, unsafe }
 */
export async function materialize(vault, dir, opts = {}) {
  const { realRoot, registry } = await rootRegistry(dir)
  const forceMirror = opts.forceMirror === true

  const planned = await planBundle(vault)

  // ---- 5. reconcile to disk through the manifest (§9) ----
  const report = {
    root: realRoot,
    ok: true,
    written: [],
    unchanged: [],
    pendingIngest: [],
    removed: [],
    stale: [],
    unsafe: []
  }
  const manifest = await withPathLock(registry, MANIFEST_FILE, () => loadManifest(realRoot))
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

  report.ok = report.pendingIngest.length === 0
  return report
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
