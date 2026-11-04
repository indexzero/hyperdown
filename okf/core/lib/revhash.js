// Copied from vault-ld/core/lib/revhash.js at 046d37f. It diverges freely
// (SPEC §0, copy-don't-depend). The revHash of SPEC §5:
//
//   revHash = SHA-256( len(base) || base || len(text) || utf8(NFC(text)) )
//
// `base` is the 64-char lowercase hex revHash of the cited base revision,
// or the empty string for null. len(x) is the 8-byte big-endian byte
// length of x. The output is lowercase hex.
import { createHash } from 'node:crypto'
import { nfc } from './canonical.js'

function len8(n) {
  const b = Buffer.alloc(8)
  b.writeBigUInt64BE(BigInt(n))
  return b
}

export function revHash(base, text) {
  const baseStr = base == null ? '' : String(base).toLowerCase()
  if (baseStr !== '' && !/^[0-9a-f]{64}$/.test(baseStr)) {
    throw new TypeError('base must be a 64-char lowercase-hex revHash or null')
  }
  const baseBytes = Buffer.from(baseStr, 'ascii')
  const textBytes = Buffer.from(nfc(String(text)), 'utf8')
  const h = createHash('sha256')
  h.update(len8(baseBytes.length))
  h.update(baseBytes)
  h.update(len8(textBytes.length))
  h.update(textBytes)
  return h.digest('hex')
}

/** SHA-256 hex of raw op bytes. */
export function rawHashHex(buf) {
  return createHash('sha256').update(buf).digest('hex')
}
