// Fault profiles (assignment §2): every scenario runs at three profiles.
// - clean:       0ms, no faults
// - lossy:       200ms latency ± 150ms jitter, 5% per-chunk stalls
// - partitioned: clean links, but scenarios write during an explicit
//                partition and heal after (the partition schedule is the
//                scenario's, not the link's)
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
