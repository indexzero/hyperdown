// Ingest watcher (SPEC-FINAL §9.2/§9.3/§9.4): human edits to the on-disk
// vault re-enter the system as ops. The watcher parses changed files,
// diffs frontmatter against view state PER FIELD and the body against the
// head revision, and emits the MINIMAL op set through a provided append
// function — never whole-file ops (§3: "file-granularity last-writer-wins
// is the failure mode this design exists to avoid").
//
// fs.watch semantics (verified against
// https://nodejs.org/api/fs.html#fswatchfilename-options-listener and
// #caveats): the API "is not 100% consistent across platforms"; on macOS
// it is backed by FSEvents and on Linux by inotify; `recursive: true` is
// supported on macOS, Windows and (since Node 20 via recursive inotify
// emulation) Linux — this repo pins engines.node >= 20. Event types
// ('rename' vs 'change') and duplication are unreliable, and `filename`
// may be null on some platforms; every event is therefore treated only as
// "this path is dirty" (null => full rescan): the watcher re-stats,
// debounces, waits for write-settle (size stable across one interval,
// §9.4), and then decides changed-vs-deleted from the filesystem itself.
//
// Coordination with materialize (§9.4): the same per-path in-flight lock
// registry (keyed by the root's realpath) serializes ingest reads against
// materialize's check+rename critical section, and the materialize
// manifest hash lets the watcher ignore the system's own writes instead
// of echoing them back as ops.
import { EventEmitter } from 'node:events'
import { watch } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { keyspace as K, canonical, isSafePath } from '@autovault-ld/core'
import { faceMetadata } from './state.js'
import { parseNote, yamlToValues } from './note.js'
import { defaultRelPath, scopeFromPath, layerFromPath } from './placement.js'
import {
  rootRegistry,
  withPathLock,
  loadManifest,
  saveManifest,
  sha256,
  isIgnoredPath,
  statOrNull,
  MANIFEST_FILE
} from './fsatomic.js'

const { nfc, canonicalArray, canonicalValue, byteForm, stableStringify } = canonical

/**
 * Create (and start) the ingest watcher for `dir`.
 *
 * `vault` must expose the @autovault-ld/store Vault read surface (`val`,
 * `scan`, `update`, `metadata`) and op emission (`append(type, payload)` —
 * the store fills the §3.2 clock and opId tag). Options:
 *
 *   append           op sink, default (type, payload) => vault.append(...)
 *   confirmDelete    async (subject, relPath) => boolean — the §9.2
 *                    "deletions require confirmation" guard. WITHOUT a
 *                    handler, DeleteSubject is NEVER emitted (a dropped
 *                    file may be accidental); the skip is observable via
 *                    the 'delete-skipped' event.
 *   debounce         ms of per-path quiet time before reading (default 100)
 *   settle           write-settle interval: file size must be stable for
 *                    one interval before the read (default 50)
 *   watch            false to disable fs.watch (drive scan()/ingestFile()
 *                    manually; used by deterministic tests)
 */
export async function createIngestWatcher(vault, dir, opts = {}) {
  const { realRoot, registry } = await rootRegistry(dir)
  const w = new IngestWatcher(vault, realRoot, registry, opts)
  if (opts.watch !== false) w._start()
  return w
}

export class IngestWatcher extends EventEmitter {
  constructor(vault, realRoot, registry, opts) {
    super()
    this.vault = vault
    this.root = realRoot
    this.registry = registry
    this.append = opts.append || ((type, payload) => vault.append(type, payload))
    this.confirmDelete = opts.confirmDelete || null
    this.debounceMs = opts.debounce ?? 100
    this.settleMs = opts.settle ?? 50
    this.meta = faceMetadata(vault)
    this.closed = false
    this._timers = new Map() // rel -> timeout
    this._ingested = new Map() // rel -> sha256 last ingested (echo suppression)
    this._known = new Set() // rels seen as notes (deletion candidates)
    this._fsw = null
  }

