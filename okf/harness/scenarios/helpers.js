// Shared scenario helpers: cluster bring-up, flag introspection, and
// permutation replay (same linearized log -> same view hash, verified by
// cloning the universe into fresh processes and re-converging).
import { setupVaultCluster } from '../lib/setup.js'
import { checkCoherence } from '../lib/coherence.js'

export { setupVaultCluster, checkCoherence }

/** Keys under a flag family, from a writer's full dump. */
export function flagKeys(dump, family) {
  const prefix = `flag/${family}/`
  return Object.keys(dump).filter((k) => k.startsWith(prefix)).sort()
}

/** Every writer's dump must be independently coherent (I8). */
export async function assertAllCoherent(writers) {
  for (const w of writers) {
    const dump = await w.dump('')
    const v = checkCoherence(dump)
    if (v.length) throw new Error(`${w.name} incoherent: ${v.slice(0, 8).join('; ')}`)
  }
}

/**
 * Permutation replay: clone the converged universe into fresh processes,
 * re-connect the clones in REVERSE writer order, converge, and return the
 * clone's view hash. Equal to the original hash ⇒ the view is a pure
 * function of the linearized log, not of physical replication timing (I1/I2).
 */
export async function replayHash(ctl, writers, label = 'replay') {
  const clones = await ctl.cloneUniverse(writers, label)
  await ctl.connectAll([...clones].reverse())
  return ctl.quiesce(clones)
}
