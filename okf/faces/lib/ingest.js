// Ingest watcher (okf SPEC §9): human edits to the on-disk OKF bundle
// re-enter the vault as MINIMAL ops. The watcher parses changed files,
// diffs frontmatter PER KEY against view state and the body against the head
// revision, and emits the smallest op set — never whole-file ops (§3: the
// failure mode this design exists to avoid is file-granularity LWW).
//
// Identity is the concept's `_id` (§6), not the filename: a known `_id` at a
// new path is a rename (SetPath); a missing `_id` mints; an unknown `_id` is
// ADOPTED (the epoch-cycle contract, §10). `_id`/`_rev` are stripped from
// the frontmatter diff (identity + derived output, never fields, §5).
//
// Link handling is APPLY's job: a SetBody triggers core's normative link
// extraction, which populates link/, bl/ and (for unresolved targets)
// wanted/ — the ranked demand index, NEVER a flag (§9, I4). The watcher only
// emits the body op.
//
// fs.watch semantics (verified against
// https://nodejs.org/api/fs.html#fswatchfilename-options-listener and
// #caveats): not 100% consistent across platforms; `recursive: true` is
// supported on macOS/Windows and, since Node 20, Linux (engines.node >= 20).
// Event types and `filename` are unreliable, so every event is treated only
// as "this path is dirty" (null => full rescan): re-stat, debounce, wait for
// write-settle, then decide changed-vs-deleted from the filesystem itself.
//
// Coordination with materialize (§9): the same per-path in-flight lock
// registry serializes ingest reads against materialize's rename critical
// section, and the emission manifest lets the watcher ignore the system's
// own writes instead of echoing them back as ops.
import { EventEmitter } from 'node:events'
import { watch } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { keyspace as K, canonical } from '@auto-okf/core'
import { parseNote, yamlToValues } from './yaml.js'
import {
  rootRegistry,
  withPathLock,
  loadManifest,
  saveManifest,
  sha256,
  isIgnoredPath,
  isReservedFile,
  statOrNull,
  walkNotes,
  MANIFEST_FILE
} from './fsatomic.js'

const { nfc, canonicalArray, canonicalValue, byteForm } = canonical

const CONFLICT_SUFFIX_RE = /\.conflict-[0-9a-f]{8,}$/
const HEX64 = /^[0-9a-f]{64}$/
const RESERVED_FRONTMATTER = new Set(['_id', '_rev'])