  _start() {
    // See header: recursive fs.watch, every event treated as "path dirty".
    this._fsw = watch(this.root, { recursive: true }, (eventType, filename) => {
      if (this.closed) return
      if (filename == null) {
        this.scan().catch((err) => this.emit('error', err))
        return
      }
      this._dirty(filename.toString())
    })
    this._fsw.on('error', (err) => this.emit('error', err))
  }

  _dirty(rel) {
    rel = rel.split(sep).join('/')
    if (isIgnoredPath(rel) || !rel.endsWith('.md')) return
    const t = this._timers.get(rel)
    if (t) clearTimeout(t)
    this._timers.set(
      rel,
      setTimeout(() => {
        this._timers.delete(rel)
        this._settleAndIngest(rel).catch((err) => this.emit('error', err))
      }, this.debounceMs)
    )
  }

  /** §9.4 write-settle: read only once the size is stable for one interval. */
  async _settleAndIngest(rel) {
    let prev = await statOrNull(join(this.root, rel))
    for (let i = 0; i < 100 && !this.closed; i++) {
      if (prev === null) return this._maybeDelete(rel)
      await sleep(this.settleMs)
      const now = await statOrNull(join(this.root, rel))
      if (now === null) return this._maybeDelete(rel)
      if (now.size === prev.size && now.mtimeMs === prev.mtimeMs) break
      prev = now
    }
    if (!this.closed) await this.ingestFile(rel)
  }

  /**
   * Ingest one note file (context-relative path). Returns the ops emitted
   * (possibly empty). Serialized against materialize by the per-path lock.
   */
  async ingestFile(rel) {
    rel = nfc(rel.split(sep).join('/')) // §3.1: NFC-normalize names from disk
    if (isIgnoredPath(rel) || !rel.endsWith('.md') || !isSafePath(rel)) return []
    return withPathLock(this.registry, rel, async () => {
      let raw
      try {
        raw = await readFile(join(this.root, rel))
      } catch (err) {
        if (err.code === 'ENOENT') return this._deleteUnlocked(rel)
        throw err
      }
      const hash = sha256(raw)
      this._known.add(rel)
      const manifest = await loadManifest(this.root)
      if (manifest.files[rel] === hash || this._ingested.get(rel) === hash) {
        // Our own materialized bytes (or an edit already ingested): not a
        // human edit — nothing to diff (§9.4 self-echo suppression).
        this.emit('skip', { path: rel, reason: 'unchanged' })
        return []
      }
      const { fm, body, warnings } = parseNote(raw.toString('utf8'))
      for (const wmsg of warnings) this.emit('warning', { path: rel, message: wmsg })
      const relNoExt = rel.slice(0, -3)
      const subject = nfc(relNoExt.split('/').pop())
      const ops = await this._diff(subject, relNoExt, fm || {}, body)
      for (const op of ops) await this.append(op.type, op.payload)
      this._ingested.set(rel, hash)
      // Account the ingested bytes into the materialize manifest: they are
      // now "known" to the system, so the next materialize may regenerate
      // the file (its canonical bytes) instead of treating the human edit
      // as still-pending (§9.4 coordination).
      await this._touchManifest(rel, hash)
      if (typeof this.vault.update === 'function') await this.vault.update()
      this.emit('ops', { path: rel, subject, ops })
      return ops
    })
  }

  async _maybeDelete(rel) {
    rel = nfc(rel.split(sep).join('/'))
    return withPathLock(this.registry, rel, () => this._deleteUnlocked(rel))
  }

  /** §9.2 removed file -> DeleteSubject, behind the confirmation guard. */
  async _deleteUnlocked(rel) {
    const manifest = await loadManifest(this.root)
    const known = manifest.files[rel] !== undefined || this._known.has(rel)
    if (!known || !rel.endsWith('.md')) return []
    const subject = nfc(rel.slice(0, -3).split('/').pop())
    if (!this.confirmDelete) {
      this.emit('delete-skipped', { path: rel, subject })
      return []
    }
    if (!(await this.confirmDelete(subject, rel))) {
      this.emit('delete-skipped', { path: rel, subject })
      return []
    }
    const ops = [{ type: 'delete-subject', payload: { s: subject } }]
    for (const op of ops) await this.append(op.type, op.payload)
    this._known.delete(rel)
    this._ingested.delete(rel)
    await this._touchManifest(rel, null)
    if (typeof this.vault.update === 'function') await this.vault.update()
    this.emit('ops', { path: rel, subject, ops })
    return ops
  }

