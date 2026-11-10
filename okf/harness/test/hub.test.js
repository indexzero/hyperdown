// The fault hub alone, without writer processes. The first socket of a
// link waits in `pending` until its partner connects. The hub must keep
// every byte sent while it waits, and deliver it in order. The initiator
// of a replication stream sends its Noise handshake at once, so a hub that
// drops those bytes leaves the link paired and dead.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { FaultHub } from '../lib/hub.js'
import { Rng } from '../lib/rng.js'

const CLEAN = { name: 'clean', latencyMs: 0, jitterMs: 0, stallP: 0, stallMs: 0 }
// Each chunk waits 1 s in the fault queue, so a test can act on the queue.
const LATENCY = { name: 'latency', latencyMs: 1000, jitterMs: 0, stallP: 0, stallMs: 0 }
const DEADLINE_MS = 5000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const header = (link, side) => JSON.stringify({ link, side }) + '\n'

// Polls until cond() is true, or returns false at the deadline. No step in
// this file depends on a fixed sleep, so a stall of the event loop only
// makes a test slower.
async function until(cond) {
  const deadline = Date.now() + DEADLINE_MS
  while (!cond()) {
    if (Date.now() > deadline) return false
    await sleep(5)
  }
  return true
}

async function waitFor(cond, what) {
  assert.ok(await until(cond), `timed out waiting for ${what}`)
}

// `accepted` holds the hub's end of each connection, so a test can wait
// until the hub reads what a client sent.
async function openHub({ profile = CLEAN, ...opts } = {}) {
  const logs = []
  const hub = new FaultHub(new Rng(1), profile, (line) => logs.push(line), opts)
  const port = await hub.listen()
  const accepted = []
  hub.server.on('connection', (socket) => accepted.push(socket))
  return { hub, port, accepted, logs, sockets: [] }
}

async function closeHub(fx) {
  for (const socket of fx.sockets) socket.destroy()
  await fx.hub.close()
}

async function connect(fx) {
  const socket = net.connect(fx.port, '127.0.0.1')
  socket.setNoDelay(true)
  socket.on('error', () => {})
  fx.sockets.push(socket)
  await new Promise((resolve) => socket.once('connect', resolve))
  let hubEnd
  await waitFor(
    () => (hubEnd = fx.accepted.find((s) => s.remotePort === socket.localPort)),
    'the hub to accept the connection'
  )
  const peer = { socket, hubEnd, sent: 0, got: '', gotAtEnd: null, closed: false }
  socket.on('data', (d) => {
    peer.got += d
  })
  socket.once('end', () => {
    peer.gotAtEnd = peer.got
  })
  socket.once('close', () => {
    peer.closed = true
  })
  return peer
}

async function pair(fx, link) {
  const epoch = (fx.hub.epochs.get(link) || 0) + 1
  const s0 = await connect(fx)
  await send(s0, header(link, 0))
  await waitFor(() => fx.hub.pending.get(link)?.socket === s0.hubEnd, `side 0 of ${link} to register`)
  const s1 = await connect(fx)
  await send(s1, header(link, 1))
  await waitFor(() => fx.hub.links.get(link)?.epoch === epoch, `${link}#${epoch} to pair`)
  return [s0, s1]
}

const rejections = (fx) => fx.logs.filter((line) => line.includes(' rejected: '))

// Waits until the hub reads the bytes, so no later step reaches the hub
// before these bytes do.
async function send(peer, bytes) {
  peer.socket.write(bytes)
  peer.sent += Buffer.byteLength(bytes)
  await waitFor(() => peer.hubEnd.bytesRead >= peer.sent, `the hub to read ${JSON.stringify(bytes)}`)
}

// The first side sends in all three phases: glued to its header, while it
// waits, and after the link pairs. The three must arrive as one stream.
async function pairLate(firstSide) {
  const fx = await openHub()
  try {
    const first = await connect(fx)
    await send(first, header('L', firstSide) + 'A')
    await waitFor(() => fx.hub.pending.get('L')?.side === firstSide, 'the first side to register')
    await send(first, 'B')
    await send(first, 'C')

    const second = await connect(fx)
    await send(second, header('L', 1 - firstSide) + 'x')
    await waitFor(() => fx.hub.links.has('L'), 'the link to pair')
    await send(first, 'D')
    await send(second, 'y')

    await until(() => second.got === 'ABCD' && first.got === 'xy')
    assert.equal(second.got, 'ABCD', 'what the second side got from the first')
    assert.equal(first.got, 'xy', 'what the first side got from the second')
  } finally {
    await closeHub(fx)
  }
}

