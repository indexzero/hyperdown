// status(vault, dir): one state per `.md` file of a bundle: in-log,
// pending-ingest, dirty, absent or foreign. Read-only: it appends no op and
// writes no file. The states are defined in SPEC §9 and in
// okf/docs/decisions/ADR-002-status-command.md.
import { readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { canonical } from '@auto-okf/core'
import { planBundle } from './materialize.js'
import { parseNote } from './yaml.js'
import { loadManifest, sha256, walkNotes, isReservedFile } from './fsatomic.js'

const { nfc } = canonical

/** [{ path, state }] in byte order of path, the shape of `--json`. */
export async function status(vault, dir) {
  const planned = await planBundle(vault)
  // Not rootRegistry: it creates the directory, and status writes nothing.
  // A missing directory is all absent.
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
    // A manifest entry with no file and no plan is retired state. No row.
    return plannedBuf !== undefined ? 'absent' : null
  }
  if (plannedBuf !== undefined && sha256(raw) === sha256(plannedBuf)) return 'in-log'
  if (trackedHash !== undefined) return 'dirty'
  // An untracked index.md or log.md: materialize reconciles it, ingest
  // ignores it.
  if (isReservedFile(rel)) return 'dirty'
  // pending-ingest only when ingest can make a concept of it: the same
  // `type` gate as the watcher.
  const { fm } = parseNote(raw.toString('utf8'))
  return fmType(fm) === null ? 'foreign' : 'pending-ingest'
}

/** Must match IngestWatcher._fmType, the `type` gate of ingest. */
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
