// Copied from vault-ld/core/lib/revhash.js at 046d37f; diverges freely —
// see okf/SPEC.md §0 copy-don't-depend. okf SPEC §5 describes len() as
// u32 LE; per §5 "on discrepancy the copied code wins", the copied 8-byte
// big-endian length prefix below is normative (recorded in DEVIATIONS.md).
// Body revision hash construction (SPEC-FINAL §6), fixed for interoperability:
//
//   revHash = SHA-256( len(base) || base || len(text) || utf8(NFC(text)) )
//
// where `base` is the 64-char lowercase-hex revHash of the cited base
// revision or the empty string for null, and len(x) is the 8-byte big-endian
// byte length of x. Output is hex, lowercase.
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

/** SHA-256 hex of raw op bytes, for flag/rejected rawHashHex (§8.4). */
export function rawHashHex(buf) {
  return createHash('sha256').update(buf).digest('hex')
}
