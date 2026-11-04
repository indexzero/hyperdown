import { setupVaultCluster } from '../lib/setup.js'
import { checkCoherence } from '../lib/coherence.js'

export { setupVaultCluster, checkCoherence }

/** Keys under a flag family, from a writer's full dump. */
export function flagKeys(dump, family) {
  const prefix = `flag/${family}/`
  return Object.keys(dump).filter((k) => k.startsWith(prefix)).sort()
}

/** Throws if the dump of any writer is not coherent on its own (I8). */
export async function assertAllCoherent(writers) {
  for (const w of writers) {
    const dump = await w.dump('')
    const v = checkCoherence(dump)
    if (v.length) throw new Error(`${w.name} incoherent: ${v.slice(0, 8).join('; ')}`)
  }
}

/**
 * Clones the converged universe into fresh processes, connects the clones
 * in reverse writer order, and returns their view hash. If it equals the
 * original hash, the view depends on the linearized log alone, not on
 * replication timing (I1, I2).
 */
export async function replayHash(ctl, writers, label = 'replay') {
  const clones = await ctl.cloneUniverse(writers, label)
  await ctl.connectAll([...clones].reverse())
  return ctl.quiesce(clones)
}
