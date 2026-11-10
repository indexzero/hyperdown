// Builds linearized node streams and drives createApply against MemView.
// No substrate, no I/O.
import { createHash } from 'node:crypto'
import {
  createApply,
  encodeOp,
  keyspace,
  MemView,
  makeTag
} from '../index.js'

/** Deterministic 32-byte writer key from a name. */
export function writerKey(name) {
  return createHash('sha256').update('okf-test-writer:' + name).digest()
}

export function hostStub() {
  const calls = []
  return {
    calls,
    async addWriter(key, opts) {
      calls.push(['addWriter', key.toString('hex'), opts])
    },
    async ackWriter(key) {
      calls.push(['ackWriter', key.toString('hex')])
    },
    async removeWriter(key) {
      calls.push(['removeWriter', key.toString('hex')])
    }
  }
}

/**
 * Each `op()` appends one node for a writer, at the writer's next seq. The
 * clock holds the writer's own [key, seq] entry and, by default, the latest
 * seq of every other writer built so far. Pass `opts.clock` as [writerHex,
 * seq] pairs to model a partition. The self entry is added unless present.
 */
export class Env {
  constructor({ genesis = 'A', config = {} } = {}) {
    this.genesisKey = Buffer.isBuffer(genesis) ? genesis : writerKey(genesis)
    this.apply = createApply({ genesisKey: this.genesisKey, ...config })
    this.nodes = []
    this.seqs = new Map()
    this.atCounter = 1700000000000
  }

  key(w) {
    return Buffer.isBuffer(w) ? w : writerKey(w)
  }

  hex(w) {
    return this.key(w).toString('hex')
  }

  tag(w, seq) {
    return makeTag(this.hex(w), seq)
  }

  observedAll() {
    const out = []
    for (const [W, next] of this.seqs) {
      if (next > 0) out.push([W, next - 1])
    }
    return out
  }

  op(w, type, payload = {}, opts = {}) {
    const key = this.key(w)
    const W = key.toString('hex')
    const seq = this.seqs.get(W) ?? 0
    let clock
    if (opts.verbatimClock) {
      clock = opts.clock // forged-clock tests pass the exact clock
    } else {
      clock = (opts.clock ? [...opts.clock] : this.observedAll()).filter(([k]) => k !== W)
      clock.push([W, seq]) // the self entry must equal the seq (SPEC §8)
    }
    this.seqs.set(W, seq + 1)
    const at = payload.at ?? this.atCounter++
    const value = encodeOp(type, { ...payload, clock, at })
    const node = { key, value, length: seq + 1, optimistic: false, seq }
    this.nodes.push(node)
    return node
  }

  /** Appends a node with raw bytes, for garbage and oversize cases. */
  raw(w, bytes) {
    const key = this.key(w)
    const W = key.toString('hex')
    const seq = this.seqs.get(W) ?? 0
    this.seqs.set(W, seq + 1)
    const node = { key, value: bytes, length: seq + 1, optimistic: false, seq }
    this.nodes.push(node)
    return node
  }

  /** Applies the nodes, by default every node built, into a fresh MemView. A `chunk` above 0 applies them in slices of that size. */
  async run(nodes = this.nodes, { view = new MemView(), host = null, chunk = 0 } = {}) {
    if (chunk > 0) {
      for (let i = 0; i < nodes.length; i += chunk) {
        await this.apply(nodes.slice(i, i + chunk), view, host)
      }
    } else {
      await this.apply(nodes, view, host)
    }
    return view
  }
}

/** All view keys under a prefix (from a MemView). */
export function keysUnder(view, prefix) {
  return Object.keys(view.dump(prefix))
}

/** The flag/rejected reasons, keyed by writer/seq. */
export function rejectedReasons(view) {
  const out = {}
  for (const [k, v] of Object.entries(view.dump('flag/rejected/'))) {
    out[k.slice('flag/rejected/'.length)] = v.reason
  }
  return out
}

/** The rejectedReasons() key of writer W's op at seq. */
export const rk = (W, seq) => keyspace.flagRejected(W, seq).slice('flag/rejected/'.length)

/** Skip `n` positions of writer `w` in an Env, as empty blocks would. */
export function gap(env, w, n = 1) {
  const W = env.hex(w)
  env.seqs.set(W, (env.seqs.get(W) ?? 0) + n)
}
