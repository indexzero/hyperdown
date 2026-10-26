// Validates the fault hub itself (no writer processes). The first socket of
// a link waits in `pending` until its partner connects. The hub must keep
// every byte that socket sends while it waits, and deliver the bytes in
// order: the bytes glued to its header, then the bytes it sent while it
// waited, then the live stream. A replication stream's initiator sends its
// first Noise handshake message at once, so a hub that dropped those bytes
// left the link paired and dead: no handshake, no replication, both ways.
//
// No step depends on a fixed sleep. Each send waits until the hub has read
// the bytes, each step waits until the hub has registered or paired the
// socket, and each delivery check polls until a deadline. A stall of the
// event loop at any point only makes a test slower.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { FaultHub } from '../lib/hub.js'
import { Rng } from '../lib/rng.js'

const CLEAN = { name: 'clean', latencyMs: 0, jitterMs: 0, stallP: 0, stallMs: 0 }
const DEADLINE_MS = 5000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const header = (link, side) => JSON.stringify({ link, side }) + '\n'

// Poll until cond() is true. Return false at the deadline.
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

// A hub, its log lines, and the hub's end of each connection it accepts,
// so that a test can wait until the hub has read what a client sent.
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
  const peer = { socket, hubEnd, sent: 0, got: '', closed: false }
  socket.on('data', (d) => {
    peer.got += d
  })
  socket.once('close', () => {
    peer.closed = true
  })
  return peer
}

// Connect side 0 and then side 1 of the link, and wait until they pair.
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

// Write the bytes, then wait until the hub has read all of them. So no
// later step can reach the hub before these bytes do.
async function send(peer, bytes) {
  peer.socket.write(bytes)
  peer.sent += Buffer.byteLength(bytes)
  await waitFor(() => peer.hubEnd.bytesRead >= peer.sent, `the hub to read ${JSON.stringify(bytes)}`)
}

// The first side of link L registers with 'A' glued to its header, then
// sends 'B' and 'C' while it waits. The second side arrives with 'x' glued
// to its header. After the link pairs, the first side sends 'D' and the
// second side sends 'y'.
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

// A pending socket that sends bytes and then a FIN must leave `pending`
// and close. Otherwise the hub keeps it, and the next socket for the link
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

// G48. A header must be one JSON object with a string `link` and a `side`
// of 0 or 1. A bad header destroys only its own socket, and the hub logs
// it. It never throws out of a 'data' listener, so the hub and a link that
// is already paired keep running.
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

// G47. A connection that sends no header line within the header deadline
// is destroyed, and the hub logs it. That covers a silent client and a
// client that stops in the middle of its header.
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

// G47. A header line longer than the header limit is destroyed at once,
// with or without its newline, so an endless header cannot grow the
// hub's buffer. A header line of exactly the limit registers.
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

// G47. The hub tracks every connection from accept to close, so close()
// finds a connection that has not sent its header line, destroys it, and
// returns. The header deadline is longer than the wait, so the deadline
// cannot be what closes these clients.
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