/**
 * Create (and start) the ingest watcher for `dir`.
 *
 * `vault` must expose the @auto-okf/store read surface (`val`, `scan`,
 * `update`) and the content-op helpers (`createConcept`, `setField`,
 * `addTag`, `remTag`, `setBody`, `setPath`, `deleteConcept`). Options:
 *
 *   confirmDelete   async (id, relPath) => boolean — the §9 deletion guard
 *                   (default ON: WITHOUT a handler, DeleteConcept is NEVER
 *                   emitted; the skip is observable via 'delete-skipped').
 *   debounce        ms of per-path quiet time before reading (default 100)
 *   settle          write-settle interval: size+mtime stable for one
 *                   interval before the read (default 50)
 *   watch           false to disable fs.watch (drive scan()/ingestFile()
 *                   manually; used by deterministic tests)
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
    this.confirmDelete = opts.confirmDelete || null
    this.debounceMs = opts.debounce ?? 100
    this.settleMs = opts.settle ?? 50
    this.closed = false
    this._timers = new Map() // rel -> timeout
    this._ingested = new Map() // rel -> sha256 last ingested (echo suppression)
    this._fsw = null
  }

  _start() {
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

  /** §9 write-settle: read only once size+mtime are stable for one interval. */
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

  // ---------- one-file ingest ----------

  /**
   * Ingest one concept file (bundle-relative path). Returns the op
   * descriptors emitted (possibly empty). Serialized against materialize by
   * the per-path lock.
   */
  async ingestFile(rel) {
    rel = nfc(rel.split(sep).join('/'))
    if (isIgnoredPath(rel) || !rel.endsWith('.md')) return []
    if (isReservedFile(rel)) {
      // §9: index.md/log.md are reserved regenerated faces — edits ignored.
      this.emit('skip', { path: rel, reason: 'reserved' })
      return []
    }
    return withPathLock(this.registry, rel, async () => {
      let raw
      try {
        raw = await readFile(join(this.root, rel))
      } catch (err) {
        if (err.code === 'ENOENT') return this._deleteUnlocked(rel)
        throw err
      }
      const hash = sha256(raw)
      const manifest = await loadManifest(this.root)
      if (manifest.files[rel] === hash || this._ingested.get(rel) === hash) {
        // Our own materialized bytes, or an edit already ingested: not a human
        // edit — nothing to diff (§9 self-echo suppression).
        this.emit('skip', { path: rel, reason: 'unchanged' })
        return []
      }
      const { fm, body, warnings } = parseNote(raw.toString('utf8'))
      for (const wmsg of warnings) this.emit('warning', { path: rel, message: wmsg })

      const { ops, established } = await this._ingestParsed(rel, fm || {}, body)

      if (!established) {
        // No concept corresponds to this file (e.g. missing/empty `type`, so
        // CreateConcept could not fire). It stays an UNTRACKED human file:
        // recording its hash in the manifest would let the next materialize
        // treat it as a prior output and DELETE it (N3). Leave it out so it
        // surfaces as pending-ingest instead.
        this.emit('ops', { path: rel, ops })
        return ops
      }
      this._ingested.set(rel, hash)
      // Account the ingested bytes into the manifest: they are now known to
      // the system, so the next materialize MAY regenerate the file (its
      // canonical bytes) instead of treating the human edit as still-pending.
      await this._touchManifest(rel, hash)
      if (typeof this.vault.update === 'function') await this.vault.update()
      this.emit('ops', { path: rel, ops })
      return ops
    })
  }

  /**
   * Diff a parsed file against the view and emit the minimal op set.
   * Resolves identity first (§6/§9: known/adopt/mint + copy detection +
   * conflict-copy awareness), then diffs fields and body.
   */
  async _ingestParsed(rel, fm, body) {
    if (typeof this.vault.update === 'function') await this.vault.update()

    const P = rel.slice(0, -3) // strip '.md'
    const terminal = P.split('/').pop()
    const isConflictCopy = CONFLICT_SUFFIX_RE.test(terminal)
    // §9 conflict-copy awareness: ingest at the suffix-stripped path.
    const authoredPath = isConflictCopy ? P.replace(CONFLICT_SUFFIX_RE, '') : P

    const emitted = []
    const id = await this._ensureConcept(rel, fm, authoredPath, isConflictCopy, emitted)
    if (id == null) return { ops: emitted, established: false } // could not create (e.g. missing type)

    if (typeof this.vault.update === 'function') await this.vault.update()
    const state = await this._conceptState(id)

    const ops = []

    // ---- path (§9): rename only, and never for a conflict copy sitting at
    // its stripped path (that IS the loser's materialized face) ----
    if (!isConflictCopy && state.exists && state.path !== authoredPath) {
      ops.push({ type: 'set-path', payload: { id, path: authoredPath } })
    }

    // ---- frontmatter per-key diff (§9) ----
    const authored = new Map() // key -> { values, scalar }
    for (const [rawKey, rawVal] of Object.entries(fm)) {
      const key = nfc(rawKey)
      if (RESERVED_FRONTMATTER.has(key)) continue // §5: identity/derived, never fields
      authored.set(key, yamlToValues(rawVal))
    }
    const keys = new Set([...authored.keys(), ...state.fields.keys()])
    for (const key of [...keys].sort(byteCmp)) {
      if (key === 'tags') {
        ops.push(...this._diffTags(id, authored.get('tags'), state.fields.get('tags')))
      } else {
        ops.push(...this._diffLww(id, key, authored.get(key), state.fields.get(key)))
      }
    }

    // ---- body diff (§9): one SetBody citing the file's _rev ----
    const text = nfc(body)
    if (text !== state.headText) {
      const base = this._chooseBase(fm._rev, state.head)
      ops.push({ type: 'set-body', payload: { id, base, text } })
    }

    for (const op of ops) await this._apply(op)
    return { ops: emitted.concat(ops), established: true }
  }

  /**
   * Ensure the concept exists and return its `_id` (§6/§9). Emits a
   * CreateConcept when adopting, minting, or copy-splitting; the created id
   * is appended to `emitted`.
   */
  async _ensureConcept(rel, fm, authoredPath, isConflictCopy, emitted) {
    const rawId = typeof fm._id === 'string' ? nfc(fm._id) : undefined

    if (rawId) {
      const meta = await this.vault.val(K.cMeta(rawId))
      if (meta !== undefined) {
        // Known id. Copy detection (§9): same _id at two paths — the file at
        // the id's current view path is the original; this one is a copy.
        if (!isConflictCopy) {
          const pathRec = await this.vault.val(K.cPath(rawId))
          const viewPath = pathRec ? pathRec.path : undefined
          if (viewPath !== undefined && viewPath !== authoredPath) {
            const original = await statOrNull(join(this.root, viewPath + '.md'))
            if (original !== null) {
              // A distinct file holds the original path: mint a fresh copy.
              this.emit('copy', { path: rel, of: rawId })
              return this._create(authoredPath, fm, undefined, emitted)
            }
          }
        }
        return rawId
      }
      // §9/§10: unknown id → ADOPT it.
      return this._create(authoredPath, fm, rawId, emitted)
    }

    // §9: missing _id → mint (write-back happens on the next materialize,
    // which stamps the deterministic minted _id into the file).
    return this._create(authoredPath, fm, undefined, emitted)
  }

  /** Emit a CreateConcept; return the concept id (adopted id or minted tag). */
  async _create(path, fm, id, emitted) {
    const type = this._fmType(fm)
    if (type == null) {
      this.emit('warning', { path: path + '.md', message: 'cannot create concept: no non-empty `type` in frontmatter' })
      return null
    }
    const res = await this._apply({ type: 'create-concept', payload: { path, type, id } })
    // Adoption keeps the supplied id; a mint's id is the create op's tag
    // (the store returns { seq, tag }).
    const conceptId = id !== undefined ? id : res && res.tag
    emitted.push({ type: 'create-concept', payload: { path, type, id: conceptId } })
    return conceptId
  }

  _fmType(fm) {
    const raw = fm.type
    const v = Array.isArray(raw) ? raw[0] : raw
    if (typeof v !== 'string') return null
    const t = nfc(v)
    return t === '' ? null : t
  }

  _chooseBase(fmRev, head) {
    if (typeof fmRev === 'string' && HEX64.test(nfc(fmRev))) return nfc(fmRev)
    // §6: missing _rev over a concept WITH revisions cites the current head;
    // over a concept without revisions, base null.
    return head !== undefined ? head : null
  }

  // ---------- per-field diff engines ----------

  /** LWW field (§5): one SetField, or SetField [] to clear a removed key. */
  _diffLww(id, key, authoredEntry, rec) {
    const current = rec && Array.isArray(rec.values) ? canonicalArray(rec.values) : undefined
    if (!authoredEntry) {
      if (current === undefined || current.length === 0) return []
      // §5: type can never be emptied (apply rejects empty-type); skip it.
      if (key === 'type') return []
      return [{ type: 'set-field', payload: { id, key, value: [] } }]
    }
    const next = canonicalArray(authoredEntry.values)
    if (current !== undefined && sameArrays(next, current)) return []
    const value = authoredEntry.scalar ? authoredEntry.values[0] : authoredEntry.values
    return [{ type: 'set-field', payload: { id, key, value } }]
  }

  /** OR-set `tags` (§5): AddTag for new members, RemTag for dropped ones. */
  _diffTags(id, authoredEntry, rec) {
    const els = (rec && rec.els) || {}
    const present = new Map() // byteForm -> value
    for (const v of Object.values(els)) present.set(byteForm(canonicalValue(v)), v)
    const wanted = new Map() // byteForm -> value
    if (authoredEntry) {
      for (const v of authoredEntry.values) {
        if (typeof v === 'string') wanted.set(byteForm(canonicalValue(v)), nfc(v))
      }
    }
    const ops = []
    for (const [bf, v] of [...wanted.entries()].sort(byteEntryCmp)) {
      if (!present.has(bf)) ops.push({ type: 'add-tag', payload: { id, value: v } })
    }
    for (const [bf, v] of [...present.entries()].sort(byteEntryCmp)) {
      // remTag recomputes the §5 citation set (every observed token) from the
      // view — the store helper owns that computation.
      if (!wanted.has(bf)) ops.push({ type: 'rem-tag', payload: { id, value: v } })
    }
    return ops
  }

  // ---------- view reads ----------

  async _conceptState(id) {
    const st = { exists: false, fields: new Map(), path: undefined, head: undefined, headText: '' }
    const meta = await this.vault.val(K.cMeta(id))
    st.exists = meta !== undefined
    for await (const { key, value } of this.vault.scan(K.cFieldPrefix(id))) {
      st.fields.set(K.parseKey(key)[3], value)
    }
    const pathRec = await this.vault.val(K.cPath(id))
    if (pathRec) st.path = pathRec.path
    st.head = await this.vault.val(K.cBody(id))
    if (st.head !== undefined) {
      const rev = await this.vault.val(K.cRev(id, st.head))
      st.headText = rev && typeof rev.text === 'string' ? rev.text : ''
    }
    return st
  }

  // ---------- op sink ----------

  /** Apply one op descriptor via the store's typed helpers. */
  async _apply(op) {
    const p = op.payload
    switch (op.type) {
      case 'create-concept':
        return this.vault.createConcept(p.path, p.type, p.id !== undefined ? { id: p.id } : {})
      case 'set-field':
        return this.vault.setField(p.id, p.key, p.value)
      case 'add-tag':
        return this.vault.addTag(p.id, p.value)
      case 'rem-tag':
        return this.vault.remTag(p.id, p.value)
      case 'set-body':
        return this.vault.setBody(p.id, p.base, p.text)
      case 'set-path':
        return this.vault.setPath(p.id, p.path)
      case 'delete-concept':
        return this.vault.deleteConcept(p.id)
      default:
        throw new Error('unknown ingest op: ' + op.type)
    }
  }

  // ---------- deletion (§9, behind the confirmation guard) ----------

  async _maybeDelete(rel) {
    rel = nfc(rel.split(sep).join('/'))
    return withPathLock(this.registry, rel, () => this._deleteUnlocked(rel))
  }

  async _deleteUnlocked(rel) {
    if (!rel.endsWith('.md') || isReservedFile(rel) || isIgnoredPath(rel)) return []
    const P = rel.slice(0, -3)
    const terminal = P.split('/').pop()
    if (CONFLICT_SUFFIX_RE.test(terminal)) {
      // A conflict copy is a transient face, not the concept's canonical
      // location — its removal is not a DeleteConcept (deletion is dangerous).
      this.emit('delete-skipped', { path: rel, reason: 'conflict-copy' })
      return []
    }
    const id = await this.vault.val(K.path(P))
    if (id === undefined) return [] // no concept holds this path
    if (!this.confirmDelete || !(await this.confirmDelete(id, rel))) {
      this.emit('delete-skipped', { path: rel, id })
      return []
    }
    const op = { type: 'delete-concept', payload: { id } }
    await this._apply(op)
    this._ingested.delete(rel)
    await this._touchManifest(rel, null)
    if (typeof this.vault.update === 'function') await this.vault.update()
    this.emit('ops', { path: rel, ops: [op] })
    return [op]
  }

  // ---------- full scan ----------

  /** Ingest every concept file on disk, then handle disappeared concepts. */
  async scan() {
    const rels = []
    await walkNotes(this.root, '', rels)
    const ops = []
    for (const rel of rels.sort(byteCmp)) {
      ops.push(...(await this.ingestFile(rel)))
    }
    const manifest = await loadManifest(this.root)
    const onDisk = new Set(rels)
    for (const rel of Object.keys(manifest.files).sort(byteCmp)) {
      if (!rel.endsWith('.md') || onDisk.has(rel) || isReservedFile(rel)) continue
      ops.push(...(await this._maybeDelete(rel)))
    }
    return ops
  }

  // ---------- manifest ----------

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
}

function sameArrays(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (byteForm(a[i]) !== byteForm(b[i])) return false
  return true
}

function byteCmp(a, b) {
  return Buffer.compare(Buffer.from(String(a), 'utf8'), Buffer.from(String(b), 'utf8'))
}

function byteEntryCmp(a, b) {
  return byteCmp(a[0], b[0])
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