  /** Full pass: ingest every note on disk, then handle disappeared notes. */
  async scan() {
    const rels = []
    await walkDir(this.root, '', rels)
    const ops = []
    for (const rel of rels.sort()) {
      ops.push(...(await this.ingestFile(rel)))
    }
    const manifest = await loadManifest(this.root)
    const onDisk = new Set(rels)
    const candidates = new Set([...Object.keys(manifest.files), ...this._known])
    for (const rel of [...candidates].sort()) {
      if (!rel.endsWith('.md') || onDisk.has(rel)) continue
      ops.push(...(await this._maybeDelete(rel)))
    }
    return ops
  }

  /** Read-modify-write of one manifest entry, under the manifest lock. */
  _touchManifest(rel, hash) {
    return withPathLock(this.registry, MANIFEST_FILE, async () => {
      const manifest = await loadManifest(this.root)
      if (hash === null) delete manifest.files[rel]
      else manifest.files[rel] = hash
      await saveManifest(this.root, manifest)
    })
  }

  async close() {
    this.closed = true
    if (this._fsw) this._fsw.close()
    for (const t of this._timers.values()) clearTimeout(t)
    this._timers.clear()
  }

  // ---------- the per-field diff engine (§9.2 minimal op set) ----------

  async _resolveKind(key) {
    if (key === '@type') return 'type'
    if (key === '@id') return 'id'
    const t = await this.vault.val(K.ctxTerm(key))
    if (t) {
      if (t.kind === 'type-alias') return 'type'
      if (t.kind === 'id-alias') return 'id'
      return t.kind // 'lww' | 'set'
    }
    if (this.meta.hostAllowlist.includes(key)) return 'host'
    return 'unmapped'
  }

  async _subjectState(s) {
    const st = { fields: new Map(), host: new Map(), id: undefined, path: undefined, head: undefined, headText: '' }
    for await (const { key, value } of this.vault.scan(K.nFieldPrefix(s))) {
      st.fields.set(K.unesc(key.split('/')[3]), value)
    }
    for await (const { key, value } of this.vault.scan(K.nHostPrefix(s))) {
      st.host.set(K.unesc(key.split('/')[3]), value)
    }
    st.id = await this.vault.val(K.nId(s))
    st.path = await this.vault.val(K.nPath(s))
    st.head = await this.vault.val(K.nBody(s))
    if (st.head !== undefined) {
      const rev = await this.vault.val(K.nRev(s, st.head))
      st.headText = (rev && rev.text) || ''
    }
    return st
  }

