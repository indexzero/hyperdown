// Op encode and decode over the generated hyperdispatch codec (SPEC §3).
//
// The generated spec/hyperdispatch exports `encode(name, message)` and
// `decode(buffer)`, which returns { id, name, value }. An unknown command
// id throws DispatchError.HANDLER_NOT_FOUND_BY_ID. hyperschema decodes an
// optional field as null, and encode needs every optional field present,
// null or not.
import { encode as hdEncode, decode as hdDecode } from '../spec/hyperdispatch/index.js'
import { nfc } from './canonical.js'

const NS = '@okf/'

// The 12 ops of SPEC §3, in wire-id order. Append only.
export const OP_TYPES = [
  'create-concept',
  'set-field',
  'add-tag',
  'rem-tag',
  'set-body',
  'set-path',
  'delete-concept',
  'undelete-concept',
  'resolve-conflict',
  'add-writer',
  'remove-writer',
  'set-writer-policy'
]

export const GOVERNANCE_OPS = new Set(['add-writer', 'remove-writer', 'set-writer-policy'])

// The optional wire fields of each struct. `clock` and `at` are on every
// op (SPEC §3).
const OPTIONALS = {
  'create-concept': ['id', 'clock', 'at'],
  'set-field': ['clock', 'at'],
  'add-tag': ['clock', 'at'],
  'rem-tag': ['clock', 'at'],
  'set-body': ['base', 'clock', 'at'],
  'set-path': ['clock', 'at'],
  'delete-concept': ['clock', 'at'],
  'undelete-concept': ['clock', 'at'],
  'resolve-conflict': ['text', 'clock', 'at'],
  'add-writer': ['clock', 'at', 'swarmKey'],
  'remove-writer': ['clock', 'at'],
  'set-writer-policy': ['clock', 'at']
}

/**
 * The tag (opId) of SPEC §3 and §6: `writerKeyHex || seqHex`, where seqHex
 * is minimal lowercase hex, no leading zeros, '0' for seq 0. It is also
 * the mint id form. apply derives it from the node, never from the payload.
 */
export function makeTag(writerKey, seq) {
  const w =
    writerKey instanceof Uint8Array ? Buffer.from(writerKey).toString('hex') : String(writerKey)
  return w + Number(seq).toString(16)
}

/** Inverse of makeTag. A writer key is 32 bytes, so 64 hex chars. */
export function parseTag(tag) {
  const t = String(tag)
  if (!/^[0-9a-f]{65,}$/.test(t)) throw new TypeError('not a tag: ' + tag)
  return { writer: t.slice(0, 64), seq: parseInt(t.slice(64), 16) }
}

/** Encode an op for append to a writer's core. */
export function encodeOp(type, payload) {
  if (!OP_TYPES.includes(type)) throw new TypeError('unknown op type: ' + type)
  const msg = { ...payload }
  for (const opt of OPTIONALS[type]) {
    if (msg[opt] === undefined) msg[opt] = null
  }
  return hdEncode(NS + type, msg)
}

/**
 * Decode a raw op buffer. Never throws (SPEC §3). Returns
 * { ok: true, type, op }, or { ok: false, reason } with 'unknown-msgid'
 * for an unregistered command id or 'undecodable' for garbage bytes. The
 * reason is in the view, so the mapping is fixed.
 */
export function decodeOp(buf) {
  let decoded
  try {
    decoded = hdDecode(buf)
  } catch (err) {
    const reason =
      err && (err.code === 'HANDLER_NOT_FOUND_BY_ID' || /HANDLER_NOT_FOUND/.test(String(err.message)))
        ? 'unknown-msgid'
        : 'undecodable'
    return { ok: false, reason }
  }
  const type = decoded.name.startsWith(NS) ? decoded.name.slice(NS.length) : decoded.name
  return { ok: true, type, op: decoded.value }
}

/**
 * Normalize an op clock, [[writerHex, seq], ...] or
 * [{ writerKey, seq }, ...], into { writerHex: seq }. Returns null for a
 * missing or malformed clock. apply rejects that as 'forged-clock'
 * (SPEC §8).
 */
export function normalizeClock(clock) {
  if (!Array.isArray(clock)) return null
  const out = {}
  for (const entry of clock) {
    let w, seq
    if (Array.isArray(entry) && entry.length === 2) {
      ;[w, seq] = entry
    } else if (entry && typeof entry === 'object') {
      w = entry.writerKey
      seq = entry.seq
    } else {
      return null
    }
    if (typeof w !== 'string' || !/^[0-9a-f]+$/.test(w)) return null
    if (!Number.isInteger(seq) || seq < 0) return null
    out[w] = Math.max(out[w] ?? 0, seq)
  }
  return out
}

/** NFC the user string fields of a decoded op (SPEC §3). */
export function normalizeOpStrings(op) {
  const out = { ...op }
  for (const f of ['id', 'key', 'path', 'type', 'value', 'text', 'base', 'keep']) {
    if (typeof out[f] === 'string') out[f] = nfc(out[f])
  }
  if (Array.isArray(out.tags)) out.tags = out.tags.map((x) => nfc(String(x)))
  if (Array.isArray(out.supersede)) out.supersede = out.supersede.map((x) => nfc(String(x)))
  if (Array.isArray(out.namespacePrefixes)) {
    out.namespacePrefixes = out.namespacePrefixes.map((x) => nfc(String(x)))
  }
  return out
}
