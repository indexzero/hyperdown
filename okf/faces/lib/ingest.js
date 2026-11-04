// Ingest: edits of a bundle re-enter the vault as the smallest set of ops
// (SPEC §9). Identity is the `_id`, not the path.
//
// apply, not the watcher, extracts the links of a SetBody.
//
// fs.watch gives unreliable event types and filenames. Every event means
// "this path is dirty", a null filename a full rescan. `recursive: true`
// needs Node 20 on Linux.
import { EventEmitter } from 'node:events'
import { watch } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { keyspace as K, canonical, encodeOp, parseTag } from '@auto-okf/core'
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
  atomicWrite,
  atomicUnlink,
  MANIFEST_FILE
} from './fsatomic.js'

const { nfc, canonicalArray, canonicalValue, byteForm } = canonical

const CONFLICT_SUFFIX_RE = /\.conflict-[0-9a-f]{8,}$/
const HEX64 = /^[0-9a-f]{64}$/
const RESERVED_FRONTMATTER = new Set(['_id', '_rev'])
// The shortest tag that makeTag can make: a 64-hex writer key and one hex digit of seq.
const MIN_TAG = '0'.repeat(65)
// The pending record: `{ concepts: { <_id>: { at, path, sha256, gone? } } }`.
// See "pending files" below.
const PENDING_FILE = '.okf-pending.json'

