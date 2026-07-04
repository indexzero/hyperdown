// materialize(vault, dir) — SPEC-FINAL §9.1/§9.3/§9.4: walk the view (n/
// and ctx/) and emit an Obsidian-compatible vault: YAML-LD frontmatter
// from field state (canonical sorted key order, §10.2 scalar forms), body
// from the head revision, context.jsonld composed from ctx/. Output is
// byte-deterministic for a given view (I9): every byte is a pure function
// of view state + vault metadata.
//
// Clobber-immunity is a VIEW property (§9.4): bodies live in the view and
// regeneration is a pure projection. Filesystem races are handled here by
// the per-path in-flight locks, the manifest hash check (files with
// unsaved external modifications are skipped and reported so they can be
// ingested first), and atomic temp+fsync+rename writes.
import { keyspace as K, canonical } from '@hyperwiki/core'
import { readVaultState, faceMetadata, keywordAlias } from './state.js'
import { placeSubject } from './placement.js'
import { renderNote } from './note.js'
import {
  rootRegistry,
  withPathLock,
  atomicWrite,
  hashFile,
  sha256,
  loadManifest,
  saveManifest,
  containedPath,
  MANIFEST_FILE
} from './fsatomic.js'

const { sortValues, byteForm } = canonical

export const CONTEXT_FILE = 'context.jsonld'

/**
 * Compose context.jsonld from ctx/ (§9.1; vault-ld §4.2: the context lives
 * outside the notes and is the single source of truth for the base
 * namespace, prefix→namespace mappings, and term definitions).
 * Deterministic: '@base' from vault metadata, scope prefixes, then term
 * definitions, all under sorted keys.
 */
export function buildContextDocument(state, rootBase) {
  const ctx = { '@base': rootBase }
  for (const [, scope] of [...state.scopes.entries()].sort(byKey)) {
    if (scope && scope.prefix) ctx[scope.prefix] = scope.base
  }
  for (const [term, rec] of [...state.terms.entries()].sort(byKey)) {
    if (rec && rec.def !== undefined && rec.def !== null) ctx[term] = rec.def
  }
  return prettyJson({ '@context': ctx }) + '\n'
}

function byKey(a, b) {
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0
}

/** Deterministic pretty JSON: sorted keys, 2-space indent (I9). */
export function prettyJson(v, indent = '') {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  const inner = indent + '  '
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]'
    return '[\n' + v.map((x) => inner + prettyJson(x, inner)).join(',\n') + '\n' + indent + ']'
  }
  const keys = Object.keys(v).sort()
  if (keys.length === 0) return '{}'
  return (
    '{\n' +
    keys.map((k) => inner + JSON.stringify(k) + ': ' + prettyJson(v[k], inner)).join(',\n') +
    '\n' +
    indent +
    '}'
  )
}

/** Field record -> emitted YAML value per §5.1/§5.7 (or null to omit). */
function fieldValue(rec) {
  if (rec.els && rec.reg) {
    // §5.7 epoch divergence: a field holding both a register slot and an
    // element map is emitted as the element map (the flag/kindmismatch
    // audit record is apply's, written when the divergence occurred).
    return orderedElements(rec.els)
  }
  if (rec.els) return orderedElements(rec.els)
  if (rec.reg) {
    const values = rec.reg.values
    return values.length === 1 ? values[0] : values // §5.1 scalar collapse
  }
  if (rec.un && rec.un.items && rec.un.items.length > 0) {
    const values = rec.un.items.map((it) => it.v) // stored canonical order (§5.6)
    return values.length === 1 ? values[0] : values
  }
  return null
}

/**
 * OR-set element map -> values in canonical §10.2 byte-form order,
 * deduplicated: element tags are OR-set bookkeeping, the face shows the
 * VALUE set (the same member under two tags is one member).
 */
function orderedElements(els) {
  const seen = new Set()
  const out = []
  for (const v of sortValues(Object.values(els).map((el) => el.v))) {
    const bf = byteForm(v)
    if (seen.has(bf)) continue
    seen.add(bf)
    out.push(v)
  }
  return out
}

/**
 * Frontmatter pairs for one subject, canonically ordered (§9.1: sorted).
 * '@type'/'@id' are written under their declared context aliases when one
 * exists (vault-ld §4.3 SHOULD), else under the keyword spelling.
 */
export function frontmatterPairs(subject, terms) {
  const typeKey = keywordAlias(terms, '@type') || '@type'
  const idKey = keywordAlias(terms, '@id') || '@id'
  const pairs = []
  if (subject.id) pairs.push([idKey, subject.id.iri]) // §5.8: emitted verbatim
  for (const [term, rec] of subject.fields) {
    if (subject.host.has(term)) {
      // §5.6: f/ and host/ are disjoint by construction; both present is a
      // migration bug upstream and MUST error rather than emit garbage.
      throw new Error(`subject '${subject.name}' holds both f/${term} and host/${term} (§5.6)`)
    }
    const key = term === '@type' ? typeKey : term
    const v = fieldValue(rec)
    if (v !== null) pairs.push([key, v])
  }
  for (const [key, rec] of subject.host) {
    pairs.push([key, rec.value]) // host-tool keys round-trip verbatim (§5.6)
  }
  pairs.sort(byKey)
  return pairs
}

