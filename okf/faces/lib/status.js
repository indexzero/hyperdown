// status(vault, dir) — the per-file vault/bundle state porcelain (ADR-002).
// Strictly read-only: appends no ops, writes no files, touches no manifest —
// the plan comes from planBundle (the exact bytes materialize would write),
// and the emission manifest and on-disk bytes are only read. One row per
// `.md` file in the union of {planned projection, emission manifest, disk},
// in canonical byte order, each carrying one state from the fixed ADR-002
// vocabulary:
//
//   in-log          on-disk bytes match the log's canonical projection
//   pending-ingest  hand-authored, untracked; ingest would establish a
//                   concept for it (mint/adopt)
//   dirty           manifest-tracked (in the log) but diverged from the
//                   projection — a hand edit ingest would fold in as diffs
//                   against the existing concept, or a log that has moved
//                   past the last materialize
//   absent          projected by the log, missing from disk (materialize
//                   would restore it)
//   foreign         not in the log, not manifest-tracked, and not
//                   establishable by ingest (e.g. another writer's
//                   mid-write WIP with no parseable non-empty `type`)
import { readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { canonical } from '@auto-okf/core'
import { planBundle } from './materialize.js'
import { parseNote } from './yaml.js'
import { loadManifest, sha256, walkNotes, isReservedFile } from './fsatomic.js'

const { nfc } = canonical

/** Per-file states, sorted by path: [{ path, state }] (the --json contract). */
export async function status(vault, dir) {
  const planned = await planBundle(vault)
  // No rootRegistry here: it mkdirs the bundle dir, and status writes
  // nothing. A missing bundle dir is simply all-absent.
  let realRoot = null
  try {
    realRoot = await realpath(dir)
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
  const manifest = realRoot === null ? { files: {} } : await loadManifest(realRoot)
  const disk = []
  if (realRoot !== null) await walkNotes(realRoot, '', disk)

  const rels = new Set([...planned.keys(), ...Object.keys(manifest.files), ...disk])
  const rows = []
  for (const rel of [...rels].sort(byteCmp)) {
    const state = await classify(realRoot, rel, planned.get(rel), manifest.files[rel])
    if (state !== null) rows.push({ path: rel, state })
  }
  return rows
}

async function classify(realRoot, rel, plannedBuf, trackedHash) {
  let raw = null
  if (realRoot !== null) {
    try {
      raw = await readFile(join(realRoot, rel))
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
  }
  if (raw === null) {
    // A manifest entry with neither a file nor a projection is retired
    // state the next materialize drops — no file, no row.
    return plannedBuf !== undefined ? 'absent' : null
  }
  if (plannedBuf !== undefined && sha256(raw) === sha256(plannedBuf)) return 'in-log'
  if (trackedHash !== undefined) return 'dirty'
  // Untracked derived face (index.md/log.md before any materialize, or
  // hand-created): materialize reconciles it, ingest ignores it.
  if (isReservedFile(rel)) return 'dirty'
  // Untracked hand-authored file: pending-ingest iff ingest could establish
  // a concept for it — the same non-empty-`type` gate as the watcher.
  const { fm } = parseNote(raw.toString('utf8'))
  return fmType(fm) === null ? 'foreign' : 'pending-ingest'
}

/** Mirror of IngestWatcher._fmType: the `type` ingest needs to mint/adopt. */
function fmType(fm) {
  const raw = fm ? fm.type : undefined
  const v = Array.isArray(raw) ? raw[0] : raw
  if (typeof v !== 'string') return null
  const t = nfc(v)
  return t === '' ? null : t
}

function byteCmp(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}