/**
 * Create the ingest watcher for `dir` and start it, unless `opts.watch` is
 * false.
 *
 * `vault` must expose the read surface of @auto-okf/store (`val`, `scan`,
 * `update`), `metadata.limits.maxOpBytes`, `clock(seq)` and the content-op
 * helpers (`createConcept`, `setField`, `addTag`, `remTag`, `setBody`,
 * `setPath`, `deleteConcept`, `undeleteConcept`).
 *
 * Options:
 *   confirmDelete   async (id, relPath) => boolean. Without a handler the
 *                   watcher never emits DeleteConcept. It emits
 *                   'delete-skipped' instead.
 *   debounce        ms of quiet time per path before a read (default 100)
 *   settle          ms that size and mtime must stay stable before a read
 *                   (default 50)
 *   watch           false: no fs.watch. The caller drives scan() and
 *                   ingestFile().
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
    this._ingested = new Map() // rel -> sha256 of the last ingest (echo suppression)
    this._fsw = null
    this._inflight = 0 // settle and ingest passes that run now
    this._pendingDeletes = new Set() // vanished paths that wait for the quiet drain
    this._drainTimer = null
    this._scanTimer = null
    this._scanChain = Promise.resolve() // serializes the rescans of directory events
    this._import = null // { rel } while importNote runs (import mode)
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
    if (isIgnoredPath(rel)) return
    if (!rel.endsWith('.md')) return this._dirtyMaybeDir(rel)
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

  /**
   * A non-`.md` path can be a directory event. macOS reports a subtree move
   * as renames of the directories, never of the nested `.md` paths. So a
   * directory, or a path that is gone, schedules one scan(). A plain
   * non-`.md` file stays ignored.
   */
  _dirtyMaybeDir(rel) {
    const t = this._timers.get(rel)
    if (t) clearTimeout(t)
    this._timers.set(
      rel,
      setTimeout(() => {
        this._timers.delete(rel)
        this._probeDir(rel).catch((err) => this.emit('error', err))
      }, this.debounceMs)
    )
  }

  async _probeDir(rel) {
    if (this.closed) return
    const st = await statOrNull(join(this.root, rel))
    if (st !== null && !st.isDirectory()) return
    this._scheduleScan()
  }

  _scheduleScan() {
    if (this._scanTimer) clearTimeout(this._scanTimer)
    this._scanTimer = setTimeout(() => {
      this._scanTimer = null
      this._scanChain = this._scanChain
        .then(() => (this.closed ? [] : this.scan()))
        .catch((err) => this.emit('error', err))
    }, this.debounceMs)
  }

  /** Write-settle: read only after size and mtime stay stable for one interval (SPEC §9). */
  async _settleAndIngest(rel) {
    this._inflight++
    try {
      let prev = await statOrNull(join(this.root, rel))
      for (let i = 0; i < 100 && !this.closed; i++) {
        if (prev === null) return this._deferDelete(rel)
        await sleep(this.settleMs)
        const now = await statOrNull(join(this.root, rel))
        if (now === null) return this._deferDelete(rel)
        if (now.size === prev.size && now.mtimeMs === prev.mtimeMs) break
        prev = now
      }
      if (!this.closed) await this.ingestFile(rel)
    } finally {
      this._inflight--
    }
  }

  /**
   * Never delete a vanished path inside the event that saw it. Queue it,
   * and drain only when the watcher is quiet: no timer, no in-flight
   * ingest. The new path of a moved file then ingests first, and its
   * SetPath vacates the old `path/<p>` claim, so the drained delete finds
   * no holder. scan() keeps the same order. See SPEC §9.
   */
  _deferDelete(rel) {
    this._pendingDeletes.add(rel)
    this._scheduleDrain()
  }

  _scheduleDrain() {
    if (this._drainTimer) clearTimeout(this._drainTimer)
    this._drainTimer = setTimeout(() => {
      this._drainTimer = null
      if (this.closed) return
      if (this._timers.size > 0 || this._inflight > 0) return this._scheduleDrain()
      this._drainDeletes().catch((err) => this.emit('error', err))
    }, this.debounceMs)
  }

  async _drainDeletes() {
    const rels = [...this._pendingDeletes].sort(byteCmp)
    this._pendingDeletes.clear()
    for (const rel of rels) {
      if (this.closed) return
      // The file is back (editor save cycle, move back): ingest it, do not delete.
      if ((await statOrNull(join(this.root, rel))) !== null) {
        this._dirty(rel)
        continue
      }
      await this._maybeDelete(rel)
    }
  }

  // ---------- one-file ingest ----------

  /**
   * Ingest one concept file at the bundle-relative path `rel`. Returns the
   * op descriptors that it emitted, possibly none. The per-path lock
   * serializes it against materialize. A dot path is ignored here, but
   * importNote takes it.
   */
  async ingestFile(rel) {
    rel = nfc(rel.split(sep).join('/'))
    if (isIgnoredPath(rel) || !rel.endsWith('.md')) return []
    if (isReservedFile(rel)) {
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
      const file = { hash: sha256(raw), owned: undefined } // owned: the concept of a file with no _id of its own
      const manifest = await loadManifest(this.root)
      if (manifest.files[rel] === file.hash || this._ingested.get(rel) === file.hash) {
        // The bytes are materialize's own, or already ingested: not a human edit.
        this.emit('skip', { path: rel, reason: 'unchanged' })
        return []
      }
      const { fm, body, warnings } = parseNote(raw.toString('utf8'))
      for (const wmsg of warnings) this.emit('warning', { path: rel, message: wmsg })

      // Refuse an oversize body here, by name, before any op of this file is
      // appended. The file stays pending. Other files are not affected.
      const refused = await this._preflightBody(fm || {}, body)
      if (refused !== null) {
        this.emit('oversize', { path: rel, ...refused })
        return []
      }

      const appended = []
      let parsed
      try {
        parsed = await this._ingestParsed(rel, fm || {}, body, appended, file)
      } catch (err) {
        await this._keepPending(rel, file)
        throw err
      }
      const { ops, established, id } = parsed

      if (!established) {
        // No concept corresponds to this file, for example because `type` is
        // missing. Do not record its hash in the manifest: the next
        // materialize then treats the file as a prior output and deletes
        // it. Left out, it stays pending-ingest.
        this.emit('ops', { path: rel, ops })
        return ops
      }
      // Read core's verdict before the record. A file with a rejected op
      // stays out of the manifest, so it stays pending and the next
      // materialize keeps it.
      const rejected = await this._rejections(appended)
      if (rejected.length > 0) {
        await this._keepPending(rel, file)
        for (const r of rejected) this.emit('rejected', { path: rel, op: r.op.type, reason: r.reason })
        return ops
      }
      await this._clearPending(rel, id)
      this._ingested.set(rel, file.hash)
      // The manifest now knows these bytes, so the next materialize can
      // regenerate the file instead of keeping it as pending.
      await this._touchManifest(rel, file.hash)
      if (typeof this.vault.update === 'function') await this.vault.update()
      this.emit('ops', { path: rel, ops })
      return ops
    })
  }

  /**
   * The oversize preflight of ingestFile. apply measures the encoded op
   * (apply.js, `raw.length > maxOpBytes`), so this encodes the set-body op
   * that the file leads to. Returns `{ bytes, limit, opBytes }` when that op
   * exceeds the pinned maxOpBytes, else null. `bytes` is the size of the
   * body.
   *
   * The encoded op is a lower bound of the op that the store appends, so
   * the preflight never refuses an op that core takes:
   * - The id is the `_id` of the file or MIN_TAG, whichever has fewer UTF-8
   *   bytes. The codec writes an id as a length prefix and its UTF-8 bytes,
   *   so count UTF-8 bytes, not UTF-16 code units.
   * - The base is the `_rev` of the file, or none.
   * - The clock is clock(0), whose self entry is the smallest position.
   * An op within a few bytes of the limit can pass, and core then rejects
   * it. A body equal to the head of its `_id` returns null. But a copy sets
   * that body on a new concept, and core's verdict covers it.
   */
  async _preflightBody(fm, body) {
    const text = nfc(body)
    const rawId = typeof fm._id === 'string' ? nfc(fm._id) : undefined
    if (rawId !== undefined && (await this.vault.val(K.cMeta(rawId))) !== undefined) {
      if (text === (await this._conceptState(rawId)).headText) return null
    } else if (text === '') {
      return null
    }
    const id = rawId !== undefined && Buffer.byteLength(rawId, 'utf8') < MIN_TAG.length ? rawId : MIN_TAG
    const base = typeof fm._rev === 'string' && HEX64.test(nfc(fm._rev)) ? nfc(fm._rev) : null
    const limit = this.vault.metadata.limits.maxOpBytes
    const op = { id, base, text, clock: await this.vault.clock(0), at: Date.now() }
    const opBytes = encodeOp('set-body', op).byteLength
    if (opBytes <= limit) return null
    return { bytes: Buffer.byteLength(text, 'utf8'), limit, opBytes }
  }

  /**
   * Diff a parsed file against the view and emit the smallest op set. Each
   * op that it appends goes on `appended` as `{ op, tag }`, for core's
   * verdict. `file`: see _ownedConcept.
   */
  async _ingestParsed(rel, fm, body, appended, file) {
    if (typeof this.vault.update === 'function') await this.vault.update()

    const P = rel.slice(0, -3) // strip '.md'
    const terminal = P.split('/').pop()
    const isConflictCopy = CONFLICT_SUFFIX_RE.test(terminal)
    // Ingest at the path without its conflict suffixes. A human file can
    // carry more than one. Strip every one, or the authored path is itself
    // reserved, apply rejects it reserved-path, and the file stays pending
    // forever.
    let authoredPath = P
    while (CONFLICT_SUFFIX_RE.test(authoredPath.split('/').pop())) {
      authoredPath = authoredPath.replace(CONFLICT_SUFFIX_RE, '')
    }

    const emitted = []
    const id = await this._ensureConcept(rel, fm, authoredPath, isConflictCopy, emitted, appended, file)
    if (id == null) return { ops: emitted, established: false } // no concept created, for example no type

    if (typeof this.vault.update === 'function') await this.vault.update()
    const state = await this._conceptState(id)

    const ops = []

    // A file on disk with a tombstoned `_id` is intent to keep. Undelete
    // first, so the SetPath and SetBody below land on a live concept. Else
    // apply flags writeafterdelete, materialize still suppresses the
    // concept, and it unlinks the file. A conflict copy never resurrects
    // the concept that it mirrors.
    if (!isConflictCopy && state.exists && state.deleted) {
      ops.push({ type: 'undelete-concept', payload: { id } })
    }

    // Rename only. Never for a conflict copy at its stripped path: that
    // file is the materialized face of the loser.
    if (!isConflictCopy && state.exists && state.path !== authoredPath) {
      ops.push({ type: 'set-path', payload: { id, path: authoredPath } })
    }

    // ---- frontmatter diff per key ----
    const authored = new Map() // key -> { values, scalar }
    for (const [rawKey, rawVal] of Object.entries(fm)) {
      const key = nfc(rawKey)
      if (RESERVED_FRONTMATTER.has(key)) continue // never fields (SPEC §5)
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

    // ---- body diff: one SetBody that cites the `_rev` of the file ----
    const text = nfc(body)
    if (text !== state.headText) {
      const base = this._chooseBase(fm._rev, state.head)
      ops.push({ type: 'set-body', payload: { id, base, text } })
    }

    for (const op of ops) await this._apply(op, appended)
    return { ops: emitted.concat(ops), established: true, id }
  }

  /**
   * Make sure that the concept exists, and return its `_id`. A
   * CreateConcept for an adopt, a mint or a copy goes on `emitted`.
   */
  async _ensureConcept(rel, fm, authoredPath, isConflictCopy, emitted, appended, file) {
    const rawId = typeof fm._id === 'string' ? nfc(fm._id) : undefined

    if (rawId) {
      const meta = await this.vault.val(K.cMeta(rawId))
      if (meta !== undefined) {
        if (!isConflictCopy) {
          const pathRec = await this.vault.val(K.cPath(rawId))
          const viewPath = pathRec ? pathRec.path : undefined
          if (viewPath !== undefined && viewPath !== authoredPath) {
            const original = await statOrNull(join(this.root, viewPath + '.md'))
            if (original !== null) {
              // A distinct file holds the view path of the id, so this file
              // is a copy (SPEC §9). It gets a new concept, or the one that
              // a pending ingest of it made.
              this.emit('copy', { path: rel, of: rawId })
              return this._ownedConcept(rel, authoredPath, fm, emitted, appended, file)
            }
          }
        }
        return rawId
      }
      // An unknown id: adopt it (SPEC §6).
      return this._create(authoredPath, fm, rawId, emitted, appended)
    }

    // No `_id`: mint. The next materialize stamps the id into the file. A
    // pending ingest of this file can already hold one (_ownedConcept).
    return this._ownedConcept(rel, authoredPath, fm, emitted, appended, file)
  }

  /** Emit a CreateConcept and return the concept id: the adopted id, or the minted tag. */
  async _create(path, fm, id, emitted, appended) {
    const type = this._fmType(fm)
    if (type == null) {
      this.emit('warning', { path: path + '.md', message: 'cannot create concept: no non-empty `type` in frontmatter' })
      return null
    }
    const res = await this._apply({ type: 'create-concept', payload: { path, type, id } }, appended)
    // An adoption keeps the supplied id. For a mint, only the view knows the
    // id: a squat on the tag-id of this writer makes apply mint a SHA
    // fallback, so the tag of the op can point at the squatter's concept.
    // Never take the op tag as identity.
    const conceptId = id !== undefined ? id : await this._resolveMintedId(res && res.tag, path)
    emitted.push({ type: 'create-concept', payload: { path, type, id: conceptId } })
    if (appended) appended[appended.length - 1].created = conceptId
    return conceptId
  }

  /**
   * Resolve the id of a new mint from the view (SPEC §6).
   * Without a squat the tag is the id: one read. After a squat the genuine
   * concept claimed `path` at create, and its `meta.created === tag`: find
   * it through path/, else scan c/.
   */
  async _resolveMintedId(tag, path) {
    if (typeof this.vault.update === 'function') await this.vault.update()
    if (tag != null) {
      const meta = await this.vault.val(K.cMeta(tag))
      if (meta !== undefined && meta.created === tag) return tag
    }
    const holder = await this.vault.val(K.path(path))
    if (holder !== undefined && holder !== tag) {
      const hm = await this.vault.val(K.cMeta(holder))
      if (hm !== undefined && hm.created === tag) return holder
    }
    for await (const { key, value } of this.vault.scan('c/')) {
      if (key.endsWith('/meta') && value && value.created === tag) return K.parseKey(key)[1]
    }
    return tag
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
    // No `_rev`: cite the head when one exists (SPEC §6).
    return head !== undefined ? head : null
  }

  // ---------- per-field diff engines ----------

  /** LWW field (SPEC §5): one SetField, or SetField [] to clear a removed key. */
  _diffLww(id, key, authoredEntry, rec) {
    const current = rec && Array.isArray(rec.values) ? canonicalArray(rec.values) : undefined
    if (!authoredEntry) {
      if (current === undefined || current.length === 0) return []
      // apply rejects an empty `type` (empty-type), so never clear it.
      if (key === 'type') return []
      return [{ type: 'set-field', payload: { id, key, value: [] } }]
    }
    const next = canonicalArray(authoredEntry.values)
    if (current !== undefined && sameArrays(next, current)) return []
    const value = authoredEntry.scalar ? authoredEntry.values[0] : authoredEntry.values
    return [{ type: 'set-field', payload: { id, key, value } }]
  }

  /** OR-set `tags` (SPEC §5): AddTag for each new member, RemTag for each dropped one. */
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
      // The store helper remTag adds the cited tags from the view.
      if (!wanted.has(bf)) ops.push({ type: 'rem-tag', payload: { id, value: v } })
    }
    return ops
  }

  // ---------- view reads ----------

  async _conceptState(id) {
    const st = { exists: false, deleted: false, fields: new Map(), path: undefined, head: undefined, headText: '' }
    const meta = await this.vault.val(K.cMeta(id))
    st.exists = meta !== undefined
    st.deleted = meta !== undefined && meta.deleted != null
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

  // ---------- import mode (SPEC §10, `auto-okf import`) ----------

  /**
   * Import one note of a face into a fresh vault (SPEC §10, importFace).
   * `raw` holds the bytes that importFace read, so the note is read once,
   * and the fidelity check compares the same bytes. Import mode differs
   * from ingestFile:
   *   - It reads no emission manifest and no pending record, and writes
   *     neither.
   *   - It treats `_rev` as absent. Each head is the first revision of its
   *     concept, and `_rev` re-derives.
   *   - A dot segment is part of a concept path.
   *   - It refuses an oversize op before the append (IMPORT_OVERSIZE), and
   *     it throws IMPORT_REJECTED on an op that core rejected. It never
   *     keeps such an op.
   * Returns the op descriptors: none when the note establishes no concept.
   * A 'warning' event says why.
   */
  async importNote(rel, raw) {
    rel = nfc(rel.split(sep).join('/'))
    const { fm, body, warnings } = parseNote(raw.toString('utf8'))
    for (const message of warnings) this.emit('warning', { path: rel, message })
    const authored = { ...(fm || {}) }
    delete authored._rev
    const appended = []
    this._import = { rel }
    let ops
    try {
      ;({ ops } = await this._ingestParsed(rel, authored, body, appended))
    } finally {
      this._import = null
    }
    const [rejected] = await this._rejections(appended)
    if (rejected !== undefined) {
      const { op, reason } = rejected
      throw namedError('IMPORT_REJECTED', `${rel}: core rejected its ${op.type} op (${reason})`, {
        path: rel,
        op: op.type,
        reason
      })
    }
    this.emit('ops', { path: rel, ops })
    return ops
  }

  /**
   * Import mode: refuse an op whose encoded form exceeds the pinned
   * maxOpBytes, before the append. clock(0) and `at` here give a lower
   * bound of the op that the store appends, as in _preflightBody, so the
   * preflight never refuses an op that core takes.
   */
  async _preflightImport(op) {
    const limit = this.vault.metadata.limits.maxOpBytes
    // rem-tag: the store adds the cited tags, so none is the lower bound.
    const payload = op.type === 'rem-tag' ? { ...op.payload, tags: [] } : op.payload
    const bytes = encodeOp(op.type, { ...payload, clock: await this.vault.clock(0), at: Date.now() }).byteLength
    if (bytes > limit) {
      const rel = this._import.rel
      throw namedError('IMPORT_OVERSIZE', `${rel}: its ${op.type} op is ${bytes} bytes encoded; maxOpBytes is ${limit}`, {
        path: rel,
        op: op.type,
        bytes,
        limit
      })
    }
  }

  /**
   * Core's verdict on each op in `appended` (`{ op, tag }`): the rejected
   * ones, as `{ op, reason }`, in append order. It folds first, so the view
   * holds each flag/rejected record.
   */
  async _rejections(appended) {
    if (typeof this.vault.update === 'function') await this.vault.update()
    const out = []
    for (const { op, tag } of appended) {
      const { writer, seq } = parseTag(tag)
      const rec = await this.vault.val(K.flagRejected(writer, seq))
      if (rec !== undefined) out.push({ op, reason: rec.reason })
    }
    return out
  }

  // ---------- op sink ----------

  /**
   * Apply one op descriptor through the store helper, and put it on
   * `appended`, when given, for core's verdict. In import mode the
   * preflight runs first.
   */
  async _apply(op, appended) {
    if (this._import !== null) await this._preflightImport(op)
    const res = await this._append(op)
    if (appended) appended.push({ op, tag: res.tag })
    return res
  }

  _append(op) {
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
      case 'undelete-concept':
        return this.vault.undeleteConcept(p.id)
      default:
        throw new Error('unknown ingest op: ' + op.type)
    }
  }

  // ---------- deletion (SPEC §9, behind the confirmation guard) ----------

  async _maybeDelete(rel) {
    rel = nfc(rel.split(sep).join('/'))
    return withPathLock(this.registry, rel, () => this._deleteUnlocked(rel))
  }

  async _deleteUnlocked(rel) {
    if (!rel.endsWith('.md') || isReservedFile(rel) || isIgnoredPath(rel)) return []
    const P = rel.slice(0, -3)
    const terminal = P.split('/').pop()
    if (CONFLICT_SUFFIX_RE.test(terminal)) {
      // A conflict copy is a transient face, not the location of the
      // concept. Its removal is not a DeleteConcept.
      this.emit('delete-skipped', { path: rel, reason: 'conflict-copy' })
      return []
    }
    // A pending file deletes the concept that the record names for it (it
    // can have lost a path collision). Another file deletes the holder of
    // its path.
    const id = (await this._pendingOf(rel)) ?? (await this.vault.val(K.path(P)))
    if (id === undefined) return [] // no concept holds this path
    if (!this.confirmDelete || !(await this.confirmDelete(id, rel))) {
      await this._gonePending(rel)
      this.emit('delete-skipped', { path: rel, id })
      return []
    }
    const op = { type: 'delete-concept', payload: { id } }
    const appended = []
    await this._apply(op, appended)
    // Read core's verdict before the record, as in ingestFile. A rejected
    // delete keeps the manifest entry and the pending record of the path,
    // so a later scan retries it.
    const rejected = await this._rejections(appended)
    if (rejected.length > 0) {
      await this._gonePending(rel)
      for (const r of rejected) this.emit('rejected', { path: rel, op: r.op.type, reason: r.reason })
      return [op]
    }
    await this._clearPending(rel, id)
    this._ingested.delete(rel)
    await this._touchManifest(rel, null)
    if (typeof this.vault.update === 'function') await this.vault.update()
    this.emit('ops', { path: rel, ops: [op] })
    return [op]
  }

  // ---------- full scan ----------

  /**
   * Ingest every concept file on disk. Then delete each concept whose path
   * the manifest or the pending record lists and the disk no longer holds.
   * A pending file never reached the manifest, so the manifest alone
   * misses its delete.
   */
  async scan() {
    const rels = []
    await walkNotes(this.root, '', rels)
    const ops = []
    for (const rel of rels.sort(byteCmp)) {
      ops.push(...(await this.ingestFile(rel)))
    }
    const listed = new Set(Object.keys((await loadManifest(this.root)).files))
    for (const { path } of Object.values((await this._loadPending()).concepts)) listed.add(path)
    const onDisk = new Set(rels)
    for (const rel of [...listed].sort(byteCmp)) {
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

  // ---------- pending files (SPEC §9) ----------
  //
  // A file with no _id of its own (a note without _id, or a copy) gets a
  // concept from its ingest. If that ingest does not complete, the file
  // stays pending with no _id, because only materialize stamps one. So the
  // watcher records the concept of the file in PENDING_FILE, keyed by its
  // _id: `path` is the file, `sha256` the bytes of that ingest, and `at`
  // the path of the concept in the view then. A later ingest takes the
  // recorded concept in place of a mint or a copy split, only on evidence
  // that the file is the same (_pendingConcept):
  //   - the file at `path`: an edit, or a retry of the same bytes.
  //   - a file at another path with the same bytes, while the disk no
  //     longer holds `path`: a rename.
  // And only while the concept is live at `at`. A record marked `gone`
  // takes back only the same bytes at `path`: a new note there is a new
  // concept. The record goes when an ingest of the file or of the concept
  // completes, or when the delete of the file takes effect.
  //
  // What the disk cannot show: a rename and an edit in one step, while no
  // watcher runs, is a new file. Before a delete pass sees `path` gone, a
  // new note at `path` looks like an edit.

  /**
   * The concept of a file with no _id of its own: the concept of its pending
   * record, else a new one (_create). `file` is ingestFile's { hash, owned }.
   * owned notes the concept, so a failed ingest records it (_keepPending).
   * Import mode passes no `file` and reads no record: the pending record of
   * a face is state of another directory.
   */
  async _ownedConcept(rel, authoredPath, fm, emitted, appended, file) {
    if (file === undefined) return this._create(authoredPath, fm, undefined, emitted, appended)
    const id = (await this._pendingConcept(rel, file.hash)) ?? (await this._create(authoredPath, fm, undefined, emitted, appended))
    if (id != null) file.owned = id
    return id
  }

  /** The recorded concept for the file at `rel` with the bytes `hash`, on the evidence above, or undefined. */
  async _pendingConcept(rel, hash) {
    const { concepts } = await this._loadPending()
    let renamed
    for (const id of Object.keys(concepts).sort(byteCmp)) {
      const e = concepts[id]
      if (e.path === rel) {
        if ((e.gone !== true || e.sha256 === hash) && (await this._stays(id, e.at))) return id
      } else if (renamed === undefined && e.sha256 === hash && (await statOrNull(join(this.root, e.path))) === null) {
        if (await this._stays(id, e.at)) renamed = id
      }
    }
    return renamed
  }

  /** Is concept `id` live, at the path `at` that its record saw? */
  async _stays(id, at) {
    const meta = await this.vault.val(K.cMeta(id))
    if (meta === undefined || meta.deleted != null) return false
    const rec = await this.vault.val(K.cPath(id))
    return rec !== undefined && rec.path === at
  }

  /** The concept that the record names for the file `rel`, while it stays. A stale record of `rel` goes. */
  async _pendingOf(rel) {
    const { concepts } = await this._loadPending()
    const id = Object.keys(concepts).find((k) => concepts[k].path === rel)
    if (id === undefined) return undefined
    if (await this._stays(id, concepts[id].at)) return id
    await this._writePending((cs) => {
      if (cs[id] !== undefined && cs[id].path === rel) delete cs[id]
    })
    return undefined
  }

  /** Record file.owned, the concept that this incomplete ingest of `rel` used, while the view holds it live. */
  async _keepPending(rel, file) {
    if (file.owned === undefined) return
    if (typeof this.vault.update === 'function') await this.vault.update()
    const meta = await this.vault.val(K.cMeta(file.owned))
    const rec = await this.vault.val(K.cPath(file.owned))
    if (meta === undefined || meta.deleted != null || rec === undefined) return
    await this._writePending((cs) => {
      for (const k of Object.keys(cs)) if (cs[k].path === rel) delete cs[k]
      cs[file.owned] = { at: rec.path, path: rel, sha256: file.hash }
    })
  }

  /** An ingest of `rel` or of concept `id` completed, or the delete of `rel` took effect: their records go. */
  _clearPending(rel, id) {
    return this._writePending((cs) => {
      if (id !== undefined) delete cs[id]
      for (const k of Object.keys(cs)) if (cs[k].path === rel) delete cs[k]
    })
  }

  /** A delete pass found the file `rel` gone and deleted nothing: mark its record `gone` (see above). */
  _gonePending(rel) {
    return this._writePending((cs) => {
      for (const k of Object.keys(cs)) if (cs[k].path === rel) cs[k] = { ...cs[k], gone: true }
    })
  }

  /** Change the record with `mutate(concepts)`, under its lock. Writes only on a change. */
  _writePending(mutate) {
    return withPathLock(this.registry, PENDING_FILE, async () => {
      const { concepts } = await this._loadPending()
      const before = canonical.stableStringify(concepts)
      mutate(concepts)
      if (canonical.stableStringify(concepts) === before) return
      if (Object.keys(concepts).length === 0) {
        await atomicUnlink(this.root, PENDING_FILE)
        return
      }
      await atomicWrite(this.root, PENDING_FILE, Buffer.from(canonical.stableStringify({ concepts }) + '\n', 'utf8'))
    })
  }

  async _loadPending() {
    let raw
    try {
      raw = await readFile(join(this.root, PENDING_FILE), 'utf8')
    } catch (err) {
      if (err.code === 'ENOENT') return { concepts: {} }
      throw err
    }
    const parsed = JSON.parse(raw)
    const concepts = {}
    for (const [id, e] of Object.entries((parsed && parsed.concepts) || {})) {
      if (e && typeof e.at === 'string' && typeof e.path === 'string' && typeof e.sha256 === 'string') concepts[id] = { ...e }
    }
    return { concepts }
  }

  async close() {
    this.closed = true
    if (this._fsw) this._fsw.close()
    for (const t of this._timers.values()) clearTimeout(t)
    this._timers.clear()
    if (this._drainTimer) clearTimeout(this._drainTimer)
    if (this._scanTimer) clearTimeout(this._scanTimer)
    this._pendingDeletes.clear()
    await this._scanChain
  }
}

/** An error whose message starts with its code, with `fields` on it. */
function namedError(code, message, fields) {
  const err = new Error(`${code}: ${message}`)
  err.code = code
  return Object.assign(err, fields)
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
