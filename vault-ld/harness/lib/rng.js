// Seeded PRNG (mulberry32) — every stochastic decision in the harness
// (fault schedules, fuzz op generation, permutation orders) flows through
// one of these, so a run is replayable from its logged seed.

export function mulberry32(seed) {
  let a = seed >>> 0
  return function next() {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export class Rng {
  constructor(seed) {
    this.seed = seed >>> 0
    this._next = mulberry32(this.seed)
  }

  /** float in [0, 1) */
  next() {
    return this._next()
  }

  /** integer in [0, n) */
  int(n) {
    return Math.floor(this._next() * n)
  }

  /** integer in [lo, hi] inclusive */
  between(lo, hi) {
    return lo + this.int(hi - lo + 1)
  }

  /** true with probability p */
  chance(p) {
    return this._next() < p
  }

  pick(arr) {
    return arr[this.int(arr.length)]
  }

  /** Fisher-Yates shuffle (copy). */
  shuffle(arr) {
    const out = arr.slice()
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(i + 1)
      ;[out[i], out[j]] = [out[j], out[i]]
    }
    return out
  }

  /** Derive an independent child stream (e.g. one per proxy direction). */
  child(label) {
    let h = 2166136261
    for (const c of String(label)) {
      h ^= c.charCodeAt(0)
      h = Math.imul(h, 16777619)
    }
    return new Rng((this.seed ^ h) >>> 0)
  }
}

/** Seed from env (HARNESS_SEED) or the clock; always log it. */
export function resolveSeed() {
  const env = process.env.HARNESS_SEED
  if (env !== undefined && env !== '') return Number(env) >>> 0
  return (Date.now() ^ (process.pid << 16)) >>> 0
}