test('side 0 first: the hub keeps the bytes it sends before its partner pairs', async () => {
  await pairLate(0)
})

test('side 1 first: the hub keeps the bytes it sends before its partner pairs', async () => {
  await pairLate(1)
})

// If the ended socket stays in `pending`, the next socket for the link
// pairs with a dead socket.
test('a FIN before pairing: the pending socket leaves pending and closes', async () => {
  const fx = await openHub()
  try {
    const first = await connect(fx)
    await send(first, header('L', 0))
    await waitFor(() => fx.hub.pending.get('L')?.side === 0, 'side 0 to register')
    await send(first, 'handshake')
    first.socket.end()

    await until(() => !fx.hub.pending.has('L') && first.hubEnd.destroyed)
    assert.equal(fx.hub.pending.has('L'), false, 'the ended socket is still pending')
    assert.equal(first.hubEnd.destroyed, true, 'the hub did not close its end')

    const second = await connect(fx)
    await send(second, header('L', 1))
    await waitFor(() => fx.hub.pending.get('L')?.side === 1, 'side 1 to register')
    assert.equal(fx.hub.links.has('L'), false, 'side 1 paired with the ended socket')
  } finally {
    await closeHub(fx)
  }
})

// The bytes glued to the header count toward the limit, and a buffer of
// exactly the limit waits. The hub destroys the socket over the limit
// instead of pausing it, because a paused socket hides its FIN.
test('pending limit: a pending socket that buffers more than the limit is destroyed and logged, and leaves pending', async () => {
  const fx = await openHub({ pendingMaxBytes: 64, pendingTimeoutMs: 60000 })
  try {
    const first = await connect(fx)
    await send(first, header('L', 0) + 'x'.repeat(16))
    await waitFor(() => fx.hub.pending.get('L')?.socket === first.hubEnd, 'side 0 to register')
    await send(first, 'y'.repeat(48))
    assert.equal(first.hubEnd.destroyed, false, 'the hub destroyed a buffer of exactly the limit')
    assert.equal(fx.hub.pending.get('L')?.socket, first.hubEnd, 'a buffer of exactly the limit left pending')

    await send(first, 'z')
    await waitFor(() => first.hubEnd.destroyed, 'the hub to destroy the socket over the limit')
    assert.equal(fx.hub.pending.has('L'), false, 'the socket over the limit is still pending')
    assert.ok(
      fx.logs.includes('link L side 0 destroyed while pending: it buffered more than 64 bytes'),
      'the hub did not log the socket over the limit'
    )
  } finally {
    await closeHub(fx)
  }
})

// The header deadline is longer than the wait, so the header deadline
// cannot be what closes the socket. The log line proves which one did.
test('pending deadline: a pending socket with no partner in time is destroyed and logged, and leaves pending', async () => {
  const fx = await openHub({ pendingTimeoutMs: 100, headerTimeoutMs: 60000 })
  try {
    const late = await connect(fx)
    await send(late, header('L', 0) + 'handshake')
    await waitFor(() => late.hubEnd.destroyed, 'the hub to destroy the socket with no partner')
    assert.equal(fx.hub.pending.has('L'), false, 'the socket with no partner is still pending')
    assert.ok(
      fx.logs.includes('link L side 0 destroyed while pending: no partner within 100ms'),
      'the hub did not log the socket with no partner'
    )
  } finally {
    await closeHub(fx)
  }
})

// Each chunk waits 1 s in the fault queue, longer than the pending
// deadline, so a delivery proves that the deadline left the paired link.
test('pending deadline: a socket that pairs in time outlives the deadline', async () => {
  const fx = await openHub({ profile: LATENCY, pendingTimeoutMs: 500 })
  try {
    const [a, b] = await pair(fx, 'L')
    await send(a, 'ping')
    await waitFor(() => b.got === 'ping', 'the paired link to deliver after the pending deadline')
    assert.equal(a.hubEnd.destroyed || b.hubEnd.destroyed, false, 'the pending deadline closed a paired socket')
    const dropped = fx.logs.filter((line) => line.includes('destroyed while pending'))
    assert.deepEqual(dropped, [], 'the hub logged a paired socket as pending')
  } finally {
    await closeHub(fx)
  }
})

