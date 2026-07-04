// Op encode/decode wrapper over the generated hyperdispatch code (§3).
//
// Sources:
// - https://github.com/holepunchto/hyperdispatch example.js: generated
//   spec/hyperdispatch exports `encode(name, message)` and `decode(buffer)`
//   returning { id, name, value }; unknown command ids throw
//   DispatchError.HANDLER_NOT_FOUND_BY_ID (verified in lib/codegen.js of the
//   installed package).
// - https://github.com/holepunchto/hyperschema README: optional fields
//   decode as null.
import { encode as hdEncode, decode as hdDecode } from '../spec/hyperdispatch/index.js'
import { nfc } from './canonical.js'

const NS = '@vault/'

export const OP_TYPES = [
  'set-field',
  'add-member',
  'rem-member',
  'unset-field',
  'set-body',
  'set-path',
  'delete-subject',
  'resolve-conflict',
  'clear-flag',
  'define-term',
  'define-scope',
  'add-writer',
  'remove-writer',
  'set-writer-policy',
  'prune-revisions'
]

export const GOVERNANCE_OPS = new Set([
  'add-writer',
  'remove-writer',
  'set-writer-policy',
  'prune-revisions'
])

// Optional wire fields per struct (hyperschema optionals decode as null and
// must be present — possibly null — at encode time).
const OPTIONALS = {
  'set-field': ['ctxKind', 'clock'],
  'add-member': ['ctxKind', 'clock'],
  'rem-member': ['ctxKind', 'clock'],
  'unset-field': ['clock'],
  'set-body': ['base', 'clock'],
  'set-path': ['scope', 'clock'],
  'delete-subject': ['clock'],
  'resolve-conflict': ['text', 'clock'],
  'clear-flag': ['clock'],
  'define-term': ['clock'],
  'define-scope': ['clock'],
  'add-writer': ['clock'],
  'remove-writer': ['clock'],
  'set-writer-policy': ['clock'],
  'prune-revisions': ['clock']
}

/** opId tag = writerKey || seq: 32-byte key || 8-byte big-endian seq (§3.2). */
export function makeTag(writerKey, seq) {
  const key = Buffer.isBuffer(writerKey) ? writerKey : Buffer.from(writerKey, 'hex')
  const tag = Buffer.alloc(key.length + 8)
  key.copy(tag, 0)
  tag.writeBigUInt64BE(BigInt(seq), key.length)
  return tag
}

export function tagHex(tag) {
  if (tag == null) return null
  return Buffer.isBuffer(tag) ? tag.toString('hex') : String(tag)
}

export function parseTag(tag) {
  const buf = Buffer.isBuffer(tag) ? tag : Buffer.from(tag, 'hex')
  return {
    writer: buf.subarray(0, buf.length - 8).toString('hex'),
    seq: Number(buf.readBigUInt64BE(buf.length - 8))
  }
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
 * Decode a raw op buffer. Never throws garbage: returns
 *   { ok: true, type, op }  or  { ok: false, reason } with reason from the
 * §8.4 enum ('unknown-msgid' | 'undecodable'). The recorded reason is
 * view-observable, so the mapping is fixed (§8.4).
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

// --- JSON-safe (de)hydration of decoded ops for the n/hold/ buffer (§8.2):
// buffers become hex strings in the view and are rehydrated at fold time.
const BUFFER_FIELDS = { tag: false, key: false, tags: true } // name -> isArray

export function opToJson(op) {
  const out = {}
  for (const [k, v] of Object.entries(op)) {
    if (v == null) {
      out[k] = null
    } else if (k in BUFFER_FIELDS && BUFFER_FIELDS[k]) {
      out[k] = v.map((b) => (Buffer.isBuffer(b) ? b.toString('hex') : String(b)))
    } else if (k in BUFFER_FIELDS) {
      out[k] = Buffer.isBuffer(v) ? v.toString('hex') : String(v)
    } else {
      out[k] = v
    }
  }
  return out
}

export function opFromJson(json) {
  const out = {}
  for (const [k, v] of Object.entries(json)) {
    if (v == null) {
      out[k] = null
    } else if (k in BUFFER_FIELDS && BUFFER_FIELDS[k]) {
      out[k] = v.map((h) => Buffer.from(h, 'hex'))
    } else if (k in BUFFER_FIELDS) {
      out[k] = Buffer.from(v, 'hex')
    } else {
      out[k] = v
    }
  }
  return out
}

/**
 * Normalize an op-carried vector clock ([[writerHex, seq], ...] or
 * [{ writerKey, seq }, ...] per §3.2) into { writerHex: seq }. Returns null
 * for a missing or malformed clock (§8.3 treats that as rejectable once the
 * writer is revoked).
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
    out[w] = Math.max(out[w] || 0, seq)
  }
  return out
}

/** NFC-normalize the user-string fields of a decoded op (§3.1). */
export function normalizeOpStrings(op) {
  const out = { ...op }
  for (const f of ['s', 'p', 'path', 'scope', 'term', 'prefix', 'flagKey', 'text', 'base', 'keep', 'before']) {
    if (typeof out[f] === 'string') out[f] = nfc(out[f])
  }
  if (Array.isArray(out.supersede)) out.supersede = out.supersede.map((x) => nfc(String(x)))
  if (Array.isArray(out.namespacePrefixes)) {
    out.namespacePrefixes = out.namespacePrefixes.map((x) => nfc(String(x)))
  }
  return out
}
