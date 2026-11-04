// Fault profiles. Every scenario runs at all three. `partitioned` has
// clean links: the scenario, not the link, schedules the partition and
// the heal.
export const PROFILES = {
  clean: {
    name: 'clean',
    latencyMs: 0,
    jitterMs: 0,
    stallP: 0,
    stallMs: 0
  },
  lossy: {
    name: 'lossy',
    latencyMs: 200,
    jitterMs: 150,
    stallP: 0.05,
    stallMs: 1000
  },
  partitioned: {
    name: 'partitioned',
    latencyMs: 0,
    jitterMs: 0,
    stallP: 0,
    stallMs: 0
  }
}

export function resolveProfile() {
  const name = process.env.HARNESS_PROFILE || 'clean'
  const p = PROFILES[name]
  if (!p) throw new Error(`unknown HARNESS_PROFILE: ${name}`)
  return p
}

/** Convergence budget scales with the profile's injected delay. */
export function quiesceTimeout(profile, base = 30000) {
  if (profile.name === 'lossy') return base * 4
  return base
}