// A header must be one JSON object with a string `link` and a `side` of 0
// or 1. A bad header must not throw out of a 'data' listener. A throw
// there takes the hub down, and the paired link with it.
test('bad headers: each destroys only its own socket, and the hub and its other links keep running', async () => {
  const fx = await openHub()
  try {
    const [a, b] = await pair(fx, 'L')
    const bad = [
      'not-json',
      'null',
      '[]',
      '"L"',
      '{"side":0}',
      '{"link":7,"side":0}',
      '{"link":"M","side":2}',
      '{"link":"M","side":"0"}'
    ]
    for (const line of bad) {
      const peer = await connect(fx)
      await send(peer, line + '\n')
      await waitFor(() => peer.hubEnd.destroyed, `the hub to destroy the socket that sent ${line}`)
    }
    assert.equal(fx.hub.pending.size, 0, 'a bad header registered')
    assert.equal(rejections(fx).length, bad.length, 'the hub did not log each bad header')

    await send(a, 'ping')
    await send(b, 'pong')
    await waitFor(() => b.got === 'ping' && a.got === 'pong', 'the paired link to deliver both ways')
  } finally {
    await closeHub(fx)
  }
})

// The two clients are a silent one and one that stops in the middle of
// its header.
test('header deadline: a client that sends no header line in time is destroyed and logged', async () => {
  const fx = await openHub({ headerTimeoutMs: 100 })
  try {
    const silent = await connect(fx)
    const partial = await connect(fx)
    await send(partial, '{"link":"L",')
    await waitFor(() => silent.hubEnd.destroyed && partial.hubEnd.destroyed, 'the hub to destroy both clients')
    const late = rejections(fx).filter((line) => line.endsWith(': no header line within 100ms'))
    assert.equal(late.length, 2, 'the hub did not log both clients')
  } finally {
    await closeHub(fx)
  }
})

// The two clients are a header with no newline and a complete header over
// the limit. Both must go at once, so an endless header cannot grow the
// hub's buffer.
test('header limit: a header over the limit is destroyed and logged, and a header at the limit registers', async () => {
  const fx = await openHub({ headerMaxBytes: 64, headerTimeoutMs: 60000 })
  try {
    const endless = await connect(fx)
    await send(endless, 'x'.repeat(65))
    const long = await connect(fx)
    await send(long, header('L'.repeat(64), 0))
    await waitFor(() => endless.hubEnd.destroyed && long.hubEnd.destroyed, 'the hub to destroy both clients')
    const over = rejections(fx).filter((line) => line.endsWith(': the header is over 64 bytes'))
    assert.equal(over.length, 2, 'the hub did not log both clients')

    const link = 'M'.repeat(64 - header('', 0).length + 1)
    assert.equal(Buffer.byteLength(header(link, 0)), 64 + 1)
    const exact = await connect(fx)
    await send(exact, header(link, 0))
    await waitFor(() => fx.hub.pending.get(link)?.socket === exact.hubEnd, 'a header of 64 bytes to register')
  } finally {
    await closeHub(fx)
  }
})

// If the hub tracks a connection only from its header line, close() waits
// for these clients for good. The header deadline is longer than the wait,
// so the deadline cannot be what closes them.
test('hub.close() returns while a connection has not sent its header line', async () => {
  const fx = await openHub({ headerTimeoutMs: 60000 })
  const silent = await connect(fx)
  const partial = await connect(fx)
  await send(partial, '{"link"')
  let closed = false
  const closing = fx.hub.close().then(() => {
    closed = true
  })
  try {
    await waitFor(() => closed, 'hub.close() to return')
    assert.equal(silent.hubEnd.destroyed, true, 'the silent client is still open')
    assert.equal(partial.hubEnd.destroyed, true, 'the partial client is still open')
  } finally {
    for (const socket of fx.sockets) socket.destroy()
    await closing
  }
})

