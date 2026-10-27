// Op encode/decode wrapper over the generated hyperdispatch codec (okf
// SPEC §3). Pattern ancestor: vault-ld/core/lib/ops.js (patterns only, no
// code path shared — SPEC §0 copy-don't-depend).
//
// Sources verified against the installed packages (2026-07-13):
// - hyperdispatch@1.6 example.js + lib/codegen.js: the generated
//   spec/hyperdispatch exports `encode(name, message)` and `decode(buffer)`
//   returning { id, name, value }; unknown command ids throw
//   DispatchError.HANDLER_NOT_FOUND_BY_ID.
// - hyperschema@1.21 README: optional fields decode as null and must be
//   present (possibly null) at encode time.
import { encode as hdEncode, decode as hdDecode } from '../spec/hyperdispatch/index.js'
import { nfc } from './canonical.js'

const NS = '@okf/'

// The 12 ops of SPEC §3, in wire-id order (append-only).
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

// Optional wire fields per struct (hyperschema optionals decode as null and
// must be present — possibly null — at encode time). `clock` and `at` are
// on every op (§3).
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
  'add-writer': ['clock', 'at'],
  'remove-writer': ['clock', 'at'],
  'set-writer-policy': ['clock', 'at']
}

/**
 * opId tag (§3, §6): `writerKeyHex || seqHex` where seqHex is minimal
 * lowercase hex, no leading zeros, '0' for seq 0. This is also the §6 mint
 * id form. Derived by apply from the node, never read from the payload.
 */
export function makeTag(writerKey, seq) {
  const w =
    writerKey instanceof Uint8Array ? Buffer.from(writerKey).toString('hex') : String(writerKey)
  return w + Number(seq).toString(16)
}

/** Inverse of makeTag: writer keys are 32 bytes = 64 hex chars. */
export function parseTag(tag) {
  const t = String(tag)
  if (!/^[0-9a-f]{65,}$/.test(t)) throw new TypeError('not a tag: ' + tag)
  return { writer: t.slice(0, 64), seq: parseInt(t.slice(64), 16) }
}

/** Encode an op for appending to the writer's core. */
export function encodeOp(type, payload) {
  if (!OP_TYPES.includes(type)) throw new TypeError('unknown op type: ' + type)
  const msg = { ...payload }
  for (const opt of OPTIONALS[type]) {
    if (msg[opt] === undefined) msg[opt] = null
  }
  return hdEncode(NS + type, msg)
}

/**
 * Decode a raw op buffer. NEVER throws (§3: "apply MUST NOT throw"):
 * returns { ok: true, type, op } or { ok: false, reason } with reason
 * 'unknown-msgid' (unregistered command id) or 'undecodable' (garbage
 * bytes). The recorded reason is view-observable, so the mapping is fixed.
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
 * Normalize an op-carried vector clock ([[writerHex, seq], ...] or
 * [{ writerKey, seq }, ...]) into { writerHex: seq }. Returns null for a
 * missing or malformed clock (§8: apply rejects it as 'forged-clock').
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

/** NFC-normalize the user-string fields of a decoded op (§3). */
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