  async _diff(subject, relNoExt, fm, body) {
    if (typeof this.vault.update === 'function') await this.vault.update()
    const view = await this._subjectState(subject)
    const ops = []

    // ---- path capture (§9.3): the authored context-relative path ----
    const scope = scopeFromPath(relNoExt)
    const authored = view.path ? view.path.path : undefined
    if (authored !== relNoExt) {
      // Emit SetPath unless the file already sits at its reconstructable
      // default and no path was ever authored (minimality).
      let atDefault = false
      if (authored === undefined) {
        const fmTypes = await this._fmTypeNames(fm)
        const layer = layerFromPath(relNoExt) === 'schema' ? 'schema' : inferLayer(fmTypes)
        atDefault = relNoExt === defaultRelPath(subject, layer, scope, fmTypes)
      }
      if (!atDefault) {
        ops.push({ type: 'set-path', payload: { s: subject, path: relNoExt, scope } })
      }
    }

    // ---- frontmatter per-field diff (§9.2) ----
    const fmSlots = new Map() // slot key -> { key, values, scalar }
    for (const [rawKey, rawVal] of Object.entries(fm)) {
      const key = nfc(rawKey)
      if (key === 'vld:path') {
        // §9.3/§10.4: vld:path is consumed on ingest, NEVER stored as a
        // field. On the Markdown face the file's actual location is the
        // authored path (already captured above); a frontmatter vld:path
        // is dropped with a warning.
        this.emit('warning', {
          path: relNoExt + '.md',
          message: 'vld:path frontmatter key consumed (file location wins on the Markdown face)'
        })
        continue
      }
      const kind = await this._resolveKind(key)
      const { values, scalar, warnings } = yamlToValues(rawVal)
      for (const wmsg of warnings) this.emit('warning', { path: relNoExt + '.md', message: wmsg })
      const slot = kind === 'type' ? '@type' : kind === 'id' ? '@id' : (kind === 'host' ? 'host:' : 'f:') + key
      fmSlots.set(slot, { key, kind, values, scalar, raw: rawVal })
    }

    // view-side slots (for removal detection)
    const viewSlots = new Set()
    for (const term of view.fields.keys()) viewSlots.add(term === '@type' ? '@type' : 'f:' + term)
    for (const k of view.host.keys()) viewSlots.add('host:' + k)
    if (view.id) viewSlots.add('@id')

    const slots = [...new Set([...fmSlots.keys(), ...viewSlots])].sort()
    for (const slot of slots) {
      const entry = fmSlots.get(slot)
      if (slot === '@id') {
        ops.push(...(await this._diffId(subject, entry, view)))
      } else if (slot === '@type') {
        ops.push(...this._diffSet(subject, entry ? entry.key : '@type', entry, view.fields.get('@type')))
      } else if (slot.startsWith('host:')) {
        ops.push(...this._diffHost(subject, slot.slice(5), entry, view.host.get(slot.slice(5))))
      } else {
        const term = slot.slice(2)
        const kind = entry ? entry.kind : await this._resolveKind(term)
        const rec = view.fields.get(term)
        if (kind === 'set') {
          ops.push(...this._diffSet(subject, term, entry, rec))
        } else if (kind === 'unmapped') {
          ops.push(...this._diffUnmapped(subject, term, entry, rec))
        } else {
          ops.push(...this._diffLww(subject, term, entry, rec))
        }
      }
    }

    // ---- body diff (§9.2): one SetBody citing the observed head ----
    const text = nfc(body)
    if (text !== view.headText) {
      ops.push({ type: 'set-body', payload: { s: subject, base: view.head ?? null, text } })
    }

    // Deterministic emission order: SetPath, field ops (already in sorted
    // slot order), SetBody last.
    return ops
  }

  async _fmTypeNames(fm) {
    const out = []
    for (const [rawKey, rawVal] of Object.entries(fm)) {
      const kind = await this._resolveKind(nfc(rawKey))
      if (kind !== 'type') continue
      for (const v of yamlToValues(rawVal).values) {
        out.push(v !== null && typeof v === 'object' && typeof v.ref === 'string' ? v.ref : String(v))
      }
    }
    return out
  }

  async _diffId(subject, entry, view) {
    const current = view.id ? view.id.iri : undefined
    if (!entry) {
      // removed frontmatter line -> UnsetField (§9.2)
      if (current === undefined) return []
      const idTerm = await this.vault.val(K.ctxTerm('id'))
      const key = idTerm && idTerm.kind === 'id-alias' ? 'id' : '@id'
      return [{ type: 'unset-field', payload: { s: subject, p: key } }]
    }
    const iri = typeof entry.values[0] === 'string' ? entry.values[0] : String(entry.raw)
    if (iri === current) return []
    return [{ type: 'set-field', payload: { s: subject, p: entry.key, o: iri } }]
  }