// The hub's sockets are half-open, so the hub must end the socket itself.
// The header deadline is longer than the wait, so the deadline cannot be
// what closes this client.
test('a FIN before the header line: the hub closes the socket at once', async () => {
  const fx = await openHub({ headerTimeoutMs: 60000 })
  try {
    const partial = await connect(fx)
    await send(partial, '{"link":"L",')
    partial.socket.end()
    await waitFor(() => partial.hubEnd.destroyed, 'the hub to close its end')
    await waitFor(() => partial.closed, 'the client to close')
    assert.equal(fx.hub.pending.size, 0, 'a partial header registered')
  } finally {
    await closeHub(fx)
  }
})

// If the old pair outlives the new one, a byte from the old pair passes a
// later cut().
test('re-registration: a link id that registers again destroys its old pair first', async () => {
  const fx = await openHub()
  try {
    const [a1, b1] = await pair(fx, 'L')
    await pair(fx, 'L')
    assert.equal(fx.hub.cut('L', 'partition'), true)
    a1.socket.write('leak-through-partition')
    await until(() => b1.got !== '' || (a1.hubEnd.destroyed && b1.hubEnd.destroyed))
    assert.equal(b1.got, '', 'a byte from the first pair passed the cut')
    assert.equal(a1.hubEnd.destroyed, true, 'side 0 of the first pair is still open')
    assert.equal(b1.hubEnd.destroyed, true, 'side 1 of the first pair is still open')
    const destroyed = fx.logs.indexOf('L#1 0->1 destroyed (re-register)')
    assert.ok(destroyed !== -1, 'the hub did not log the end of the first pair')
    assert.ok(destroyed < fx.logs.indexOf('link L#2 paired (profile clean)'), 'the first pair ended after the second paired')
  } finally {
    await closeHub(fx)
  }
})

test('same side: two sockets that claim one side never pair, and the newer one wins', async () => {
  const fx = await openHub()
  try {
    const older = await connect(fx)
    await send(older, header('L', 0))
    await waitFor(() => fx.hub.pending.get('L')?.socket === older.hubEnd, 'the older side 0 to register')
    const newer = await connect(fx)
    await send(newer, header('L', 0))
    await until(() => fx.hub.links.has('L') || fx.hub.pending.get('L')?.socket === newer.hubEnd)
    assert.equal(fx.hub.links.has('L'), false, 'two sockets for side 0 paired')
    assert.equal(fx.hub.pending.get('L')?.socket, newer.hubEnd, 'the newer side 0 does not wait')
    await waitFor(() => older.hubEnd.destroyed, 'the hub to destroy the older side 0')

    const one = await connect(fx)
    await send(one, header('L', 1))
    await waitFor(() => fx.hub.links.has('L'), 'the newer side 0 and side 1 to pair')
    await send(newer, 'ping')
    await send(one, 'pong')
    await waitFor(() => one.got === 'ping' && newer.got === 'pong', 'the link to deliver both ways')
  } finally {
    await closeHub(fx)
  }
})

// The latency profile holds 'final' in the fault queue when the FIN
// arrives. The hub must drain that queue before it ends side 1.
test('graceful close: a latency-only link delivers its final payload after end()', async () => {
  const fx = await openHub({ profile: LATENCY })
  try {
    const [a, b] = await pair(fx, 'L')
    await send(a, 'final')
    a.socket.end()
    await waitFor(() => a.hubEnd.readableEnded, 'the hub to read the end of side 0')
    await waitFor(() => a.hubEnd.destroyed && b.hubEnd.destroyed, 'the hub to close both ends of the link')
    await waitFor(() => b.closed, 'side 1 to close')
    assert.equal(b.gotAtEnd, 'final', 'what side 1 got before its end')
    assert.ok(fx.logs.includes('L#1 0->1 ended (peer-end)'), 'the hub did not log the graceful end')
  } finally {
    await closeHub(fx)
  }
})

