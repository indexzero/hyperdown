// Fault-proxy hub: every replication byte between two writer processes
// passes through here (assignment §1 "fault proxy"). Writer processes dial
// the hub over local TCP, identify themselves with one JSON header line
// ({ link, side }), and the hub pairs side 0 with side 1 of the same link
// through two independent FaultDirection pipes (one per direction), each
// supporting seeded fixed latency, jitter, probabilistic byte-stalls, a
// byte-budget kill (kill-mid-frame), and hard cut (partition).
//
// All stochastic decisions come from a per-direction child of the run's
// seeded RNG; every fault decision is appended to the run log, so a run is
// replayable from its seed.
import net from 'node:net'

class FaultDirection {
  /**
   * @param from source socket   @param to destination socket
   * @param profile { latencyMs, jitterMs, stallP, stallMs }
   * @param rng seeded Rng child unique to this direction
   * @param log (line) => void
   */
  constructor(name, from, to, profile, rng, log) {
    this.name = name
    this.from = from
    this.to = to
    this.profile = profile
    this.rng = rng
    this.log = log
    this.killAfterBytes = Infinity
    this.bytes = 0
    this._queue = [] // ordered { at, chunk }
    this._timer = null
    this._lastAt = 0 // absolute-time delivery watermark (monotonic)
    this._destroyed = false

    from.on('data', (chunk) => this._enqueue(chunk))
    from.on('error', () => {})
    from.on('close', () => this.destroy('peer-close'))
  }

  _enqueue(chunk) {
    if (this._destroyed) return
    const p = this.profile
    let delay = 0
    if (p.latencyMs || p.jitterMs) {
      delay = p.latencyMs + Math.round((this.rng.next() * 2 - 1) * p.jitterMs)
      if (delay < 0) delay = 0
    }
    if (p.stallP && this.rng.chance(p.stallP)) {
      delay += p.stallMs
      this.log(`${this.name} stall +${p.stallMs}ms (chunk ${chunk.length}B)`)
    }
    // Absolute-time watermark scheduling: latency is per-chunk but PIPELINED
    // (real links do not serialize latency), so a burst of N chunks is
    // spread by jitter around one delay, not compounded into N*delay of
    // backlog. Delivery order is preserved because `at` is monotonic.
    const now = Date.now()
    const at = Math.max(now + delay, this._lastAt)
    this._lastAt = at
    this._queue.push({ at, chunk })
    this._schedule()
  }

  _schedule() {
    if (this._timer || this._destroyed || this._queue.length === 0) return
    const wait = Math.max(0, this._queue[0].at - Date.now())
    this._timer = setTimeout(() => {
      this._timer = null
      this._drain()
    }, wait)
  }

  _drain() {
    if (this._destroyed) return
    const now = Date.now()
    while (this._queue.length && this._queue[0].at <= now) {
      const { chunk } = this._queue.shift()
      let out = chunk
      if (this.bytes + chunk.length > this.killAfterBytes) {
        out = chunk.subarray(0, Math.max(0, this.killAfterBytes - this.bytes))
        if (out.length > 0 && !this.to.destroyed) this.to.write(out)
        this.log(`${this.name} kill-mid-frame after ${this.bytes + out.length}B`)
        this.destroy('kill-mid-frame')
        return
      }
      this.bytes += chunk.length
      if (!this.to.destroyed) {
        const ok = this.to.write(out)
        if (!ok) {
          // destination backpressure: pause the source until it drains
          this.from.pause()
          this.to.once('drain', () => {
            if (!this._destroyed) this.from.resume()
          })
        }
      }
    }
    this._schedule()
  }

  destroy(reason) {
    if (this._destroyed) return
    this._destroyed = true
    if (this._timer) clearTimeout(this._timer)
    this._timer = null
    this._queue = []
    this.log(`${this.name} destroyed (${reason})`)
    this.from.destroy()
    this.to.destroy()
  }
}

// A header is one JSON object: { link: <string>, side: 0 or 1 }. Return
// { link, side }, or { error } with the reason that the header is bad.
function parseHeader(bytes) {
  let header
  try {
    header = JSON.parse(bytes.toString())
  } catch {
    return { error: 'the header is not JSON' }
  }
  if (header === null || typeof header !== 'object' || Array.isArray(header)) {
    return { error: 'the header is not an object' }
  }
  if (typeof header.link !== 'string') return { error: 'the header has no string link' }
  if (header.side !== 0 && header.side !== 1) return { error: 'the header side is not 0 or 1' }
  return { link: header.link, side: header.side }
}

export class FaultHub {
  /**
   * @param rng run Rng (children are derived per link direction)
   * @param defaultProfile applied to every link unless overridden
   * @param log (line) => void
   * @param opts.headerTimeoutMs a connection that sends no header line
   *   within this time is destroyed. Default 10000 ms.
   * @param opts.headerMaxBytes a header line longer than this, with or
   *   without its newline, is destroyed. Default 1024 bytes.
   */
  constructor(rng, defaultProfile, log = () => {}, { headerTimeoutMs = 10000, headerMaxBytes = 1024 } = {}) {
    this.rng = rng
    this.defaultProfile = defaultProfile
    this.log = log
    this.headerTimeoutMs = headerTimeoutMs
    this.headerMaxBytes = headerMaxBytes
    this.conns = new Set() // every accepted socket, from accept to close
    this.pending = new Map() // linkId -> { side, socket, chunks, detach }
    this.links = new Map() // linkId -> { a2b, b2a, sockets, epoch }
    this.profiles = new Map() // linkId -> profile override
    this.epochs = new Map() // linkId -> connection epoch counter
    this.server = net.createServer((socket) => this._onConnection(socket))
  }

