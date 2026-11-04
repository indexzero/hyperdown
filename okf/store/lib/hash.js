// The view hash of SPEC §11 at store level: I2 convergence and I3 rebuild
// equality.
import { createHash } from 'node:crypto'

/**
 * Hash a full range scan of a view whose `createReadStream()` yields
 * `{ key, value }` with value the raw stored string: ViewAdapter or
 * MemView. The bytes must match MemView.hash() of @auto-okf/core (key,
 * 0x00, value, '\n'), so a view folded over autobee hashes the same as the
 * same linearized sequence folded over MemView.
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