// A FIN from one side ends only the direction from that side. The hub must
// keep writing to that side until the queue toward it drains.
test('graceful close: when both sides end with a payload in each fault queue, both payloads arrive', async () => {
  const fx = await openHub({ profile: LATENCY })
  try {
    const [a, b] = await pair(fx, 'L')
    await send(a, 'a-final')
    await send(b, 'b-final')
    assert.equal(a.got + b.got, '', 'a payload left the hub before both FINs, so the test did not fill both queues')
    a.socket.end()
    b.socket.end()
    await waitFor(() => a.hubEnd.readableEnded && b.hubEnd.readableEnded, 'the hub to read the end of both sides')
    await waitFor(() => a.closed && b.closed, 'both sides to close')
    assert.equal(a.gotAtEnd, 'b-final', 'what side 0 got before its end')
    assert.equal(b.gotAtEnd, 'a-final', 'what side 1 got before its end')
    await waitFor(() => a.hubEnd.destroyed && b.hubEnd.destroyed, 'the hub to close both ends of the link')
    assert.ok(fx.logs.includes('L#1 0->1 ended (peer-end)'), 'the hub did not log the graceful end of 0->1')
    assert.ok(fx.logs.includes('L#1 1->0 ended (peer-end)'), 'the hub did not log the graceful end of 1->0')
  } finally {
    await closeHub(fx)
  }
})

test('after end(), a hard cut and a kill-mid-frame still drop the queued bytes at once', async () => {
  const fx = await openHub({ profile: LATENCY })
  try {
    const [a, b] = await pair(fx, 'L')
    await send(a, 'queued')
    a.socket.end()
    await waitFor(() => a.hubEnd.readableEnded, 'the hub to read the end of side 0 of L')
    fx.hub.cut('L')
    await waitFor(() => a.hubEnd.destroyed && b.hubEnd.destroyed, 'the hub to close both ends of L')
    await waitFor(() => b.closed, 'side 1 of L to close')
    assert.equal(b.got, '', 'a queued byte passed the cut')

    const [c, d] = await pair(fx, 'M')
    fx.hub.killAfter('M', 3)
    await send(c, 'abcdef')
    await send(c, 'ghi')
    c.socket.end()
    await waitFor(() => c.hubEnd.readableEnded, 'the hub to read the end of side 0 of M')
    await waitFor(() => c.hubEnd.destroyed && d.hubEnd.destroyed, 'the hub to close both ends of M')
    await waitFor(() => d.closed, 'side 1 of M to close')
    assert.equal(d.got, 'abc', 'what side 1 of M got past the kill')
  } finally {
    await closeHub(fx)
  }
})

// Side 1 does not read, so the hub pauses side 0 until side 1 drains. A
// closed side 1 never drains, and a paused socket with bytes in its read
// buffer hides its FIN. So the hub must resume side 0 when side 1 closes,
// or side 0 stays open for good.
test('graceful close: a source paused for backpressure still closes after its destination closes', async () => {
  const MiB = 1024 * 1024
  const fx = await openHub({ profile: LATENCY })
  try {
    const [a, b] = await pair(fx, 'L')
    b.socket.pause()
    a.socket.write(Buffer.alloc(32 * MiB))
    // 16 MiB is more than the kernel buffers of one loopback connection
    // hold (8 MiB at most on macOS), so side 1 cannot drain by chance.
    await waitFor(
      () => b.hubEnd.writableLength > 16 * MiB && a.hubEnd.isPaused(),
      'the hub to hold 16 MiB for side 1 and to pause side 0'
    )
    // The extra 1 MiB waits in the read buffer of the paused side 0.
    a.socket.write(Buffer.alloc(MiB))
    await waitFor(() => a.hubEnd.readableLength > 0, 'bytes to wait in the read buffer of side 0')
    b.socket.end()
    await waitFor(() => b.hubEnd.readableEnded, 'the hub to read the end of side 1')
    b.socket.destroy()
    await waitFor(() => b.hubEnd.destroyed, 'the hub to close side 1')
    await waitFor(() => a.hubEnd.destroyed, 'the hub to close side 0')
  } finally {
    await closeHub(fx)
  }
})

// While side 1 does not read, many writes to side 1 return false. One
// 'drain' listener per write leaks listeners for the life of the link.
test('backpressure: the hub waits for one drain per pause, not one per write', async () => {
  const MiB = 1024 * 1024
  const fx = await openHub({ profile: LATENCY })
  try {
    const [a, b] = await pair(fx, 'L')
    b.socket.pause()
    a.socket.write(Buffer.alloc(32 * MiB))
    await waitFor(
      () => b.hubEnd.writableLength > 16 * MiB && a.hubEnd.isPaused(),
      'the hub to hold 16 MiB for side 1 and to pause side 0'
    )
    assert.equal(b.hubEnd.listenerCount('drain'), 1, 'drain listeners on side 1')
  } finally {
    await closeHub(fx)
  }
})