  /** OR-set diff: adds and observed-remove citations (§5.3, §9.2). */
  _diffSet(subject, key, entry, rec) {
    const els = (rec && rec.els) || {}
    const present = new Map() // byteForm -> [tagHex]
    for (const [tag, el] of Object.entries(els)) {
      const bf = byteForm(el.v)
      if (!present.has(bf)) present.set(bf, [])
      present.get(bf).push(tag)
    }
    const wanted = new Map() // byteForm -> value
    if (entry) {
      for (const v of entry.values) wanted.set(byteForm(canonicalValue(v)), v)
    }
    const ops = []
    for (const [bf, v] of [...wanted.entries()].sort()) {
      if (!present.has(bf)) {
        ops.push({ type: 'add-member', payload: { s: subject, p: key, o: v, ctxKind: 'set' } })
      }
    }
    for (const [bf, tags] of [...present.entries()].sort()) {
      if (!wanted.has(bf)) {
        // §5.3 citation contract: cite EVERY element-tag currently mapped
        // to the removed value in the resolved view.
        ops.push({
          type: 'rem-member',
          payload: { s: subject, p: key, tags: tags.sort().map((t) => Buffer.from(t, 'hex')), ctxKind: 'set' }
        })
      }
    }
    return ops
  }

  /** LWW diff at whole-array granularity (§5.1): one SetField or UnsetField. */
  _diffLww(subject, term, entry, rec) {
    const current = rec && rec.reg ? rec.reg.values : rec && rec.els ? sortedElValues(rec.els) : undefined
    if (!entry) {
      if (current === undefined && !(rec && rec.un)) return []
      return [{ type: 'unset-field', payload: { s: subject, p: term } }]
    }
    const next = canonicalArray(entry.values)
    if (current !== undefined && sameValueArrays(next, canonicalArray(current))) return []
    const o = entry.scalar ? entry.values[0] : entry.values
    // §5.7: pin the kind we resolved against so a reorged DefineTerm cannot
    // silently reinterpret this write.
    return [{ type: 'set-field', payload: { s: subject, p: term, o, ctxKind: 'scalar' } }]
  }

  /** Host-tool keys (§5.6): whole-value replace, never flagged. */
  _diffHost(subject, key, entry, rec) {
    if (!entry) {
      if (rec === undefined) return []
      return [{ type: 'unset-field', payload: { s: subject, p: key } }]
    }
    const next = entry.scalar ? canonicalValue(entry.values[0]) : entry.values.map(canonicalValue)
    if (rec !== undefined && stableStringify(next) === stableStringify(rec.value)) return []
    return [{ type: 'set-field', payload: { s: subject, p: key, o: entry.scalar ? entry.values[0] : entry.values } }]
  }

  /**
   * Unmapped terms (§5.2/§5.6): SetField ACCUMULATES in the view, so pure
   * additions are one SetField; any removal needs UnsetField (clears the
   * accumulation) followed by a SetField re-asserting the surviving
   * values. ctxKind is not pinnable for unmapped terms (§5.7).
   */
  _diffUnmapped(subject, term, entry, rec) {
    const current = rec && rec.un ? canonicalArray(rec.un.items.map((it) => it.v)) : []
    const wanted = entry ? canonicalArray(entry.values) : []
    if (sameValueArrays(current, wanted)) return []
    if (!entry) return [{ type: 'unset-field', payload: { s: subject, p: term } }]
    const currentSet = new Set(current.map(byteForm))
    const wantedSet = new Set(wanted.map(byteForm))
    const removals = [...currentSet].some((bf) => !wantedSet.has(bf))
    const o = entry.scalar ? entry.values[0] : entry.values
    const ops = []
    if (removals) ops.push({ type: 'unset-field', payload: { s: subject, p: term } })
    ops.push({ type: 'set-field', payload: { s: subject, p: term, o } })
    return ops
  }
}

function sortedElValues(els) {
  return Object.entries(els)
    .sort()
    .map(([, el]) => el.v)
}

function sameValueArrays(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (byteForm(a[i]) !== byteForm(b[i])) return false
  }
  return true
}

function inferLayer(types) {
  const META = new Set([
    'owl:Ontology',
    'owl:Class',
    'owl:ObjectProperty',
    'owl:DatatypeProperty',
    'rdfs:Class',
    'rdf:Property',
    'skos:ConceptScheme',
    'skos:Concept'
  ])
  return types.some((t) => META.has(t)) ? 'schema' : 'data'
}

async function walkDir(root, rel, out) {
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
    if (e.isDirectory()) await walkDir(root, childRel, out)
    else if (e.isFile() && childRel.endsWith('.md')) out.push(childRel)
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