  async listen() {
    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', resolve)
    })
    this.port = this.server.address().port
    return this.port
  }

  setLinkProfile(linkId, profile) {
    this.profiles.set(linkId, profile)
  }

  // The header phase lasts from accept until the header line arrives. It
  // has a deadline and a size limit. A connection that misses either, or
  // sends a bad header, ends alone: the hub logs it and destroys only that
  // socket. `conns` holds every socket until it closes, so close() finds
  // a socket in any phase.
  _onConnection(socket) {
    socket.setNoDelay(true)
    socket.on('error', () => {})
    this.conns.add(socket)
    socket.once('close', () => this.conns.delete(socket))
    const who = `${socket.remoteAddress}:${socket.remotePort}`
    let buf = Buffer.alloc(0)
    let timer = null
    const stop = () => {
      clearTimeout(timer)
      socket.off('data', onData)
      socket.off('close', stop)
    }
    const reject = (reason) => {
      stop()
      this.log(`connection ${who} rejected: ${reason}`)
      socket.destroy()
    }
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk])
      const nl = buf.indexOf(0x0a)
      if ((nl === -1 ? buf.length : nl) > this.headerMaxBytes) {
        reject(`the header is over ${this.headerMaxBytes} bytes`)
        return
      }
      if (nl === -1) return
      stop()
      const header = parseHeader(buf.subarray(0, nl))
      if (header.error) {
        reject(header.error)
        return
      }
      this._register(header.link, header.side, socket, buf.subarray(nl + 1))
    }
    socket.on('data', onData)
    socket.once('close', stop)
    timer = setTimeout(() => reject(`no header line within ${this.headerTimeoutMs}ms`), this.headerTimeoutMs)
  }

  // The newest registration of a link id wins. If the link is paired, the
  // hub destroys the old pair first, so no byte of it passes a later cut().
  // Two sockets that claim one side never pair: the hub destroys the older
  // one, and the newer one waits. A client dials again because it takes
  // its old socket to be dead. The hub can see that close late, or never
  // for a half-dead socket. If the older socket won, it could block the
  // link until then.
  _register(link, side, socket, rest) {
    if (this.links.has(link)) this.cut(link, 're-register')
    let other = this.pending.get(link)
    if (other && other.side === side) {
      this.pending.delete(link)
      other.detach()
      this.log(`link ${link} side ${side} registered again: the older socket is destroyed`)
      other.socket.destroy()
      other = null
    }
    if (!other) {
      this._wait(link, side, socket, rest)
      return
    }
    this.pending.delete(link)
    other.detach()
    const [s0, q0, s1, q1] =
      side === 1
        ? [other.socket, other.chunks, socket, [rest]]
        : [socket, [rest], other.socket, other.chunks]
    const epoch = (this.epochs.get(link) || 0) + 1
    this.epochs.set(link, epoch)
    const profile = this.profiles.get(link) || this.defaultProfile
    const rngA = this.rng.child(`${link}#${epoch}:a2b`)
    const rngB = this.rng.child(`${link}#${epoch}:b2a`)
    const a2b = new FaultDirection(`${link}#${epoch} 0->1`, s0, s1, profile, rngA, this.log)
    const b2a = new FaultDirection(`${link}#${epoch} 1->0`, s1, s0, profile, rngB, this.log)
    const entry = { a2b, b2a, sockets: [s0, s1], epoch }
    this.links.set(link, entry)
    this.log(`link ${link}#${epoch} paired (profile ${profile.name})`)
    // The bytes glued to each header are real replication bytes. They go
    // first, then the bytes the pending socket buffered while it waited, in
    // order. Later bytes reach the 'data' listener of each FaultDirection.
    for (const chunk of q0) if (chunk.length) a2b._enqueue(chunk)
    for (const chunk of q1) if (chunk.length) b2a._enqueue(chunk)
  }

  // An unpaired socket waits in `pending`, and a 'data' listener buffers
  // what it reads until its partner arrives. The listener keeps the bytes:
  // a flowing socket with no listener drops them, and a replication
  // initiator sends its first handshake message at once, so the link would
  // pair dead. The listener also keeps the socket flowing: a paused socket
  // defers 'end', so after a FIN it would never close and would stay
  // pending, and the next socket for the link would pair with it.
  _wait(link, side, socket, rest) {
    const entry = { side, socket, chunks: [rest], detach: null }
    const onData = (chunk) => entry.chunks.push(chunk)
    const onGone = () => {
      entry.detach()
      entry.chunks = []
      if (this.pending.get(link) === entry) this.pending.delete(link)
    }
    entry.detach = () => {
      socket.off('data', onData)
      socket.off('end', onGone)
      socket.off('close', onGone)
    }
    socket.on('data', onData)
    socket.once('end', onGone)
    socket.once('close', onGone)
    this.pending.set(link, entry)
  }

  /** Hard partition: sever both directions of a link. */
  cut(linkId, reason = 'cut') {
    const entry = this.links.get(linkId)
    if (!entry) return false
    entry.a2b.destroy(reason)
    entry.b2a.destroy(reason)
    this.links.delete(linkId)
    return true
  }

  /** Sever after N more bytes in the 0->1 direction (kill-mid-frame). */
  killAfter(linkId, bytes) {
    const entry = this.links.get(linkId)
    if (!entry) return false
    entry.a2b.killAfterBytes = entry.a2b.bytes + bytes
    return true
  }

  async close() {
    for (const linkId of [...this.links.keys()]) this.cut(linkId, 'hub-close')
    // This also destroys each pending socket, and each socket that has not
    // sent its header line yet. Otherwise server.close() waits for them.
    for (const socket of [...this.conns]) socket.destroy()
    this.pending.clear()
    await new Promise((r) => this.server.close(r))
  }
}