/**
 * Walk the view and write the vault. Returns a report:
 *   {
 *     root,                        // resolved vault root
 *     written: [rel],              // files (re)written this pass
 *     unchanged: [rel],            // already at target bytes
 *     pendingIngest: [rel],        // §9.4: unsaved external modifications,
 *                                  //        skipped — ingest them first
 *     unsafe: [{ subject, reason }], // §9.4 path-safety skips
 *     stale: [rel]                 // previously materialized, no longer
 *                                  //        produced (left in place)
 *   }
 *
 * DEVIATION (recorded in DEVIATIONS.md): §9.4 asks materialize to record
 * flag/unsafepath/<s> in the view, but the view is written only by apply
 * folding ops (§9.3) and core exposes no flag-writing op; unsafe skips are
 * therefore returned in this report instead.
 */
export async function materialize(vault, dir, opts = {}) {
  if (typeof vault.update === 'function') await vault.update()
  const { realRoot, registry } = await rootRegistry(dir)
  const meta = faceMetadata(vault)
  const state = opts.state || (await readVaultState(vault))

  const report = {
    root: realRoot,
    written: [],
    unchanged: [],
    pendingIngest: [],
    unsafe: [],
    stale: []
  }

  // ---- plan the full file set first (placement + §9.4 checks) ----
  const files = new Map() // rel (with extension) -> Buffer
  files.set(CONTEXT_FILE, Buffer.from(buildContextDocument(state, meta.rootBase), 'utf8'))

  const caseSeen = new Map() // lowercased rel -> subject (§9.4 (d))
  for (const name of [...state.subjects.keys()].sort()) {
    const subject = state.subjects.get(name)
    if (subject.deleted) continue // §9.2 tombstone suppression
    const placed = placeSubject(name, subject)
    if (placed.unsafe) {
      report.unsafe.push({ subject: name, reason: placed.unsafe })
      continue
    }
    const rel = placed.rel + '.md'
    // lexical containment re-check on the final path (§9.4)
    try {
      containedPath(realRoot, rel)
    } catch {
      report.unsafe.push({ subject: name, reason: 'escapes-root' })
      continue
    }
    const lower = rel.toLowerCase()
    if (caseSeen.has(lower)) {
      // §9.4 (d): case-insensitive collision — deterministic loser (the
      // lexicographically later subject) is skipped and reported.
      report.unsafe.push({ subject: name, reason: `case-collision:${caseSeen.get(lower)}` })
      continue
    }
    caseSeen.set(lower, name)

    const head = subject.head
    const body = head !== undefined ? (subject.revs.get(head) || {}).text || '' : ''
    const pairs = frontmatterPairs(subject, state.terms)
    files.set(rel, Buffer.from(renderNote(pairs, body), 'utf8'))
  }

  // ---- write, under per-path locks, with the §9.4 protocol ----
  const manifest = await withPathLock(registry, MANIFEST_FILE, () => loadManifest(realRoot))
  const next = { files: {} }
  for (const rel of [...files.keys()].sort()) {
    const buf = files.get(rel)
    await withPathLock(registry, rel, async () => {
      const abs = containedPath(realRoot, rel)
      const last = manifest.files[rel]
      const onDisk = await hashFile(abs)
      const target = sha256(buf)
      if (onDisk === target) {
        report.unchanged.push(rel)
        next.files[rel] = target
        return
      }
      if (onDisk !== null && onDisk !== last) {
        // §9.4: unsaved external modification — treat as an ingest event
        // first; never clobber authored bytes.
        report.pendingIngest.push(rel)
        if (last !== undefined) next.files[rel] = last
        return
      }
      try {
        await atomicWrite(realRoot, rel, buf, { precondition: { hash: onDisk } })
      } catch (err) {
        if (err.code === 'MODIFIED') {
          report.pendingIngest.push(rel)
          if (last !== undefined) next.files[rel] = last
          return
        }
        if (err.code === 'UNSAFE_PATH') {
          report.unsafe.push({ subject: rel, reason: 'escapes-root' })
          return
        }
        throw err
      }
      report.written.push(rel)
      next.files[rel] = target
    })
  }

  // Previously materialized files that this view no longer produces are
  // left in place and reported (materialize never deletes; see README).
  for (const rel of Object.keys(manifest.files)) {
    if (!files.has(rel)) {
      report.stale.push(rel)
      next.files[rel] = manifest.files[rel]
    }
  }

  // Merge-save under the manifest lock: entries a concurrently running
  // ingest watcher touched during this pass (for paths this pass did not
  // handle) are preserved (§9.4 coordination).
  await withPathLock(registry, MANIFEST_FILE, async () => {
    const current = await loadManifest(realRoot)
    await saveManifest(realRoot, { files: { ...current.files, ...next.files } })
  })
  return report
}

/** The reconstructable-default check used by exportTurtle (§10.4). */
export { defaultRelPath } from './placement.js'

/** Re-exported for tests: subject key parse helper. */
export const _internal = { fieldValue, orderedElements, K }
