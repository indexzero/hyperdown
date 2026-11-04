// Every replication byte between two writers passes through the hub over
// local TCP. A writer sends one JSON header line, { link, side }. The hub
// pairs side 0 with side 1 of one link through two FaultDirection pipes.
//
// Every random decision comes from the run's RNG and goes to the run log,
// so a run replays from its seed.
import net from 'node:net'

class FaultDirection {
  /**
   * @param from the source socket
   * @param to the destination socket
   * @param profile { latencyMs, jitterMs, stallP, stallMs }
   * @param rng a seeded Rng child unique to this direction
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
    this._lastAt = 0 // the delivery time of the last queued chunk, never decreases
    this._destroyed = false
    this._ending = false // the source sent its FIN
    this._ended = false // the queue drained after the FIN, and `to` got its FIN

    from.on('data', (chunk) => this._enqueue(chunk))
    from.on('error', () => {})
    // A FIN from the source closes this direction only. The queued bytes
    // still go out, then the destination gets a FIN. The sockets are
    // half-open, so the other direction still drains into the source. A
    // close with no FIN first (a reset, an error or a destroy) drops the
    // queue at once, as cut() and kill-mid-frame do.
    from.once('end', () => {
      this._ending = true
      this._endIfDrained()
    })
    from.on('close', () => {
      if (!this._ending) this.destroy('peer-close')
    })
    // A paused source hides its FIN, and a closed `to` never emits 'drain'.
    // So the source stays paused and never closes. Resume it so that its
    // FIN can arrive.
    to.on('close', () => {
      if (!this._destroyed) from.resume()
    })
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
    // Latency is per chunk but pipelined, as on a real link. A burst of N
    // chunks spreads around one delay, not N delays. `at` never decreases,
    // so the delivery order holds.
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
        if (out.length > 0 && this.to.writable) this.to.write(out)
        this.log(`${this.name} kill-mid-frame after ${this.bytes + out.length}B`)
        this.destroy('kill-mid-frame')
        return
      }
      this.bytes += chunk.length
      if (this.to.writable) {
        const ok = this.to.write(out)
        if (!ok && !this.from.isPaused()) {
          // Pause the source until `to` drains. One 'drain' event resumes
          // it, so register one listener, not one per write.
          this.from.pause()
          this.to.once('drain', () => {
            if (!this._destroyed) this.from.resume()
          })
        }
      }
    }
    this._endIfDrained()
    this._schedule()
  }

  _endIfDrained() {
    if (!this._ending || this._ended || this._destroyed || this._queue.length) return
    this._ended = true
    this.log(`${this.name} ended (peer-end)`)
    if (this.to.writable) this.to.end()
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

// Returns { link, side }, or { error } with the reason that the header is bad.
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
   * @param rng the run Rng. The hub derives one child per link direction.
   * @param defaultProfile the profile of every link without an override
   * @param log (line) => void
   * @param opts.headerTimeoutMs the hub destroys a connection that sends no
   *   header line within this time. Default 10000 ms.
   * @param opts.headerMaxBytes the hub destroys a connection whose header
   *   line is longer than this, with or without its newline. Default 1024.
   * @param opts.pendingTimeoutMs the hub destroys a socket that has no
   *   partner within this time after its header line. Default 30000 ms.
   * @param opts.pendingMaxBytes the hub destroys a waiting socket that
   *   buffers more than this after its header line. Default 1048576.
   */
  constructor(
    rng,
    defaultProfile,
    log = () => {},
    { headerTimeoutMs = 10000, headerMaxBytes = 1024, pendingTimeoutMs = 30000, pendingMaxBytes = 1048576 } = {}
  ) {
    this.rng = rng
    this.defaultProfile = defaultProfile
    this.log = log
    this.headerTimeoutMs = headerTimeoutMs
    this.headerMaxBytes = headerMaxBytes
    this.pendingTimeoutMs = pendingTimeoutMs
    this.pendingMaxBytes = pendingMaxBytes
    this.conns = new Set() // every accepted socket, from accept to close
    this.pending = new Map() // linkId -> { side, socket, chunks, bytes, detach }
    this.links = new Map() // linkId -> { a2b, b2a, sockets, epoch }
    this.profiles = new Map() // linkId -> profile override
    this.epochs = new Map() // linkId -> connection epoch counter
    // Half-open: a FIN from a client does not end the hub's writes to it.
    // FaultDirection, _onConnection and _wait each end their socket after
    // its FIN.
    this.server = net.createServer({ allowHalfOpen: true }, (socket) => this._onConnection(socket))
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

  // The header phase runs from accept to the header line, under a deadline
  // and a size limit. A connection that misses either, or sends a bad
  // header, dies alone: the hub destroys only that socket. `conns` holds
  // every socket until it closes, so close() finds a socket in any phase.
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
      socket.off('end', onEnd)
      socket.off('close', stop)
    }
    const onEnd = () => {
      stop()
      socket.end()
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
    socket.once('end', onEnd)
    socket.once('close', stop)
    timer = setTimeout(() => reject(`no header line within ${this.headerTimeoutMs}ms`), this.headerTimeoutMs)
  }

  // The newest registration of a link wins. An old pair dies first, so a
  // later cut() misses no byte of it. Two sockets on one side never pair:
  // the hub destroys the older one. A client dials again when it takes its
  // old socket to be dead, and the hub can see that close late or never.
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
    // The bytes after each header line are replication bytes. They go
    // first, then the bytes that the pending socket buffered, in order.
    for (const chunk of q0) if (chunk.length) a2b._enqueue(chunk)
    for (const chunk of q1) if (chunk.length) b2a._enqueue(chunk)
  }

  // An unpaired socket waits in `pending`. A 'data' listener buffers its
  // bytes: a flowing socket with no listener drops them, and a replication
  // initiator sends its handshake at once, so the link pairs dead.
  _wait(link, side, socket, rest) {
    const entry = { side, socket, chunks: [], bytes: 0, detach: null }
    const onGone = () => {
      entry.detach()
      entry.chunks = []
      if (this.pending.get(link) === entry) this.pending.delete(link)
    }
    const drop = (reason) => {
      onGone()
      this.log(`link ${link} side ${side} destroyed while pending: ${reason}`)
      socket.destroy()
    }
    // Never pause a pending socket to limit its buffer. A paused socket
    // defers 'end', so it never closes, stays pending, and pairs with the
    // next socket of the link. Destroy it over the limit instead.
    const onData = (chunk) => {
      entry.chunks.push(chunk)
      entry.bytes += chunk.length
      if (entry.bytes > this.pendingMaxBytes) drop(`it buffered more than ${this.pendingMaxBytes} bytes`)
    }
    const onEnd = () => {
      onGone()
      socket.end()
    }
    const timer = setTimeout(() => drop(`no partner within ${this.pendingTimeoutMs}ms`), this.pendingTimeoutMs)
    entry.detach = () => {
      clearTimeout(timer)
      socket.off('data', onData)
      socket.off('end', onEnd)
      socket.off('close', onGone)
    }
    socket.on('data', onData)
    socket.once('end', onEnd)
    socket.once('close', onGone)
    this.pending.set(link, entry)
    onData(rest)
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
    // This destroys pending sockets and sockets with no header line too.
    // Otherwise server.close() waits for them.
    for (const socket of [...this.conns]) socket.destroy()
    for (const entry of this.pending.values()) entry.detach()
    this.pending.clear()
    await new Promise((r) => this.server.close(r))
  }
}
