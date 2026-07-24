// Full-range-scan view hash — the I2 convergence / I3 rebuild-equality
// check at store level (okf SPEC §11). Byte construction matches
// @auto-okf/core's MemView.hash() exactly (key, 0x00, raw stored value
// bytes, '\n'), so a view folded over a real autobee hashes identically to
// the same linearized sequence folded over MemView in the unit suite.
import { createHash } from 'node:crypto'

/**
 * Hash a full range scan of any view exposing
 * `createReadStream() -> async iterable of { key, value }` where value is
 * the raw stored string (ViewAdapter over an autobee view, or core's
 * MemView — both yield the stableStringify bytes apply wrote).
 */
export async function viewHash(view) {
  const h = createHash('sha256')
  for await (const { key, value } of view.createReadStream({})) {
    h.update(key)
    h.update('\x00')
    h.update(typeof value === 'string' ? value : String(value))
    h.update('\n')
  }
  return h.digest('hex')
}
