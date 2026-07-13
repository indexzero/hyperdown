// Shared unit-test harness for the @auto-okf/core invariant suite: builds
// linearized node streams (with spec-correct clocks) and drives createApply
// against MemView directly — no substrate, no I/O, fully deterministic.
import { createHash } from 'node:crypto'
import {
  createApply,
  encodeOp,
  MemView,
  makeTag
} from '../core/index.js'

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
 * Node-stream builder. Each `op()` call appends one node for a writer,
 * assigning the writer's next seq and an auto-built vector clock (§3):
 * the clock includes the writer's own [key, seq] entry (the §8
 * forged-clock rule) plus, by default, every other writer's latest seq
 * built so far ("observed everything"). Pass `opts.clock` (array of
 * [writerHex, seq]) to model concurrency/partitions explicitly — the
 * self entry is appended automatically unless already present.
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

  /** The tag/mint-id a writer op got: makeTag(writer, seq). */
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
      clock = opts.clock // forged-clock tests: use exactly what was given
    } else {
      clock = (opts.clock ? [...opts.clock] : this.observedAll()).filter(([k]) => k !== W)
      clock.push([W, seq]) // §8: self entry must equal the actual seq
    }
    this.seqs.set(W, seq + 1)
    const at = payload.at ?? this.atCounter++
    const value = encodeOp(type, { ...payload, clock, at })
    const node = { key, value, length: seq + 1, optimistic: false, seq }
    this.nodes.push(node)
    return node
  }

  /** Append a raw (garbage / oversize) node. */
  raw(w, bytes) {
    const key = this.key(w)
    const W = key.toString('hex')
    const seq = this.seqs.get(W) ?? 0
    this.seqs.set(W, seq + 1)
    const node = { key, value: bytes, length: seq + 1, optimistic: false, seq }
    this.nodes.push(node)
    return node
  }

  /** Apply nodes (default: everything built) into a fresh MemView. */
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

/** Convenience: the flag/rejected reasons keyed by writer/seq. */
export function rejectedReasons(view) {
  const out = {}
  for (const [k, v] of Object.entries(view.dump('flag/rejected/'))) {
    out[k.slice('flag/rejected/'.length)] = v.reason
  }
  return out
}
