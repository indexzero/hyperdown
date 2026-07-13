// Full-range-scan view hash — the I2 convergence / I3 rebuild-equality
// check at store level (SPEC-FINAL §12). Byte construction matches
// @hyperwiki/core's MemView.hash() (key, 0x00, JSON value, '\n') so a view
// folded over a real autobee hashes identically to the same linearized
// sequence folded over MemView in the unit suite.
import { createHash } from 'node:crypto'

/**
 * Hash a full range scan of any view exposing
 * `createReadStream() -> async iterable of { key, value }`
 * (ViewAdapter over an autobee view, or core's MemView).
 */
export async function viewHash(view) {
  const h = createHash('sha256')
  for await (const { key, value } of view.createReadStream({})) {
    h.update(key)
    h.update('\x00')
    h.update(JSON.stringify(value === undefined ? null : value))
    h.update('\n')
  }
  return h.digest('hex')
}
