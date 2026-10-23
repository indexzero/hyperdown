// The autobee@1 substrate for the release-seam tests: autobee@1.0.10 with
// corestore 7.11.0, the pair the last autobee@1 release of okf ran. Both are
// loaded through vault-ld/store's own dependencies (vault-ld stays on
// autobee@1), so no okf package depends on them. When vault-ld moves off
// autobee@1, these tests need another source for it.
//
// BundleOnAutobee1 is this release's Bundle with that substrate swapped in
// (Bundle.Autobee / Bundle.Corestore) and without the flag-day check or the
// marker, as in the old release. For the non-optimistic ops these tests
// write, it lays out the store exactly as the old release did; it differs
// only in optimistic handling (it makes no host.ackWriter call).
import { createRequire } from 'node:module'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Bundle } from '../store/index.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const requireV1 = createRequire(join(ROOT, 'vault-ld', 'store', 'package.json'))

export const AutobeeV1 = requireV1('autobee')
export const CorestoreV1 = requireV1('corestore')

export class BundleOnAutobee1 extends Bundle {
  static Autobee = AutobeeV1
  static Corestore = CorestoreV1
  static substrate = 'autobee@1'
}
